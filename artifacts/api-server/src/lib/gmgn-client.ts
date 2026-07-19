// ── GMGN OpenAPI client — read-only wallet analytics ─────────────────────────
//
// Minimal client for the "exist auth" (read-only) subset of the official GMGN
// OpenAPI (https://openapi.gmgn.ai) — the same API surface documented by the
// official `gmgn-cli` / GMGN Agent Skills package (github.com/GMGNAI/gmgn-skills).
//
// Only read endpoints are used (wallet_stats, wallet_activity) — these use
// "exist auth" (X-APIKEY + timestamp + client_id query params, no private-key
// signature required). We deliberately do NOT implement the "signed auth"
// (swap/order/trade) endpoints — this bot never trades through GMGN, it only
// reads wallet performance data to score smart-money wallets.
//
// No API key configured → every call resolves to `null` so callers can treat
// "no data" identically to "GMGN unavailable" and fail safe (no trade).

import axios from 'axios';
import { logger } from './logger.js';

const GMGN_HOST = process.env.GMGN_API_HOST || 'https://openapi.gmgn.ai';
const REQUEST_TIMEOUT_MS = 4_000;

let loggedMissingKey = false;

// Wallet-scoring uses GMGN_API_KEY_2 when set (dedicated key so discovery
// polling on GMGN_API_KEY never starves the on-critical-path wallet lookups).
// Falls back to GMGN_API_KEY so a single-key deployment still works.
function apiKey(): string | undefined {
  const key = process.env.GMGN_API_KEY_2 || process.env.GMGN_API_KEY;
  if (!key && !loggedMissingKey) {
    loggedMissingKey = true;
    logger.warn('Neither GMGN_API_KEY_2 nor GMGN_API_KEY is set — smart wallet consensus scoring disabled (all wallet scores will be 0, no entries will trigger)');
  }
  return key;
}

// ── Rate limiting / ban avoidance ────────────────────────────────────────────
//
// GMGN's read endpoints have a per-IP rate limit; hitting it triggers a
// temporary IP ban (`code: 429, error: "RATE_LIMIT_BANNED"`, with a
// `reset_at` unix-seconds timestamp). Every buyer wallet triggers TWO calls
// (wallet_stats + wallet_activity), and dozens of buyers can arrive across
// tracked tokens within seconds — with no throttling, that blows through the
// limit almost immediately and self-inflicts a ban that then makes EVERY
// wallet score 0 until it clears.
//
// Fix: (1) serialize + space out requests to stay under the limit, and
// (2) once banned, stop calling entirely until `reset_at` passes instead of
// hammering the ban further.
const MIN_REQUEST_INTERVAL_MS = 600; // caps us at ~1.7 req/sec to GMGN — conservative to avoid re-triggering the ban
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
let bannedUntilMs = 0;
let loggedBan = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GmgnBannedError extends Error {}

/**
 * Reserves the next outbound-request slot, honoring the pacing interval.
 * Throws `GmgnBannedError` instead of sleeping through an active ban window —
 * we never want dozens of queued lookups to sit there and then all fire the
 * instant the ban lifts (which would just trigger another ban immediately).
 */
function reserveSlot(): Promise<void> {
  const runAfter = requestQueue.then(async () => {
    if (bannedUntilMs > Date.now()) throw new GmgnBannedError();
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();
  });
  requestQueue = runAfter.catch(() => {});
  return runAfter;
}

/** Reads a GMGN rate-limit-ban error response and, if present, stops all further calls until it clears. */
function applyBanIfPresent(data: any): void {
  if (data?.error === 'RATE_LIMIT_BANNED' && typeof data.reset_at === 'number') {
    const untilMs = data.reset_at * 1000;
    if (untilMs > bannedUntilMs) bannedUntilMs = untilMs;
    if (!loggedBan) {
      loggedBan = true;
      logger.warn(
        { resetAt: new Date(bannedUntilMs).toISOString() },
        'GMGN: IP rate-limit banned — pausing all wallet-score lookups until the ban clears',
      );
    }
  }
}

function buildAuthQuery(): { timestamp: number; client_id: string } {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: cryptoRandomUUID() };
}

// Avoid importing node:crypto's randomUUID under a different module boundary —
// use the global (available in Node 20 / browsers) with a fallback.
function cryptoRandomUUID(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Fallback RFC4122-ish v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function existAuthGet<T = any>(subPath: string, query: Record<string, any>): Promise<T | null> {
  const key = apiKey();
  if (!key) return null;

  try {
    await reserveSlot();
  } catch (err) {
    if (err instanceof GmgnBannedError) return null; // fail fast, don't even attempt while banned
    throw err;
  }

  try {
    const { timestamp, client_id } = buildAuthQuery();
    const res = await axios.get(`${GMGN_HOST}${subPath}`, {
      params: { ...query, timestamp, client_id },
      headers: { 'X-APIKEY': key, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    });
    // A successful response means any prior ban has cleared — allow the next
    // ban (if it happens again later) to be logged again.
    if (loggedBan) { loggedBan = false; bannedUntilMs = 0; }
    const body = res.data;
    // GMGN wraps responses as { code, msg, data }. code 0 = success.
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        logger.warn({ subPath, code: body.code, msg: body.msg }, 'GMGN: API returned non-zero code — wallet score will fall back to 0');
        return null;
      }
      return body.data as T;
    }
    return body as T;
  } catch (err: any) {
    applyBanIfPresent(err?.response?.data);
    // Elevated to warn (not debug) so GMGN failures are visible in production
    // logs (default LOG_LEVEL=info) — this was previously silent, making it
    // impossible to tell "GMGN_API_KEY set but calls failing" apart from
    // "GMGN_API_KEY missing" from Render logs alone.
    logger.warn(
      { subPath, status: err?.response?.status, data: err?.response?.data, err: err?.message },
      'GMGN: request failed — wallet score will fall back to 0',
    );
    return null;
  }
}

// NOTE on field names: these mirror the ACTUAL /v1/user/wallet_stats response
// shape (verified against the live API), which differs from GMGN's older/other
// docs. Win rate and average holding period are nested under `pnl_stat`, trade
// counts are plain `buy`/`sell` (not `buy_count`/`sell_count`), and the
// realized-PnL ratio is `realized_profit_pnl` (not `pnl`). Getting any of these
// wrong silently zeroes every wallet score (all fields read as `undefined`,
// so every scoring condition falls through) — always verify against a live
// response before renaming.
export interface GmgnWalletStats {
  realized_profit?: number;
  unrealized_profit?: number;
  realized_profit_pnl?: number; // ratio, e.g. -0.072 = -7.2% realized ROI
  total_cost?: number;
  buy?: number;
  sell?: number;
  pnl_stat?: {
    winrate?: number; // 0-1 ratio
    avg_holding_period?: number; // seconds
    token_num?: number;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface GmgnWalletActivityItem {
  tx_hash?: string;
  event_type?: 'buy' | 'sell' | 'add' | 'remove' | 'transfer';
  token?: { address?: string; symbol?: string };
  token_amount?: number;
  cost_usd?: number;
  price_usd?: number;
  timestamp?: number;
  [key: string]: any;
}

export interface GmgnWalletActivityResponse {
  activities?: GmgnWalletActivityItem[];
  next?: string;
  [key: string]: any;
}

/** GET /v1/user/wallet_stats — win rate, pnl, buy/sell counts for a wallet over a period. */
export async function getWalletStats(chain: string, wallet: string, period: '1d' | '7d' | '30d' = '30d'): Promise<GmgnWalletStats | null> {
  const data = await existAuthGet<any>('/v1/user/wallet_stats', { chain, wallet_address: wallet, period });
  // API can return either a single object or a single-element array for one wallet.
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/** GET /v1/user/wallet_activity — recent transaction history, used to approximate wallet age & hold time. */
export async function getWalletActivity(chain: string, wallet: string, limit = 50): Promise<GmgnWalletActivityResponse | null> {
  return existAuthGet<GmgnWalletActivityResponse>('/v1/user/wallet_activity', { chain, wallet_address: wallet, limit });
}

export function isGmgnConfigured(): boolean {
  return Boolean(process.env.GMGN_API_KEY_2 || process.env.GMGN_API_KEY);
}

/** Non-zero when GMGN has temporarily banned this server's IP for rate-limit violations (unix ms, or 0 if not banned). */
export function getGmgnBannedUntil(): number {
  return bannedUntilMs > Date.now() ? bannedUntilMs : 0;
}
