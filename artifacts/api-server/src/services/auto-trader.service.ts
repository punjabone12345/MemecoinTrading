import axios from 'axios';
import { logger } from '../lib/logger.js';
import { scanTokens, getAllTokens, setDailyLossStatus, markTokenEntered, setTradedTodayMints, hotRefreshScanningTokens } from './scanner.service.js';
import { getSettings } from './settings.service.js';
import { openPosition, getOpenPositions } from './position.service.js';
import { getBalance } from './settings.service.js';
import { query } from '../lib/db.js';
import { broadcastTokens } from '../websocket/server.js';

/**
 * Fetch the real-time entry price by MINT address at trade execution time.
 *
 * Why by mint, not pairAddress:
 *   Querying by pairAddress can silently return the pumpfun bonding-curve pair
 *   if that address was cached (price ~5-10x lower than the real market price).
 *   Fetching by mint gives us ALL pairs for the token so we can:
 *     1. Filter out every pumpfun bonding-curve pair (dexId='pumpfun')
 *     2. Pick the most liquid remaining pair — highest confidence real price
 *   This is the same logic DexScreener's own UI uses to display the "main" price.
 *
 * Returns { price, pairAddress } so the caller can also update the stored pair URL.
 * Falls back to the cached price if the API call fails or returns no valid pairs.
 */
async function fetchLiveEntryPrice(
  mint: string,
  fallback: number
): Promise<{ price: number; pairAddress: string | null }> {
  try {
    const res = await axios.get<{
      pairs?: { priceUsd?: string; dexId?: string; pairAddress?: string; liquidity?: { usd?: number } }[];
    }>(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 6000 }
    );

    const valid = (res.data?.pairs ?? [])
      .filter((p) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
      .filter((p) => parseFloat(p.priceUsd ?? '0') > 0)
      // Most liquid pair = most reliable price (matches what DexScreener UI shows)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    if (valid.length > 0) {
      const best = valid[0];
      const price = parseFloat(best.priceUsd!);
      logger.info(
        { mint, price, dexId: best.dexId, pairAddress: best.pairAddress, liquidity: best.liquidity?.usd },
        'Live entry price fetched by mint'
      );
      return { price, pairAddress: best.pairAddress ?? null };
    }
  } catch (err) {
    logger.warn({ err, mint }, 'Live entry price fetch failed — using cached price');
  }
  return { price: fallback, pairAddress: null };
}

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

// ── Post-restart guard ───────────────────────────────────────────────────────
// On restart the scanner re-discovers ALL tokens currently on DexScreener,
// including old graduations from hours ago. We only want to trade tokens that
// graduated AFTER this server instance started.
//
// Two guards in checkEntries():
//   1. preStartupMints — all mints already in detected_migrations at boot time.
//      Populated once in startAutoTrader() before any scanning begins.
//   2. Pair-age check — any DexScreener token whose pool is older than this
//      server has been running is skipped (it graduated before restart).
// ────────────────────────────────────────────────────────────────────────────
const STARTUP_TIME_MS = Date.now();
const preStartupMints = new Set<string>();

let fetchTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let hotRefreshInterval: ReturnType<typeof setInterval> | null = null;
let isFetching = false;
let isChecking = false;
let isHotRefreshing = false;
let traderStarted = false;

// Cached daily-loss state — refreshed every 10s inside the check loop
// so we don't hammer the DB on every 1s tick.
let cachedDailyPnl = 0;
let cachedDailyLossLimit = 0;
let cachedLimitHit = false;
let lastDailyLossCheck = 0;
const DAILY_LOSS_CACHE_MS = 10_000;

// Cached ever-traded mints — refreshed every 30s (mints don't change often).
// Once a mint is traded it is NEVER re-entered, even after the position closes
// or the server restarts. The full historical positions table is queried so
// there is no date boundary.
let lastTradedTodayCheck = 0;
const TRADED_TODAY_CACHE_MS = 30_000;
let cachedTradedTodayMints = new Set<string>();

export function startAutoTrader(): void {
  if (traderStarted) return;
  traderStarted = true;

  // ── Snapshot pre-existing mints before scanning starts ──────────────────
  // Load every mint already in detected_migrations so we never trade a token
  // that graduated before this restart. This runs once, synchronously queued,
  // before the first fetch loop executes.
  query<{ mint: string }>(`SELECT DISTINCT mint FROM detected_migrations WHERE mint IS NOT NULL`)
    .then((rows) => {
      for (const r of rows) preStartupMints.add(r.mint);
      logger.info({ count: preStartupMints.size }, 'Post-restart guard: pre-startup mints loaded — these will not be traded');
    })
    .catch((err) => logger.warn({ err }, 'Post-restart guard: failed to load pre-startup mints'));

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

  // ── HOT REFRESH loop (3s) ───────────────────────────────────────────────
  // Re-fetches live DexScreener pair data specifically for SCANNING tokens
  // and recently-rejected tokens (last 90s). These are the tokens closest to
  // eligibility — a stale 5m candle or BSR reading could be the only thing
  // blocking entry. Broadcasts immediately when any status changes so the UI
  // reflects the update within seconds, not at the next 15s full scan.
  hotRefreshInterval = setInterval(async () => {
    if (isHotRefreshing || isFetching) return; // skip if full scan running
    isHotRefreshing = true;
    try {
      const anyChanged = await hotRefreshScanningTokens();
      // Always broadcast — keeps the frontend live even when no status changes.
      // Hot refresh already runs every 3s so the payload is pre-computed in memory.
      await broadcastTokens();
      if (anyChanged) {
        await checkEntries(); // immediately check entries if status changed
      }
    } catch (err) {
      logger.error({ err }, 'Hot refresh cycle error');
    } finally {
      isHotRefreshing = false;
    }
  }, 3_000);

  logger.info('Auto-trader started');
}

async function checkEntries(): Promise<void> {
  const settings = await getSettings();

  // Auto-trader is OFF — only whale sniper is active
  if (!settings.autoTraderEnabled) return;

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

  // ── Ever-traded mints — cached, refreshed every 30s ─────────────────────
  // Query ALL positions (no date filter) so a mint is never re-entered even
  // if it was traded days/weeks ago or if the server was restarted.
  if (nowMs - lastTradedTodayCheck > TRADED_TODAY_CACHE_MS) {
    const tradedTodayRows = await query<{ mint: string }>(`
      SELECT DISTINCT mint FROM positions
    `);
    cachedTradedTodayMints = new Set(tradedTodayRows.map((r) => r.mint));
    setTradedTodayMints(cachedTradedTodayMints);
    lastTradedTodayCheck = nowMs;
  }

  const tokens = getAllTokens();
  const openPositions = await getOpenPositions();
  const openMints = new Set(openPositions.map((p) => p.mint));

  // Server uptime in ms — used to determine if a pair graduated before restart.
  const serverUptimeMs = Date.now() - STARTUP_TIME_MS;

  let attempted = 0;
  let skippedDuplicate = 0;
  let skippedTradedToday = 0;
  let skippedPreStartup = 0;
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
      logger.info({ mint: token.mint, symbol: token.symbol }, 'SKIP: already traded this mint before (one trade per mint ever — no re-entry)');
      skippedTradedToday++; continue;
    }

    // ── Post-restart guard ────────────────────────────────────────────────
    // Guard 1: mint was in detected_migrations before this server started.
    if (preStartupMints.has(token.mint)) {
      skippedPreStartup++; continue;
    }
    // Guard 2: pair was created before this server instance started.
    // token.age is in hours; convert to ms and compare to server uptime.
    // If the pool is older than we've been running, it graduated pre-restart.
    const pairAgeMs = token.age * 3_600_000;
    if (pairAgeMs > serverUptimeMs) {
      skippedPreStartup++; continue;
    }
    // ─────────────────────────────────────────────────────────────────────

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

    // Fetch a guaranteed real-time price by MINT right now — never use the cached
    // price as entry. Fetching by mint ensures we always get the graduated
    // Raydium/PumpSwap pair price (most liquid, highest confidence), never the
    // pumpfun bonding-curve price (which is ~5-10x lower and causes wrong P&L).
    const { price: livePrice, pairAddress: livePairAddress } = await fetchLiveEntryPrice(
      token.mint,
      token.price
    );

    // Use the freshly-fetched pair address if available — it's guaranteed to be
    // the most liquid non-pumpfun pool. Fall back to cached pairAddress / mint.
    const bestPairAddress = livePairAddress ?? token.pairAddress ?? token.mint;
    const dexUrl = `https://dexscreener.com/solana/${bestPairAddress}`;

    logger.info(
      {
        mint: token.mint, symbol: token.symbol, score: token.score,
        cachedPrice: token.price, livePrice,
        pairAddress: bestPairAddress,
        mc: token.marketCap, bsr: token.buySellRatio,
      },
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
      price: livePrice,
      mc: token.marketCap,
      dexUrl,
      sources: token.sources ?? [],
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

  if (attempted > 0 || skippedTradedToday > 0 || skippedPreStartup > 0) {
    logger.info({ attempted, skippedDuplicate, skippedTradedToday, skippedPreStartup, skippedNotEligible, skippedNoPrice }, 'checkEntries complete');
  }
}

export function stopAutoTrader(): void {
  if (fetchTimeout) { clearTimeout(fetchTimeout); fetchTimeout = null; }
  traderStarted = false;
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
  if (hotRefreshInterval) { clearInterval(hotRefreshInterval); hotRefreshInterval = null; }
}
