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

function apiKey(): string | undefined {
  const key = process.env.GMGN_API_KEY;
  if (!key && !loggedMissingKey) {
    loggedMissingKey = true;
    logger.warn('GMGN_API_KEY not set — smart wallet consensus scoring disabled (all wallet scores will be 0, no entries will trigger)');
  }
  return key;
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
    const { timestamp, client_id } = buildAuthQuery();
    const res = await axios.get(`${GMGN_HOST}${subPath}`, {
      params: { ...query, timestamp, client_id },
      headers: { 'X-APIKEY': key, 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    });
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

export interface GmgnWalletStats {
  realized_profit?: number;
  unrealized_profit?: number;
  winrate?: number;
  total_cost?: number;
  buy_count?: number;
  sell_count?: number;
  pnl?: number;
  [key: string]: any;
}

export interface GmgnWalletActivityItem {
  transaction_hash?: string;
  type?: 'buy' | 'sell' | 'add' | 'remove' | 'transfer';
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
  return Boolean(process.env.GMGN_API_KEY);
}
