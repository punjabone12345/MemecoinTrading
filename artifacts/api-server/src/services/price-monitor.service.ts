import axios from 'axios';
import { logger } from '../lib/logger.js';
import { getOpenPositions, updatePositionPrice } from './position.service.js';
import { broadcast } from '../websocket/server.js';

let monitorInterval: ReturnType<typeof setInterval> | null = null;

interface DexPriceResult {
  pairs?: Array<{
    baseToken: { address: string };
    priceUsd?: string;
    marketCap?: number;
    fdv?: number;
    txns?: { h1?: { buys: number; sells: number } };
  }>;
}

async function fetchPrices(mints: string[]): Promise<Map<string, { price: number; mc: number; bsr: number }>> {
  const result = new Map<string, { price: number; mc: number; bsr: number }>();
  if (mints.length === 0) return result;

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));

    for (const chunk of chunks) {
      const res = await axios.get<DexPriceResult>(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
        { timeout: 5000 }
      );
      for (const pair of res.data?.pairs ?? []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const price = parseFloat(pair.priceUsd ?? '0');
        const mc = pair.marketCap ?? pair.fdv ?? 0;
        const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
        const bsr = h1.sells > 0 ? h1.buys / h1.sells : h1.buys > 0 ? 99 : 1;
        if (!result.has(mint) || price > 0) {
          result.set(mint, { price, mc, bsr });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Price fetch error');
  }

  return result;
}

export function startPriceMonitor(): void {
  if (monitorInterval) return;

  monitorInterval = setInterval(async () => {
    try {
      const positions = await getOpenPositions();
      if (positions.length === 0) return;

      const mints = positions.map((p) => p.mint);
      const prices = await fetchPrices(mints);

      const enriched = positions.map((p) => {
        const data = prices.get(p.mint);
        const currentPrice = data?.price ?? p.entryPrice;
        const currentMc = data?.mc ?? p.entryMc;
        const bsr = data?.bsr ?? 1;
        const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100;
        const pnlSol = p.sizeSol * (pnlPct / 100);

        return {
          ...p,
          currentPrice,
          currentMc,
          buySellRatio: bsr,
          pnlPct,
          pnlSol,
        };
      });

      // Broadcast live price update to all connected clients
      broadcast({ type: 'positions', data: enriched });

      // Update each position's TP/SL in the background
      for (const pos of positions) {
        const data = prices.get(pos.mint);
        if (data && data.price > 0) {
          updatePositionPrice(pos.id, data.price).catch((err) =>
            logger.warn({ err, id: pos.id }, 'Price update error')
          );
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
