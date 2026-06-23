import { logger } from '../lib/logger.js';
import { scanTokens, getAllTokens, setDailyLossStatus, markTokenEntered } from './scanner.service.js';
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
  }, 10_000);

  logger.info('Auto-trader started');
}

async function runScanCycle(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    // CRITICAL: Sync DB open positions into in-memory cache BEFORE scanning.
    // On a server restart the cache is empty — if we scan first, opened tokens
    // get re-evaluated as ELIGIBLE for that cycle. Syncing first ensures
    // scanTokens() sees the correct ENTERED status and never re-marks them
    // ELIGIBLE, so the UI and checkEntries() are always in sync.
    const openPositionsPre = await getOpenPositions();
    for (const pos of openPositionsPre) {
      markTokenEntered(pos.mint);
    }

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

  let attempted = 0;
  let skippedDuplicate = 0;
  let skippedNotEligible = 0;
  let skippedConditions = 0;

  for (const token of tokens) {
    if (openPositions.length + attempted >= settings.maxOpenPositions) break;
    if (openMints.has(token.mint)) { skippedDuplicate++; continue; }
    if (token.status !== 'ELIGIBLE') { skippedNotEligible++; continue; }

    // Entry conditions
    const meetsScore = token.score >= settings.minEntryScore;
    const meetsBSR = token.buySellRatio >= settings.minBuySellRatio;
    const notFOMO = token.priceChange5m <= 50; // Block if pumped >50% in last 5 min

    if (!meetsScore || !meetsBSR || !notFOMO) {
      logger.info(
        { mint: token.mint, symbol: token.symbol, score: token.score, minEntryScore: settings.minEntryScore, bsr: token.buySellRatio, minBSR: settings.minBuySellRatio, priceChange5m: token.priceChange5m, meetsScore, meetsBSR, notFOMO },
        'Eligible token skipped — entry conditions not met'
      );
      skippedConditions++;
      continue;
    }

    const dexUrl = `https://dexscreener.com/solana/${token.mint}`;
    logger.info({ mint: token.mint, symbol: token.symbol, score: token.score }, 'Attempting to open position');
    const position = await openPosition({
      mint: token.mint,
      name: token.name,
      symbol: token.symbol,
      score: token.score,
      price: token.price,
      mc: token.marketCap,
      dexUrl,
    });
    if (position) {
      openMints.add(token.mint);
      attempted++;
    } else {
      logger.warn({ mint: token.mint, symbol: token.symbol }, 'openPosition returned null — skipping');
    }
  }

  logger.info({ attempted, skippedDuplicate, skippedNotEligible, skippedConditions }, 'checkEntries complete');
}

export function stopAutoTrader(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}
