import axios from 'axios';
import { logger } from '../lib/logger.js';
import { Token, FilterResult, ScoreBreakdown } from '../types/index.js';
import { getSettings } from './settings.service.js';
import { checkRugcheck } from './rugcheck.service.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  volume?: { h1?: number; h24?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
  labels?: string[];
  url?: string;
}

const tokenCache = new Map<string, Token>();
// Persistent set of mints that have open positions — survives between scan
// cycles and is checked during scanTokens() so even a cold-cache restart
// never re-marks an entered token as ELIGIBLE.
const enteredMints = new Set<string>();

// ── Liquidity stability history ──────────────────────────────────────────────
// Stores timestamped liquidity readings per mint so we can detect >15% drops
// over a 5-minute window before committing to an entry.
// Pruned to 10 minutes of data per mint; cleaned up alongside tokenCache eviction.
const liquidityHistory = new Map<string, Array<{ ts: number; liq: number }>>();

function recordLiquidityPoint(mint: string, liq: number): void {
  if (liq <= 0) return; // ignore zero/missing liquidity readings
  const now = Date.now();
  const PRUNE_MS = 10 * 60_000; // keep 10 min of history
  const history = liquidityHistory.get(mint) ?? [];
  history.push({ ts: now, liq });
  // Prune old entries
  const cutoff = now - PRUNE_MS;
  const trimmed = history.filter((h) => h.ts >= cutoff);
  liquidityHistory.set(mint, trimmed);
}

/**
 * Returns whether liquidity is stable (no >15% drop in the last 5 minutes).
 * Only blocks when we have ≥2 readings spanning at least 30 seconds — new
 * tokens with no history pass through unblocked.
 */
function checkLiquidityStability(mint: string, currentLiq: number): { stable: boolean; dropPct: number } {
  const WINDOW_MS   = 5 * 60_000; // 5-minute look-back window
  const MIN_SPAN_MS = 30_000;     // require at least 30s of history before blocking
  const DROP_LIMIT  = 15;         // block if liquidity fell >15%

  const history = liquidityHistory.get(mint);
  if (!history || history.length < 2) return { stable: true, dropPct: 0 };

  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Find the oldest reading within the 5-minute window
  const inWindow = history.filter((h) => h.ts >= windowStart);
  if (inWindow.length < 2) return { stable: true, dropPct: 0 };

  const oldest = inWindow[0];
  // Not enough time elapsed — don't penalise brand-new entries in cache
  if (now - oldest.ts < MIN_SPAN_MS) return { stable: true, dropPct: 0 };
  // Reference liquidity: the peak over the window (avoids false positives from
  // brief API dips being the "oldest" reading)
  const refLiq = Math.max(...inWindow.map((h) => h.liq));
  if (refLiq <= 0) return { stable: true, dropPct: 0 };

  const dropPct = ((refLiq - currentLiq) / refLiq) * 100;
  return { stable: dropPct <= DROP_LIMIT, dropPct: Math.max(0, dropPct) };
}
let scanCount = 0;
let passedFilters = 0;
let eligibleCount = 0;

// Rejection reason counters — reset each scan, read by getScanStats()
const rejectionCounts = new Map<string, number>();
function bumpReject(reason: string) { rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1); }

// Exposed so auto-trader can update this after entry checks
let dailyLossLimitHit = false;
let dailyPnlSnapshot = 0;
let dailyLossLimitSnapshot = 0;

export function setDailyLossStatus(hit: boolean, pnl: number, limit: number): void {
  dailyLossLimitHit = hit;
  dailyPnlSnapshot = pnl;
  dailyLossLimitSnapshot = limit;
}

export function getScanStats() {
  // Recompute eligible from the live cache so it stays accurate after
  // markTokenEntered() is called post-scan (e.g. to sync DB open positions)
  const liveEligible = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE').length;
  return {
    scanning: scanCount,
    passed: passedFilters,
    eligible: liveEligible,
    dailyLossLimitHit,
    dailyPnl: dailyPnlSnapshot,
    dailyLossLimit: dailyLossLimitSnapshot,
    rejectionCounts: Object.fromEntries(
      [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
  };
}

export function getAllTokens(): Token[] {
  return Array.from(tokenCache.values()).sort((a, b) => b.score - a.score);
}

export function getTokenByMint(mint: string): Token | undefined {
  return tokenCache.get(mint);
}

export function calcScore(
  token: Partial<Token>,
  mcRange?: { minMc: number; maxMc: number },
): ScoreBreakdown {
  let priceMomentum = 0;
  const p5 = token.priceChange5m ?? 0;
  if (p5 > 3) priceMomentum = 25;
  else if (p5 > 1) priceMomentum = 15;
  else if (p5 > 0) priceMomentum = 8;

  let volumeMomentum = 0;
  const v1h = token.volume1hCurrent ?? 0;
  const v1hPrev = token.volume1hPrev ?? 0;
  // Fall back to 24h average hourly rate when no prior h1 window exists.
  // This gives meaningful momentum on first-scan tokens instead of always 0.
  const avgHourly = (token.volume24h ?? 0) / 24;
  const baseline = v1hPrev > 0 ? v1hPrev : (avgHourly > 0 ? avgHourly : 0);
  const vRatio = baseline > 0 ? v1h / baseline : (v1h > 0 ? 2 : 0);
  if (vRatio > 2) volumeMomentum = 25;
  else if (vRatio > 1.5) volumeMomentum = 18;
  else if (vRatio > 1.2) volumeMomentum = 10;

  let buyPressure = 0;
  const bsr = token.buySellRatio ?? 1;
  if (bsr > 3) buyPressure = 25;
  else if (bsr > 2) buyPressure = 18;
  else if (bsr > 1.5) buyPressure = 12;
  else if (bsr > 1.2) buyPressure = 6;

  // MC Quality — scored relative to the user-configured MC filter range.
  // Divides [minMc, maxMc] into 4 equal quartiles; lower MC = higher score
  // because early/small tokens have more upside potential.
  // Falls back to absolute thresholds when no range is provided.
  let mcQuality = 0;
  const mc = token.marketCap ?? 0;
  if (mcRange && mcRange.maxMc > mcRange.minMc && mc >= mcRange.minMc && mc <= mcRange.maxMc) {
    const span = mcRange.maxMc - mcRange.minMc;
    const pos = (mc - mcRange.minMc) / span; // 0 = at minMc, 1 = at maxMc
    if (pos < 0.25) mcQuality = 25;       // Q1: freshest — most upside
    else if (pos < 0.50) mcQuality = 18;  // Q2
    else if (pos < 0.75) mcQuality = 12;  // Q3
    else mcQuality = 6;                   // Q4: near maxMc — less upside
  } else {
    // Fallback: absolute ranges (used when no mcRange passed)
    if (mc >= 250_000 && mc < 1_000_000) mcQuality = 25;
    else if (mc >= 100_000 && mc < 250_000) mcQuality = 18;
    else if (mc >= 1_000_000 && mc < 5_000_000) mcQuality = 15;
    else if (mc >= 5_000_000 && mc < 20_000_000) mcQuality = 8;
  }

  return {
    priceMomentum,
    volumeMomentum,
    buyPressure,
    mcQuality,
    total: priceMomentum + volumeMomentum + buyPressure + mcQuality,
  };
}

const ALLOWED_DEXES = ['raydium', 'pump-fun', 'pumpfun', 'pumpswap', 'orca', 'meteora'];

/**
 * Age-adjusted minimum score gate.
 * Younger tokens face higher score bars to compensate for thinner history.
 *   0 – 30 min  → 90
 *   30 – 60 min → 85
 *   ≥ 1 h       → 80
 * The user's configured minEntryScore is respected as an additional floor.
 */
function getAgeAdjustedMinScore(ageH: number, settingsMin: number): number {
  const ageMin = ageH * 60;
  let required: number;
  if (ageMin < 30) required = 90;
  else if (ageMin < 60) required = 85;
  else required = 80;
  return Math.max(settingsMin, required);
}

function buildFilterResults(
  pair: DexPair,
  settings: Awaited<ReturnType<typeof getSettings>>,
  rugOk: boolean,
  topHolder: number,
  creatorPct: number,
  qualityScore: number,
  aggVol24h: number,
  aggBsr: number,
  freshChange5m: number,
  freshLiq?: number,
  liqStability?: { stable: boolean; dropPct: number },
): FilterResult[] {
  const mc = pair.marketCap ?? pair.fdv ?? 0;
  const vol24 = aggVol24h;
  // Use explicitly-passed fresh liquidity when available; bulk endpoint often returns 0 for
  // Meteora/Orca DLMM pools even though real liquidity exists (per-pair endpoint is accurate).
  const liq = freshLiq !== undefined ? freshLiq : (pair.liquidity?.usd ?? 0);
  const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const bsr = aggBsr;
  const change5m = freshChange5m;
  const change24 = pair.priceChange?.h24 ?? 0;
  const dexOk = ALLOWED_DEXES.includes(pair.dexId?.toLowerCase() ?? '');

  // Age-adjusted score gate — replaces both the hard minAge lower bound and the
  // old "young token ≥80" check. Each age bucket gets a tighter requirement.
  const effectiveMinScore = getAgeAdjustedMinScore(ageH, settings.minEntryScore);
  const ageScoreOk = qualityScore >= effectiveMinScore;
  const ageMin = ageH * 60;
  const ageBucket = ageMin < 30 ? '0–30m' : ageMin < 60 ? '30–60m' : '≥1h';

  // Liquidity stability: passes when stable OR when we have no history yet
  const liqStable = liqStability?.stable ?? true;
  const liqDropPct = liqStability?.dropPct ?? 0;
  const liqStabilityLabel = liqDropPct > 0 ? `-${liqDropPct.toFixed(1)}%` : 'stable';

  // Labels dynamically reflect the actual threshold from settings (not hardcoded defaults)
  return [
    { name: `MC ≥$${(settings.minMc/1000).toFixed(0)}K`, passed: mc >= settings.minMc, value: `$${(mc/1000).toFixed(0)}K`, required: `≥$${(settings.minMc/1000).toFixed(0)}K` },
    { name: `MC ≤$${(settings.maxMc/1_000_000).toFixed(1)}M`, passed: mc <= settings.maxMc, value: `$${(mc/1_000_000).toFixed(2)}M`, required: `≤$${(settings.maxMc/1_000_000).toFixed(1)}M` },
    { name: `Vol24h ≥$${(settings.minVolume24h/1000).toFixed(0)}K`, passed: vol24 >= settings.minVolume24h, value: `$${(vol24/1000).toFixed(0)}K`, required: `≥$${(settings.minVolume24h/1000).toFixed(0)}K` },
    { name: `Age ≤${settings.maxAgeHours}h`, passed: ageH <= settings.maxAgeHours, value: `${ageH.toFixed(1)}h`, required: `≤${settings.maxAgeHours}h` },
    { name: `Liquidity ≥$${(settings.minLiquidity/1000).toFixed(0)}K`, passed: liq >= settings.minLiquidity, value: `$${(liq/1000).toFixed(0)}K`, required: `≥$${(settings.minLiquidity/1000).toFixed(0)}K` },
    { name: `BSR ≥${settings.minBuySellRatio}x (24h)`, passed: bsr >= settings.minBuySellRatio, value: `${bsr.toFixed(2)}x`, required: `≥${settings.minBuySellRatio}x` },
    { name: 'No 5m FOMO >50%', passed: change5m <= 50, value: `${change5m.toFixed(1)}%`, required: '≤50% in 5m' },
    { name: 'Not pumped >500%', passed: change24 <= 500, value: `${change24.toFixed(0)}%`, required: '≤500% in 24h' },
    { name: 'Rugcheck pass', passed: rugOk || !settings.rugcheckEnabled, value: rugOk ? 'PASS' : 'FAIL', required: 'PASS' },
    { name: 'DEX supported', passed: dexOk, value: pair.dexId ?? 'unknown', required: 'Raydium/Pump/Orca' },
    // maxTopHolder and maxCreatorPct: only enforce when rugcheck has supplied real data (>0)
    { name: `Top holder ≤${settings.maxTopHolder}%`, passed: topHolder === 0 || topHolder <= settings.maxTopHolder, value: `${topHolder.toFixed(1)}%`, required: `≤${settings.maxTopHolder}%` },
    { name: `Creator ≤${settings.maxCreatorPct}%`, passed: creatorPct === 0 || creatorPct <= settings.maxCreatorPct, value: `${creatorPct.toFixed(1)}%`, required: `≤${settings.maxCreatorPct}%` },
    // Liquidity stability: block tokens already being drained (>15% drop in last 5 min)
    { name: 'Liq stable (<15% drop/5m)', passed: liqStable, value: liqStabilityLabel, required: '<15% drop in 5m' },
    // Age-adjusted score gate: younger tokens need higher scores to account for thin history
    { name: `Score ≥${effectiveMinScore} (${ageBucket})`, passed: ageScoreOk, value: `score ${qualityScore}`, required: `≥${effectiveMinScore}` },
  ];
}

// ── Raydium on-chain pool API ────────────────────────────────────────────────
// Fetches all Raydium AMM/CPMM pools sorted by 24h volume directly from their
// official API — no keyword guessing, just every real trading pair on-chain.
// Quote tokens (SOL, USDC, USDT) are stripped so only base meme-coin mints remain.
const RAYDIUM_QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // SOL (wrapped)
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);

interface RaydiumPool {
  id?: string;
  mintA?: { address?: string };
  mintB?: { address?: string };
  tvl?: number;
  day?: { volume?: number };
}

interface RaydiumResponse {
  success?: boolean;
  data?: { count?: number; data?: RaydiumPool[] };
}

async function fetchRaydiumMints(): Promise<string[]> {
  try {
    // Pages 1–10 × 100 pools/page = up to 1000 Raydium pools sorted by 24h volume
    const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const requests = pages.map((p) =>
      axios.get<RaydiumResponse>(
        `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=volume24h&sortType=desc&pageSize=100&page=${p}`,
        { timeout: 12000 }
      ).catch(() => ({ data: { data: { data: [] as RaydiumPool[] } } }))
    );

    const results = await Promise.all(requests);
    const mints = new Set<string>();

    for (const res of results) {
      const pools = res.data?.data?.data ?? [];
      for (const pool of pools) {
        // Pick the non-quote side as the token we care about
        const mintA = pool.mintA?.address ?? '';
        const mintB = pool.mintB?.address ?? '';
        if (mintA && !RAYDIUM_QUOTE_MINTS.has(mintA)) mints.add(mintA);
        if (mintB && !RAYDIUM_QUOTE_MINTS.has(mintB)) mints.add(mintB);
      }
    }

    logger.info({ count: mints.size }, 'Raydium on-chain: fetched pool mints');
    return Array.from(mints);
  } catch (err) {
    logger.warn({ err }, 'Raydium API fetch error');
    return [];
  }
}

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

interface GeckoPool {
  id: string;
  attributes: {
    name?: string;
    address?: string;
    base_token_price_usd?: string;
    market_cap_usd?: string;
    fdv_usd?: string;
    volume_usd?: { h24?: string; h1?: string };
    price_change_percentage?: { m5?: string; h1?: string; h24?: string };
    transactions?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
    reserve_in_usd?: string;
    pool_created_at?: string;
    dex_id?: string;
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

async function fetchGeckoMints(): Promise<string[]> {
  try {
    // Fetch 5 pages of trending, 5 pages of top-volume, and 3 pages of new pools in parallel.
    // Each page returns ~20 pools → up to 260 mints from GeckoTerminal alone.
    const pages = [1, 2, 3, 4, 5];
    const newPages = [1, 2, 3];

    const geckoRequests = [
      ...pages.map((p) =>
        axios.get<{ data: GeckoPool[] }>(
          `${GECKO_BASE}/networks/solana/trending_pools?include=base_token&page=${p}`,
          { timeout: 10000, headers: { Accept: 'application/json;version=20230302' } }
        ).catch(() => ({ data: { data: [] as GeckoPool[] } }))
      ),
      ...pages.map((p) =>
        axios.get<{ data: GeckoPool[] }>(
          `${GECKO_BASE}/networks/solana/pools?sort=h24_volume_desc&page=${p}`,
          { timeout: 10000, headers: { Accept: 'application/json;version=20230302' } }
        ).catch(() => ({ data: { data: [] as GeckoPool[] } }))
      ),
      ...newPages.map((p) =>
        axios.get<{ data: GeckoPool[] }>(
          `${GECKO_BASE}/networks/solana/new_pools?include=base_token&page=${p}`,
          { timeout: 10000, headers: { Accept: 'application/json;version=20230302' } }
        ).catch(() => ({ data: { data: [] as GeckoPool[] } }))
      ),
    ];

    const allResults = await Promise.all(geckoRequests);
    const mints = new Set<string>();
    for (const res of allResults) {
      for (const pool of res.data?.data ?? []) {
        const tokenId = pool.relationships?.base_token?.data?.id;
        if (tokenId) {
          const mint = tokenId.replace(/^solana_/, '');
          if (mint && mint.length > 10) mints.add(mint);
        }
      }
    }
    logger.info({ count: mints.size }, 'GeckoTerminal: fetched Solana token mints');
    return Array.from(mints);
  } catch (err) {
    logger.warn({ err }, 'GeckoTerminal fetch error');
    return [];
  }
}

async function fetchDexPairs(): Promise<DexPair[]> {
  try {
    const allPairs: DexPair[] = [];

    // ── Run all independent fetches in parallel ──────────────────────
    // Sources:
    //   1. Raydium on-chain API   — all real AMM/CPMM pools sorted by 24h volume
    //   2. GeckoTerminal          — trending + top-volume + new_pools (13 pages)
    //   3. DexScreener profiles   — boosted/trending tokens
    //   4. DexScreener boosts     — top paid promotions (often early movers)
    // No keyword guessing — every mint comes from actual on-chain activity.
    const [raydiumMints, geckoMints, profileRes, boostRes] = await Promise.all([
      // 1. Raydium: 10 pages × 100 pools = up to 1000 on-chain pools
      fetchRaydiumMints(),

      // 2. GeckoTerminal: 13-page deep scan
      fetchGeckoMints(),

      // 3. DexScreener: latest token profiles (boosted/trending)
      axios.get<Array<{ tokenAddress: string; chainId: string }>>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 10000 }
      ).catch(() => ({ data: [] as Array<{ tokenAddress: string; chainId: string }> })),

      // 4. DexScreener: top boosted tokens
      axios.get<Array<{ tokenAddress: string; chainId: string }>>(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`,
        { timeout: 10000 }
      ).catch(() => ({ data: [] as Array<{ tokenAddress: string; chainId: string }> })),
    ]);

    // Collect all mints for DexScreener batch-lookup
    const extraMints = new Set<string>([...raydiumMints, ...geckoMints]);

    if (Array.isArray(profileRes.data)) {
      profileRes.data.filter((t) => t.chainId === 'solana').forEach((t) => extraMints.add(t.tokenAddress));
    }
    if (Array.isArray(boostRes.data)) {
      boostRes.data.filter((t) => t.chainId === 'solana').forEach((t) => extraMints.add(t.tokenAddress));
    }

    // Batch-lookup all collected mints on DexScreener.
    // DexScreener allows up to 30 addresses per request and rate-limits aggressive
    // parallel bursts. We fire 5 chunks concurrently, wait 300 ms, then the next 5.
    // This keeps throughput high (~300 pairs/s) without triggering rate-limits.
    const mintList = Array.from(extraMints);
    const mintChunks: string[][] = [];
    for (let i = 0; i < mintList.length; i += 30) mintChunks.push(mintList.slice(i, i + 30));

    const CONCURRENCY = 8;
    const CHUNK_DELAY_MS = 100;

    for (let i = 0; i < mintChunks.length; i += CONCURRENCY) {
      const batch = mintChunks.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((chunk) =>
          axios.get<{ pairs: DexPair[] }>(
            `${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`,
            { timeout: 12000 }
          ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
        )
      );
      for (const r of batchResults) {
        if (r.data?.pairs) allPairs.push(...r.data.pairs.filter((p) => p.chainId === 'solana'));
      }
      // Brief pause between concurrency windows to avoid rate-limiting
      if (i + CONCURRENCY < mintChunks.length) {
        await new Promise((res) => setTimeout(res, CHUNK_DELAY_MS));
      }
    }

    // Deduplicate by pairAddress
    const seen = new Set<string>();
    const deduped = allPairs.filter((p) => {
      if (!p.pairAddress || seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress);
      return true;
    });

    logger.info({ total: deduped.length }, 'fetchDexPairs: total unique pairs fetched');
    return deduped;
  } catch (err) {
    logger.warn({ err }, 'DexScreener fetch error');
    return [];
  }
}

// DEX quality ranking: tiebreaker only — used AFTER liquidity to pick between
// equally-liquid pairs. Higher = preferred.
const DEX_RANK: Record<string, number> = { raydium: 100, orca: 80, meteora: 70, pumpswap: 60, 'pump-fun': 50, pumpfun: 50 };

export async function scanTokens(): Promise<void> {
  const settings = await getSettings();
  const allPairs = await fetchDexPairs();
  passedFilters = 0;
  eligibleCount = 0;
  rejectionCounts.clear(); // reset counters each scan cycle

  // ── Multi-pool aggregation ───────────────────────────────────────────────
  // A token can trade across multiple pools (e.g. Raydium + PumpSwap).
  // DexScreener's website shows TOTAL volume across all pools; we must do
  // the same or we'll see a fraction of the real volume and miss valid trades.
  //
  // Strategy:
  //   • Group all pairs by mint
  //   • Pick the BEST pair for price/MC/liq/priceChange data:
  //       PRIMARY   — highest liquidity.usd  (most liquid pool = most reliable data)
  //       SECONDARY — highest h1 volume      (most active pool this hour)
  //       TERTIARY  — DEX rank               (tiebreaker: established AMMs preferred)
  //     NOTE: DEX rank must NOT override liquidity. The old formula multiplied rank
  //     by 1000, letting a low-liquidity Meteora pair beat a $52K PumpSwap pair
  //     simply because Meteora rank(70) > PumpSwap rank(50). This caused all data
  //     (price changes, liquidity, DEX label) to reflect the wrong/empty pair.
  //   • SUM vol24h, vol1h across all pools → true total market volume
  //   • SUM h1 buys/sells across all pools → true BSR
  type AggregatedPair = DexPair & { aggVol24h: number; aggVol1h: number; aggBsr: number };

  const mintGroupMap = new Map<string, DexPair[]>();
  for (const pair of allPairs) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;
    const group = mintGroupMap.get(mint) ?? [];
    group.push(pair);
    mintGroupMap.set(mint, group);
  }

  const pairs: AggregatedPair[] = [];
  for (const [, group] of mintGroupMap) {
    // Liquidity-first pair selection:
    //   liq (USD)  × 100  → primary key  (1 dollar of liquidity = 100 score points)
    //   h1 vol     × 1    → secondary    (activity this hour)
    //   DEX rank   × 1    → tertiary     (tiebreaker between equal-liquidity pools)
    // With this formula a pool needs ZERO liquidity and ZERO h1 vol for DEX rank
    // alone to decide — i.e. rank only matters when pools are equally illiquid.
    let best = group[0];
    let bestScore = 0;
    for (const p of group) {
      const liq  = p.liquidity?.usd ?? 0;
      const h1vol = p.volume?.h1 ?? 0;
      const rank  = DEX_RANK[p.dexId?.toLowerCase() ?? ''] ?? 0;
      const s = liq * 100 + h1vol + rank;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    // Aggregate volumes and transaction counts across ALL pools
    const aggVol24h = group.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    const aggVol1h  = group.reduce((sum, p) => sum + (p.volume?.h1  ?? 0), 0);
    // Use h24 buys/sells — matches what DexScreener displays and is far more stable
    // than h1 which is too noisy (one weak hour tanks a genuinely bullish token)
    const totalBuys24h  = group.reduce((sum, p) => sum + (p.txns?.h24?.buys  ?? 0), 0);
    const totalSells24h = group.reduce((sum, p) => sum + (p.txns?.h24?.sells ?? 0), 0);
    const aggBsr = totalSells24h > 0 ? totalBuys24h / totalSells24h : totalBuys24h > 0 ? 99 : 1;
    pairs.push({ ...best, aggVol24h, aggVol1h, aggBsr });
  }

  // scanCount = unique mints in THIS cycle (after dedup). This keeps the number
  // consistent with rejectionCounts so the UI breakdown adds up correctly.
  // (Using tokenCache.size inflates the count with stale entries from past cycles.)
  scanCount = pairs.length;

  // ── PASS 1: Pre-filter using bulk data ──────────────────────────────────
  // Eliminates 95%+ of tokens (wrong MC/vol/age) without expensive API calls.
  // Candidates (those passing pre-filter) go to Pass 2 for real-time data.
  type CandidateEntry = { pair: AggregatedPair; mc: number; vol24: number; bsr: number; v1h: number; liq: number; ageH: number; change24: number; change1h: number; change5m: number; price: number };
  const candidates: CandidateEntry[] = [];

  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;

    const mc     = pair.marketCap ?? pair.fdv ?? 0;
    const vol24  = pair.aggVol24h;
    const bsr    = pair.aggBsr;
    const v1h    = pair.aggVol1h;
    const liq    = pair.liquidity?.usd ?? 0;
    const ageH   = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
    const change24 = pair.priceChange?.h24 ?? 0;
    const change1h = pair.priceChange?.h1 ?? 0;
    const change5m = pair.priceChange?.m5 ?? 0;
    const price    = parseFloat(pair.priceUsd ?? '0');

    let preReject: string | undefined;
    let preRejectKey: string | undefined;
    if      (mc < settings.minMc)           { preReject = `MC too low ($${(mc/1000).toFixed(0)}K < $${(settings.minMc/1000).toFixed(0)}K min)`;             preRejectKey = 'MC too low'; }
    else if (mc > settings.maxMc)           { preReject = `MC too high ($${(mc/1e6).toFixed(1)}M > $${(settings.maxMc/1e6).toFixed(1)}M max)`;              preRejectKey = 'MC too high'; }
    else if (vol24 < settings.minVolume24h) { preReject = `Vol24h too low ($${(vol24/1000).toFixed(0)}K < $${(settings.minVolume24h/1000).toFixed(0)}K min)`; preRejectKey = 'Vol24h too low'; }
    else if (ageH > settings.maxAgeHours)   { preReject = `Age ${ageH.toFixed(1)}h > ${settings.maxAgeHours}h max`;                                          preRejectKey = 'Age too old'; }
    else if (change24 > 500)                { preReject = `Already pumped ${change24.toFixed(0)}% in 24h (>500% blocks entry)`;                              preRejectKey = 'Already pumped >500%'; }

    const existing = tokenCache.get(mint);

    if (preReject) {
      if (preRejectKey) bumpReject(preRejectKey);
      if (enteredMints.has(mint)) continue;
      // Compute real score even for pre-rejected tokens so the UI shows meaningful
      // momentum data instead of 0/100 for everything. Status stays REJECTED.
      const preV1hPrev = existing?.volume1hCurrent ?? 0;
      const prePartial: Partial<Token> = {
        priceChange5m: change5m,
        volume1hCurrent: v1h,
        volume1hPrev: preV1hPrev,
        volume24h: vol24,
        buySellRatio: bsr,
        marketCap: mc,
      };
      const preScore = calcScore(prePartial, { minMc: settings.minMc, maxMc: settings.maxMc });
      tokenCache.set(mint, {
        mint, name: pair.baseToken.name || 'Unknown', symbol: pair.baseToken.symbol || '???',
        score: preScore.total, marketCap: mc, volume24h: vol24, priceChange1h: change1h, priceChange5m: change5m,
        priceChange24h: change24, buySellRatio: bsr, liquidity: liq, age: ageH,
        dexId: pair.dexId ?? '', pairAddress: pair.pairAddress, price,
        rugcheck: true, freezeAuthority: false, mintAuthority: false,
        topHolder: existing?.topHolder ?? 0, creatorPct: existing?.creatorPct ?? 0,
        status: 'REJECTED', rejectReason: preReject, scoreBreakdown: preScore,
        filterResults: buildFilterResults(pair, settings, existing?.rugcheck ?? true, existing?.topHolder ?? 0, existing?.creatorPct ?? 0, preScore.total, vol24, bsr, change5m, liq > 0 ? liq : undefined, undefined),
        consecutiveTrending: 0, volume1hPrev: preV1hPrev, volume1hCurrent: v1h, lastChecked: Date.now(),
      });
      continue;
    }

    candidates.push({ pair, mc, vol24, bsr, v1h, liq, ageH, change24, change1h, change5m, price });
  }

  // ── PASS 2: Targeted fresh-data fetch for candidates ────────────────────
  // Candidates passed MC/vol/age pre-filter — now we need REAL-TIME 5m/1h
  // data before applying the full filter. The bulk batch endpoint can return
  // 5m data that is 15-60s stale, causing valid tokens to be falsely rejected
  // (or worse, FOMO-pumped tokens to be wrongly accepted).
  // DexScreener's /pairs endpoint returns live data for specific pair addresses.
  const freshPairMap = new Map<string, DexPair>(); // pairAddress → live pair
  if (candidates.length > 0) {
    const pairAddrs = candidates.map((c) => c.pair.pairAddress).filter(Boolean) as string[];
    const freshChunks: string[][] = [];
    for (let i = 0; i < pairAddrs.length; i += 30) freshChunks.push(pairAddrs.slice(i, i + 30));

    const freshResults = await Promise.all(
      freshChunks.map((chunk) =>
        axios.get<{ pairs: DexPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${chunk.join(',')}`,
          { timeout: 8000 }
        ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
      )
    );
    for (const res of freshResults) {
      for (const p of res.data?.pairs ?? []) {
        if (p.pairAddress) freshPairMap.set(p.pairAddress, p);
      }
    }
    logger.info({ candidates: candidates.length, freshFetched: freshPairMap.size }, 'Fresh pair data fetched for candidates');
  }

  // ── PASS 2 continued: full filter evaluation with real-time data ─────────
  for (const { pair, mc, vol24, bsr, v1h, liq, ageH, change24, change1h, change5m: bulkChange5m, price } of candidates) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;

    // Use live data from targeted fetch; fall back to bulk data if not returned
    const fresh = freshPairMap.get(pair.pairAddress ?? '');
    // 5m and 1h price change: use freshest available — these are the most time-sensitive
    const change5m = fresh?.priceChange?.m5  ?? bulkChange5m;
    const freshChange1h = fresh?.priceChange?.h1 ?? change1h;
    // Price: prefer fresh (more accurate for entry price calculations)
    const freshPrice = fresh ? parseFloat(fresh.priceUsd ?? '0') || price : price;
    // Liquidity: bulk endpoint frequently returns 0 for Meteora/Orca DLMM pools;
    // per-pair endpoint is authoritative — always prefer it when available.
    const freshLiq = (fresh?.liquidity?.usd !== undefined && fresh.liquidity.usd > 0)
      ? fresh.liquidity.usd
      : liq > 0 ? liq : (fresh?.liquidity?.usd ?? 0);
    // h1 volume: bulk /tokens/ endpoint sometimes omits or zeroes h1;
    // per-pair endpoint returns accurate real-time volume — use it for scoring.
    const freshV1h = (fresh?.volume?.h1 !== undefined && fresh.volume.h1 > 0)
      ? fresh.volume.h1
      : v1h;

    const existing = tokenCache.get(mint);

    // Rugcheck (with cache — 5-min TTL so we don't hammer rugcheck API)
    // IMPORTANT: when rugcheckEnabled is false, always use rugOk=true and do NOT
    // read from the cache. A previously-cached rugcheck:false value would propagate
    // into token.rugcheck, which the emergency exit in position.service checks, causing
    // positions to be closed even though the user disabled rugcheck.
    let rugOk = true;
    let topHolder = existing?.topHolder ?? 0;
    let creatorPct = existing?.creatorPct ?? 0;
    if (settings.rugcheckEnabled) {
      if (existing && Date.now() - existing.lastChecked < 5 * 60_000) {
        rugOk = existing.rugcheck;
        // Use cached percentages from previous rugcheck call if available
        topHolder = existing.topHolder > 0 ? existing.topHolder : topHolder;
        creatorPct = existing.creatorPct > 0 ? existing.creatorPct : creatorPct;
      } else {
        const rugResult = await checkRugcheck(mint, settings.maxCreatorPct).catch(() => ({ ok: true, topHolder: 0, creatorPct: 0 }));
        rugOk = rugResult.ok;
        // Only update from rugcheck when it returned real data
        if (rugResult.topHolder > 0) topHolder = rugResult.topHolder;
        if (rugResult.creatorPct > 0) creatorPct = rugResult.creatorPct;
      }
    }

    // Volume momentum: use fresh h1 as current, previous scan's h1 as baseline
    const v1hPrev = (existing && existing.volume1hCurrent > 0)
      ? existing.volume1hCurrent
      : freshV1h * 0.8;

    const partial: Partial<Token> = {
      priceChange5m: change5m,
      volume1hCurrent: freshV1h,
      volume1hPrev: v1hPrev,
      volume24h: vol24,
      buySellRatio: bsr,
      marketCap: mc,
    };

    const scoreBreakdown = calcScore(partial, { minMc: settings.minMc, maxMc: settings.maxMc });
    // Record liquidity for stability tracking, then evaluate drop over last 5 min
    recordLiquidityPoint(mint, freshLiq);
    const liqStability = checkLiquidityStability(mint, freshLiq);
    if (!liqStability.stable) {
      logger.info({ mint, symbol: pair.baseToken.symbol, dropPct: liqStability.dropPct.toFixed(1) }, 'LIQ DRAIN: liquidity dropped >15% in 5m — blocking entry');
    }
    // Pass real-time change5m, fresh liquidity, and stability check so filters use accurate data
    const filterResults = buildFilterResults(pair, settings, rugOk, topHolder, creatorPct, scoreBreakdown.total, vol24, bsr, change5m, freshLiq, liqStability);
    const allPassed = filterResults.every((f) => f.passed);

    if (allPassed) passedFilters++;

    const rejectReason = !allPassed ? filterResults.find((f) => !f.passed)?.name : undefined;
    if (rejectReason) bumpReject(rejectReason);

    const prevConsecutive = existing?.consecutiveTrending ?? 0;
    const isUp = change5m >= 0 && (scoreBreakdown.total >= (existing?.score ?? 0));
    const consecutive = isUp ? prevConsecutive + 1 : 0;

    const trendOk = settings.trendChecksRequired <= 1 || consecutive >= settings.trendChecksRequired;

    const effectiveMinScore = getAgeAdjustedMinScore(ageH, settings.minEntryScore);

    const status: Token['status'] = enteredMints.has(mint)
      ? 'ENTERED'
      : allPassed && scoreBreakdown.total >= effectiveMinScore && trendOk
      ? 'ELIGIBLE'
      : !allPassed
      ? 'REJECTED'
      : 'SCANNING';

    if (status === 'ELIGIBLE') {
      logger.info(
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, effectiveMinScore, ageH: ageH.toFixed(2), consecutive, trendRequired: settings.trendChecksRequired, change5m, breakdown: scoreBreakdown },
        'AUDIT ACCEPTED: token meets all requirements — status=ELIGIBLE'
      );
      eligibleCount++;
    } else if (status === 'SCANNING') {
      logger.debug({ mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, effectiveMinScore }, 'AUDIT SCANNING');
    } else if (status === 'REJECTED') {
      logger.debug({ mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, reason: rejectReason }, 'AUDIT REJECTED');
    }

    tokenCache.set(mint, {
      mint,
      name: pair.baseToken.name || 'Unknown',
      symbol: pair.baseToken.symbol || '???',
      score: scoreBreakdown.total,
      marketCap: mc,
      volume24h: vol24,
      priceChange1h: freshChange1h,
      priceChange5m: change5m,
      priceChange24h: change24,
      buySellRatio: bsr,
      liquidity: freshLiq,
      age: ageH,
      dexId: pair.dexId ?? '',
      pairAddress: pair.pairAddress,
      price: freshPrice,
      rugcheck: rugOk,
      freezeAuthority: false,
      mintAuthority: false,
      topHolder,
      creatorPct,
      status,
      rejectReason,
      tradedToday: tradedTodaySet.has(mint),
      scoreBreakdown,
      filterResults,
      consecutiveTrending: consecutive,
      volume1hPrev: v1hPrev,
      volume1hCurrent: freshV1h,
      lastChecked: Date.now(),
    });
  }

  // Clean old tokens (not seen in last 30 min, not entered)
  for (const [mint, token] of tokenCache.entries()) {
    if (token.status !== 'ENTERED' && Date.now() - token.lastChecked > 30 * 60_000) {
      tokenCache.delete(mint);
      liquidityHistory.delete(mint); // free associated history alongside cache eviction
    }
  }

  // Recount eligible/scanning from current cycle only (mints processed above).
  // scanCount was already set to pairs.length after dedup — do NOT override with
  // tokenCache.size, which includes stale entries from past cycles and makes the
  // rejection breakdown look like it's missing tokens.
  eligibleCount = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE').length;
  passedFilters = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE' || t.status === 'SCANNING').length;
  logger.info({ scanCount, passedFilters, eligibleCount }, 'Scan complete');
}

// ── HOT REFRESH ─────────────────────────────────────────────────────────────
// Runs every 3 seconds (separate from the full 15s scan cycle).
// Targets only SCANNING, recently-REJECTED, and brand-new tokens so they
// flip to ELIGIBLE the moment real-world data corrects — not 15s later.
// Returns true when at least one token changed status (caller broadcasts).
export async function hotRefreshScanningTokens(): Promise<boolean> {
  const settings = await getSettings().catch(() => null);
  if (!settings) return false;

  const now = Date.now();

  // Collect mints worth refreshing:
  //  • SCANNING — close to eligible, any filter could flip any second
  //  • REJECTED in last 90s — might have just been rejected due to stale 5m data
  //  • Any token not refreshed in last 10s that isn't already ENTERED/ELIGIBLE
  const targets: { mint: string; pairAddress: string; token: Token }[] = [];
  for (const [mint, token] of tokenCache.entries()) {
    if (token.status === 'ENTERED') continue;
    if (token.status === 'ELIGIBLE') continue;
    const isScanning  = token.status === 'SCANNING';
    const recentReject = token.status === 'REJECTED' && (now - token.lastChecked) < 90_000;
    const stale       = (now - token.lastChecked) > 10_000;
    if ((isScanning || recentReject) && stale && token.pairAddress) {
      targets.push({ mint, pairAddress: token.pairAddress, token });
    }
  }
  if (targets.length === 0) return false;

  // Fetch fresh pair data for all targets in parallel chunks of 30
  const pairAddrs = targets.map((t) => t.pairAddress);
  const chunks: string[][] = [];
  for (let i = 0; i < pairAddrs.length; i += 30) chunks.push(pairAddrs.slice(i, i + 30));

  const freshMap = new Map<string, DexPair>();
  const results = await Promise.all(
    chunks.map((chunk) =>
      axios.get<{ pairs: DexPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${chunk.join(',')}`,
        { timeout: 6000 }
      ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
    )
  );
  for (const res of results) {
    for (const p of res.data?.pairs ?? []) {
      if (p.pairAddress) freshMap.set(p.pairAddress, p);
    }
  }

  let anyChanged = false;

  for (const { mint, pairAddress, token } of targets) {
    const fresh = freshMap.get(pairAddress);
    if (!fresh) continue; // pair not returned — leave as-is

    // Pull the freshest values — these are what was stale before
    const change5m  = fresh.priceChange?.m5  ?? token.priceChange5m;
    const change1h  = fresh.priceChange?.h1  ?? token.priceChange1h;
    const change24  = fresh.priceChange?.h24 ?? token.priceChange24h;
    const mc        = fresh.marketCap ?? fresh.fdv ?? token.marketCap;
    // Prefer fresh per-pair liquidity; fall back to stored value (already corrected by Pass 2)
    const liq       = (fresh.liquidity?.usd !== undefined && fresh.liquidity.usd > 0)
      ? fresh.liquidity.usd
      : token.liquidity;
    const price     = parseFloat(fresh.priceUsd ?? '0') || token.price;
    const vol24     = token.volume24h;  // aggregated value — keep as-is (not in single pair fetch)
    const bsr       = token.buySellRatio;
    // Prefer fresh h1 volume; fall back to stored value
    const v1h       = (fresh.volume?.h1 !== undefined && fresh.volume.h1 > 0)
      ? fresh.volume.h1
      : token.volume1hCurrent;
    const v1hPrev   = token.volume1hPrev > 0 ? token.volume1hPrev : v1h * 0.8;
    const ageH      = fresh.pairCreatedAt ? (now - fresh.pairCreatedAt) / 3_600_000 : token.age;

    // Quick pre-filter disqualifier — skip re-eval if clearly still wrong
    if (mc < settings.minMc || mc > settings.maxMc) continue;
    if (vol24 < settings.minVolume24h) continue;
    if (ageH > settings.maxAgeHours) continue;
    if (change24 > 500) continue;

    const partial: Partial<Token> = {
      priceChange5m: change5m,
      volume1hCurrent: v1h,
      volume1hPrev: v1hPrev,
      volume24h: vol24,
      buySellRatio: bsr,
      marketCap: mc,
    };
    const scoreBreakdown = calcScore(partial, { minMc: settings.minMc, maxMc: settings.maxMc });
    // Record liquidity for stability tracking, then evaluate drop over last 5 min
    recordLiquidityPoint(mint, liq);
    const liqStability = checkLiquidityStability(mint, liq);
    if (!liqStability.stable) {
      logger.info({ mint, symbol: token.symbol, dropPct: liqStability.dropPct.toFixed(1), source: 'hot-refresh' }, 'LIQ DRAIN: liquidity dropped >15% in 5m — blocking entry');
    }
    // Pass liq explicitly so the filter label shows the real value (per-pair endpoint)
    const filterResults  = buildFilterResults(fresh, settings, token.rugcheck, token.topHolder, token.creatorPct, scoreBreakdown.total, vol24, bsr, change5m, liq, liqStability);
    const allPassed = filterResults.every((f) => f.passed);
    const rejectReason = !allPassed ? filterResults.find((f) => !f.passed)?.name : undefined;

    const prevConsecutive = token.consecutiveTrending ?? 0;
    const isUp = change5m >= 0 && (scoreBreakdown.total >= (token.score ?? 0));
    const consecutive = isUp ? prevConsecutive + 1 : 0;
    const trendOk = settings.trendChecksRequired <= 1 || consecutive >= settings.trendChecksRequired;

    const effectiveMinScore = getAgeAdjustedMinScore(ageH, settings.minEntryScore);

    const newStatus: Token['status'] = enteredMints.has(mint)
      ? 'ENTERED'
      : allPassed && scoreBreakdown.total >= effectiveMinScore && trendOk
      ? 'ELIGIBLE'
      : !allPassed
      ? 'REJECTED'
      : 'SCANNING';

    if (newStatus !== token.status) {
      anyChanged = true;
      if (newStatus === 'ELIGIBLE') {
        logger.info(
          { mint, symbol: token.symbol, score: scoreBreakdown.total, change5m, source: 'hot-refresh' },
          'HOT REFRESH → ELIGIBLE'
        );
      }
    }

    tokenCache.set(mint, {
      ...token,
      marketCap: mc,
      liquidity: liq,
      price,
      priceChange5m: change5m,
      priceChange1h: change1h,
      priceChange24h: change24,
      age: ageH,
      score: scoreBreakdown.total,
      scoreBreakdown,
      filterResults,
      consecutiveTrending: consecutive,
      status: newStatus,
      rejectReason,
      volume1hCurrent: v1h,
      volume1hPrev: v1hPrev,
      lastChecked: now,
    });
  }

  if (targets.length > 0) {
    logger.debug({ targets: targets.length, freshFetched: freshMap.size, anyChanged }, 'Hot refresh complete');
  }
  return anyChanged;
}

export function markTokenEntered(mint: string): void {
  enteredMints.add(mint);
  const t = tokenCache.get(mint);
  if (t) tokenCache.set(mint, { ...t, status: 'ENTERED' });
}

export function markTokenAvailable(mint: string): void {
  enteredMints.delete(mint);
  const t = tokenCache.get(mint);
  if (t) tokenCache.set(mint, { ...t, status: 'ELIGIBLE' });
}

const tradedTodaySet = new Set<string>();

export function setTradedTodayMints(mints: Set<string>): void {
  tradedTodaySet.clear();
  for (const m of mints) tradedTodaySet.add(m);
  // Update cache for any tokens already present
  for (const mint of mints) {
    const t = tokenCache.get(mint);
    if (t) tokenCache.set(mint, { ...t, tradedToday: true });
  }
}
