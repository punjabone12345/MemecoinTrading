import { logger } from '../lib/logger.js';
import { scanTokens, getAllTokens, setDailyLossStatus } from './scanner.service.js';
import { getSettings } from './settings.service.js';
import { openPosition, getOpenPositions } from './position.service.js';
import { getBalance } from './settings.service.js';
import { query } from '../lib/db.js';
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
    // Re-broadcast after entries so the UI immediately reflects ENTERED status
    await broadcastTokens();
  } catch (err) {
    logger.error({ err }, 'Scan cycle error');
  } finally {
    isRunning = false;
  }
}

async function checkEntries(): Promise<void> {
  const settings = await getSettings();
  const balance = await getBalance();

  // Check daily loss limit upfront so we can surface it in the UI
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayRows = await query<{ pnl_sol: string }>(`
    SELECT pnl_sol FROM positions WHERE status = 'CLOSED' AND exit_time >= $1
  `, [today.toISOString()]);
  const dailyPnl = todayRows.reduce((s, r) => s + parseFloat(r.pnl_sol ?? '0'), 0);
  const dailyLossLimit = -(balance * settings.maxDailyLossPct / 100);
  const limitHit = dailyPnl <= dailyLossLimit;

  // Publish the daily loss status so the scanner stats and UI can show it
  setDailyLossStatus(limitHit, dailyPnl, dailyLossLimit);

  if (limitHit) {
    logger.info({ dailyPnl, dailyLossLimit }, 'Daily loss limit hit, no new entries');
    return;
  }

  const tokens = getAllTokens();
  const openPositions = await getOpenPositions();
  const openMints = new Set(openPositions.map((p) => p.mint));

  for (const token of tokens) {
    if (openPositions.length >= settings.maxOpenPositions) break;
    if (openMints.has(token.mint)) continue;
    if (token.status !== 'ELIGIBLE') continue;

    // Entry conditions
    const meetsScore = token.score >= settings.minEntryScore;
    const meetsBSR = token.buySellRatio >= settings.minBuySellRatio;
    const notFOMO = token.priceChange5m <= 50; // Block if pumped >50% in last 5 min

    if (meetsScore && meetsBSR && notFOMO) {
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
