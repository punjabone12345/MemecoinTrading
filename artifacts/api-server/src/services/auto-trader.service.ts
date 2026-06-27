import { logger } from '../lib/logger.js';
import { scanTokens, getAllTokens, setDailyLossStatus, markTokenEntered, setTradedTodayMints } from './scanner.service.js';
import { getSettings } from './settings.service.js';
import { openPosition, getOpenPositions } from './position.service.js';
import { getBalance } from './settings.service.js';
import { query } from '../lib/db.js';
import { broadcastTokens } from '../websocket/server.js';

// ── Two independent loops ────────────────────────────────────────────────────
//
// FETCH loop  (slow, ~15s):  Calls scanTokens() → hits DexScreener/GeckoTerminal
//                             APIs and refreshes the in-memory tokenCache.
//
// CHECK loop  (fast, 1s):    Calls checkEntries() → reads from tokenCache only,
//                             no external API calls. Evaluates every cached token
//                             for entry every second so we never miss a brief
//                             momentum window between data fetches.
//
// Decoupling these means we can watch 500–1000+ tokens for entry conditions
// every single second without hammering external APIs.
// ────────────────────────────────────────────────────────────────────────────

let fetchTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let isFetching = false;
let isChecking = false;
let traderStarted = false;

// Cached daily-loss state — refreshed every 10s inside the check loop
// so we don't hammer the DB on every 1s tick.
let cachedDailyPnl = 0;
let cachedDailyLossLimit = 0;
let cachedLimitHit = false;
let lastDailyLossCheck = 0;
const DAILY_LOSS_CACHE_MS = 10_000;

// Cached traded-today mints — refreshed every 30s (mints don't change often)
let lastTradedTodayCheck = 0;
const TRADED_TODAY_CACHE_MS = 30_000;
let cachedTradedTodayMints = new Set<string>();

export function startAutoTrader(): void {
  if (traderStarted) return;
  traderStarted = true;

  // ── FETCH loop ──────────────────────────────────────────────────────────
  // Self-scheduling setTimeout loop — re-reads scanFrequencyMs from settings
  // on every cycle, so changing it in the UI takes effect on the NEXT fetch
  // without restarting the server.
  const DEFAULT_FETCH_MS = 15_000;

  async function runFetch(): Promise<void> {
    if (isFetching) return;
    isFetching = true;
    try {
      // CRITICAL: Sync DB open positions into in-memory cache BEFORE scanning.
      // On server restart the cache is empty — syncing first ensures scanTokens()
      // sees the correct ENTERED status and never re-marks open positions ELIGIBLE.
      const openPositionsPre = await getOpenPositions();
      for (const pos of openPositionsPre) {
        markTokenEntered(pos.mint);
      }
      await scanTokens();
      await broadcastTokens();
    } catch (err) {
      logger.error({ err }, 'Fetch cycle error');
    } finally {
      isFetching = false;
    }
  }

  async function scheduleFetch(): Promise<void> {
    const settings = await getSettings().catch(() => null);
    const delay = Math.max(5_000, settings?.scanFrequencyMs ?? DEFAULT_FETCH_MS);
    fetchTimeout = setTimeout(async () => {
      await runFetch();
      scheduleFetch(); // reschedule — picks up any scanFrequencyMs change
    }, delay);
  }

  runFetch();     // immediate first run
  scheduleFetch(); // start the self-rescheduling timer

  // ── CHECK loop (1s) ─────────────────────────────────────────────────────
  // Reads from the already-populated tokenCache — no API calls.
  // Checks every cached token for entry conditions every second.
  // NOTE: broadcastTokens() is NOT called here — only after a FETCH cycle
  // or when a trade fires. Broadcasting 1000+ tokens every second was the
  // single biggest performance killer.
  checkInterval = setInterval(async () => {
    if (isChecking) return;
    isChecking = true;
    try {
      await checkEntries();
    } catch (err) {
      logger.error({ err }, 'Check cycle error');
    } finally {
      isChecking = false;
    }
  }, 1_000);

  logger.info('Auto-trader started');
}

async function checkEntries(): Promise<void> {
  const settings = await getSettings();
  const balance = await getBalance();
  const nowMs = Date.now();

  // ── Daily loss limit — cached, refreshed every 10s ──────────────────────
  if (nowMs - lastDailyLossCheck > DAILY_LOSS_CACHE_MS) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRows = await query<{ pnl_sol: string }>(`
      SELECT pnl_sol FROM positions WHERE status = 'CLOSED' AND exit_time >= $1
    `, [today.toISOString()]);
    cachedDailyPnl = todayRows.reduce((s, r) => s + parseFloat(r.pnl_sol ?? '0'), 0);
    cachedDailyLossLimit = -(balance * settings.maxDailyLossPct / 100);
    cachedLimitHit = cachedDailyPnl <= cachedDailyLossLimit;
    setDailyLossStatus(cachedLimitHit, cachedDailyPnl, cachedDailyLossLimit);
    lastDailyLossCheck = nowMs;
  }

  if (cachedLimitHit) {
    logger.debug({ dailyPnl: cachedDailyPnl, dailyLossLimit: cachedDailyLossLimit }, 'Daily loss limit hit, no new entries');
    return;
  }

  // ── Traded-today mints — cached, refreshed every 30s ────────────────────
  if (nowMs - lastTradedTodayCheck > TRADED_TODAY_CACHE_MS) {
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istMidnightMs = Math.floor((nowMs + istOffsetMs) / 86_400_000) * 86_400_000 - istOffsetMs;
    const tradedTodayRows = await query<{ mint: string }>(`
      SELECT DISTINCT mint FROM positions WHERE entry_time >= $1
    `, [new Date(istMidnightMs).toISOString()]);
    cachedTradedTodayMints = new Set(tradedTodayRows.map((r) => r.mint));
    setTradedTodayMints(cachedTradedTodayMints);
    lastTradedTodayCheck = nowMs;
  }

  const tokens = getAllTokens();
  const openPositions = await getOpenPositions();
  const openMints = new Set(openPositions.map((p) => p.mint));

  let attempted = 0;
  let skippedDuplicate = 0;
  let skippedTradedToday = 0;
  let skippedNotEligible = 0;
  let skippedNoPrice = 0;

  for (const token of tokens) {
    if (openPositions.length + attempted >= settings.maxOpenPositions) {
      logger.debug({ openCount: openPositions.length, attempted, max: settings.maxOpenPositions }, 'Max open positions reached — stopping entry loop');
      break;
    }
    if (openMints.has(token.mint)) {
      skippedDuplicate++; continue;
    }
    if (cachedTradedTodayMints.has(token.mint)) {
      logger.info({ mint: token.mint, symbol: token.symbol }, 'SKIP: already traded today (no re-entry until IST midnight)');
      skippedTradedToday++; continue;
    }

    // ELIGIBLE is already a full gate: scanner sets it only when ALL filter checks pass
    // AND score >= minEntryScore. Do NOT re-check those conditions here.
    if (token.status !== 'ELIGIBLE') {
      skippedNotEligible++; continue;
    }

    // Guard: skip if scanner returned price=0 (DexScreener missing priceUsd)
    if (!token.price || token.price <= 0) {
      logger.warn({ mint: token.mint, symbol: token.symbol }, 'ELIGIBLE token has price=0 — skipping until price is available');
      skippedNoPrice++;
      continue;
    }

    // Use pair-specific URL so the price monitor fallback fetcher can resolve
    // the correct pool, and the DEX button links to the right pair page.
    const dexUrl = `https://dexscreener.com/solana/${token.pairAddress || token.mint}`;
    logger.info(
      { mint: token.mint, symbol: token.symbol, score: token.score, price: token.price, mc: token.marketCap, bsr: token.buySellRatio },
      'ELIGIBLE token found — attempting to open position'
    );
    // Lock this mint immediately — before the async openPosition() call.
    // Without this, if openPosition() is slow (DB write, RPC), the next 1s
    // check tick could race in and see the mint as not-yet-open and enter again.
    cachedTradedTodayMints.add(token.mint);

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
      // Keep the mint in cachedTradedTodayMints so it won't be re-entered even
      // after the position closes (e.g. quick SL) within the 30s cache window.
      // The DB query on next cache refresh will also confirm it.
      setTradedTodayMints(cachedTradedTodayMints);
      logger.info({ mint: token.mint, symbol: token.symbol, positionId: position.id }, 'Position opened successfully');
    } else {
      // openPosition() rejected for a non-entry reason (balance, max positions, etc.)
      // Remove the optimistic lock so the token can be retried next tick.
      cachedTradedTodayMints.delete(token.mint);
      logger.warn({ mint: token.mint, symbol: token.symbol, score: token.score, balance, maxOpen: settings.maxOpenPositions }, 'openPosition returned null — check balance/maxPositions/dailyLoss');
    }
  }

  if (attempted > 0 || skippedTradedToday > 0) {
    logger.info({ attempted, skippedDuplicate, skippedTradedToday, skippedNotEligible, skippedNoPrice }, 'checkEntries complete');
  }
}

export function stopAutoTrader(): void {
  if (fetchTimeout) { clearTimeout(fetchTimeout); fetchTimeout = null; }
  traderStarted = false;
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
}
