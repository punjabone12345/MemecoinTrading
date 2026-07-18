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
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────
//
// Discovery endpoints live on gmgn.ai (the web-app quotation API), NOT on
// openapi.gmgn.ai (which is the wallet-analytics OpenAPI only).
// Sending X-APIKEY to gmgn.ai bypasses its Cloudflare bot-detection layer,
// so discovery only works from environments where GMGN_API_KEY is set.
//
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
// Uses a `curl` subprocess instead of axios/fetch.
//
// Rationale: Cloudflare on gmgn.ai blocks Node.js HTTP clients (axios, fetch,
// undici) based on their TLS/JA3 fingerprint even when X-APIKEY is present,
// returning 403. The system `curl` binary uses libcurl's TLS stack which
// Cloudflare allows through. Spawning curl is the simplest reliable workaround
// and is available on both Replit and Render without any extra packages.

async function discoveryGet<T = any>(
  host: string,
  path: string,
  params: Record<string, any> = {},
): Promise<T | null> {
  try {
    await reserveSlot();
  } catch (err) {
    if (err instanceof GmgnDiscoveryBannedError) return null;
    throw err;
  }

  const authParams  = buildAuthParams();
  const authHeaders = buildAuthHeaders();

  // Build query string
  const allParams = { ...params, ...authParams };
  const qs = Object.entries(allParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${host}${path}${qs ? '?' + qs : ''}`;

  // Build curl args
  const curlArgs: string[] = [
    '-s',                                       // silent
    '--max-time', String(Math.round(REQUEST_TIMEOUT_MS / 1_000)),
    '--compressed',                             // accept gzip
  ];
  for (const [k, v] of Object.entries(authHeaders)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }
  curlArgs.push(url);

  try {
    const { stdout } = await execFileAsync('curl', curlArgs, { timeout: REQUEST_TIMEOUT_MS + 2_000 });

    // Clear ban state on success
    if (bannedUntilMs && bannedUntilMs <= Date.now()) {
      bannedUntilMs   = 0;
      consecutiveBans = 0;
    }

    let body: any;
    try {
      body = JSON.parse(stdout);
    } catch {
      logger.debug({ path, rawLen: stdout.length }, 'GMGN discovery: non-JSON response (Cloudflare HTML?)');
      return null;
    }

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
    // curl exit codes: 28 = timeout, 6 = DNS, 7 = connection refused
    const exitCode = err?.code;
    logger.debug({ path, exitCode, err: err?.message?.slice(0, 120) }, 'GMGN discovery: curl subprocess failed');
    return null;
  }
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
 * period: '5m' | '1h' | '6h' | '24h'
 */
export async function fetchTrendingTokens(
  period: '5m' | '1h' | '6h' | '24h' = '5m',
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
