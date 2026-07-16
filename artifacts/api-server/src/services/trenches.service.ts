/**
 * Token Discovery Service — DexScreener token-profiles/latest/v1
 *
 * Replaces the old PumpFun migration-wallet on-chain tracker entirely.
 * Polls DexScreener's public token-profiles endpoint every 10 seconds to
 * discover newly created / newly-active Solana memecoins.
 *
 * Rate limit: 60 requests/second (we poll at ~6 req/min — very safe).
 *
 * Tracking window: 1 hour per token from first discovery.
 * Migration handling: if a mint reappears in the "latest" feed after its
 * 1-hour window has elapsed, it is treated as a new/migration event and
 * fired again with a fresh 1-hour window.
 */

import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEXSCREENER_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const POLL_INTERVAL_MS  = 10_000;   // 10 seconds — 6 req/min, well within 60/sec cap
const MAX_FEED          = 50;
const TRACKING_WINDOW_MS = 60 * 60_000; // 1 hour — must match MAX_TRACKING_MS in sniper engine

// Stable mints that appear on DexScreener but are not memecoins
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
  ts:          number;    // when we fired onGraduation for this mint
  name?:       string;
  description?: string;
  icon?:       string;
  isMigration: boolean;  // true = this is a re-appearance / migration event
}

// ── In-memory state ───────────────────────────────────────────────────────────

// mint → timestamp of the last time we fired onGraduation for this mint.
// Used to deduplicate within the 1-hour window and to detect migrations
// (mints that reappear after their window expires).
const firedAt = new Map<string, number>();

// Recent discovery feed for the UI (newest first)
const discoveryFeed: DiscoveryEvent[] = [];

// Running total of unique mints discovered this session
let totalDiscovered = 0;

// ── Diagnostics ───────────────────────────────────────────────────────────────

let pollCount          = 0;
let lastPollSuccessMs  = 0;
let consecutiveFailures = 0;
let lastPollError: string | null = null;
let sessionStartMs     = 0;

// ── Callbacks ─────────────────────────────────────────────────────────────────

let onGraduation: ((ev: { mint: string; poolAddress?: string; ts: number }) => void) | null = null;

export function setOnGraduation(
  cb: (ev: { mint: string; poolAddress?: string; ts: number }) => void,
): void {
  onGraduation = cb;
}

// ── Public feed accessors (for scanner route) ─────────────────────────────────

export function getDiscoveryFeed(): DiscoveryEvent[] {
  return discoveryFeed.slice(0, MAX_FEED);
}

export function getDiscoveryTotal(): number {
  return totalDiscovered;
}

// Legacy alias used by routes/index.ts debug diagnostics
export function getSourceActivity() {
  return {
    dexscreener: {
      total:  totalDiscovered,
      recent: discoveryFeed.slice(0, 20),
    },
  };
}

// ── DexScreener fetch ─────────────────────────────────────────────────────────

interface TokenProfile {
  url?:          string;
  chainId?:      string;
  tokenAddress?: string;
  icon?:         string;
  header?:       string;
  description?:  string;
  links?:        Array<{ type?: string; label?: string; url?: string }>;
}

async function fetchLatestProfiles(): Promise<TokenProfile[]> {
  const res = await fetch(DEXSCREENER_PROFILES_URL, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    throw new Error(`DexScreener token-profiles: HTTP ${res.status}`);
  }

  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error('DexScreener token-profiles: unexpected response shape');
  return data as TokenProfile[];
}

// ── Core poll ─────────────────────────────────────────────────────────────────

async function pollDexScreenerProfiles(): Promise<void> {
  try {
    const profiles = await fetchLatestProfiles();
    pollCount++;
    lastPollSuccessMs = Date.now();
    consecutiveFailures = 0;
    lastPollError = null;

    const now = Date.now();
    let fired = 0;

    for (const profile of profiles) {
      const mint = profile.tokenAddress?.trim();
      if (!mint || mint.length < 20) continue;
      if (profile.chainId !== 'solana') continue;
      if (IGNORE_MINTS.has(mint)) continue;

      const previousFire = firedAt.get(mint);
      const isMigration  = previousFire !== undefined && now - previousFire >= TRACKING_WINDOW_MS;
      const isNew        = previousFire === undefined;

      // Skip if already tracking within the 1-hour window
      if (!isNew && !isMigration) continue;

      // Fire the graduation callback (sniper engine receives the new token)
      firedAt.set(mint, now);
      if (isNew) totalDiscovered++;

      const ev: DiscoveryEvent = {
        mint,
        ts:          now,
        name:        undefined,
        description: profile.description?.slice(0, 120),
        icon:        profile.icon,
        isMigration,
      };

      // Push to feed (newest first)
      discoveryFeed.unshift(ev);
      if (discoveryFeed.length > MAX_FEED) discoveryFeed.pop();

      if (onGraduation) {
        onGraduation({ mint, ts: now });
      }

      // Persist discovery to DB (non-blocking)
      const source = isMigration ? 'dexscreener_migration' : 'dexscreener';
      query(`
        INSERT INTO detected_migrations
          (source, instruction_type, tx_signature, pool_address, mint, creator_wallet)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (tx_signature) DO NOTHING
      `, [source, 'token_profile', `dex_${mint}_${now}`, null, mint, null])
        .catch(() => {});

      if (isMigration) {
        logger.info(
          { mint: mint.slice(0, 16) },
          'DexScreener discovery: migration re-appeared — fresh 1h window',
        );
      }
      fired++;
    }

    if (fired > 0) {
      logger.info(
        { fired, total: totalDiscovered, profilesChecked: profiles.length },
        'DexScreener discovery: new tokens queued',
      );
    }
  } catch (err: any) {
    consecutiveFailures++;
    lastPollError = String(err?.message ?? err ?? 'unknown');
    logger.warn(
      { msg: lastPollError, failures: consecutiveFailures },
      'DexScreener discovery: poll failed',
    );
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let started    = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!started) return;
  pollTimer = setTimeout(async () => {
    await pollDexScreenerProfiles();
    schedulePoll();
  }, POLL_INTERVAL_MS);
}

export function startTrenchesScanner(): void {
  if (started) return;
  started = true;
  sessionStartMs = Date.now();

  logger.info('DexScreener discovery: starting token-profiles poller (10s interval)');
  // Run first poll immediately, then schedule recurring
  void pollDexScreenerProfiles().then(() => schedulePoll());
}

export function stopTrenchesScanner(): void {
  if (!started) return;
  started = false;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  logger.info('DexScreener discovery: stopped');
}

// ── Diagnostics (for /api/debug) ─────────────────────────────────────────────

export function getTrenchesDiagnostics() {
  return {
    source:            'dexscreener_token_profiles',
    sessionStartMs,
    pollCount,
    lastPollSuccessMs,
    lastPollAgoSec:    lastPollSuccessMs ? Math.round((Date.now() - lastPollSuccessMs) / 1_000) : null,
    consecutiveFailures,
    lastPollError,
    pollIntervalMs:    POLL_INTERVAL_MS,
    totalDiscovered,
    trackingWindowMs:  TRACKING_WINDOW_MS,
    activeMints:       firedAt.size,
    // Legacy fields expected by routes/index.ts
    isBootstrap:       pollCount === 0,
    lastSeenSig:       null,
    consecutivePollFailures: consecutiveFailures,
    pollDelayMs:       POLL_INTERVAL_MS,
    pumpfunMintsTotal: totalDiscovered,  // aliased for debug route backward compat
    heliusWsConfigured: false,
    heliusApiKeySet:   !!process.env.HELIUS_API_KEY,
    rpcEndpoint:       process.env.RPC_ENDPOINT ?? (process.env.HELIUS_API_KEY ? 'helius-http' : 'public-mainnet'),
    recentFeed: discoveryFeed.slice(0, 5).map(e => ({
      mint: e.mint.slice(0, 12),
      instructionType: e.isMigration ? 'migration' : 'new_token',
      ts: e.ts,
    })),
  };
}
