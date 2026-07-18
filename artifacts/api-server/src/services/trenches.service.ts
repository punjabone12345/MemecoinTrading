/**
 * Token Discovery Service — GeckoTerminal new_pools
 *
 * Replaces the DexScreener token-profiles/latest/v1 poller which is
 * consistently 429-blocked from Replit's shared IP.
 *
 * GeckoTerminal free tier: ~30 req/min.
 * We poll 2 pages every 25 seconds = ~5 req/min — very safe.
 *
 * Suppression model (replaces simple 1-hour firedAt):
 *   suppressedUntil: Map<mint, unix-ms>
 *   • Normal new fire      → suppressedUntil = now + TRACKING_WINDOW_MS (1 hour)
 *   • releaseForRediscovery(mint, delayMs) → suppressedUntil = now + delayMs
 *     This lets the sniper engine shorten the suppression window when the
 *     rejection reason was transient (DexScreener indexing lag, liq = 0, etc.)
 *   • Truly permanent outcomes (traded, rugcheck, holder, etc.) keep the full
 *     1-hour window set by the normal first fire.
 *
 * Coverage counters track how many pools are seen, fired, and skipped so
 * the /api/diagnostics/coverage endpoint can report discovery health.
 */

import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const GECKO_BASE       = 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools';
const PAGES_PER_POLL   = 2;            // pages 1 & 2 — ~40 newest pools
const PAGE_STAGGER_MS  = 800;          // stagger between page requests
const POLL_INTERVAL_MS = 25_000;       // 25 s base → ~5 req/min (2 pages × 2.4/min)
const BOOT_DELAY_MS    = 8_000;        // wait after startup before first poll (let old instance clear)
const MAX_FEED         = 50;
const TRACKING_WINDOW_MS = 60 * 60_000;  // 1 hour — default suppression for normal fires

// Backoff for GeckoTerminal 429s
const GT_BACKOFF_BASE_MS = 15_000;
const GT_BACKOFF_MAX_MS  = 120_000;

// Only fire for pools created within the last 2 hours (avoids spamming old
// pools on cold boot while still catching everything within our window).
const MAX_POOL_AGE_MS = 2 * 60 * 60_000;

// Stable / infrastructure mints that appear in new_pools as base tokens
const IGNORE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',    // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // wETH (Wormhole)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
]);

// ── Discovery event (shared with UI / scanner route) ──────────────────────────

export interface DiscoveryEvent {
  mint:        string;
  poolAddress?: string;
  ts:          number;
  name?:       string;
  isMigration: boolean;
  reserveUsd?: number;  // GeckoTerminal reserve_in_usd at discovery time (proxy for initial liquidity)
}

// ── In-memory state ───────────────────────────────────────────────────────────

/**
 * suppressedUntil maps mint → unix-ms when the suppression expires.
 * Until that time, the token will not re-fire onGraduation.
 *
 * Normal first fire: suppressedUntil = now + TRACKING_WINDOW_MS (1 hour)
 * releaseForRediscovery: overrides to now + delayMs (short window for transient failures)
 */
const suppressedUntil = new Map<string, number>();

const discoveryFeed: DiscoveryEvent[] = [];
let totalDiscovered = 0;

// ── Coverage counters ─────────────────────────────────────────────────────────

let totalPoolsSeen        = 0;   // total pool items returned by GeckoTerminal
let totalPoolsFired       = 0;   // total onGraduation callbacks fired
let totalPoolsSkippedAge  = 0;   // skipped: pool older than MAX_POOL_AGE_MS
let totalPoolsSkippedDupe = 0;   // skipped: still within suppression window
let totalPoolsSkippedIgnore = 0; // skipped: in IGNORE_MINTS or invalid mint

// ── Diagnostics ───────────────────────────────────────────────────────────────

let pollCount           = 0;
let lastPollSuccessMs   = 0;
let consecutiveFailures = 0;
let lastPollError: string | null = null;
let sessionStartMs      = 0;

// ── Callbacks ─────────────────────────────────────────────────────────────────

let onGraduation: ((ev: { mint: string; poolAddress?: string; ts: number; reserveUsd?: number }) => void) | null = null;

export function setOnGraduation(
  cb: (ev: { mint: string; poolAddress?: string; ts: number; reserveUsd?: number }) => void,
): void {
  onGraduation = cb;
}

// ── Suppression control (called by sniper engine on transient failures) ────────

/**
 * Shorten the suppression window for a mint that was pruned due to a transient
 * reason (DexScreener indexing lag, liq = 0, validation timeout).
 *
 * After delayMs, the next GeckoTerminal poll will re-fire this mint so the
 * validation can be attempted again with a fresh DexScreener check.
 *
 * Do NOT call this for permanent rejections (rugcheck, holder limits, traded).
 * Those should keep the full 1-hour suppression window.
 */
export function releaseForRediscovery(mint: string, delayMs: number): void {
  suppressedUntil.set(mint, Date.now() + delayMs);
  logger.debug(
    { mint: mint.slice(0, 12), retryInSec: Math.round(delayMs / 1_000) },
    'Discovery: released for re-discovery (transient failure)',
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
    dexscreener: {
      total:  totalDiscovered,
      recent: discoveryFeed.slice(0, 20),
    },
  };
}

// ── GeckoTerminal fetch ───────────────────────────────────────────────────────

interface GeckoPool {
  id: string;
  attributes: {
    name?:            string;
    pool_created_at?: string;
    reserve_in_usd?:  string;
  };
  relationships: {
    base_token: { data: { id: string } };
    dex?:       { data: { id: string } };
  };
}

async function fetchNewPoolsPage(page: number): Promise<GeckoPool[]> {
  const url = `${GECKO_BASE}?page=${page}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; apex-meme-trader/1.0)',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`GeckoTerminal new_pools page ${page}: HTTP ${res.status}`);

  const data: any = await res.json();
  if (!Array.isArray(data?.data)) throw new Error(`GeckoTerminal new_pools page ${page}: unexpected shape`);
  return data.data as GeckoPool[];
}

// ── Rate-limit backoff state ──────────────────────────────────────────────────

let gtBackoffUntil    = 0;   // unix ms — block all polls until this time
let gtConsecutive429s = 0;

function reportGecko429(): void {
  gtConsecutive429s++;
  const delay = Math.min(GT_BACKOFF_BASE_MS * 2 ** (gtConsecutive429s - 1), GT_BACKOFF_MAX_MS);
  gtBackoffUntil = Date.now() + delay;
  logger.warn(
    { delaySec: Math.round(delay / 1000), consecutive: gtConsecutive429s },
    'DexScreener discovery: GeckoTerminal 429 — backing off',
  );
}

function reportGeckoSuccess(): void {
  if (gtConsecutive429s > 0) logger.info('DexScreener discovery: GeckoTerminal request succeeded — backoff cleared');
  gtConsecutive429s = 0;
}

// ── Core poll ─────────────────────────────────────────────────────────────────

async function pollGeckoNewPools(): Promise<void> {
  // Respect backoff from previous 429s
  if (Date.now() < gtBackoffUntil) return;

  const now     = Date.now();
  let fired     = 0;
  let pagesOk   = 0;
  let got429    = false;
  let poolsSeen = 0;

  for (let page = 1; page <= PAGES_PER_POLL; page++) {
    if (page > 1) await new Promise(r => setTimeout(r, PAGE_STAGGER_MS));
    if (!started) return; // stopped while staggering

    let pools: GeckoPool[];
    try {
      pools = await fetchNewPoolsPage(page);
      pagesOk++;
    } catch (pageErr: any) {
      const msg = String(pageErr?.message ?? pageErr ?? '');
      if (msg.includes('429')) {
        got429 = true;
        break; // back off immediately; no point trying remaining pages
      }
      // Other error (timeout, network): log and continue to next page
      logger.warn({ error: msg, page }, 'DexScreener discovery: page fetch failed');
      continue;
    }

    poolsSeen += pools.length;

    for (const pool of pools) {
      // Extract mint from "solana_<MINT>" relationship ID
      const baseId = pool.relationships?.base_token?.data?.id ?? '';
      const mint   = baseId.startsWith('solana_') ? baseId.slice(7) : '';
      if (!mint || mint.length < 20) {
        totalPoolsSkippedIgnore++;
        continue;
      }
      if (IGNORE_MINTS.has(mint)) {
        totalPoolsSkippedIgnore++;
        continue;
      }

      // Extract pool address from "solana_<POOL>" pool ID
      const poolId      = pool.id ?? '';
      const poolAddress = poolId.startsWith('solana_') ? poolId.slice(7) : undefined;

      // Age filter — skip pools older than MAX_POOL_AGE_MS
      const createdAt = pool.attributes?.pool_created_at;
      if (createdAt) {
        const createdMs = new Date(createdAt).getTime();
        if (Number.isFinite(createdMs) && now - createdMs > MAX_POOL_AGE_MS) {
          totalPoolsSkippedAge++;
          continue;
        }
      }

      // Suppression check — skip if within suppression window
      const suppressExpiry = suppressedUntil.get(mint);
      if (suppressExpiry !== undefined && now < suppressExpiry) {
        totalPoolsSkippedDupe++;
        continue;
      }

      // Whether this is a re-fire (was previously suppressed) or brand new
      const isMigration = suppressExpiry !== undefined; // had a previous fire whose window expired or was released
      const isNew       = suppressExpiry === undefined;

      // Set new suppression window (default: 1 hour)
      // releaseForRediscovery() can shorten this after transient failures
      suppressedUntil.set(mint, now + TRACKING_WINDOW_MS);

      if (isNew) totalDiscovered++;

      // Parse initial reserve (proxy for initial liquidity)
      const rawReserve  = pool.attributes?.reserve_in_usd;
      const reserveUsd  = rawReserve ? parseFloat(rawReserve) : undefined;
      const tokenName   = pool.attributes?.name?.split(' / ')[0]?.trim();

      const ev: DiscoveryEvent = {
        mint,
        poolAddress,
        ts:          now,
        name:        tokenName,
        isMigration,
        reserveUsd,
      };

      discoveryFeed.unshift(ev);
      if (discoveryFeed.length > MAX_FEED) discoveryFeed.pop();

      if (onGraduation) {
        onGraduation({ mint, poolAddress, ts: now, reserveUsd });
      }

      totalPoolsFired++;

      // Persist discovery to DB (non-blocking)
      const source = isMigration ? 'dexscreener_migration' : 'dexscreener';
      query(`
        INSERT INTO detected_migrations
          (source, instruction_type, tx_signature, pool_address, mint, creator_wallet)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tx_signature) DO NOTHING
      `, [source, 'token_profile', `gecko_${mint}_${now}`, poolAddress ?? null, mint, null])
        .catch(() => {});

      if (isMigration) {
        logger.info(
          { mint: mint.slice(0, 16) },
          'DexScreener discovery: token re-appeared after suppression window — fresh tracking',
        );
      }
      fired++;
    }
  }

  // Update global coverage counters
  totalPoolsSeen += poolsSeen;

  if (got429) {
    // 429: apply exponential backoff; do NOT count as a success
    reportGecko429();
    consecutiveFailures++;
    lastPollError = 'GeckoTerminal 429';
    return;
  }

  if (pagesOk === 0) {
    // All pages failed (non-429 errors)
    consecutiveFailures++;
    lastPollError = 'all pages failed';
    logger.warn({ failures: consecutiveFailures }, 'DexScreener discovery: all pages failed');
    return;
  }

  // At least one page succeeded
  reportGeckoSuccess();
  pollCount++;
  lastPollSuccessMs   = Date.now();
  consecutiveFailures = 0;
  lastPollError       = null;

  if (fired > 0) {
    logger.info({ fired, total: totalDiscovered }, 'DexScreener discovery: new tokens queued');
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let started   = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!started) return;
  // When in backoff, schedule the next attempt for the end of the backoff window
  // (plus a small jitter) rather than the fixed poll interval.
  const backoffRemaining = Math.max(0, gtBackoffUntil - Date.now());
  const delay = Math.max(POLL_INTERVAL_MS, backoffRemaining + 2_000);
  pollTimer = setTimeout(async () => {
    await pollGeckoNewPools();
    schedulePoll();
  }, delay);
}

export function startTrenchesScanner(): void {
  if (started) return;
  started        = true;
  sessionStartMs = Date.now();

  logger.info(`DexScreener discovery: starting GeckoTerminal new_pools poller (${POLL_INTERVAL_MS / 1000}s interval, ${BOOT_DELAY_MS / 1000}s boot delay)`);

  // Delay the first poll so the previous server instance's rate-limit window
  // has time to clear before we start firing requests.
  pollTimer = setTimeout(async () => {
    await pollGeckoNewPools();
    schedulePoll();
  }, BOOT_DELAY_MS);
}

export function stopTrenchesScanner(): void {
  if (!started) return;
  started = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  logger.info('DexScreener discovery: stopped');
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

export function getTrenchesDiagnostics() {
  const elapsedMs      = sessionStartMs ? Date.now() - sessionStartMs : 0;
  const elapsedHours   = elapsedMs / 3_600_000;
  const tokensPerHour  = elapsedHours > 0.05 ? Math.round(totalDiscovered / elapsedHours) : null;

  // Count currently-active suppression entries (mint still within its window)
  const nowMs = Date.now();
  let suppressedCount = 0;
  for (const expiry of suppressedUntil.values()) {
    if (nowMs < expiry) suppressedCount++;
  }

  // Discovery rate: fraction of seen pools that were actually fired
  const eligibleSeen = totalPoolsSeen - totalPoolsSkippedIgnore - totalPoolsSkippedAge;
  const discoveryRate = eligibleSeen > 0
    ? Math.round((totalPoolsFired / eligibleSeen) * 100)
    : null;

  // Coverage health flag: if >80% of eligible pools are dupes, we may be missing fresh ones
  const dupeFraction  = eligibleSeen > 0 ? totalPoolsSkippedDupe / eligibleSeen : 0;
  const coverageAlert = dupeFraction > 0.8 && totalPoolsSeen > 50;

  return {
    source:             'gecko_terminal_new_pools',
    sessionStartMs,
    pollCount,
    lastPollSuccessMs,
    lastPollAgoSec:     lastPollSuccessMs ? Math.round((Date.now() - lastPollSuccessMs) / 1_000) : null,
    consecutiveFailures,
    lastPollError,
    pollIntervalMs:     POLL_INTERVAL_MS,
    pagesPerPoll:       PAGES_PER_POLL,

    // Discovered / fired
    totalDiscovered,
    tokensPerHour,

    // Raw pool counts
    totalPoolsSeen,
    totalPoolsFired,
    totalPoolsSkippedAge,
    totalPoolsSkippedDupe,
    totalPoolsSkippedIgnore,

    // Coverage estimates
    discoveryRatePct:   discoveryRate,    // % of eligible pools that were fired (excluding ignored + aged)
    coverageAlert,                        // true if most eligible pools are dupes (possible gap in pages)
    dupeFraction:       Math.round(dupeFraction * 100),

    // Suppression state
    suppressedCount,    // how many mints are currently within their suppression window
    trackingWindowMs:   TRACKING_WINDOW_MS,

    // Legacy fields kept for compatibility
    activeMints:        suppressedUntil.size,
    isBootstrap:        pollCount === 0,
    lastSeenSig:        null,
    consecutivePollFailures: consecutiveFailures,
    pollDelayMs:        POLL_INTERVAL_MS,
    pumpfunMintsTotal:  totalDiscovered,
    heliusWsConfigured: false,
    heliusApiKeySet:    !!process.env.HELIUS_API_KEY,
    rpcEndpoint:        process.env.RPC_ENDPOINT ?? (process.env.HELIUS_API_KEY ? 'helius-http' : 'public-mainnet'),
    recentFeed: discoveryFeed.slice(0, 5).map(e => ({
      mint:            e.mint.slice(0, 12),
      instructionType: e.isMigration ? 'migration' : 'new_token',
      ts:              e.ts,
      reserveUsd:      e.reserveUsd,
    })),
  };
}
