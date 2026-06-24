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

export function calcScore(token: Partial<Token>): ScoreBreakdown {
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

  let mcQuality = 0;
  const mc = token.marketCap ?? 0;
  if (mc >= 250_000 && mc < 1_000_000) mcQuality = 25;
  else if (mc >= 100_000 && mc < 250_000) mcQuality = 18;
  else if (mc >= 1_000_000 && mc < 5_000_000) mcQuality = 15;
  else if (mc >= 5_000_000 && mc < 20_000_000) mcQuality = 8;

  return {
    priceMomentum,
    volumeMomentum,
    buyPressure,
    mcQuality,
    total: priceMomentum + volumeMomentum + buyPressure + mcQuality,
  };
}

const ALLOWED_DEXES = ['raydium', 'pump-fun', 'pumpfun', 'pumpswap', 'orca', 'meteora'];

function buildFilterResults(pair: DexPair, settings: Awaited<ReturnType<typeof getSettings>>, rugOk: boolean, topHolder: number, creatorPct: number): FilterResult[] {
  const mc = pair.marketCap ?? pair.fdv ?? 0;
  const vol24 = pair.volume?.h24 ?? 0;
  const liq = pair.liquidity?.usd ?? 0;
  const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const h1Txns = pair.txns?.h1 ?? { buys: 0, sells: 0 };
  const bsr = h1Txns.sells > 0 ? h1Txns.buys / h1Txns.sells : h1Txns.buys > 0 ? 99 : 1;
  const change5m = pair.priceChange?.m5 ?? 0;
  const change24 = pair.priceChange?.h24 ?? 0;
  const dexOk = ALLOWED_DEXES.includes(pair.dexId?.toLowerCase() ?? '');

  // Labels dynamically reflect the actual threshold from settings (not hardcoded defaults)
  return [
    { name: `MC ≥$${(settings.minMc/1000).toFixed(0)}K`, passed: mc >= settings.minMc, value: `$${(mc/1000).toFixed(0)}K`, required: `≥$${(settings.minMc/1000).toFixed(0)}K` },
    { name: `MC ≤$${(settings.maxMc/1_000_000).toFixed(1)}M`, passed: mc <= settings.maxMc, value: `$${(mc/1_000_000).toFixed(2)}M`, required: `≤$${(settings.maxMc/1_000_000).toFixed(1)}M` },
    { name: `Vol24h ≥$${(settings.minVolume24h/1000).toFixed(0)}K`, passed: vol24 >= settings.minVolume24h, value: `$${(vol24/1000).toFixed(0)}K`, required: `≥$${(settings.minVolume24h/1000).toFixed(0)}K` },
    { name: `Age ${settings.minAgeHours}h–${settings.maxAgeHours}h`, passed: ageH >= settings.minAgeHours && ageH <= settings.maxAgeHours, value: `${ageH.toFixed(1)}h`, required: `${settings.minAgeHours}h–${settings.maxAgeHours}h` },
    { name: `Liquidity ≥$${(settings.minLiquidity/1000).toFixed(0)}K`, passed: liq >= settings.minLiquidity, value: `$${(liq/1000).toFixed(0)}K`, required: `≥$${(settings.minLiquidity/1000).toFixed(0)}K` },
    { name: `BSR ≥${settings.minBuySellRatio}x`, passed: bsr >= settings.minBuySellRatio, value: `${bsr.toFixed(2)}x`, required: `≥${settings.minBuySellRatio}x` },
    { name: 'No 5m FOMO >50%', passed: change5m <= 50, value: `${change5m.toFixed(1)}%`, required: '≤50% in 5m' },
    { name: 'Not pumped >500%', passed: change24 <= 500, value: `${change24.toFixed(0)}%`, required: '≤500% in 24h' },
    { name: 'Rugcheck pass', passed: rugOk || !settings.rugcheckEnabled, value: rugOk ? 'PASS' : 'FAIL', required: 'PASS' },
    { name: 'DEX supported', passed: dexOk, value: pair.dexId ?? 'unknown', required: 'Raydium/Pump/Orca' },
    // maxTopHolder and maxCreatorPct: only enforce when rugcheck has supplied real data (>0)
    { name: `Top holder ≤${settings.maxTopHolder}%`, passed: topHolder === 0 || topHolder <= settings.maxTopHolder, value: `${topHolder.toFixed(1)}%`, required: `≤${settings.maxTopHolder}%` },
    { name: `Creator ≤${settings.maxCreatorPct}%`, passed: creatorPct === 0 || creatorPct <= settings.maxCreatorPct, value: `${creatorPct.toFixed(1)}%`, required: `≤${settings.maxCreatorPct}%` },
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

    // Batch-lookup all collected mints on DexScreener (30 per request, no cap)
    const mintList = Array.from(extraMints);
    const mintChunks: string[][] = [];
    for (let i = 0; i < mintList.length; i += 30) mintChunks.push(mintList.slice(i, i + 30));

    const mintResults = await Promise.all(
      mintChunks.map((chunk) =>
        axios.get<{ pairs: DexPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`,
          { timeout: 10000 }
        ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
      )
    );
    for (const r of mintResults) {
      if (r.data?.pairs) allPairs.push(...r.data.pairs.filter((p) => p.chainId === 'solana'));
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

// DEX quality ranking: higher = preferred when multiple pools exist for same mint.
// Raydium is the primary graduation target; Orca/Meteora are established AMMs.
const DEX_RANK: Record<string, number> = { raydium: 100, orca: 80, meteora: 70, pumpswap: 50, 'pump-fun': 40, pumpfun: 40 };

export async function scanTokens(): Promise<void> {
  const settings = await getSettings();
  const allPairs = await fetchDexPairs();
  scanCount = allPairs.length;
  passedFilters = 0;
  eligibleCount = 0;
  rejectionCounts.clear(); // reset counters each scan cycle

  // ── Best-pair deduplication ──────────────────────────────────────────────
  // When a token has multiple pools (e.g. Raydium CPMM + old dead Raydium v1),
  // pick the best pair per mint: prefer highest h1 volume, break ties by DEX rank.
  // This prevents stale low-activity pools from overriding live pool data.
  const bestPairMap = new Map<string, DexPair>();
  for (const pair of allPairs) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;
    const h1Vol = pair.volume?.h1 ?? 0;
    const dexRank = DEX_RANK[pair.dexId?.toLowerCase() ?? ''] ?? 0;
    const score = h1Vol + dexRank * 1000; // weight DEX rank heavily as tiebreaker
    const existing = bestPairMap.get(mint);
    if (!existing) { bestPairMap.set(mint, pair); continue; }
    const existH1Vol = existing.volume?.h1 ?? 0;
    const existRank = DEX_RANK[existing.dexId?.toLowerCase() ?? ''] ?? 0;
    const existScore = existH1Vol + existRank * 1000;
    if (score > existScore) bestPairMap.set(mint, pair);
  }
  const pairs = Array.from(bestPairMap.values());

  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;

    const mc = pair.marketCap ?? pair.fdv ?? 0;
    const vol24 = pair.volume?.h24 ?? 0;
    const liq = pair.liquidity?.usd ?? 0;
    const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
    const h1Txns = pair.txns?.h1 ?? { buys: 0, sells: 0 };
    const bsr = h1Txns.sells > 0 ? h1Txns.buys / h1Txns.sells : h1Txns.buys > 0 ? 99 : 1;
    const change24 = pair.priceChange?.h24 ?? 0;
    const change1h = pair.priceChange?.h1 ?? 0;
    const change5m = pair.priceChange?.m5 ?? 0;
    const price = parseFloat(pair.priceUsd ?? '0');

    // Quick pre-filter — still store in cache as REJECTED so UI shows all tokens
    let preReject: string | undefined;
    let preRejectKey: string | undefined;
    if (mc < settings.minMc)       { preReject = `MC too low ($${(mc/1000).toFixed(0)}K < $${(settings.minMc/1000).toFixed(0)}K min)`;          preRejectKey = 'MC too low'; }
    else if (mc > settings.maxMc)  { preReject = `MC too high ($${(mc/1e6).toFixed(1)}M > $${(settings.maxMc/1e6).toFixed(1)}M max)`;            preRejectKey = 'MC too high'; }
    else if (vol24 < settings.minVolume24h) { preReject = `Vol24h too low ($${(vol24/1000).toFixed(0)}K < $${(settings.minVolume24h/1000).toFixed(0)}K min)`; preRejectKey = 'Vol24h too low'; }
    else if (settings.minAgeHours > 0 && ageH < settings.minAgeHours) { preReject = `Too new (${ageH.toFixed(1)}h < ${settings.minAgeHours}h min)`;       preRejectKey = 'Age too new'; }
    else if (ageH > settings.maxAgeHours)   { preReject = `Age ${ageH.toFixed(1)}h > ${settings.maxAgeHours}h max`;                               preRejectKey = 'Age too old'; }
    else if (change24 > 500)                { preReject = `Already pumped ${change24.toFixed(0)}% in 24h (>500% blocks entry)`;                   preRejectKey = 'Already pumped >500%'; }

    const existing = tokenCache.get(mint);

    if (preReject) {
      if (preRejectKey) bumpReject(preRejectKey);
      if (enteredMints.has(mint)) continue; // Never downgrade entered tokens
      tokenCache.set(mint, {
        mint, name: pair.baseToken.name || 'Unknown', symbol: pair.baseToken.symbol || '???',
        score: 0, marketCap: mc, volume24h: vol24, priceChange1h: change1h, priceChange5m: change5m,
        priceChange24h: change24, buySellRatio: bsr, liquidity: liq, age: ageH,
        dexId: pair.dexId ?? '', pairAddress: pair.pairAddress, price,
        rugcheck: true, freezeAuthority: false, mintAuthority: false,
        topHolder: existing?.topHolder ?? 0, creatorPct: existing?.creatorPct ?? 0,
        status: 'REJECTED', rejectReason: preReject, scoreBreakdown: { priceMomentum: 0, volumeMomentum: 0, buyPressure: 0, mcQuality: 0, total: 0 },
        filterResults: [], consecutiveTrending: 0, volume1hPrev: 0, volume1hCurrent: 0, lastChecked: Date.now(),
      });
      continue;
    }

    // Rugcheck (with cache)
    let rugOk = true;
    if (existing && Date.now() - existing.lastChecked < 5 * 60_000) {
      rugOk = existing.rugcheck;
    } else if (settings.rugcheckEnabled) {
      rugOk = await checkRugcheck(mint).catch(() => true);
    }

    const v1h = pair.volume?.h1 ?? 0;
    // Use the ACTUAL h1 volume from the previous scan as the baseline.
    // volume1hCurrent from the last cycle is the true previous-hour volume.
    // Falls back to v1h*0.8 on first sight so new tokens get a mild boost, not 0.
    const v1hPrev = (existing && existing.volume1hCurrent > 0)
      ? existing.volume1hCurrent
      : v1h * 0.8;

    const partial: Partial<Token> = {
      priceChange5m: change5m,
      volume1hCurrent: v1h,
      volume1hPrev: v1hPrev,
      volume24h: vol24,
      buySellRatio: bsr,
      marketCap: mc,
    };
    const topHolder = existing?.topHolder ?? 0;
    const creatorPct = existing?.creatorPct ?? 0;

    const scoreBreakdown = calcScore(partial);
    const filterResults = buildFilterResults(pair, settings, rugOk, topHolder, creatorPct);
    const allPassed = filterResults.every((f) => f.passed);

    if (allPassed) passedFilters++;

    const rejectReason = !allPassed ? filterResults.find((f) => !f.passed)?.name : undefined;
    if (rejectReason) bumpReject(rejectReason);

    const prevConsecutive = existing?.consecutiveTrending ?? 0;
    // Require non-negative 5m change (>= 0 instead of > 0) so a flat candle doesn't
    // reset the trend counter — only actual red candles (decline) should break the streak.
    const isUp = change5m >= 0 && (scoreBreakdown.total >= (existing?.score ?? 0));
    const consecutive = isUp ? prevConsecutive + 1 : 0;

    // trendChecksRequired: token must pass all filters AND maintain positive momentum
    // for N consecutive fetch cycles before becoming ELIGIBLE.
    // Prevents entering on a single spike that immediately reverses.
    const trendOk = settings.trendChecksRequired <= 1 || consecutive >= settings.trendChecksRequired;

    const status: Token['status'] = enteredMints.has(mint)
      ? 'ENTERED'
      : allPassed && scoreBreakdown.total >= settings.minEntryScore && trendOk
      ? 'ELIGIBLE'
      : !allPassed
      ? 'REJECTED'
      : 'SCANNING';

    // Audit log every token decision
    if (status === 'ELIGIBLE') {
      logger.info(
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, threshold: settings.minEntryScore, consecutive, trendRequired: settings.trendChecksRequired, breakdown: scoreBreakdown },
        'AUDIT ACCEPTED: token meets all requirements — status=ELIGIBLE'
      );
      eligibleCount++;
    } else if (status === 'SCANNING') {
      logger.debug(
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, threshold: settings.minEntryScore },
        'AUDIT SCANNING: passed filters but score below threshold'
      );
    } else if (status === 'REJECTED') {
      logger.debug(
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, reason: rejectReason },
        'AUDIT REJECTED: failed filter check'
      );
    }

    const token: Token = {
      mint,
      name: pair.baseToken.name || 'Unknown',
      symbol: pair.baseToken.symbol || '???',
      score: scoreBreakdown.total,
      marketCap: mc,
      volume24h: vol24,
      priceChange1h: change1h,
      priceChange5m: change5m,
      priceChange24h: change24,
      buySellRatio: bsr,
      liquidity: liq,
      age: ageH,
      dexId: pair.dexId ?? '',
      pairAddress: pair.pairAddress,
      price,
      rugcheck: rugOk,
      freezeAuthority: false,
      mintAuthority: false,
      topHolder: existing?.topHolder ?? 0,
      creatorPct: existing?.creatorPct ?? 0,
      status,
      rejectReason,
      tradedToday: tradedTodaySet.has(mint),
      scoreBreakdown,
      filterResults,
      consecutiveTrending: consecutive,
      volume1hPrev: v1hPrev,
      volume1hCurrent: v1h,
      lastChecked: Date.now(),
    };

    tokenCache.set(mint, token);
  }

  // Clean old tokens (not seen in last 30 min, not entered)
  for (const [mint, token] of tokenCache.entries()) {
    if (token.status !== 'ENTERED' && Date.now() - token.lastChecked > 30 * 60_000) {
      tokenCache.delete(mint);
    }
  }

  // Recalculate from full cache so stats match what the UI token list shows
  scanCount = tokenCache.size;
  eligibleCount = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE').length;
  passedFilters = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE' || t.status === 'SCANNING').length;
  logger.info({ scanCount, passedFilters, eligibleCount }, 'Scan complete');
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
