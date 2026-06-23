import { logger } from '../lib/logger.js';
import { scanTokens, getAllTokens } from './scanner.service.js';
import { getSettings } from './settings.service.js';
import { openPosition, getOpenPositions } from './position.service.js';
import { broadcastTokens } from '../websocket/server.js';

let scanInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

export function startAutoTrader(): void {
  if (scanInterval) return;

  // Run immediately
  runScanCycle();

  scanInterval = setInterval(async () => {
    await runScanCycle();
  }, 30_000);

  logger.info('Auto-trader started');
}

async function runScanCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    await scanTokens();
    await broadcastTokens();
    await checkEntries();
  } catch (err) {
    logger.error({ err }, 'Scan cycle error');
  } finally {
    isRunning = false;
  }
}

async function checkEntries(): Promise<void> {
  const settings = await getSettings();
  const tokens = getAllTokens();
  const openPositions = await getOpenPositions();
  const openMints = new Set(openPositions.map((p) => p.mint));

  for (const token of tokens) {
    if (openPositions.length >= settings.maxOpenPositions) break;
    if (openMints.has(token.mint)) continue;
    if (token.status !== 'ELIGIBLE') continue;

    // Entry conditions
    const meetsScore = token.score >= settings.minEntryScore;
    const meetsTrend = token.consecutiveTrending >= settings.trendChecksRequired;
    const meetsBSR = token.buySellRatio >= settings.minBuySellRatio;
    const notFOMO = token.priceChange5m <= 50; // Block hyper-pumps (>50% in 5m)

    if (meetsScore && meetsTrend && meetsBSR && notFOMO) {
      const dexUrl = `https://dexscreener.com/solana/${token.mint}`;
      await openPosition({
        mint: token.mint,
        name: token.name,
        symbol: token.symbol,
        score: token.score,
        price: token.price,
        mc: token.marketCap,
        dexUrl,
      });
      openMints.add(token.mint);
    }
  }
}

export function stopAutoTrader(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}
