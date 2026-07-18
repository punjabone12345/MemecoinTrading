/**
 * Token Discovery Service — GMGN-first architecture
 *
 * Primary discovery source: GMGN API
 *   • /defi/quotation/v1/tokens/new_pairs/sol  — newest token pairs (every 15 s)
 *   • /defi/quotation/v1/rank/sol/swaps/5m     — trending by swap count (every 30 s)
 *
 * Market data validation: DexScreener (unchanged — handled downstream in sniper engine)
 * Wallet analysis:        GMGN (unchanged — handled in wallet-score.service.ts)
 *
 * Suppression model (same as before):
 *   suppressedUntil: Map<mint, unix-ms>
 *   • Normal new fire       → suppressedUntil = now + TRACKING_WINDOW_MS (1 hour)
 *   • releaseForRediscovery → suppressedUntil = now + delayMs (short window for transient failures)
 *
 * Exported interface is intentionally identical to the old GeckoTerminal implementation
 * so that index.ts, sniper-engine.service.ts, and all routes need no changes.
 */

import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import {
  fetchTrendingTokens,
  getDiscoveryBannedUntil,
  type GmgnDiscoveredToken,
} from '../lib/gmgn-discovery.js';
import https from 'node:https';

// ── Constants ─────────────────────────────────────────────────────────────────

const NEW_PAIRS_INTERVAL_MS  = 15_000;  // poll new_pairs every 15 s
const TRENDING_INTERVAL_MS   = 30_000;  // poll trending every 30 s
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

export interface DiscoveryEvent {
  mint:         string;
  poolAddress?: string;
  ts:           number;
  name?:        string;
  symbol?:      string;
  isMigration:  boolean;
  reserveUsd?:  number;
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

let newPairsPollCount          = 0;
let trendingPollCount          = 0;
let lastNewPairsSuccessMs      = 0;
let lastTrendingSuccessMs      = 0;
let consecutiveNewPairsFailures = 0;
let consecutiveTrendingFailures = 0;
let lastNewPairsError: string | null  = null;
let lastTrendingError: string | null  = null;
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
function processTokens(tokens: GmgnDiscoveredToken[], source: 'new_pairs' | 'trending'): number {
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

    // Skip tokens with no GMGN-reported DEX liquidity — they are still on the
    // pumpfun bonding curve and will never have a DexScreener DEX pool.
    // Tracking them causes the sniper's validateOrPrune loop to spin for the
    // full 10-minute deadline with liq=0 from DexScreener, wasting pipeline
    // capacity and preventing any real graduates from being wallet-scored.
    if (!liquidity || liquidity < 100) {
      totalTokensSkippedIgnore++;
      continue;
    }

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
      recordDiscoveryDelay(openTimestamp);
    }

    // Use GMGN-provided liquidity as proxy for initial reserve
    const reserveUsd = liquidity;

    const ev: DiscoveryEvent = {
      mint,
      poolAddress,
      ts:          now,
      name,
      symbol,
      isMigration: isReFire,
      reserveUsd,
    };

    discoveryFeed.unshift(ev);
    if (discoveryFeed.length > MAX_FEED) discoveryFeed.pop();

    if (onGraduation) {
      onGraduation({ mint, poolAddress, ts: now, reserveUsd });
    }

    totalTokensFired++;

    // Persist to DB (non-blocking)
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

// ── GeckoTerminal fallback ────────────────────────────────────────────────────
//
// GeckoTerminal's public API has no Cloudflare protection and works from any
// cloud IP (including Render's datacenter IPs). Used as a fallback whenever
// GMGN returns null — typically because Render's IP is Cloudflare-blocked
// without GMGN_API_KEY set.

async function fetchGeckoTerminalNewPools(): Promise<GmgnDiscoveredToken[] | null> {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.geckoterminal.com',
      path: '/api/v2/networks/solana/new_pools?page=1',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 10_000,
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const items: any[] = json?.data ?? [];
          const out: GmgnDiscoveredToken[] = [];
          for (const item of items) {
            const attrs = item.attributes ?? {};
            const baseId: string = item.relationships?.base_token?.data?.id ?? '';
            const mint = baseId.startsWith('solana_') ? baseId.slice(7) : '';
            if (!mint || mint.length < 20) continue;
            // Only include DEX pools (pumpswap, raydium, orca…) — not bonding curve
            const dexId: string = item.relationships?.dex?.data?.id ?? '';
            if (dexId === 'pump_fun' || dexId === 'pumpfun') continue;
            const poolAddress: string = attrs.address ?? (item.id ?? '').replace('solana_', '');
            const reserveUsd = parseFloat(attrs.reserve_in_usd ?? '0') || 0;
            if (reserveUsd < 100) continue; // skip micro/seeded pools
            const createdAt = attrs.pool_created_at
              ? Math.floor(new Date(attrs.pool_created_at).getTime() / 1000)
              : undefined;
            out.push({
              mint,
              poolAddress,
              name:          attrs.name?.split(' / ')[0] ?? undefined,
              symbol:        attrs.name?.split(' / ')[0] ?? undefined,
              openTimestamp: createdAt,
              liquidity:     reserveUsd,
              marketCap:     parseFloat(attrs.market_cap_usd ?? '0') || undefined,
              volume1h:      parseFloat(attrs.volume_usd?.h1 ?? '0') || undefined,
              priceUsd:      parseFloat(attrs.base_token_price_usd ?? '0') || undefined,
            });
          }
          resolve(out.length > 0 ? out : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Short-window rank poller (1m) — replaces broken new_pairs endpoint ────────
//
// The /tokens/new_pairs/sol GMGN endpoint returns "invalid argument" (code 40000300)
// regardless of parameters. The /rank/sol/swaps/1m endpoint is fully functional,
// returns tokens with activity in the last minute, and serves the same purpose
// (surfacing the newest, most-actively-traded tokens).
//
// If GMGN is unreachable (e.g. Cloudflare-blocked on Render without GMGN_API_KEY),
// GeckoTerminal new pools is used as a fallback after 3 consecutive failures.

async function pollNewPairs(): Promise<void> {
  const bannedUntil = getDiscoveryBannedUntil();
  if (bannedUntil > Date.now()) return; // respect discovery rate-limit ban

  const tokens = await fetchTrendingTokens('1m', 100);

  if (tokens === null) {
    consecutiveNewPairsFailures++;
    lastNewPairsError = 'API returned null (rate-limited or error)';

    // After 3 consecutive GMGN failures, try GeckoTerminal as a fallback
    if (consecutiveNewPairsFailures >= 3) {
      const gtTokens = await fetchGeckoTerminalNewPools();
      if (gtTokens && gtTokens.length > 0) {
        const fired = processTokens(gtTokens, 'new_pairs');
        if (fired > 0) {
          logger.info(
            { fired, total: totalDiscovered, gmgnFailures: consecutiveNewPairsFailures },
            'GMGN discovery: new tokens queued from GeckoTerminal fallback (GMGN unavailable)',
          );
        }
        return;
      }
    }

    logger.debug({ failures: consecutiveNewPairsFailures }, 'GMGN discovery: rank/1m fetch failed');
    return;
  }

  const fired = processTokens(tokens, 'new_pairs');
  consecutiveNewPairsFailures = 0;
  lastNewPairsError = null;
  newPairsPollCount++;
  lastNewPairsSuccessMs = Date.now();

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'GMGN discovery: new tokens queued from rank/1m');
  }
}

// ── Trending poller ───────────────────────────────────────────────────────────

async function pollTrending(): Promise<void> {
  const bannedUntil = getDiscoveryBannedUntil();
  if (bannedUntil > Date.now()) return;

  const tokens = await fetchTrendingTokens('5m', 100);

  if (tokens === null) {
    consecutiveTrendingFailures++;
    lastTrendingError = 'API returned null (rate-limited or error)';
    logger.debug({ failures: consecutiveTrendingFailures }, 'GMGN discovery: trending fetch failed');
    return;
  }

  const fired = processTokens(tokens, 'trending');
  consecutiveTrendingFailures = 0;
  lastTrendingError = null;
  trendingPollCount++;
  lastTrendingSuccessMs = Date.now();

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'GMGN discovery: new tokens queued from trending');
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let started              = false;
let newPairsTimer: ReturnType<typeof setTimeout> | null  = null;
let trendingTimer: ReturnType<typeof setTimeout> | null  = null;

function scheduleNewPairs(): void {
  if (newPairsTimer) { clearTimeout(newPairsTimer); newPairsTimer = null; }
  if (!started) return;

  // If in ban window, delay until the ban clears (+ 2 s jitter)
  const banned = getDiscoveryBannedUntil();
  const delay  = banned > Date.now()
    ? (banned - Date.now() + 2_000)
    : NEW_PAIRS_INTERVAL_MS;

  newPairsTimer = setTimeout(async () => {
    await pollNewPairs();
    scheduleNewPairs();
  }, delay);
}

function scheduleTrending(): void {
  if (trendingTimer) { clearTimeout(trendingTimer); trendingTimer = null; }
  if (!started) return;

  const banned = getDiscoveryBannedUntil();
  const delay  = banned > Date.now()
    ? (banned - Date.now() + 2_000)
    : TRENDING_INTERVAL_MS;

  trendingTimer = setTimeout(async () => {
    await pollTrending();
    scheduleTrending();
  }, delay);
}

export function startTrenchesScanner(): void {
  if (started) return;
  started        = true;
  sessionStartMs = Date.now();

  const gmgnKeySet = !!process.env.GMGN_API_KEY;
  logger.info(
    {
      rank1mIntervalMs:  NEW_PAIRS_INTERVAL_MS,
      rank5mIntervalMs:  TRENDING_INTERVAL_MS,
      bootDelayMs:       BOOT_DELAY_MS,
      gmgnApiKeySet:     gmgnKeySet,
    },
    'GMGN discovery: starting (rank/1m + rank/5m pollers)',
  );

  if (!gmgnKeySet) {
    logger.warn(
      'GMGN_API_KEY not set — discovery will attempt unauthenticated requests; rate limits will be stricter',
    );
  }

  // Stagger the two pollers so they don't fire simultaneously
  newPairsTimer = setTimeout(async () => {
    await pollNewPairs();
    scheduleNewPairs();
  }, BOOT_DELAY_MS);

  trendingTimer = setTimeout(async () => {
    await pollTrending();
    scheduleTrending();
  }, BOOT_DELAY_MS + 7_500); // offset by 7.5 s so requests interleave
}

export function stopTrenchesScanner(): void {
  if (!started) return;
  started = false;
  if (newPairsTimer) { clearTimeout(newPairsTimer); newPairsTimer = null; }
  if (trendingTimer) { clearTimeout(trendingTimer); trendingTimer = null; }
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

  // Derive combined "last success" and failure counts from the two pollers
  const lastPollSuccessMs   = Math.max(lastNewPairsSuccessMs, lastTrendingSuccessMs);
  const consecutiveFailures = consecutiveNewPairsFailures + consecutiveTrendingFailures;
  const lastPollError       = lastNewPairsError ?? lastTrendingError ?? null;
  const pollCount           = newPairsPollCount + trendingPollCount;

  return {
    source:               'gmgn_new_pairs_and_trending',
    sessionStartMs,
    pollCount,
    lastPollSuccessMs,
    lastPollAgoSec:       lastPollSuccessMs ? Math.round((Date.now() - lastPollSuccessMs) / 1_000) : null,
    consecutiveFailures,
    lastPollError,
    pollIntervalMs:       NEW_PAIRS_INTERVAL_MS,

    // Per-poller breakdown
    pollers: {
      newPairs: {
        pollCount:           newPairsPollCount,
        lastSuccessMs:       lastNewPairsSuccessMs,
        lastSuccessAgoSec:   lastNewPairsSuccessMs ? Math.round((Date.now() - lastNewPairsSuccessMs) / 1_000) : null,
        consecutiveFailures: consecutiveNewPairsFailures,
        lastError:           lastNewPairsError,
        intervalMs:          NEW_PAIRS_INTERVAL_MS,
      },
      trending: {
        pollCount:           trendingPollCount,
        lastSuccessMs:       lastTrendingSuccessMs,
        lastSuccessAgoSec:   lastTrendingSuccessMs ? Math.round((Date.now() - lastTrendingSuccessMs) / 1_000) : null,
        consecutiveFailures: consecutiveTrendingFailures,
        lastError:           lastTrendingError,
        intervalMs:          TRENDING_INTERVAL_MS,
      },
    },

    // Discovered / fired
    totalDiscovered,
    tokensPerHour,

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
    pollDelayMs:              NEW_PAIRS_INTERVAL_MS,
    pagesPerPoll:             2,    // new_pairs + trending = 2 sources
    pumpfunMintsTotal:        totalDiscovered,
    heliusWsConfigured:       false,
    heliusApiKeySet:          !!process.env.HELIUS_API_KEY,
    gmgnApiKeySet:            !!process.env.GMGN_API_KEY,
    rpcEndpoint:              process.env.RPC_ENDPOINT ?? (process.env.HELIUS_API_KEY ? 'helius-http' : 'public-mainnet'),
    recentFeed: discoveryFeed.slice(0, 5).map(e => ({
      mint:            e.mint.slice(0, 12),
      instructionType: e.isMigration ? 'refire' : 'new_token',
      ts:              e.ts,
      reserveUsd:      e.reserveUsd,
    })),
  };
}
