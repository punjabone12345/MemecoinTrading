import axios from 'axios';
import { logger } from '../lib/logger.js';
import { getOpenPositions, updatePositionPrice } from './position.service.js';
import { broadcast } from '../websocket/server.js';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

// Last confirmed good price per position ID.
// Used to reject DexScreener ticks that look like bad data (>60% drop in 1s).
const lastKnownPrice = new Map<string, number>();

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

// PRIMARY: fetch by pair address — targeted, real-time, no multi-pool aggregation lag.
// Used for all open positions that have a dexUrl (pair address known at entry time).
// Much faster than mint-based fetch during volatile dumps because DexScreener serves
// a single specific pool rather than aggregating across all pools for the token.
async function fetchByPairAddresses(pairAddresses: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (pairAddresses.length === 0) return result;

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < pairAddresses.length; i += 30) chunks.push(pairAddresses.slice(i, i + 30));

    await Promise.all(
      chunks.map(async (chunk) => {
        const res = await axios.get<DexPriceResult>(
          `https://api.dexscreener.com/latest/dex/pairs/solana/${chunk.join(',')}`,
          { timeout: 4000 }
        );
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
      })
    );
  } catch (err) {
    logger.warn({ err }, 'Price fetch (by pair address) error');
  }

  return result;
}

// FALLBACK: fetch by mint — used when position has no dexUrl / pair address unknown.
async function fetchByMints(mints: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (mints.length === 0) return result;

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

    for (const chunk of chunks) {
      const res = await axios.get<DexPriceResult>(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { timeout: 4000 }
      );
      // Track txn activity count per mint to pick the most active pair.
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
    }
  } catch (err) {
    logger.warn({ err }, 'Price fetch (by mint) error');
  }

  return result;
}

// Extract pair address from DexScreener URL like https://dexscreener.com/solana/<pair>
function pairAddressFromDexUrl(dexUrl?: string): string | undefined {
  if (!dexUrl) return undefined;
  const m = dexUrl.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/);
  return m?.[1];
}

export function startPriceMonitor(): void {
  if (monitorInterval) return;

  // 500ms interval — halves reaction time vs 1s for trailing SL / hard SL.
  // Fast memecoins can dump 30%+ in 2 seconds; every 500ms saved matters.
  monitorInterval = setInterval(async () => {
    try {
      const positions = await getOpenPositions();
      if (positions.length === 0) return;

      // Split positions into: pair-address known (primary) vs mint-only (fallback)
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

      // Fetch both in parallel
      const [pairPrices, mintPrices] = await Promise.all([
        fetchByPairAddresses(withPair.map((w) => w.pairAddr)),
        fetchByMints(mintOnly.map((p) => p.mint)),
      ]);

      // Build unified price map keyed by position ID
      const priceById = new Map<string, PriceData>();
      for (const { pos, pairAddr } of withPair) {
        const d = pairPrices.get(pairAddr);
        if (d && d.price > 0) priceById.set(pos.id, d);
      }
      for (const pos of mintOnly) {
        const d = mintPrices.get(pos.mint);
        if (d && d.price > 0) priceById.set(pos.id, d);
      }

      // Build enriched list for UI broadcast
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

      // SL/TP checks — run for every position with a valid price
      for (const pos of positions) {
        const data = priceById.get(pos.id);
        if (data && data.price > 0) {
          const prev = lastKnownPrice.get(pos.id);

          // Sanity gate: reject a tick that is >60% below the last known price.
          // DexScreener occasionally serves stale/wrong prices from a de-listed pair.
          // Use a tighter 50% gate for the pair-address fetch (those are single-pool,
          // less likely to be a pool-switch artifact) vs mint fetch.
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
          logger.warn({ mint: pos.mint, id: pos.id }, 'No price for open position — SL check skipped');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Price monitor cycle error');
    }
  }, 500);

  logger.info('Price monitor started (500ms interval)');
}

export function stopPriceMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
