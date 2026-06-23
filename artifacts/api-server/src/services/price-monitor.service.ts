import axios from 'axios';
import { logger } from '../lib/logger.js';
import { getOpenPositions, updatePositionPrice } from './position.service.js';
import { broadcast } from '../websocket/server.js';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

interface DexPair {
  baseToken?: { address: string };
  pairAddress?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  txns?: { h1?: { buys: number; sells: number } };
}

interface DexPriceResult {
  pairs?: DexPair[];
  pair?: DexPair;
}

type PriceData = { price: number; mc: number; bsr: number };

async function fetchByMints(mints: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (mints.length === 0) return result;

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

    for (const chunk of chunks) {
      const res = await axios.get<DexPriceResult>(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { timeout: 6000 }
      );
      for (const pair of res.data?.pairs ?? []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const price = parseFloat(pair.priceUsd ?? '0');
        const mc = pair.marketCap ?? pair.fdv ?? 0;
        const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
        const bsr = h1.sells > 0 ? h1.buys / h1.sells : h1.buys > 0 ? 99 : 1;

        // Keep the entry with the HIGHEST price (most liquid pair is usually primary).
        // Using highest avoids false SL triggers from stale low-liq pools.
        // SL guard is conservative enough (25%) that a real dump clears it anyway.
        const existing = result.get(mint);
        if (!existing || price > existing.price) {
          result.set(mint, { price, mc, bsr });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Price fetch (by mint) error');
  }

  return result;
}

// Fallback: fetch by pair address for positions whose mint returned price=0
async function fetchByPairAddress(pairAddress: string): Promise<number> {
  try {
    const res = await axios.get<DexPriceResult>(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`,
      { timeout: 6000 }
    );
    const pair = res.data?.pair ?? res.data?.pairs?.[0];
    return parseFloat(pair?.priceUsd ?? '0');
  } catch {
    return 0;
  }
}

// Extract pair address from DexScreener URL like https://dexscreener.com/solana/<pair>
function pairAddressFromDexUrl(dexUrl?: string): string | undefined {
  if (!dexUrl) return undefined;
  const m = dexUrl.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/);
  return m?.[1];
}

export function startPriceMonitor(): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const positions = await getOpenPositions();
      if (positions.length === 0) return;

      const mints = positions.map((p) => p.mint);
      const prices = await fetchByMints(mints);

      // Fallback: for any open position with price=0, try fetching by pair address
      const fallbackFetches = positions
        .filter((p) => {
          const d = prices.get(p.mint);
          return !d || d.price === 0;
        })
        .map(async (p) => {
          const pairAddr = pairAddressFromDexUrl(p.dexUrl);
          if (!pairAddr) return;
          const price = await fetchByPairAddress(pairAddr);
          if (price > 0) {
            prices.set(p.mint, { price, mc: p.entryMc, bsr: 1 });
          }
        });

      if (fallbackFetches.length > 0) {
        await Promise.all(fallbackFetches);
      }

      const enriched = positions.map((p) => {
        const data = prices.get(p.mint);
        const currentPrice = data && data.price > 0 ? data.price : p.entryPrice;
        const currentMc = data?.mc ?? p.entryMc;
        const bsr = data?.bsr ?? 1;
        const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlSol = p.sizeSol * (pnlPct / 100);

        return { ...p, currentPrice, currentMc, buySellRatio: bsr, pnlPct, pnlSol };
      });

      broadcast({ type: 'positions', data: enriched });

      // Run SL/TP checks for every position with a valid price
      for (const pos of positions) {
        const data = prices.get(pos.mint);
        if (data && data.price > 0) {
          updatePositionPrice(pos.id, data.price).catch((err) =>
            logger.warn({ err, id: pos.id }, 'Price update error')
          );
        } else {
          logger.warn({ mint: pos.mint, id: pos.id }, 'No price for open position — SL check skipped');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Price monitor cycle error');
    }
  }, 1000);

  logger.info('Price monitor started (1s interval)');
}

export function stopPriceMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
