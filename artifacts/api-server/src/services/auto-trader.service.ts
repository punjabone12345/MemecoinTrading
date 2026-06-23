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
  let skippedNoPrice = 0;

  for (const token of tokens) {
    if (openPositions.length + attempted >= settings.maxOpenPositions) {
      logger.info({ openCount: openPositions.length, attempted, max: settings.maxOpenPositions }, 'Max open positions reached — stopping entry loop');
      break;
    }
    if (openMints.has(token.mint)) { skippedDuplicate++; continue; }

    // ELIGIBLE is already a full gate: scanner sets it only when ALL filter checks pass
    // AND score >= minEntryScore. Do NOT re-check those same conditions here — a
    // settings read race between scanTokens() and checkEntries() can cause valid
    // ELIGIBLE tokens to be blocked by a stale/different minEntryScore value.
    if (token.status !== 'ELIGIBLE') { skippedNotEligible++; continue; }

    // Guard: skip if scanner returned price=0 (DexScreener missing priceUsd)
    // We can't open a position without an entry price.
    if (!token.price || token.price <= 0) {
      logger.warn({ mint: token.mint, symbol: token.symbol }, 'ELIGIBLE token has price=0 — skipping until price is available');
      skippedNoPrice++;
      continue;
    }

    const dexUrl = `https://dexscreener.com/solana/${token.mint}`;
    logger.info(
      { mint: token.mint, symbol: token.symbol, score: token.score, price: token.price, mc: token.marketCap, bsr: token.buySellRatio },
      'ELIGIBLE token found — attempting to open position'
    );
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
      logger.info({ mint: token.mint, symbol: token.symbol, positionId: position.id }, 'Position opened successfully');
    } else {
      logger.warn({ mint: token.mint, symbol: token.symbol, score: token.score, balance, maxOpen: settings.maxOpenPositions }, 'openPosition returned null — check balance/maxPositions/dailyLoss');
    }
  }

  logger.info({ attempted, skippedDuplicate, skippedNotEligible, skippedNoPrice }, 'checkEntries complete');
}

export function stopAutoTrader(): void {
  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
}
