import axios, { AxiosError } from 'axios';
import { logger } from '../lib/logger.js';
import { getOpenPositions, updatePositionPrice, closePosition } from './position.service.js';
import { broadcast } from '../websocket/server.js';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

const lastKnownPrice = new Map<string, number>();

// Track how many consecutive 3s ticks each position has had no price.
// After NO_PRICE_AUTO_CLOSE_TICKS (20 ticks = 60s), auto-close at last known price.
const noPriceTicks = new Map<string, number>();
const NO_PRICE_AUTO_CLOSE_TICKS = 20; // 20 × 3s = 60s

interface DexPair {
  baseToken?: { address: string };
  pairAddress?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  txns?: { h1?: { buys: number; sells: number } };
  liquidity?: { usd?: number };
}

interface DexPriceResult {
  pairs?: DexPair[];
  pair?: DexPair;
}

type PriceData = { price: number; mc: number; bsr: number; liquidity: number };

// ── 429 / rate-limit state ───────────────────────────────────────────────────
let consecutiveDex429s = 0;
let dexBackoffUntil = 0;          // epoch ms — don't touch DexScreener until this time
let dexBackoffMultiplier = 1;     // doubles on each consecutive 429

const MAX_DEX_429S_BEFORE_FALLBACK = 5;

function recordDex429(retryAfterSec: number): void {
  consecutiveDex429s++;
  dexBackoffMultiplier = Math.pow(2, consecutiveDex429s - 1);  // 1, 2, 4, 8, 16 …
  const waitMs = retryAfterSec * 1000 * dexBackoffMultiplier;
  dexBackoffUntil = Date.now() + waitMs;
  logger.warn(
    { consecutiveDex429s, retryAfterSec, dexBackoffMultiplier, waitSec: waitMs / 1000 },
    'DexScreener 429 — backing off'
  );
}

function recordDexSuccess(): void {
  if (consecutiveDex429s > 0) {
    logger.info({ after429s: consecutiveDex429s }, 'DexScreener recovered — resetting backoff');
  }
  consecutiveDex429s = 0;
  dexBackoffMultiplier = 1;
  dexBackoffUntil = 0;
}

function isDexBlocked(): boolean {
  return Date.now() < dexBackoffUntil;
}

function shouldUseFallback(): boolean {
  return consecutiveDex429s >= MAX_DEX_429S_BEFORE_FALLBACK;
}

// Parse Retry-After header — returns seconds (integer).
// Handles both numeric ("30") and HTTP-date formats.
function parseRetryAfter(header: string | undefined): number {
  if (!header) return 15;  // conservative default
  const n = parseInt(header, 10);
  if (!isNaN(n) && n > 0) return Math.min(n, 120);  // cap at 2 min
  // HTTP-date format
  const d = Date.parse(header);
  if (!isNaN(d)) return Math.max(5, Math.ceil((d - Date.now()) / 1000));
  return 15;
}

// ── GeckoTerminal fallback ───────────────────────────────────────────────────
// Endpoint: GET /networks/solana/pools/multi/{addresses}  (up to 30 per request)
const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';

interface GeckoPoolAttr {
  address?: string;
  base_token_price_usd?: string;
  market_cap_usd?: string;
  fdv_usd?: string;
  reserve_in_usd?: string;
  transactions?: { h1?: { buys: number; sells: number } };
}
interface GeckoPoolItem {
  attributes?: GeckoPoolAttr;
}
interface GeckoMultiResponse {
  data?: GeckoPoolItem[];
}

async function fetchGeckoByPairAddresses(pairAddresses: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (pairAddresses.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < pairAddresses.length; i += 30) chunks.push(pairAddresses.slice(i, i + 30));

  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await axios.get<GeckoMultiResponse>(
          `${GECKO_BASE}/networks/solana/pools/multi/${chunk.join(',')}`,
          { timeout: 8000, headers: { Accept: 'application/json;version=20230302' } }
        );
        for (const item of res.data?.data ?? []) {
          const attr = item.attributes;
          if (!attr?.address) continue;
          const price = parseFloat(attr.base_token_price_usd ?? '0');
          if (price <= 0) continue;
          const mc = parseFloat(attr.market_cap_usd ?? attr.fdv_usd ?? '0');
          const liquidity = parseFloat(attr.reserve_in_usd ?? '0');
          const h1 = attr.transactions?.h1 ?? { buys: 0, sells: 0 };
          const bsr = h1.sells > 0 ? h1.buys / h1.sells : h1.buys > 0 ? 99 : 1;
          result.set(attr.address.toLowerCase(), { price, mc, bsr, liquidity });
        }
      } catch (err) {
        logger.warn({ err }, 'GeckoTerminal price fallback error');
      }
    })
  );

  return result;
}

// ── DexScreener fetchers ─────────────────────────────────────────────────────

async function fetchByPairAddresses(pairAddresses: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (pairAddresses.length === 0) return result;

  if (isDexBlocked()) {
    logger.debug({ unblockIn: Math.ceil((dexBackoffUntil - Date.now()) / 1000) }, 'DexScreener blocked — skipping pair fetch');
    return result;
  }

  // All addresses fit in ≤30-address batches. With ≤20 open positions this is always 1 request.
  const chunks: string[][] = [];
  for (let i = 0; i < pairAddresses.length; i += 30) chunks.push(pairAddresses.slice(i, i + 30));

  try {
    await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await axios.get<DexPriceResult>(
            `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(',')}`,
            { timeout: 6000 }
          );
          recordDexSuccess();
          for (const pair of res.data?.pairs ?? []) {
            const pairAddr = pair.pairAddress;
            if (!pairAddr) continue;
            const price = parseFloat(pair.priceUsd ?? '0');
            if (price <= 0) continue;
            const mc = pair.marketCap ?? pair.fdv ?? 0;
            const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
            const bsr = h1.sells > 0 ? h1.buys / h1.sells : h1.buys > 0 ? 99 : 1;
            const liquidity = pair.liquidity?.usd ?? 0;
            result.set(pairAddr, { price, mc, bsr, liquidity });
          }
        } catch (err) {
          const axErr = err as AxiosError;
          if (axErr.response?.status === 429) {
            const retryAfter = parseRetryAfter(axErr.response.headers['retry-after'] as string | undefined);
            recordDex429(retryAfter);
          } else {
            logger.warn({ err }, 'Price fetch (by pair address) chunk error');
          }
        }
      })
    );
  } catch (err) {
    logger.warn({ err }, 'Price fetch (by pair address) error');
  }

  return result;
}

async function fetchByMints(mints: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (mints.length === 0) return result;

  if (isDexBlocked()) {
    logger.debug({ unblockIn: Math.ceil((dexBackoffUntil - Date.now()) / 1000) }, 'DexScreener blocked — skipping mint fetch');
    return result;
  }

  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

  for (const chunk of chunks) {
    try {
      const res = await axios.get<DexPriceResult>(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { timeout: 6000 }
      );
      recordDexSuccess();
      const activity = new Map<string, number>();
      for (const pair of res.data?.pairs ?? []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const price = parseFloat(pair.priceUsd ?? '0');
        if (price <= 0) continue;
        const mc = pair.marketCap ?? pair.fdv ?? 0;
        const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
        const bsr = h1.sells > 0 ? h1.buys / h1.sells : h1.buys > 0 ? 99 : 1;
        const h1Count = h1.buys + h1.sells;
        const prevActivity = activity.get(mint) ?? -1;
        if (h1Count > prevActivity) {
          const liquidity = pair.liquidity?.usd ?? 0;
          result.set(mint, { price, mc, bsr, liquidity });
          activity.set(mint, h1Count);
        }
      }
    } catch (err) {
      const axErr = err as AxiosError;
      if (axErr.response?.status === 429) {
        const retryAfter = parseRetryAfter(axErr.response.headers['retry-after'] as string | undefined);
        recordDex429(retryAfter);
        break; // stop hitting DexScreener for remaining chunks
      } else {
        logger.warn({ err }, 'Price fetch (by mint) chunk error');
      }
    }
  }

  return result;
}

function pairAddressFromDexUrl(dexUrl?: string): string | undefined {
  if (!dexUrl) return undefined;
  const m = dexUrl.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/);
  return m?.[1];
}

export function startPriceMonitor(): void {
  if (monitorInterval) return;

  // 3000ms interval — down from 500ms.
  // At 20 open positions: 1 batched DexScreener request per 3s = sustainable.
  // (500ms was 1 request per 500ms = 6 req/s = Cloudflare 1015 rate-limit territory)
  monitorInterval = setInterval(async () => {
    try {
      const positions = await getOpenPositions();
      if (positions.length === 0) return;

      const withPair: { pos: (typeof positions)[0]; pairAddr: string }[] = [];
      const mintOnly: (typeof positions)[0][] = [];

      for (const pos of positions) {
        const pairAddr = pairAddressFromDexUrl(pos.dexUrl);
        if (pairAddr) {
          withPair.push({ pos, pairAddr });
        } else {
          mintOnly.push(pos);
        }
      }

      let pairPrices: Map<string, PriceData>;
      let mintPrices: Map<string, PriceData>;

      if (shouldUseFallback()) {
        // DexScreener repeatedly rate-limiting — switch to GeckoTerminal
        logger.info(
          { consecutiveDex429s, fallback: 'GeckoTerminal' },
          'DexScreener rate-limited — using GeckoTerminal fallback for price data'
        );
        const pairAddrs = withPair.map((w) => w.pairAddr);
        // GeckoTerminal has no mint-based multi-fetch; mint-only positions get empty prices this cycle
        [pairPrices, mintPrices] = await Promise.all([
          fetchGeckoByPairAddresses(pairAddrs),
          Promise.resolve(new Map<string, PriceData>()),
        ]);
        // Normalize GeckoTerminal keys to lowercase for match (DexScreener uses mixed case)
        const normalizedPairPrices = new Map<string, PriceData>();
        for (const [k, v] of pairPrices) normalizedPairPrices.set(k.toLowerCase(), v);
        pairPrices = normalizedPairPrices;
      } else {
        [pairPrices, mintPrices] = await Promise.all([
          fetchByPairAddresses(withPair.map((w) => w.pairAddr)),
          fetchByMints(mintOnly.map((p) => p.mint)),
        ]);
      }

      // Build unified price map keyed by position ID
      const priceById = new Map<string, PriceData>();
      for (const { pos, pairAddr } of withPair) {
        const d = pairPrices.get(pairAddr) ?? pairPrices.get(pairAddr.toLowerCase());
        if (d && d.price > 0) priceById.set(pos.id, d);
      }
      for (const pos of mintOnly) {
        const d = mintPrices.get(pos.mint);
        if (d && d.price > 0) priceById.set(pos.id, d);
      }

      const enriched = positions.map((p) => {
        const data = priceById.get(p.id);
        const currentPrice = data && data.price > 0 ? data.price : p.entryPrice;
        const currentMc = data?.mc ?? p.entryMc;
        const bsr = data?.bsr ?? 1;
        const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlSol = p.sizeSol * (pnlPct / 100);
        return { ...p, currentPrice, currentMc, buySellRatio: bsr, pnlPct, pnlSol };
      });

      broadcast({ type: 'positions', data: enriched });

      for (const pos of positions) {
        const data = priceById.get(pos.id);
        if (data && data.price > 0) {
          // Price found — reset no-price counter
          noPriceTicks.delete(pos.id);
          const prev = lastKnownPrice.get(pos.id);
          const dropThreshold = pairAddressFromDexUrl(pos.dexUrl) ? 0.45 : 0.40;
          if (prev && data.price < prev * dropThreshold) {
            logger.warn(
              {
                id: pos.id, symbol: pos.symbol,
                prevPrice: prev, newPrice: data.price,
                dropPct: (((prev - data.price) / prev) * 100).toFixed(1),
                source: pairAddressFromDexUrl(pos.dexUrl) ? 'pair' : 'mint',
              },
              'Price sanity gate: >55% single-tick drop rejected — skipping SL check this cycle'
            );
          } else {
            lastKnownPrice.set(pos.id, data.price);
            updatePositionPrice(pos.id, data.price, data.bsr, data.liquidity).catch((err) =>
              logger.warn({ err, id: pos.id }, 'Price update error')
            );
          }
        } else {
          // No price from any source — increment staleness counter
          const ticks = (noPriceTicks.get(pos.id) ?? 0) + 1;
          noPriceTicks.set(pos.id, ticks);
          logger.warn({ mint: pos.mint, id: pos.id, symbol: pos.symbol, noPriceTicks: ticks, threshold: NO_PRICE_AUTO_CLOSE_TICKS }, 'No price for open position — SL check skipped');

          if (ticks >= NO_PRICE_AUTO_CLOSE_TICKS) {
            // Token has had no price for 60+ seconds — likely dead/rugged/delisted.
            // Close at last known price so PnL is as accurate as possible.
            const closePrice = lastKnownPrice.get(pos.id) ?? pos.entryPrice;
            logger.warn({ id: pos.id, symbol: pos.symbol, closePrice, ticks }, 'Auto-closing position: no price data for 60s — token likely dead or rugged');
            noPriceTicks.delete(pos.id);
            lastKnownPrice.delete(pos.id);
            closePosition(pos.id, closePrice, 'Auto-closed: no price data for 60s — token dead or rugged').catch((err) =>
              logger.warn({ err, id: pos.id }, 'Auto-close error')
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Price monitor cycle error');
    }
  }, 3000);

  logger.info('Price monitor started (3000ms interval)');
}

export function stopPriceMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
