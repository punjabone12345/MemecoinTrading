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
  const v1hPrev = token.volume1hPrev ?? 1;
  const vRatio = v1hPrev > 0 ? v1h / v1hPrev : 1;
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
  if (mc >= 500_000 && mc < 5_000_000) mcQuality = 25;
  else if (mc >= 5_000_000 && mc < 20_000_000) mcQuality = 15;
  else if (mc >= 20_000_000 && mc < 100_000_000) mcQuality = 8;

  return {
    priceMomentum,
    volumeMomentum,
    buyPressure,
    mcQuality,
    total: priceMomentum + volumeMomentum + buyPressure + mcQuality,
  };
}

const ALLOWED_DEXES = ['raydium', 'pump-fun', 'pumpfun', 'pumpswap', 'orca', 'meteora'];

function buildFilterResults(pair: DexPair, settings: Awaited<ReturnType<typeof getSettings>>, rugOk: boolean): FilterResult[] {
  const mc = pair.marketCap ?? pair.fdv ?? 0;
  const vol24 = pair.volume?.h24 ?? 0;
  const liq = pair.liquidity?.usd ?? 0;
  const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const h1Txns = pair.txns?.h1 ?? { buys: 0, sells: 0 };
  const bsr = h1Txns.sells > 0 ? h1Txns.buys / h1Txns.sells : h1Txns.buys > 0 ? 99 : 1;
  const change5m = pair.priceChange?.m5 ?? 0;
  const change24 = pair.priceChange?.h24 ?? 0;
  const dexOk = ALLOWED_DEXES.includes(pair.dexId?.toLowerCase() ?? '');

  return [
    { name: 'Market Cap ≥$500K', passed: mc >= settings.minMc, value: `$${(mc/1000).toFixed(0)}K`, required: `≥$${(settings.minMc/1000).toFixed(0)}K` },
    { name: 'Market Cap ≤$7M', passed: mc <= settings.maxMc, value: `$${(mc/1_000_000).toFixed(2)}M`, required: `≤$${(settings.maxMc/1_000_000).toFixed(0)}M` },
    { name: '24h Volume ≥$100K', passed: vol24 >= settings.minVolume24h, value: `$${(vol24/1000).toFixed(0)}K`, required: `≥$${(settings.minVolume24h/1000).toFixed(0)}K` },
    { name: 'Age in range', passed: ageH >= settings.minAgeHours && ageH <= settings.maxAgeHours, value: `${ageH.toFixed(1)}h`, required: `${settings.minAgeHours}h–${settings.maxAgeHours}h` },
    { name: 'Liquidity ≥$50K', passed: liq >= settings.minLiquidity, value: `$${(liq/1000).toFixed(0)}K`, required: `≥$${(settings.minLiquidity/1000).toFixed(0)}K` },
    { name: 'Buy/Sell ≥1.2x', passed: bsr >= settings.minBuySellRatio, value: `${bsr.toFixed(2)}x`, required: `≥${settings.minBuySellRatio}x` },
    { name: 'No 5m FOMO >50%', passed: change5m <= 50, value: `${change5m.toFixed(1)}%`, required: '≤50% in 5m' },
    { name: 'Not pumped >500%', passed: change24 <= 500, value: `${change24.toFixed(0)}%`, required: '≤500% in 24h' },
    { name: 'Rugcheck pass', passed: rugOk || !settings.rugcheckEnabled, value: rugOk ? 'PASS' : 'FAIL', required: 'PASS' },
    { name: 'DEX supported', passed: dexOk, value: pair.dexId ?? 'unknown', required: 'Raydium/Pump/Orca' },
  ];
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
    // Keyword list: broad terms to surface meme coins across all popular niches.
    // Each search returns up to 30 Solana pairs — 20 terms × 30 = up to 600 extra pairs.
    const SEARCH_TERMS = [
      'raydium', 'pump', 'pumpswap', 'orca', 'meteora',
      'solana meme', 'meme sol', 'cat sol', 'dog sol', 'pepe sol',
      'ai sol', 'bonk', 'wif', 'trump sol', 'frog sol',
      'moon sol', 'bull sol', 'sol token', 'based sol', 'degen sol',
    ];

    const [profileRes, boostRes, geckoMints, searchResults] = await Promise.all([
      // 1. DexScreener: latest token profiles (boosted/trending)
      axios.get<Array<{ tokenAddress: string; chainId: string }>>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 10000 }
      ).catch(() => ({ data: [] as Array<{ tokenAddress: string; chainId: string }> })),

      // 2. DexScreener: top boosted tokens
      axios.get<Array<{ tokenAddress: string; chainId: string }>>(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`,
        { timeout: 10000 }
      ).catch(() => ({ data: [] as Array<{ tokenAddress: string; chainId: string }> })),

      // 3. GeckoTerminal: 5-page trending + 5-page top-volume + 3-page new_pools
      fetchGeckoMints(),

      // 4. DexScreener keyword searches — 20 diverse terms
      Promise.all(
        SEARCH_TERMS.map((term) =>
          axios.get<{ pairs: DexPair[] }>(
            `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(term)}`,
            { timeout: 10000 }
          ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
        )
      ),
    ]);

    // Collect all mint addresses to batch-lookup on DexScreener
    const extraMints = new Set<string>([...geckoMints]);

    if (Array.isArray(profileRes.data)) {
      profileRes.data.filter((t) => t.chainId === 'solana').forEach((t) => extraMints.add(t.tokenAddress));
    }
    if (Array.isArray(boostRes.data)) {
      boostRes.data.filter((t) => t.chainId === 'solana').forEach((t) => extraMints.add(t.tokenAddress));
    }

    // Add keyword search results directly (they already have full pair data)
    for (const res of searchResults) {
      if (res.data?.pairs) allPairs.push(...res.data.pairs.filter((p) => p.chainId === 'solana'));
    }

    // Batch-lookup all remaining mints on DexScreener (30 per request, no cap).
    // Previously this was sliced to 150 — now we process all collected mints.
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
    if (mc < settings.minMc) preReject = `MC too low ($${(mc/1000).toFixed(0)}K < $${(settings.minMc/1000).toFixed(0)}K min)`;
    else if (mc > settings.maxMc) preReject = `MC too high ($${(mc/1e6).toFixed(1)}M > $${(settings.maxMc/1e6).toFixed(1)}M max)`;
    else if (vol24 < settings.minVolume24h) preReject = `Vol24h too low ($${(vol24/1000).toFixed(0)}K < $${(settings.minVolume24h/1000).toFixed(0)}K min)`;
    else if (ageH > settings.maxAgeHours) preReject = `Age ${ageH.toFixed(1)}h > ${settings.maxAgeHours}h max`;
    else if (change24 > 500) preReject = `Already pumped ${change24.toFixed(0)}% in 24h (>500% blocks entry)`;

    const existing = tokenCache.get(mint);

    if (preReject) {
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
    const v1hPrev = existing?.volume1hPrev ?? v1h * 0.8;

    const partial: Partial<Token> = {
      priceChange5m: change5m,
      volume1hCurrent: v1h,
      volume1hPrev: v1hPrev,
      buySellRatio: bsr,
      marketCap: mc,
    };
    const scoreBreakdown = calcScore(partial);
    const filterResults = buildFilterResults(pair, settings, rugOk);
    const allPassed = filterResults.every((f) => f.passed);

    if (allPassed) passedFilters++;

    const rejectReason = !allPassed ? filterResults.find((f) => !f.passed)?.name : undefined;

    const prevConsecutive = existing?.consecutiveTrending ?? 0;
    const isUp = change5m > 0 && (scoreBreakdown.total >= (existing?.score ?? 0));
    const consecutive = isUp ? prevConsecutive + 1 : 0;

    const status: Token['status'] = enteredMints.has(mint)
      ? 'ENTERED'
      : allPassed && scoreBreakdown.total >= settings.minEntryScore
      ? 'ELIGIBLE'
      : !allPassed
      ? 'REJECTED'
      : 'SCANNING';

    // Audit log every token decision
    if (status === 'ELIGIBLE') {
      logger.info(
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, threshold: settings.minEntryScore, breakdown: scoreBreakdown },
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
