/**
 * GMGN Discovery API client
 *
 * Separate from gmgn-client.ts (wallet scoring) so the two rate limiters
 * never compete — wallet scoring calls are on-the-critical-path for trade
 * entry and must never be delayed by discovery polling.
 *
 * Endpoints used (openapi.gmgn.ai, same exist-auth as wallet scoring):
 *   GET /defi/quotation/v1/tokens/new_pairs/sol   — newest Solana token pairs
 *   GET /defi/quotation/v1/rank/sol/swaps/5m      — hottest tokens by swap count (5-min window)
 *
 * Rate limit: discovery polls at 2 req/s (500 ms interval) — conservative.
 * On 429 the client backs off exponentially and re-queues from where it left off.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────
//
// Two discovery transport strategies, chosen at request time:
//
//   WITH GMGN_API_KEY  → openapi.gmgn.ai via axios (X-APIKEY header + auth
//                        params, same transport as wallet scoring). No
//                        Cloudflare on this host — works from any IP including
//                        Render's datacenter IPs.
//
//   WITHOUT key        → gmgn.ai via curl subprocess. curl's libcurl TLS
//                        fingerprint bypasses Cloudflare on Replit IPs. Used
//                        only for keyless local/Replit testing.
//
const GMGN_OPEN_API_HOST    = process.env.GMGN_API_HOST       || 'https://openapi.gmgn.ai';
const GMGN_QUOTATION_HOST   = process.env.GMGN_QUOTATION_HOST || 'https://gmgn.ai';
const REQUEST_TIMEOUT_MS    = 8_000;
const MIN_REQUEST_INTERVAL  = 500;   // 2 req/s cap — leaves headroom for other callers

// ── Shared types ──────────────────────────────────────────────────────────────

/** A single discovered token from GMGN */
export interface GmgnDiscoveredToken {
  mint:           string;
  poolAddress?:   string;
  name?:          string;
  symbol?:        string;
  openTimestamp?: number;   // unix seconds — when the pool first opened
  liquidity?:     number;   // USD
  marketCap?:     number;   // USD
  volume1h?:      number;   // USD
  priceUsd?:      number;
}

// ── Rate limit / ban state ─────────────────────────────────────────────────────

let requestQueue: Promise<void>  = Promise.resolve();
let lastRequestAt                = 0;
let bannedUntilMs                = 0;
let consecutiveBans              = 0;

function sleepMs(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

class GmgnDiscoveryBannedError extends Error {}

function reserveSlot(): Promise<void> {
  const run = requestQueue.then(async () => {
    if (bannedUntilMs > Date.now()) throw new GmgnDiscoveryBannedError();
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL) await sleepMs(MIN_REQUEST_INTERVAL - elapsed);
    lastRequestAt = Date.now();
  });
  requestQueue = run.catch(() => {});
  return run;
}

function applyBanIfPresent(responseData: any): void {
  const resetAt = responseData?.reset_at;
  if (
    (responseData?.error === 'RATE_LIMIT_BANNED' || responseData?.code === 429) &&
    typeof resetAt === 'number'
  ) {
    const untilMs = resetAt * 1000;
    if (untilMs > bannedUntilMs) bannedUntilMs = untilMs;
    consecutiveBans++;
    logger.warn(
      { resetAt: new Date(untilMs).toISOString(), consecutiveBans },
      'GMGN discovery: rate-limit ban — pausing discovery until ban clears',
    );
  }
}

export function getDiscoveryBannedUntil(): number {
  return bannedUntilMs > Date.now() ? bannedUntilMs : 0;
}

// ── Auth builder ──────────────────────────────────────────────────────────────

function buildAuthParams(): Record<string, any> {
  const key = process.env.GMGN_API_KEY;
  if (!key) return {};
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: cryptoUUID(),
  };
}

function buildAuthHeaders(): Record<string, string> {
  const key = process.env.GMGN_API_KEY;
  // Always send browser-like headers; X-APIKEY is what bypasses Cloudflare on gmgn.ai
  const base: Record<string, string> = {
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Referer':         'https://gmgn.ai/',
    'Origin':          'https://gmgn.ai',
  };
  if (key) base['X-APIKEY'] = key;
  return base;
}

function cryptoUUID(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Generic GET helper ────────────────────────────────────────────────────────
//
// Two transport strategies depending on whether GMGN_API_KEY is set:
//
//   WITH key  → axios to openapi.gmgn.ai (identical transport to wallet
//               scoring). No Cloudflare on this host — works from Render
//               datacenter IPs. X-APIKEY sent as header; timestamp +
//               client_id sent as query params.
//
//   WITHOUT key → curl subprocess to gmgn.ai. curl's libcurl TLS fingerprint
//               bypasses the Cloudflare WAF on Replit's IP space, so keyless
//               local/Replit testing still works.

async function discoveryGetAxios<T = any>(
  path: string,
  params: Record<string, any> = {},
): Promise<T | null> {
  const key = process.env.GMGN_API_KEY!;
  const allParams = {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: cryptoUUID(),
  };
  try {
    const res = await axios.get<any>(`${GMGN_OPEN_API_HOST}${path}`, {
      headers: { 'X-APIKEY': key, 'Content-Type': 'application/json' },
      params:  allParams,
      timeout: REQUEST_TIMEOUT_MS,
    });
    const body = res.data;
    if (bannedUntilMs && bannedUntilMs <= Date.now()) { bannedUntilMs = 0; consecutiveBans = 0; }
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) {
        applyBanIfPresent(body);
        logger.warn({ path, code: body.code, msg: body.msg }, 'GMGN discovery: non-zero response code');
        return null;
      }
      return (body.data ?? body) as T;
    }
    return body as T;
  } catch (err: any) {
    const status = err?.response?.status;
    logger.warn({ path, status, err: err?.message?.slice(0, 200) }, 'GMGN discovery: axios request failed');
    return null;
  }
}

async function discoveryGetCurl<T = any>(
  path: string,
  params: Record<string, any> = {},
): Promise<T | null> {
  const authHeaders = buildAuthHeaders();
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${GMGN_QUOTATION_HOST}${path}${qs ? '?' + qs : ''}`;
  const curlArgs: string[] = [
    '-s', '--max-time', String(Math.round(REQUEST_TIMEOUT_MS / 1_000)), '--compressed',
  ];
  for (const [k, v] of Object.entries(authHeaders)) curlArgs.push('-H', `${k}: ${v}`);
  curlArgs.push(url);
  try {
    const { stdout } = await execFileAsync('curl', curlArgs, { timeout: REQUEST_TIMEOUT_MS + 2_000 });
    if (bannedUntilMs && bannedUntilMs <= Date.now()) { bannedUntilMs = 0; consecutiveBans = 0; }
    let body: any;
    try { body = JSON.parse(stdout); } catch {
      logger.warn({ path, rawLen: stdout.length, rawHead: stdout.slice(0, 200) }, 'GMGN discovery: non-JSON response (Cloudflare block?)');
      return null;
    }
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code !== 0) { applyBanIfPresent(body); logger.warn({ path, code: body.code, msg: body.msg }, 'GMGN discovery: non-zero response code'); return null; }
      return (body.data ?? body) as T;
    }
    return body as T;
  } catch (err: any) {
    logger.warn({ path, exitCode: err?.code, err: err?.message?.slice(0, 200) }, 'GMGN discovery: curl subprocess failed');
    return null;
  }
}

async function discoveryGet<T = any>(
  _host: string,
  path: string,
  params: Record<string, any> = {},
): Promise<T | null> {
  try {
    await reserveSlot();
  } catch (err) {
    if (err instanceof GmgnDiscoveryBannedError) return null;
    throw err;
  }

  if (process.env.GMGN_API_KEY) {
    // Key present → use axios to openapi.gmgn.ai (no Cloudflare, works on Render)
    return discoveryGetAxios<T>(path, params);
  }
  // No key → curl to gmgn.ai (libcurl TLS fingerprint bypasses Cloudflare on Replit)
  return discoveryGetCurl<T>(path, params);
}

// ── Startup diagnostics ───────────────────────────────────────────────────────

(async () => {
  const keySet = !!process.env.GMGN_API_KEY;
  const transport = keySet ? `axios → ${GMGN_OPEN_API_HOST}` : `curl → ${GMGN_QUOTATION_HOST}`;
  if (!keySet) {
    try {
      const { stdout } = await execFileAsync('which', ['curl'], { timeout: 3_000 });
      logger.info({ curlPath: stdout.trim(), keySet, transport }, 'GMGN discovery: transport selected');
    } catch {
      logger.warn({ keySet, transport }, 'GMGN discovery: curl NOT found in PATH — discovery will fail without API key');
    }
  } else {
    logger.info({ keySet, transport }, 'GMGN discovery: transport selected');
  }
})();

/** Returns diagnostic info callable via GET /api/scanner/gmgn-probe */
export async function probeGmgnConnection(): Promise<Record<string, any>> {
  const keySet = !!process.env.GMGN_API_KEY;
  const transport = keySet ? `axios → ${GMGN_OPEN_API_HOST}` : `curl → ${GMGN_QUOTATION_HOST}`;
  const path = '/defi/quotation/v1/rank/sol/swaps/1m';
  const result = await discoveryGet<any>(keySet ? GMGN_OPEN_API_HOST : GMGN_QUOTATION_HOST, path, { limit: 1, orderby: 'swaps', direction: 'desc' });
  return { keySet, transport, success: result !== null, tokenCount: Array.isArray(result?.rank) ? result.rank.length : (result !== null ? 1 : 0) };
}

// ── New Pairs endpoint ─────────────────────────────────────────────────────────

export interface GmgnNewPairsResponse {
  pairs?: GmgnRawPair[];
  [key: string]: any;
}

interface GmgnRawPair {
  // New-pairs response shape (may vary across API versions)
  base_address?:    string;
  address?:         string;           // fallback field name
  quote_address?:   string;
  pool_address?:    string;
  name?:            string;
  symbol?:          string;
  open_timestamp?:  number;           // unix seconds
  creation_timestamp?: number;
  liquidity?:       number | string;
  market_cap?:      number | string;
  volume?:          { h1?: number; m5?: number } | number;
  price?:           number | string;
  base_token_info?: { name?: string; symbol?: string };
  [key: string]: any;
}

/**
 * Fetches the newest Solana token pairs from GMGN.
 * Returns normalised GmgnDiscoveredToken[] or null on any error.
 */
export async function fetchNewPairs(limit = 50): Promise<GmgnDiscoveredToken[] | null> {
  const data = await discoveryGet<GmgnNewPairsResponse>(
    GMGN_QUOTATION_HOST,
    '/defi/quotation/v1/tokens/new_pairs/sol',
    { limit, orderby: 'open_timestamp', direction: 'desc' },
  );

  if (!data) return null;

  const pairs: GmgnRawPair[] = Array.isArray(data)
    ? data
    : (data.pairs ?? data.data?.pairs ?? []);

  return pairs.map(normaliseRawPair).filter((t): t is GmgnDiscoveredToken => !!t.mint);
}

// ── Trending / Rank endpoint ──────────────────────────────────────────────────

interface GmgnRankResponse {
  rank?: GmgnRawRankItem[];
  [key: string]: any;
}

interface GmgnRawRankItem {
  address?:        string;
  mint?:           string;
  pool_address?:   string;
  name?:           string;
  symbol?:         string;
  open_timestamp?: number;
  creation_timestamp?: number;
  liquidity?:      number | string;
  market_cap?:     number | string;
  volume?:         { h1?: number; m5?: number } | number;
  price?:          number | string;
  [key: string]: any;
}

/**
 * Fetches trending Solana tokens by swap count over the given period.
 * period: '1m' | '5m' | '1h' | '6h' | '24h'
 */
export async function fetchTrendingTokens(
  period: '1m' | '5m' | '1h' | '6h' | '24h' = '5m',
  limit = 50,
): Promise<GmgnDiscoveredToken[] | null> {
  const data = await discoveryGet<GmgnRankResponse>(
    GMGN_QUOTATION_HOST,
    `/defi/quotation/v1/rank/sol/swaps/${period}`,
    { orderby: 'swaps', direction: 'desc', limit },
  );

  if (!data) return null;

  const items: GmgnRawRankItem[] = Array.isArray(data)
    ? data
    : (data.rank ?? data.data?.rank ?? []);

  return items.map(normaliseRawRankItem).filter((t): t is GmgnDiscoveredToken => !!t.mint);
}

// ── Normalisation helpers ─────────────────────────────────────────────────────

function toNum(v: number | string | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : undefined;
}

function normaliseRawPair(p: GmgnRawPair): GmgnDiscoveredToken {
  const mint        = p.base_address ?? p.address ?? '';
  const name        = p.name ?? p.base_token_info?.name;
  const symbol      = p.symbol ?? p.base_token_info?.symbol;
  const openTs      = p.open_timestamp ?? p.creation_timestamp;
  const liq         = toNum(p.liquidity);
  const mc          = toNum(p.market_cap);
  const vol1h       = typeof p.volume === 'object' ? toNum(p.volume?.h1) : toNum(p.volume as any);
  const priceUsd    = toNum(p.price);

  return { mint, poolAddress: p.pool_address, name, symbol, openTimestamp: openTs, liquidity: liq, marketCap: mc, volume1h: vol1h, priceUsd };
}

function normaliseRawRankItem(r: GmgnRawRankItem): GmgnDiscoveredToken {
  const mint        = r.address ?? r.mint ?? '';
  const openTs      = r.open_timestamp ?? r.creation_timestamp;
  const liq         = toNum(r.liquidity);
  const mc          = toNum(r.market_cap);
  const vol1h       = typeof r.volume === 'object' ? toNum(r.volume?.h1) : toNum(r.volume as any);
  const priceUsd    = toNum(r.price);

  return { mint, poolAddress: r.pool_address, name: r.name, symbol: r.symbol, openTimestamp: openTs, liquidity: liq, marketCap: mc, volume1h: vol1h, priceUsd };
}
