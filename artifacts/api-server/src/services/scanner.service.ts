import axios from 'axios';
import { logger } from '../lib/logger.js';
import { Token, FilterResult, ScoreBreakdown } from '../types/index.js';
import { getSettings } from './settings.service.js';
import { checkRugcheck } from './rugcheck.service.js';
import { getMintSources, addMintSource, getPumpfunMints } from './trenches.service.js';
import { getMeteoraMintsCount, getMeteoraMintsSet } from './helius-ws.service.js';

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

// Mints with open positions — never re-marked eligible
const enteredMints = new Set<string>();

// Permanent age blacklist — these never get younger, skip forever
const ageBannedMints = new Set<string>();

// ── Fresh mint queue ──────────────────────────────────────────────────────────
// Fed by two discovery methods:
//   1. Helius WS → Meteora DLMM/DAMM pool creation
//   2. PumpFun migration wallet polling
// Each scan cycle batch-looks them up on DexScreener and applies filters.
const freshMintQueue = new Set<string>();

export function addToFreshMintQueue(mint: string): void {
  if (!ageBannedMints.has(mint) && mint.length > 20) {
    freshMintQueue.add(mint);
  }
}

// ── Liquidity stability tracking ──────────────────────────────────────────────
const liquidityHistory = new Map<string, Array<{ ts: number; liq: number }>>();

function recordLiquidityPoint(mint: string, liq: number): void {
  if (liq <= 0) return;
  const now = Date.now();
  const PRUNE_MS = 10 * 60_000;
  const history = liquidityHistory.get(mint) ?? [];
  history.push({ ts: now, liq });
  liquidityHistory.set(mint, history.filter((h) => h.ts >= now - PRUNE_MS));
}

function checkLiquidityStability(mint: string, currentLiq: number): { stable: boolean; dropPct: number } {
  const WINDOW_MS   = 5 * 60_000;
  const MIN_SPAN_MS = 30_000;
  const DROP_LIMIT  = 15;

  const history = liquidityHistory.get(mint);
  if (!history || history.length < 2) return { stable: true, dropPct: 0 };

  const now = Date.now();
  const inWindow = history.filter((h) => h.ts >= now - WINDOW_MS);
  if (inWindow.length < 2) return { stable: true, dropPct: 0 };

  const oldest = inWindow[0];
  if (now - oldest.ts < MIN_SPAN_MS) return { stable: true, dropPct: 0 };

  const refLiq = Math.max(...inWindow.map((h) => h.liq));
  if (refLiq <= 0) return { stable: true, dropPct: 0 };

  const dropPct = ((refLiq - currentLiq) / refLiq) * 100;
  return { stable: dropPct <= DROP_LIMIT, dropPct: Math.max(0, dropPct) };
}

// ── Scan stats ─────────────────────────────────────────────────────────────────
let scanCount = 0;
let passedFilters = 0;
let eligibleCount = 0;
const rejectionCounts = new Map<string, number>();
function bumpReject(reason: string) { rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1); }

let dailyLossLimitHit = false;
let dailyPnlSnapshot = 0;
let dailyLossLimitSnapshot = 0;

export function setDailyLossStatus(hit: boolean, pnl: number, limit: number): void {
  dailyLossLimitHit = hit;
  dailyPnlSnapshot = pnl;
  dailyLossLimitSnapshot = limit;
}

export function getScanStats() {
  const liveEligible = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE').length;
  return {
    scanning: scanCount,
    passed: passedFilters,
    eligible: liveEligible,
    dailyLossLimitHit,
    dailyPnl: dailyPnlSnapshot,
    dailyLossLimit: dailyLossLimitSnapshot,
    ageBanned: ageBannedMints.size,
    freshQueueSize: freshMintQueue.size,
    pumpPortalConnected: true, // Polling is always active (wallet tracker runs every 5s)
    pumpfunPolling: true,
    rejectionCounts: Object.fromEntries(
      [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1])
    ),
    // Discovery method counts
    meteoraCount: getMeteoraMintsCount(),
    pumpfunCount: getPumpfunMints().size,
    trenchesCount: 0, // removed — replaced by meteoraCount
  };
}

export function getAllTokens(): Token[] {
  return Array.from(tokenCache.values()).sort((a, b) => b.score - a.score);
}

export function getTokenByMint(mint: string): Token | undefined {
  return tokenCache.get(mint);
}

// ── Scoring ────────────────────────────────────────────────────────────────────
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
  if (mcRange && mcRange.maxMc > mcRange.minMc && mc >= mcRange.minMc && mc <= mcRange.maxMc) {
    const span = mcRange.maxMc - mcRange.minMc;
    const pos = (mc - mcRange.minMc) / span;
    if (pos < 0.25) mcQuality = 25;
    else if (pos < 0.50) mcQuality = 18;
    else if (pos < 0.75) mcQuality = 12;
    else mcQuality = 6;
  } else {
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
  const liq = freshLiq !== undefined ? freshLiq : (pair.liquidity?.usd ?? 0);
  const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 0;
  const bsr = aggBsr;
  const change5m = freshChange5m;
  const change24 = pair.priceChange?.h24 ?? 0;
  const dexOk = ALLOWED_DEXES.includes(pair.dexId?.toLowerCase() ?? '');

  const effectiveMinScore = getAgeAdjustedMinScore(ageH, settings.minEntryScore);
  const ageScoreOk = qualityScore >= effectiveMinScore;
  const ageMin = ageH * 60;
  const ageBucket = ageMin < 30 ? '0–30m' : ageMin < 60 ? '30–60m' : '≥1h';

  const liqStable = liqStability?.stable ?? true;
  const liqDropPct = liqStability?.dropPct ?? 0;
  const liqStabilityLabel = liqDropPct > 0 ? `-${liqDropPct.toFixed(1)}%` : 'stable';

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
    { name: 'DEX supported', passed: dexOk, value: pair.dexId ?? 'unknown', required: 'Raydium/Pump/Orca/Meteora' },
    { name: `Top holder ≤${settings.maxTopHolder}%`, passed: topHolder === 0 || topHolder <= settings.maxTopHolder, value: `${topHolder.toFixed(1)}%`, required: `≤${settings.maxTopHolder}%` },
    { name: `Creator ≤${settings.maxCreatorPct}%`, passed: creatorPct === 0 || creatorPct <= settings.maxCreatorPct, value: `${creatorPct.toFixed(1)}%`, required: `≤${settings.maxCreatorPct}%` },
    { name: 'Liq stable (<15% drop/5m)', passed: liqStable, value: liqStabilityLabel, required: '<15% drop in 5m' },
    { name: `Score ≥${effectiveMinScore} (${ageBucket})`, passed: ageScoreOk, value: `score ${qualityScore}`, required: `≥${effectiveMinScore}` },
  ];
}

// DEX quality ranking — tiebreaker only after liquidity
const DEX_RANK: Record<string, number> = { raydium: 100, orca: 80, meteora: 70, pumpswap: 60, 'pump-fun': 50, pumpfun: 50 };

// ── DexScreener lookup from freshMintQueue ────────────────────────────────────
// Only processes mints fed by the two discovery methods:
//   1. Helius WS → Meteora DLMM/DAMM (via addToFreshMintQueue)
//   2. PumpFun migration wallet polling (via addToFreshMintQueue)
async function fetchDexPairs(): Promise<DexPair[]> {
  // Re-enqueue all discovered mints on every cycle so they stay in the queue
  // even after a first-pass pruning. PumpFun and Meteora both get the same treatment.
  for (const mint of getPumpfunMints()) {
    if (!ageBannedMints.has(mint)) freshMintQueue.add(mint);
  }
  for (const mint of getMeteoraMintsSet()) {
    if (!ageBannedMints.has(mint)) freshMintQueue.add(mint);
  }

  if (freshMintQueue.size === 0) return [];

  const mintList = Array.from(freshMintQueue)
    .filter((m) => !ageBannedMints.has(m))
    .slice(0, 300); // cap per cycle to keep DexScreener calls fast

  if (mintList.length === 0) return [];

  const allPairs: DexPair[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < mintList.length; i += 30) chunks.push(mintList.slice(i, i + 30));

  const CONCURRENCY = 8;
  const CHUNK_DELAY_MS = 100;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((chunk) =>
        axios.get<{ pairs: DexPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/tokens/${chunk.join(',')}`,
          { timeout: 12000 },
        ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
      )
    );
    for (const r of results) {
      if (r.data?.pairs) allPairs.push(...r.data.pairs.filter((p) => p.chainId === 'solana'));
    }
    if (i + CONCURRENCY < chunks.length) {
      await new Promise((res) => setTimeout(res, CHUNK_DELAY_MS));
    }
  }

  logger.info(
    { queued: freshMintQueue.size, processed: mintList.length, pairs: allPairs.length },
    'Queue scan: DexScreener lookup complete',
  );

  const seen = new Set<string>();
  return allPairs.filter((p) => {
    if (!p.pairAddress || seen.has(p.pairAddress)) return false;
    seen.add(p.pairAddress);
    return true;
  });
}

// ── Main scan loop ────────────────────────────────────────────────────────────
export async function scanTokens(): Promise<void> {
  const settings = await getSettings();
  const allPairs = await fetchDexPairs();
  passedFilters = 0;
  eligibleCount = 0;
  rejectionCounts.clear();

  // ── Multi-pool aggregation ────────────────────────────────────────────────
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
    let best = group[0];
    let bestScore = 0;
    for (const p of group) {
      const liq  = p.liquidity?.usd ?? 0;
      const h1vol = p.volume?.h1 ?? 0;
      const rank  = DEX_RANK[p.dexId?.toLowerCase() ?? ''] ?? 0;
      const s = liq * 100 + h1vol + rank;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    const aggVol24h = group.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    const aggVol1h  = group.reduce((sum, p) => sum + (p.volume?.h1  ?? 0), 0);
    const totalBuys24h  = group.reduce((sum, p) => sum + (p.txns?.h24?.buys  ?? 0), 0);
    const totalSells24h = group.reduce((sum, p) => sum + (p.txns?.h24?.sells ?? 0), 0);
    const aggBsr = totalSells24h > 0 ? totalBuys24h / totalSells24h : totalBuys24h > 0 ? 99 : 1;
    pairs.push({ ...best, aggVol24h, aggVol1h, aggBsr });
  }

  scanCount = pairs.length;

  // ── PASS 1: Pre-filter ────────────────────────────────────────────────────
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

    const isGraduating = vol24 < 500 && change5m > 200 && change24 > 200
      && Math.abs(change5m - change24) < Math.abs(change24) * 0.05;

    let preReject: string | undefined;
    let preRejectKey: string | undefined;
    let permanentBan = false;
    if      (isGraduating)                  { preReject = `Graduating — migration in progress, data unreliable`;                                               preRejectKey = 'Graduating (no real data)'; }
    else if (mc < settings.minMc)           { preReject = `MC too low ($${(mc/1000).toFixed(0)}K < $${(settings.minMc/1000).toFixed(0)}K min)`;               preRejectKey = 'MC too low'; }
    else if (mc > settings.maxMc)           { preReject = `MC too high ($${(mc/1e6).toFixed(1)}M > $${(settings.maxMc/1e6).toFixed(1)}M max)`;                preRejectKey = 'MC too high'; }
    else if (vol24 < settings.minVolume24h) { preReject = `Vol24h too low ($${(vol24/1000).toFixed(0)}K < $${(settings.minVolume24h/1000).toFixed(0)}K min)`;  preRejectKey = 'Vol24h too low'; }
    else if (ageH > settings.maxAgeHours)   { preReject = `Age ${ageH.toFixed(1)}h > ${settings.maxAgeHours}h max`;                                            preRejectKey = 'Age too old'; permanentBan = true; }
    else if (change24 > 500)                { preReject = `Already pumped ${change24.toFixed(0)}% in 24h (>500% blocks entry)`;                                preRejectKey = 'Already pumped >500%'; }

    const existing = tokenCache.get(mint);

    if (preReject) {
      if (preRejectKey) bumpReject(preRejectKey);
      if (enteredMints.has(mint)) continue;

      if (permanentBan) {
        ageBannedMints.add(mint);
        freshMintQueue.delete(mint);
        tokenCache.delete(mint);
        liquidityHistory.delete(mint);
        continue;
      }

      const preV1hPrev = existing?.volume1hCurrent ?? 0;
      const prePartial: Partial<Token> = {
        priceChange5m: change5m, volume1hCurrent: v1h, volume1hPrev: preV1hPrev,
        volume24h: vol24, buySellRatio: bsr, marketCap: mc,
      };
      const preScore = calcScore(prePartial, { minMc: settings.minMc, maxMc: settings.maxMc });
      addMintSource(mint, 'bot');
      tokenCache.set(mint, {
        mint, name: pair.baseToken.name || 'Unknown', symbol: pair.baseToken.symbol || '???',
        score: preScore.total, marketCap: mc, volume24h: vol24, priceChange1h: change1h,
        priceChange5m: change5m, priceChange24h: change24, buySellRatio: bsr, liquidity: liq,
        age: ageH, dexId: pair.dexId ?? '', pairAddress: pair.pairAddress, price,
        rugcheck: true, freezeAuthority: false, mintAuthority: false,
        topHolder: existing?.topHolder ?? 0, creatorPct: existing?.creatorPct ?? 0,
        status: 'REJECTED', rejectReason: preReject, scoreBreakdown: preScore,
        filterResults: buildFilterResults(pair, settings, existing?.rugcheck ?? true, existing?.topHolder ?? 0, existing?.creatorPct ?? 0, preScore.total, vol24, bsr, change5m, liq > 0 ? liq : undefined, undefined),
        consecutiveTrending: 0, volume1hPrev: preV1hPrev, volume1hCurrent: v1h, lastChecked: Date.now(),
        sources: getMintSources(mint),
      });
      continue;
    }

    candidates.push({ pair, mc, vol24, bsr, v1h, liq, ageH, change24, change1h, change5m, price });
  }

  // ── PASS 2: Fresh per-pair data for candidates ─────────────────────────────
  const freshPairMap = new Map<string, DexPair>();
  if (candidates.length > 0) {
    const pairAddrs = candidates.map((c) => c.pair.pairAddress).filter(Boolean) as string[];
    const freshChunks: string[][] = [];
    for (let i = 0; i < pairAddrs.length; i += 30) freshChunks.push(pairAddrs.slice(i, i + 30));

    const freshResults = await Promise.all(
      freshChunks.map((chunk) =>
        axios.get<{ pairs: DexPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${chunk.join(',')}`,
          { timeout: 8000 },
        ).catch(() => ({ data: { pairs: [] as DexPair[] } }))
      )
    );
    for (const res of freshResults) {
      for (const p of res.data?.pairs ?? []) {
        if (p.pairAddress) freshPairMap.set(p.pairAddress, p);
      }
    }
    logger.info({ candidates: candidates.length, freshFetched: freshPairMap.size }, 'Fresh pair data fetched');
  }

  // ── PASS 2 continued: full filter with real-time data ─────────────────────
  for (const { pair, mc, vol24, bsr, v1h, liq, ageH, change24, change1h, change5m: bulkChange5m, price } of candidates) {
    const mint = pair.baseToken?.address;
    if (!mint) continue;

    const fresh = freshPairMap.get(pair.pairAddress ?? '');
    const change5m   = fresh?.priceChange?.m5  ?? bulkChange5m;
    const freshChange1h = fresh?.priceChange?.h1 ?? change1h;
    const freshPrice = fresh ? parseFloat(fresh.priceUsd ?? '0') || price : price;
    const freshLiq   = (fresh?.liquidity?.usd !== undefined && fresh.liquidity.usd > 0)
      ? fresh.liquidity.usd : liq > 0 ? liq : (fresh?.liquidity?.usd ?? 0);
    const freshV1h   = (fresh?.volume?.h1 !== undefined && fresh.volume.h1 > 0)
      ? fresh.volume.h1 : v1h;

    const existing = tokenCache.get(mint);

    let rugOk = true;
    let topHolder = existing?.topHolder ?? 0;
    let creatorPct = existing?.creatorPct ?? 0;
    if (settings.rugcheckEnabled) {
      if (existing && Date.now() - existing.lastChecked < 5 * 60_000) {
        rugOk = existing.rugcheck;
        topHolder = existing.topHolder > 0 ? existing.topHolder : topHolder;
        creatorPct = existing.creatorPct > 0 ? existing.creatorPct : creatorPct;
      } else {
        const rugResult = await checkRugcheck(mint, settings.maxCreatorPct).catch(() => ({ ok: true, topHolder: 0, creatorPct: 0 }));
        rugOk = rugResult.ok;
        if (rugResult.topHolder > 0) topHolder = rugResult.topHolder;
        if (rugResult.creatorPct > 0) creatorPct = rugResult.creatorPct;
      }
    }

    const v1hPrev = (existing && existing.volume1hCurrent > 0)
      ? existing.volume1hCurrent : freshV1h * 0.8;

    const partial: Partial<Token> = {
      priceChange5m: change5m, volume1hCurrent: freshV1h, volume1hPrev: v1hPrev,
      volume24h: vol24, buySellRatio: bsr, marketCap: mc,
    };
    const scoreBreakdown = calcScore(partial, { minMc: settings.minMc, maxMc: settings.maxMc });

    recordLiquidityPoint(mint, freshLiq);
    const liqStability = checkLiquidityStability(mint, freshLiq);
    if (!liqStability.stable) {
      logger.info({ mint, symbol: pair.baseToken.symbol, dropPct: liqStability.dropPct.toFixed(1) }, 'LIQ DRAIN: liquidity dropped >15% in 5m — blocking entry');
    }

    const filterResults = buildFilterResults(fresh ?? pair, settings, rugOk, topHolder, creatorPct, scoreBreakdown.total, vol24, bsr, change5m, freshLiq, liqStability);
    const allPassed = filterResults.every((f) => f.passed);
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
        { mint, symbol: pair.baseToken.symbol, score: scoreBreakdown.total, effectiveMinScore, ageH: ageH.toFixed(2), consecutive },
        'AUDIT ACCEPTED: token meets all requirements — status=ELIGIBLE',
      );
      eligibleCount++;
    }

    addMintSource(mint, 'bot');
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
      sources: getMintSources(mint),
    });
  }

  // ── Evict stale tokens ────────────────────────────────────────────────────
  const now = Date.now();
  for (const [mint, token] of tokenCache.entries()) {
    if (token.status === 'ENTERED') continue;
    const ttl = token.status === 'REJECTED' ? 3 * 60_000 : 10 * 60_000;
    if (now - token.lastChecked > ttl) {
      tokenCache.delete(mint);
      liquidityHistory.delete(mint);
    }
  }

  eligibleCount = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE').length;
  passedFilters = Array.from(tokenCache.values()).filter((t) => t.status === 'ELIGIBLE' || t.status === 'SCANNING').length;

  // Prune freshMintQueue: remove evaluated or age-banned mints
  for (const mint of freshMintQueue) {
    if (tokenCache.has(mint) || ageBannedMints.has(mint)) freshMintQueue.delete(mint);
  }
  if (freshMintQueue.size > 2000) {
    const overflow = Array.from(freshMintQueue).slice(0, freshMintQueue.size - 2000);
    for (const m of overflow) freshMintQueue.delete(m);
  }

  const topRejects = [...rejectionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  logger.info({ scanCount, passedFilters, eligibleCount, ageBanned: ageBannedMints.size, freshQueue: freshMintQueue.size, topRejects }, 'Scan complete');
}

// ── HOT REFRESH ───────────────────────────────────────────────────────────────
let hotRefreshCursor = 0;
export async function hotRefreshScanningTokens(): Promise<boolean> {
  const settings = await getSettings().catch(() => null);
  if (!settings) return false;

  const now = Date.now();
  const STALE_MS = 8_000;

  const scanningTargets: { mint: string; pairAddress: string; token: Token }[] = [];
  const rejectedPool:    { mint: string; pairAddress: string; token: Token }[] = [];

  for (const [mint, token] of tokenCache.entries()) {
    if (token.status === 'ENTERED' || token.status === 'ELIGIBLE') continue;
    if (!token.pairAddress) continue;
    if (ageBannedMints.has(mint)) { tokenCache.delete(mint); liquidityHistory.delete(mint); continue; }
    if ((now - token.lastChecked) < STALE_MS) continue;
    if (token.status === 'SCANNING') {
      scanningTargets.push({ mint, pairAddress: token.pairAddress, token });
    } else {
      rejectedPool.push({ mint, pairAddress: token.pairAddress, token });
    }
  }

  const BATCHES = 3;
  const batchSize = Math.ceil(rejectedPool.length / BATCHES);
  const batchStart = (hotRefreshCursor % BATCHES) * batchSize;
  hotRefreshCursor++;
  const rejectedBatch = rejectedPool.slice(batchStart, batchStart + batchSize);

  const targets = [...scanningTargets, ...rejectedBatch];
  if (targets.length === 0) return false;

  const pairAddrs = targets.map((t) => t.pairAddress);
  const chunks: string[][] = [];
  for (let i = 0; i < pairAddrs.length; i += 30) chunks.push(pairAddrs.slice(i, i + 30));

  const freshMap = new Map<string, DexPair>();
  const results = await Promise.all(
    chunks.map((chunk) =>
      axios.get<{ pairs: DexPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${chunk.join(',')}`,
        { timeout: 6000 },
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
    if (!fresh) continue;

    const change5m  = fresh.priceChange?.m5  ?? token.priceChange5m;
    const change1h  = fresh.priceChange?.h1  ?? token.priceChange1h;
    const change24  = fresh.priceChange?.h24 ?? token.priceChange24h;
    const mc        = fresh.marketCap ?? fresh.fdv ?? token.marketCap;
    const liq       = (fresh.liquidity?.usd !== undefined && fresh.liquidity.usd > 0)
      ? fresh.liquidity.usd : token.liquidity;
    const price     = parseFloat(fresh.priceUsd ?? '0') || token.price;
    const vol24     = token.volume24h;
    const bsr       = token.buySellRatio;
    const v1h       = (fresh.volume?.h1 !== undefined && fresh.volume.h1 > 0)
      ? fresh.volume.h1 : token.volume1hCurrent;
    const v1hPrev   = token.volume1hPrev > 0 ? token.volume1hPrev : v1h * 0.8;
    const ageH      = fresh.pairCreatedAt ? (now - fresh.pairCreatedAt) / 3_600_000 : token.age;

    if (ageH > settings.maxAgeHours) {
      ageBannedMints.add(mint);
      freshMintQueue.delete(mint);
      tokenCache.delete(mint);
      liquidityHistory.delete(mint);
      continue;
    }
    if (mc < settings.minMc || mc > settings.maxMc || vol24 < settings.minVolume24h || change24 > 500) {
      tokenCache.set(mint, {
        ...token,
        marketCap: mc, price, liquidity: liq, age: ageH,
        priceChange5m: change5m, priceChange1h: change1h, priceChange24h: change24, lastChecked: now,
      });
      continue;
    }

    const partial: Partial<Token> = {
      priceChange5m: change5m, volume1hCurrent: v1h, volume1hPrev: v1hPrev,
      volume24h: vol24, buySellRatio: bsr, marketCap: mc,
    };
    const scoreBreakdown = calcScore(partial, { minMc: settings.minMc, maxMc: settings.maxMc });
    recordLiquidityPoint(mint, liq);
    const liqStability = checkLiquidityStability(mint, liq);
    if (!liqStability.stable) {
      logger.info({ mint, symbol: token.symbol, dropPct: liqStability.dropPct.toFixed(1), source: 'hot-refresh' }, 'LIQ DRAIN: liquidity dropped >15% in 5m — blocking entry');
    }
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
      : !allPassed ? 'REJECTED' : 'SCANNING';

    if (newStatus !== token.status) {
      anyChanged = true;
      if (newStatus === 'ELIGIBLE') {
        logger.info({ mint, symbol: token.symbol, score: scoreBreakdown.total, change5m, source: 'hot-refresh' }, 'HOT REFRESH → ELIGIBLE');
      }
    }

    tokenCache.set(mint, {
      ...token,
      marketCap: mc, liquidity: liq, price,
      priceChange5m: change5m, priceChange1h: change1h, priceChange24h: change24,
      age: ageH, score: scoreBreakdown.total, scoreBreakdown, filterResults,
      consecutiveTrending: consecutive, status: newStatus, rejectReason,
      volume1hCurrent: v1h, volume1hPrev: v1hPrev, lastChecked: now,
    });
  }

  if (targets.length > 0) {
    logger.debug({ targets: targets.length, freshFetched: freshMap.size, anyChanged }, 'Hot refresh complete');
  }
  return anyChanged;
}

export async function reEvaluateCachedTokens(): Promise<void> {
  const settings = await getSettings();
  const now = Date.now();

  for (const [mint, token] of tokenCache.entries()) {
    if (enteredMints.has(mint)) continue;
    if (token.age > settings.maxAgeHours) {
      ageBannedMints.add(mint);
      freshMintQueue.delete(mint);
      tokenCache.delete(mint);
      continue;
    }

    const scoreBreakdown = calcScore(token, { minMc: settings.minMc, maxMc: settings.maxMc });
    const fakePair: DexPair = {
      chainId: 'solana', dexId: token.dexId, pairAddress: token.pairAddress,
      baseToken: { address: mint, name: token.name, symbol: token.symbol },
      quoteToken: { symbol: 'SOL' },
      priceUsd: String(token.price), marketCap: token.marketCap, fdv: token.marketCap,
      liquidity: { usd: token.liquidity },
      priceChange: { m5: token.priceChange5m, h1: token.priceChange1h, h24: token.priceChange24h },
      volume: { h1: token.volume1hCurrent, h24: token.volume24h },
      pairCreatedAt: now - token.age * 3_600_000,
      txns: { h24: { buys: Math.round(token.buySellRatio * 100), sells: 100 } },
    };

    const liqStability = checkLiquidityStability(mint, token.liquidity);
    const filterResults = buildFilterResults(
      fakePair, settings, token.rugcheck, token.topHolder, token.creatorPct,
      scoreBreakdown.total, token.volume24h, token.buySellRatio, token.priceChange5m,
      token.liquidity, liqStability,
    );

    const allPassed = filterResults.every((f) => f.passed);
    const rejectReason = !allPassed ? filterResults.find((f) => !f.passed)?.name : undefined;
    const effectiveMinScore = getAgeAdjustedMinScore(token.age, settings.minEntryScore);
    const trendOk = settings.trendChecksRequired <= 1 || (token.consecutiveTrending ?? 0) >= settings.trendChecksRequired;

    const newStatus: Token['status'] = allPassed && scoreBreakdown.total >= effectiveMinScore && trendOk
      ? 'ELIGIBLE' : !allPassed ? 'REJECTED' : 'SCANNING';

    tokenCache.set(mint, { ...token, score: scoreBreakdown.total, scoreBreakdown, filterResults, status: newStatus, rejectReason });
  }

  logger.info({ tokenCount: tokenCache.size }, 'Settings changed — re-evaluated all cached tokens');
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
  for (const mint of mints) {
    const t = tokenCache.get(mint);
    if (t) tokenCache.set(mint, { ...t, tradedToday: true });
  }
}
