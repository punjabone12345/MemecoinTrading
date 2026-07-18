/**
 * Token Discovery Service — GMGN-first architecture
 *
 * Primary discovery source: GMGN API — three parallel pollers:
 *   • /defi/quotation/v1/rank/sol/swaps/1m  — short-burst new tokens  (every 15 s)
 *   • /defi/quotation/v1/rank/sol/swaps/5m  — 5-min trending          (every 30 s)
 *   • /defi/quotation/v1/rank/sol/swaps/1h  — 1-hour trending         (every 60 s)
 *
 * Each source is labelled so that downstream analytics can compare their
 * performance independently:
 *   discoverySource in DiscoveryEvent → 'rank_1m' | 'rank_5m' | 'rank_1h'
 *   DB column source                  → 'gmgn_rank_1m' | 'gmgn_rank_5m' | 'gmgn_rank_1h'
 *                                       (+ '_refire' suffix for re-appearances)
 *
 * Market data validation: DexScreener (unchanged — handled downstream in sniper engine)
 * Wallet analysis:        GMGN (unchanged — handled in wallet-score.service.ts)
 */

import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import {
  fetchTrendingTokens,
  getDiscoveryBannedUntil,
  type GmgnDiscoveredToken,
} from '../lib/gmgn-discovery.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const RANK_1M_INTERVAL_MS    = 15_000;  // poll rank/1m every 15 s
const RANK_5M_INTERVAL_MS    = 30_000;  // poll rank/5m every 30 s
const RANK_1H_INTERVAL_MS    = 60_000;  // poll rank/1h every 60 s
const NEW_PAIRS_INTERVAL_MS  = RANK_1M_INTERVAL_MS; // alias kept for diagnostics compat
const TRENDING_INTERVAL_MS   = RANK_5M_INTERVAL_MS; // alias kept for diagnostics compat
const BOOT_DELAY_MS          = 5_000;   // let previous instance clear before first request
const MAX_FEED               = 50;
const TRACKING_WINDOW_MS     = 60 * 60_000; // 1 hour default suppression

// Only fire tokens created/opened within the last 2 hours to avoid spamming old pools
const MAX_TOKEN_AGE_MS       = 2 * 60 * 60_000;

// Retry budget: if both endpoints return null, wait this long before retrying
const BACKOFF_BASE_MS        = 15_000;
const BACKOFF_MAX_MS         = 120_000;

// Stable infrastructure mints to ignore
const IGNORE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',    // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // wETH (Wormhole)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
]);

// ── Discovery event ────────────────────────────────────────────────────────────

export type GmgnDiscoverySource = 'rank_1m' | 'rank_5m' | 'rank_1h';

export interface DiscoveryEvent {
  mint:            string;
  poolAddress?:    string;
  ts:              number;
  name?:           string;
  symbol?:         string;
  isMigration:     boolean;
  reserveUsd?:     number;
  discoverySource: GmgnDiscoverySource;
}

// ── In-memory state ───────────────────────────────────────────────────────────

const suppressedUntil = new Map<string, number>();
const discoveryFeed: DiscoveryEvent[] = [];
let totalDiscovered = 0;

// ── Coverage counters ─────────────────────────────────────────────────────────

let totalTokensSeen          = 0;
let totalTokensFired         = 0;
let totalTokensSkippedAge    = 0;
let totalTokensSkippedDupe   = 0;
let totalTokensSkippedIgnore = 0;

// ── Diagnostics ───────────────────────────────────────────────────────────────

let newPairsPollCount           = 0;  // rank/1m
let trendingPollCount           = 0;  // rank/5m
let trending1hPollCount         = 0;  // rank/1h
let lastNewPairsSuccessMs       = 0;
let lastTrendingSuccessMs       = 0;
let lastTrending1hSuccessMs     = 0;
let consecutiveNewPairsFailures  = 0;
let consecutiveTrendingFailures  = 0;
let consecutiveTrending1hFailures = 0;
let lastNewPairsError: string | null   = null;
let lastTrendingError: string | null   = null;
let lastTrending1hError: string | null = null;

// Per-source fired counts for performance comparison
const firedBySource: Record<GmgnDiscoverySource, number> = { rank_1m: 0, rank_5m: 0, rank_1h: 0 };
let sessionStartMs             = 0;

/**
 * Rolling discovery delay tracker:
 * "Discovery delay" = how long after the token was created/opened
 *  until we first fired the graduation callback.
 *  Tracked as a rolling window of the last 200 observations.
 */
const DELAY_WINDOW = 200;
const recentDiscoveryDelaysSec: number[] = [];

function recordDiscoveryDelay(openTimestampSec: number | undefined): void {
  if (!openTimestampSec) return;
  const delaySec = Math.max(0, (Date.now() / 1000) - openTimestampSec);
  recentDiscoveryDelaysSec.push(delaySec);
  if (recentDiscoveryDelaysSec.length > DELAY_WINDOW) recentDiscoveryDelaysSec.shift();
}

function avgDiscoveryDelaySec(): number | null {
  if (recentDiscoveryDelaysSec.length === 0) return null;
  const sum = recentDiscoveryDelaysSec.reduce((a, b) => a + b, 0);
  return Math.round((sum / recentDiscoveryDelaysSec.length) * 10) / 10;
}

// ── Callbacks ─────────────────────────────────────────────────────────────────

let onGraduation: ((ev: { mint: string; poolAddress?: string; ts: number; reserveUsd?: number }) => void) | null = null;

export function setOnGraduation(
  cb: (ev: { mint: string; poolAddress?: string; ts: number; reserveUsd?: number }) => void,
): void {
  onGraduation = cb;
}

// ── Suppression control ───────────────────────────────────────────────────────

/**
 * Shorten the suppression window for a mint pruned due to a transient failure
 * (DexScreener not indexed yet, liq = 0, validation timeout).
 * Does NOT apply to permanent rejections (rugcheck, holder limits, traded).
 */
export function releaseForRediscovery(mint: string, delayMs: number): void {
  suppressedUntil.set(mint, Date.now() + delayMs);
  logger.debug(
    { mint: mint.slice(0, 12), retryInSec: Math.round(delayMs / 1_000) },
    'GMGN discovery: released for re-discovery (transient failure)',
  );
}

// ── Public feed accessors ─────────────────────────────────────────────────────

export function getDiscoveryFeed(): DiscoveryEvent[] {
  return discoveryFeed.slice(0, MAX_FEED);
}

export function getDiscoveryTotal(): number {
  return totalDiscovered;
}

export function getSourceActivity() {
  return {
    gmgn: {
      total:  totalDiscovered,
      recent: discoveryFeed.slice(0, 20),
    },
  };
}

// ── Core token processor (shared by both polls) ───────────────────────────────

/**
 * Process a list of tokens returned by a GMGN endpoint.
 * Applies age filter, suppression, dedup, then fires onGraduation.
 * Returns the number of new tokens fired.
 */
function processTokens(tokens: GmgnDiscoveredToken[], source: GmgnDiscoverySource): number {
  const now = Date.now();
  let fired = 0;

  for (const tok of tokens) {
    const { mint, poolAddress, name, symbol, openTimestamp, liquidity } = tok;

    if (!mint || mint.length < 20) {
      totalTokensSkippedIgnore++;
      continue;
    }
    if (IGNORE_MINTS.has(mint)) {
      totalTokensSkippedIgnore++;
      continue;
    }

    totalTokensSeen++;

    // Age filter — only fire tokens opened within the last 2 hours
    if (openTimestamp) {
      const ageMs = now - openTimestamp * 1000;
      if (ageMs > MAX_TOKEN_AGE_MS) {
        totalTokensSkippedAge++;
        continue;
      }
    }

    // Suppression check
    const suppressExpiry = suppressedUntil.get(mint);
    if (suppressExpiry !== undefined && now < suppressExpiry) {
      totalTokensSkippedDupe++;
      continue;
    }

    const isReFire = suppressExpiry !== undefined;
    const isNew    = suppressExpiry === undefined;

    // Set or refresh suppression window
    suppressedUntil.set(mint, now + TRACKING_WINDOW_MS);

    if (isNew) {
      totalDiscovered++;
      firedBySource[source]++;
      recordDiscoveryDelay(openTimestamp);
    }

    // Use GMGN-provided liquidity as proxy for initial reserve
    const reserveUsd = liquidity;

    const ev: DiscoveryEvent = {
      mint,
      poolAddress,
      ts:              now,
      name,
      symbol,
      isMigration:     isReFire,
      reserveUsd,
      discoverySource: source,
    };

    discoveryFeed.unshift(ev);
    if (discoveryFeed.length > MAX_FEED) discoveryFeed.pop();

    if (onGraduation) {
      onGraduation({ mint, poolAddress, ts: now, reserveUsd });
    }

    totalTokensFired++;

    // Persist to DB with source label so analytics can slice by discovery window
    const dbSource = isReFire ? `gmgn_${source}_refire` : `gmgn_${source}`;
    query(
      `INSERT INTO detected_migrations
         (source, instruction_type, tx_signature, pool_address, mint, creator_wallet)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_signature) DO NOTHING`,
      [dbSource, 'token_profile', `gmgn_${mint}_${now}`, poolAddress ?? null, mint, null],
    ).catch(() => {});

    if (isReFire) {
      logger.info(
        { mint: mint.slice(0, 16), source },
        'GMGN discovery: token re-appeared after suppression — fresh tracking',
      );
    }

    fired++;
  }

  return fired;
}

// ── rank/1m poller ────────────────────────────────────────────────────────────
// Replaces broken new_pairs endpoint; returns the most recently-active tokens.

async function pollNewPairs(): Promise<void> {
  const bannedUntil = getDiscoveryBannedUntil();
  if (bannedUntil > Date.now()) return;

  const tokens = await fetchTrendingTokens('1m', 100);

  if (tokens === null) {
    consecutiveNewPairsFailures++;
    lastNewPairsError = 'API returned null (rate-limited or error)';
    logger.debug({ failures: consecutiveNewPairsFailures }, 'GMGN discovery: rank/1m fetch failed');
    return;
  }

  const fired = processTokens(tokens, 'rank_1m');
  consecutiveNewPairsFailures = 0;
  lastNewPairsError = null;
  newPairsPollCount++;
  lastNewPairsSuccessMs = Date.now();

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'GMGN discovery: new tokens queued from rank/1m');
  }
}

// ── rank/5m poller ────────────────────────────────────────────────────────────

async function pollTrending(): Promise<void> {
  const bannedUntil = getDiscoveryBannedUntil();
  if (bannedUntil > Date.now()) return;

  const tokens = await fetchTrendingTokens('5m', 100);

  if (tokens === null) {
    consecutiveTrendingFailures++;
    lastTrendingError = 'API returned null (rate-limited or error)';
    logger.debug({ failures: consecutiveTrendingFailures }, 'GMGN discovery: rank/5m fetch failed');
    return;
  }

  const fired = processTokens(tokens, 'rank_5m');
  consecutiveTrendingFailures = 0;
  lastTrendingError = null;
  trendingPollCount++;
  lastTrendingSuccessMs = Date.now();

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'GMGN discovery: new tokens queued from rank/5m');
  }
}

// ── rank/1h poller ────────────────────────────────────────────────────────────
// Longer trending window — surfaces tokens that have sustained activity over an
// hour, complementing the short-burst 1m and 5m signals.

async function pollTrending1h(): Promise<void> {
  const bannedUntil = getDiscoveryBannedUntil();
  if (bannedUntil > Date.now()) return;

  const tokens = await fetchTrendingTokens('1h', 100);

  if (tokens === null) {
    consecutiveTrending1hFailures++;
    lastTrending1hError = 'API returned null (rate-limited or error)';
    logger.debug({ failures: consecutiveTrending1hFailures }, 'GMGN discovery: rank/1h fetch failed');
    return;
  }

  const fired = processTokens(tokens, 'rank_1h');
  consecutiveTrending1hFailures = 0;
  lastTrending1hError = null;
  trending1hPollCount++;
  lastTrending1hSuccessMs = Date.now();

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'GMGN discovery: new tokens queued from rank/1h');
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let started              = false;
let newPairsTimer:   ReturnType<typeof setTimeout> | null = null;
let trendingTimer:   ReturnType<typeof setTimeout> | null = null;
let trending1hTimer: ReturnType<typeof setTimeout> | null = null;

function makeScheduler(
  poll: () => Promise<void>,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
  intervalMs: number,
): () => void {
  function schedule(): void {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!started) return;
    const banned = getDiscoveryBannedUntil();
    const delay  = banned > Date.now() ? (banned - Date.now() + 2_000) : intervalMs;
    timerRef.current = setTimeout(async () => { await poll(); schedule(); }, delay);
  }
  return schedule;
}

// Wrap mutable timer vars in objects so makeScheduler can mutate them by reference
const _np  = { current: null as ReturnType<typeof setTimeout> | null };
const _t5  = { current: null as ReturnType<typeof setTimeout> | null };
const _t1h = { current: null as ReturnType<typeof setTimeout> | null };

const scheduleNewPairs   = makeScheduler(pollNewPairs,    _np,  RANK_1M_INTERVAL_MS);
const scheduleTrending   = makeScheduler(pollTrending,    _t5,  RANK_5M_INTERVAL_MS);
const scheduleTrending1h = makeScheduler(pollTrending1h,  _t1h, RANK_1H_INTERVAL_MS);

export function startTrenchesScanner(): void {
  if (started) return;
  started        = true;
  sessionStartMs = Date.now();

  const gmgnKeySet = !!process.env.GMGN_API_KEY;
  logger.info(
    {
      rank1mIntervalMs:  RANK_1M_INTERVAL_MS,
      rank5mIntervalMs:  RANK_5M_INTERVAL_MS,
      rank1hIntervalMs:  RANK_1H_INTERVAL_MS,
      bootDelayMs:       BOOT_DELAY_MS,
      gmgnApiKeySet:     gmgnKeySet,
    },
    'GMGN discovery: starting (rank/1m + rank/5m + rank/1h pollers)',
  );

  if (!gmgnKeySet) {
    logger.warn('GMGN_API_KEY not set — discovery will attempt unauthenticated requests; rate limits will be stricter');
  }

  // Stagger the three pollers: 5 s, 12.5 s, 20 s after boot
  _np.current = setTimeout(async () => { await pollNewPairs();   scheduleNewPairs();   }, BOOT_DELAY_MS);
  _t5.current = setTimeout(async () => { await pollTrending();   scheduleTrending();   }, BOOT_DELAY_MS + 7_500);
  _t1h.current = setTimeout(async () => { await pollTrending1h(); scheduleTrending1h(); }, BOOT_DELAY_MS + 15_000);
}

export function stopTrenchesScanner(): void {
  if (!started) return;
  started = false;
  if (_np.current)  { clearTimeout(_np.current);  _np.current  = null; }
  if (_t5.current)  { clearTimeout(_t5.current);  _t5.current  = null; }
  if (_t1h.current) { clearTimeout(_t1h.current); _t1h.current = null; }
  logger.info('GMGN discovery: stopped');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export function getTrenchesDiagnostics() {
  const elapsedMs     = sessionStartMs ? Date.now() - sessionStartMs : 0;
  const elapsedHours  = elapsedMs / 3_600_000;
  const tokensPerHour = elapsedHours > 0.05 ? Math.round(totalDiscovered / elapsedHours) : null;

  const nowMs = Date.now();
  let suppressedCount = 0;
  for (const expiry of suppressedUntil.values()) {
    if (nowMs < expiry) suppressedCount++;
  }

  const eligibleSeen  = totalTokensSeen - totalTokensSkippedIgnore - totalTokensSkippedAge;
  const discoveryRate = eligibleSeen > 0
    ? Math.round((totalTokensFired / eligibleSeen) * 100)
    : null;

  const dupeFraction  = eligibleSeen > 0 ? totalTokensSkippedDupe / eligibleSeen : 0;
  const coverageAlert = dupeFraction > 0.8 && totalTokensSeen > 50;

  const bannedUntil   = getDiscoveryBannedUntil();

  // Derive combined "last success" and failure counts from all three pollers
  const lastPollSuccessMs   = Math.max(lastNewPairsSuccessMs, lastTrendingSuccessMs, lastTrending1hSuccessMs);
  const consecutiveFailures = consecutiveNewPairsFailures + consecutiveTrendingFailures + consecutiveTrending1hFailures;
  const lastPollError       = lastNewPairsError ?? lastTrendingError ?? lastTrending1hError ?? null;
  const pollCount           = newPairsPollCount + trendingPollCount + trending1hPollCount;

  return {
    source:               'gmgn_rank_1m_5m_1h',
    sessionStartMs,
    pollCount,
    lastPollSuccessMs,
    lastPollAgoSec:       lastPollSuccessMs ? Math.round((Date.now() - lastPollSuccessMs) / 1_000) : null,
    consecutiveFailures,
    lastPollError,
    pollIntervalMs:       RANK_1M_INTERVAL_MS,

    // Per-poller breakdown (labelled by GMGN window)
    pollers: {
      newPairs: {
        label:               'rank/1m',
        pollCount:           newPairsPollCount,
        lastSuccessMs:       lastNewPairsSuccessMs,
        lastSuccessAgoSec:   lastNewPairsSuccessMs ? Math.round((Date.now() - lastNewPairsSuccessMs) / 1_000) : null,
        consecutiveFailures: consecutiveNewPairsFailures,
        lastError:           lastNewPairsError,
        intervalMs:          RANK_1M_INTERVAL_MS,
        firedTotal:          firedBySource['rank_1m'],
      },
      trending: {
        label:               'rank/5m',
        pollCount:           trendingPollCount,
        lastSuccessMs:       lastTrendingSuccessMs,
        lastSuccessAgoSec:   lastTrendingSuccessMs ? Math.round((Date.now() - lastTrendingSuccessMs) / 1_000) : null,
        consecutiveFailures: consecutiveTrendingFailures,
        lastError:           lastTrendingError,
        intervalMs:          RANK_5M_INTERVAL_MS,
        firedTotal:          firedBySource['rank_5m'],
      },
      trending1h: {
        label:               'rank/1h',
        pollCount:           trending1hPollCount,
        lastSuccessMs:       lastTrending1hSuccessMs,
        lastSuccessAgoSec:   lastTrending1hSuccessMs ? Math.round((Date.now() - lastTrending1hSuccessMs) / 1_000) : null,
        consecutiveFailures: consecutiveTrending1hFailures,
        lastError:           lastTrending1hError,
        intervalMs:          RANK_1H_INTERVAL_MS,
        firedTotal:          firedBySource['rank_1h'],
      },
    },

    // Discovered / fired — total and by source
    totalDiscovered,
    tokensPerHour,
    firedBySource,

    // GMGN discovery delay (time from token creation to our detection)
    avgDiscoveryDelaySec:  avgDiscoveryDelaySec(),
    discoveryDelayWindow:  recentDiscoveryDelaysSec.length,

    // Raw token counts
    totalTokensSeen,
    totalTokensFired,
    totalTokensSkippedAge,
    totalTokensSkippedDupe,
    totalTokensSkippedIgnore,

    // Coverage estimates
    discoveryRatePct: discoveryRate,
    coverageAlert,
    dupeFraction:     Math.round(dupeFraction * 100),

    // Suppression state
    suppressedCount,
    trackingWindowMs: TRACKING_WINDOW_MS,

    // Rate-limit ban state
    gmgnBannedUntilMs: bannedUntil,
    gmgnBanned:        bannedUntil > 0,

    // Legacy fields for route compatibility
    activeMints:              suppressedUntil.size,
    isBootstrap:              pollCount === 0,
    lastSeenSig:              null,
    consecutivePollFailures:  consecutiveFailures,
    pollDelayMs:              RANK_1M_INTERVAL_MS,
    pagesPerPoll:             3,    // rank/1m + rank/5m + rank/1h
    pumpfunMintsTotal:        totalDiscovered,
    heliusWsConfigured:       false,
    heliusApiKeySet:          !!process.env.HELIUS_API_KEY,
    gmgnApiKeySet:            !!process.env.GMGN_API_KEY,
    rpcEndpoint:              process.env.RPC_ENDPOINT ?? (process.env.HELIUS_API_KEY ? 'helius-http' : 'public-mainnet'),
    recentFeed: discoveryFeed.slice(0, 5).map(e => ({
      mint:            e.mint.slice(0, 12),
      instructionType: e.isMigration ? 'refire' : 'new_token',
      discoverySource: e.discoverySource,
      ts:              e.ts,
      reserveUsd:      e.reserveUsd,
    })),
  };
}
