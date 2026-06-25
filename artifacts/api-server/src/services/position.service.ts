import { query } from '../lib/db.js';
import { Position } from '../types/index.js';
import { getSettings, getBalance, setBalance } from './settings.service.js';
import { markTokenEntered, markTokenAvailable, getTokenByMint } from './scanner.service.js';
import { notifyBought, notifyClosed, notifyEmergencyExit } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { broadcastPositions, broadcastBalance } from '../websocket/server.js';

// Per-position baseline snapshot for emergency exit detection.
// Captured on first price update after entry; cleared on close.
const positionBaselines = new Map<string, { liquidity: number; topHolder: number }>();

// Per-position mutex: prevents concurrent updatePositionPrice calls from
// racing on TP/SL checks. Without this, two rapid price ticks both read
// tp1Hit=false and fire TP1 twice, closing 30% of position twice.
const positionLocks = new Map<string, Promise<void>>();

async function withPositionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = positionLocks.get(id) ?? Promise.resolve();
  let releaseLock!: () => void;
  const next = new Promise<void>((res) => { releaseLock = res; });
  positionLocks.set(id, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    releaseLock();
    // Clean up if no more waiters
    if (positionLocks.get(id) === next) positionLocks.delete(id);
  }
}

// Consecutive-tick confirmation counters per position per signal key.
// A signal must be true for EMERGENCY_CONFIRM_TICKS straight before the exit fires.
// Prevents momentary DexScreener data glitches (BSR h1 window reset, liquidity blip)
// from causing false emergency exits.
const EMERGENCY_CONFIRM_TICKS = 3;
const emergencyConfirmCounts = new Map<string, Map<string, number>>();

// SL must breach for SL_CONFIRM_TICKS consecutive ticks before closing.
// Prevents a single bad DexScreener tick firing a false Stop Loss.
const SL_CONFIRM_TICKS = 2;
const slConfirmCounts = new Map<string, number>();

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

export async function getOpenPositions(): Promise<Position[]> {
  const rows = await query<Record<string, unknown>>(`
    SELECT * FROM positions WHERE status = 'OPEN' ORDER BY entry_time DESC
  `);
  return rows.map(rowToPosition);
}

export async function getClosedPositions(): Promise<Position[]> {
  const rows = await query<Record<string, unknown>>(`
    SELECT * FROM positions WHERE status = 'CLOSED' ORDER BY exit_time DESC
  `);
  return rows.map(rowToPosition);
}

export async function getPositionById(id: string): Promise<Position | null> {
  const rows = await query<Record<string, unknown>>(`SELECT * FROM positions WHERE id = $1`, [id]);
  return rows.length ? rowToPosition(rows[0]) : null;
}

function rowToPosition(r: Record<string, unknown>): Position {
  return {
    id: String(r.id),
    mint: String(r.mint),
    name: String(r.name),
    symbol: String(r.symbol ?? '???'),
    entryPrice: parseFloat(String(r.entry_price)),
    entryMc: parseFloat(String(r.entry_mc)),
    entryTime: String(r.entry_time),
    exitPrice: r.exit_price != null ? parseFloat(String(r.exit_price)) : undefined,
    exitMc: r.exit_mc != null ? parseFloat(String(r.exit_mc)) : undefined,
    exitTime: r.exit_time != null ? String(r.exit_time) : undefined,
    sizeSol: parseFloat(String(r.size_sol)),
    pnlSol: r.pnl_sol != null ? parseFloat(String(r.pnl_sol)) : undefined,
    pnlPct: r.pnl_pct != null ? parseFloat(String(r.pnl_pct)) : undefined,
    scoreAtEntry: parseInt(String(r.score_at_entry)),
    peakPrice: parseFloat(String(r.peak_price)),
    slCurrent: parseFloat(String(r.sl_current)),
    tp1Hit: Boolean(r.tp1_hit),
    tp2Hit: Boolean(r.tp2_hit),
    tp3Hit: Boolean(r.tp3_hit),
    closeReason: r.close_reason != null ? String(r.close_reason) : undefined,
    status: String(r.status) as 'OPEN' | 'CLOSED',
    mode: String(r.mode) as 'paper' | 'live',
    txSignature: r.tx_signature != null ? String(r.tx_signature) : undefined,
    dexUrl: r.dex_url != null ? String(r.dex_url) : undefined,
    notes: r.notes != null ? String(r.notes) : undefined,
    initialSizeSol: r.initial_size_sol != null ? parseFloat(String(r.initial_size_sol)) : undefined,
    bankdProfitSol: r.banked_profit_sol != null ? parseFloat(String(r.banked_profit_sol)) : undefined,
  };
}

export async function openPosition(params: {
  mint: string; name: string; symbol: string; score: number;
  price: number; mc: number; dexUrl?: string;
}): Promise<Position | null> {
  const settings = await getSettings();
  const open = await getOpenPositions();

  if (open.length >= settings.maxOpenPositions) {
    logger.warn({ openCount: open.length, max: settings.maxOpenPositions }, 'openPosition blocked: max open positions reached');
    return null;
  }

  // Prevent duplicate open positions for the same mint
  if (open.some((p) => p.mint === params.mint)) {
    logger.warn({ mint: params.mint }, 'openPosition blocked: already have open position for this mint');
    return null;
  }

  // Check daily loss limit
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayRows = await query<{ pnl_sol: string }>(`
    SELECT pnl_sol FROM positions 
    WHERE status = 'CLOSED' AND exit_time >= $1
  `, [today.toISOString()]);
  const dailyPnl = todayRows.reduce((s, r) => s + parseFloat(r.pnl_sol ?? '0'), 0);
  const balance = await getBalance();
  const dailyLossLimit = -(balance * settings.maxDailyLossPct / 100);
  if (dailyPnl <= dailyLossLimit) {
    logger.warn({ dailyPnl, dailyLossLimit, balance, maxDailyLossPct: settings.maxDailyLossPct }, 'openPosition blocked: daily loss limit hit');
    return null;
  }

  let sizePct: number;
  if (params.score >= 90) sizePct = settings.sizeScore90;
  else if (params.score >= 80) sizePct = settings.sizeScore80;
  else sizePct = settings.sizeScore70;

  const sizeSol = balance * sizePct / 100;
  logger.info({ balance, sizePct, sizeSol, score: params.score }, 'openPosition: computed trade size');
  if (sizeSol <= 0) {
    logger.warn({ sizeSol, sizePct, balance }, 'openPosition blocked: trade size is 0 — check sizeScore settings');
    return null;
  }
  if (sizeSol > balance) {
    logger.warn({ sizeSol, balance }, 'openPosition blocked: insufficient balance');
    return null;
  }

  const slPrice = params.price * (1 - settings.slPct / 100);

  // Dynamic INSERT: only include columns that actually exist in the DB table.
  // This handles legacy Render schemas with unknown extra NOT-NULL columns —
  // we never reference columns we don't own, so no constraint can block us.
  const colRows = await query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'positions'
  `);
  const existingCols = new Set(colRows.map((r) => r.column_name));

  const wantedCols: Record<string, unknown> = {
    mint: params.mint,
    name: params.name,
    symbol: params.symbol,
    entry_price: params.price,
    entry_mc: params.mc,
    size_sol: sizeSol,
    initial_size_sol: sizeSol,
    banked_profit_sol: 0,
    score_at_entry: params.score,
    peak_price: params.price,
    sl_current: slPrice,
    mode: process.env.TRADING_MODE || 'paper',
    dex_url: params.dexUrl ?? null,
    status: 'OPEN',
  };

  const colNames = Object.keys(wantedCols).filter((c) => existingCols.has(c));
  const colValues = colNames.map((c) => wantedCols[c]);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

  logger.info({ colNames }, 'openPosition: inserting with columns');

  const buildAndInsert = () =>
    query<Record<string, unknown>>(
      `INSERT INTO positions (${colNames.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      colValues
    );

  let rows: Record<string, unknown>[];
  try {
    rows = await buildAndInsert();
  } catch (err: any) {
    // 23502 = NOT NULL violation on a column we don't own (e.g. legacy position_id).
    // Drop NOT NULL from every column not in our known schema, then retry once.
    if (err.code === '23502') {
      logger.warn({ err: err.message }, 'openPosition: NOT NULL constraint hit — healing schema');
      const knownCols = new Set([
        'id','mint','name','symbol','entry_price','entry_mc','entry_time',
        'size_sol','initial_size_sol','banked_profit_sol','score_at_entry','peak_price','sl_current','status','mode',
        'exit_price','exit_mc','exit_time','pnl_sol','pnl_pct','tp1_hit',
        'tp2_hit','tp3_hit','close_reason','tx_signature','dex_url','notes','created_at',
      ]);
      const badCols = await query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'positions'
          AND is_nullable = 'NO'
      `);
      for (const { column_name } of badCols) {
        if (!knownCols.has(column_name)) {
          try {
            await query(`ALTER TABLE positions ALTER COLUMN "${column_name}" DROP NOT NULL`);
            logger.info({ column_name }, 'openPosition: dropped NOT NULL from legacy column');
          } catch (alterErr: any) {
            logger.warn({ column_name, err: alterErr.message }, 'openPosition: could not drop NOT NULL');
          }
        }
      }
      rows = await buildAndInsert();
    } else {
      throw err;
    }
  }

  const position = rowToPosition(rows[0]);
  await setBalance(balance - sizeSol);
  markTokenEntered(params.mint);

  await notifyBought({ name: params.name, symbol: params.symbol, price: params.price, mc: params.mc, score: params.score, sizeSol });
  await broadcastPositions();
  await broadcastBalance();
  // Immediately update token status to ENTERED on the scan page
  const { broadcastTokens } = await import('../websocket/server.js');
  await broadcastTokens();

  logger.info({ mint: params.mint, sizeSol, score: params.score }, 'Position opened');
  return position;
}

export async function closePosition(id: string, currentPrice: number, reason: string, options?: { silent?: boolean }): Promise<Position | null> {
  const pos = await getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return null;

  // Runner PnL — on the remaining position size after any partial closes
  const pricePnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const runnerPnl = pos.sizeSol * (pricePnlPct / 100);

  // TP profits already banked to balance during partial closes — add them so
  // pnl_sol represents the TRUE total realised profit for the entire trade.
  const bankdProfit = pos.bankdProfitSol ?? 0;
  const initialSizeSol = pos.initialSizeSol ?? pos.sizeSol;

  const totalPnlSol = runnerPnl + bankdProfit;
  // pnl_pct = total profit as % of original capital invested
  const totalPnlPct = initialSizeSol > 0 ? (totalPnlSol / initialSizeSol) * 100 : pricePnlPct;

  const currentMc = pos.entryMc * (currentPrice / pos.entryPrice);

  const rows = await query<Record<string, unknown>>(`
    UPDATE positions SET
      exit_price = $1, exit_mc = $2, exit_time = NOW(),
      pnl_sol = $3, pnl_pct = $4, close_reason = $5, status = 'CLOSED'
    WHERE id = $6 RETURNING *
  `, [currentPrice, currentMc, totalPnlSol, totalPnlPct, reason, id]);

  // Return only runner capital + runner PnL — TP profits were already credited
  // to the balance during each partialClose() call.
  const balance = await getBalance();
  await setBalance(balance + pos.sizeSol + runnerPnl);
  markTokenAvailable(pos.mint);

  // Clean up per-position exit state so it doesn't persist after close
  positionBaselines.delete(id);
  emergencyConfirmCounts.delete(id);
  slConfirmCounts.delete(id);

  // Only send the close notification if not suppressed (e.g. emergency exit sends its own)
  if (!options?.silent) {
    await notifyClosed({ name: pos.name, symbol: pos.symbol, pnlSol: totalPnlSol, pnlPct: totalPnlPct, reason });
  }
  await broadcastPositions();
  await broadcastBalance();

  return rowToPosition(rows[0]);
}

export async function updatePositionPrice(id: string, currentPrice: number, freshBsr?: number, freshLiquidity?: number): Promise<void> {
  return withPositionLock(id, () => _updatePositionPrice(id, currentPrice, freshBsr, freshLiquidity));
}

async function _updatePositionPrice(id: string, currentPrice: number, freshBsr?: number, freshLiquidity?: number): Promise<void> {
  const pos = await getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return;

  const settings = await getSettings();
  const newPeak = Math.max(pos.peakPrice, currentPrice);
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // Trailing SL — always active from entry, trails trailingSLPct% below peak.
  // Since peak starts at entryPrice, trailing SL = entry * (1 - trailingSLPct/100)
  // which equals the initial hard SL. As price rises, peak rises and trailing SL ratchets up.
  const trailSL = newPeak * (1 - settings.trailingSLPct / 100);
  const newSL = Math.max(pos.slCurrent, trailSL);

  await query(`
    UPDATE positions SET peak_price = $1, sl_current = $2
    WHERE id = $3
  `, [newPeak, newSL, id]);

  // ── SL check with 2-tick confirmation ───────────────────────────────────
  // Require currentPrice to be below SL for SL_CONFIRM_TICKS consecutive ticks
  // before closing. A single bad DexScreener tick cannot fire a Stop Loss alone.
  if (currentPrice <= newSL) {
    const slCount = (slConfirmCounts.get(id) ?? 0) + 1;
    slConfirmCounts.set(id, slCount);
    if (slCount < SL_CONFIRM_TICKS) {
      logger.info(
        { id, symbol: pos.symbol, currentPrice, slPrice: newSL, tick: slCount, required: SL_CONFIRM_TICKS },
        'SL breach tick — waiting for confirmation'
      );
    } else {
      slConfirmCounts.delete(id);
      await closePosition(id, currentPrice, 'Stop Loss (-20%)');
      return;
    }
  } else {
    // Price recovered — reset SL confirmation counter
    if (slConfirmCounts.has(id)) {
      logger.info({ id, symbol: pos.symbol, currentPrice, slPrice: newSL }, 'SL breach cleared — price recovered, resetting counter');
      slConfirmCounts.delete(id);
    }
  }

  // ── Emergency exit checks ────────────────────────────────────────────────
  // Score is an ENTRY filter only — do NOT exit on score alone.
  // Only exit on structural integrity failures: rug, liquidity drain, creator dump.
  //
  // Every signal uses a CONFIRMATION COUNTER: it must be true for
  // EMERGENCY_CONFIRM_TICKS consecutive price ticks before the exit fires.
  // This prevents momentary DexScreener glitches (h1 BSR window reset,
  // temporary liquidity blips) from causing false emergency exits.
  const token = getTokenByMint(pos.mint);
  if (token) {
    // Use fresh real-time values from price monitor when available;
    // fall back to scanner's cached token data if not provided.
    const liveBsr = freshBsr ?? token.buySellRatio;
    const liveLiquidity = freshLiquidity ?? token.liquidity;

    // Establish baseline on first observation after entry
    if (!positionBaselines.has(id)) {
      positionBaselines.set(id, {
        liquidity: liveLiquidity,
        topHolder: token.topHolder,
      });
      logger.info({ positionId: id, mint: pos.mint, baseLiquidity: liveLiquidity, baseTopHolder: token.topHolder, source: freshLiquidity != null ? 'fresh' : 'scanner' }, 'Emergency-exit baseline captured');
    }
    const baseline = positionBaselines.get(id)!;

    // Ensure per-position confirmation map exists
    if (!emergencyConfirmCounts.has(id)) {
      emergencyConfirmCounts.set(id, new Map());
    }
    const counts = emergencyConfirmCounts.get(id)!;

    // Helper: increment counter for a signal key; return true when threshold met
    function confirm(key: string, active: boolean): boolean {
      if (!active) { counts.set(key, 0); return false; }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n < EMERGENCY_CONFIRM_TICKS) {
        logger.info({ positionId: id, symbol: pos.symbol, signal: key, tick: n, required: EMERGENCY_CONFIRM_TICKS }, 'Emergency signal building — not yet confirmed');
        return false;
      }
      return true;
    }

    const emergencyReasons: string[] = [];

    // 1. Rugcheck failure — confirmed immediately (on-chain, not DexScreener noise)
    if (confirm('rugcheck', !token.rugcheck)) {
      emergencyReasons.push('Rugcheck failed (on-chain risk detected)');
    }

    // 2. Creator / whale sell dump — uses fresh per-tick BSR from price monitor
    //    Threshold: 0.3x (3 sells per 10 buys) for 3 consecutive seconds
    if (confirm('bsr', liveBsr < 0.3)) {
      emergencyReasons.push(`Extreme sell pressure (BSR ${liveBsr.toFixed(2)}x) for ${EMERGENCY_CONFIRM_TICKS}s — likely creator/whale dump`);
    }

    // 3. Liquidity drained >40% from entry baseline — uses fresh liquidity from price monitor
    const liqActive = baseline.liquidity > 1000 && liveLiquidity < baseline.liquidity * 0.60;
    if (confirm('liquidity', liqActive)) {
      const dropPct = (((baseline.liquidity - liveLiquidity) / baseline.liquidity) * 100).toFixed(0);
      emergencyReasons.push(`Liquidity drained ${dropPct}% ($${(baseline.liquidity / 1000).toFixed(0)}K → $${(liveLiquidity / 1000).toFixed(0)}K) for ${EMERGENCY_CONFIRM_TICKS}s`);
    }

    // 4. Top-holder concentration surged >15pp (coordinated accumulation before dump)
    if (confirm('topHolder', baseline.topHolder > 0 && token.topHolder > baseline.topHolder + 15)) {
      emergencyReasons.push(`Top-holder concentration surged ${baseline.topHolder.toFixed(1)}% → ${token.topHolder.toFixed(1)}%`);
    }

    if (emergencyReasons.length > 0) {
      const reason = emergencyReasons.join('; ');
      const pnl = pos.sizeSol * (pnlPct / 100);
      logger.warn({ positionId: id, mint: pos.mint, symbol: pos.symbol, reason, pnl }, 'EMERGENCY EXIT triggered');
      await notifyEmergencyExit({ name: pos.name, symbol: pos.symbol, reason, pnlSol: pnl });
      await closePosition(id, currentPrice, `EMERGENCY: ${reason}`, { silent: true });
    }
  }
}

export async function editPosition(id: string, updates: {
  // Open-position fields
  entryPrice?: number; sizeSol?: number; slCurrent?: number;
  tp1Hit?: boolean; tp2Hit?: boolean; tp3Hit?: boolean; notes?: string;
  // Closed-position correction fields
  exitPrice?: number; exitTime?: string;
  pnlSol?: number; pnlPct?: number;
  closeReason?: string; status?: 'OPEN' | 'CLOSED';
}): Promise<Position | null> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.entryPrice !== undefined) { sets.push(`entry_price = $${i++}`); vals.push(updates.entryPrice); }
  if (updates.sizeSol !== undefined) { sets.push(`size_sol = $${i++}`); vals.push(updates.sizeSol); }
  if (updates.slCurrent !== undefined) { sets.push(`sl_current = $${i++}`); vals.push(updates.slCurrent); }
  if (updates.tp1Hit !== undefined) { sets.push(`tp1_hit = $${i++}`); vals.push(updates.tp1Hit); }
  if (updates.tp2Hit !== undefined) { sets.push(`tp2_hit = $${i++}`); vals.push(updates.tp2Hit); }
  if (updates.tp3Hit !== undefined) { sets.push(`tp3_hit = $${i++}`); vals.push(updates.tp3Hit); }
  if (updates.notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(updates.notes); }
  if (updates.exitPrice !== undefined) { sets.push(`exit_price = $${i++}`); vals.push(updates.exitPrice); }
  if (updates.exitTime !== undefined) { sets.push(`exit_time = $${i++}`); vals.push(updates.exitTime); }
  if (updates.pnlSol !== undefined) { sets.push(`pnl_sol = $${i++}`); vals.push(updates.pnlSol); }
  if (updates.pnlPct !== undefined) { sets.push(`pnl_pct = $${i++}`); vals.push(updates.pnlPct); }
  if (updates.closeReason !== undefined) { sets.push(`close_reason = $${i++}`); vals.push(updates.closeReason); }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); vals.push(updates.status); }

  if (sets.length === 0) return getPositionById(id);

  vals.push(id);
  const rows = await query<Record<string, unknown>>(
    `UPDATE positions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );

  await broadcastPositions();
  return rows.length ? rowToPosition(rows[0]) : null;
}

export async function deletePosition(id: string): Promise<void> {
  const pos = await getPositionById(id);
  if (!pos) return;

  if (pos.status === 'OPEN') {
    const balance = await getBalance();
    await setBalance(balance + pos.sizeSol);
    markTokenAvailable(pos.mint);
  }

  await query(`DELETE FROM positions WHERE id = $1`, [id]);
  await broadcastPositions();
  await broadcastBalance();
}

export async function getAnalytics() {
  const closed = await getClosedPositions();
  const open = await getOpenPositions();

  const wins = closed.filter((p) => (p.pnlSol ?? 0) > 0);
  const losses = closed.filter((p) => (p.pnlSol ?? 0) <= 0);
  const totalPnl = closed.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

  const grossProfit = wins.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + (p.pnlSol ?? 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const bestTrade = wins.length > 0 ? Math.max(...wins.map((p) => p.pnlPct ?? 0)) : 0;
  const worstTrade = losses.length > 0 ? Math.min(...losses.map((p) => p.pnlPct ?? 0)) : 0;

  // Streak
  let currentStreak = 0; let maxWin = 0; let maxLoss = 0;
  let tempWin = 0; let tempLoss = 0;
  for (const p of [...closed].reverse()) {
    const won = (p.pnlSol ?? 0) > 0;
    if (won) { tempWin++; tempLoss = 0; currentStreak = tempWin; }
    else { tempLoss++; tempWin = 0; currentStreak = -tempLoss; }
    maxWin = Math.max(maxWin, tempWin);
    maxLoss = Math.max(maxLoss, tempLoss);
  }

  // Drawdown
  let peak = 0; let drawdown = 0; let running = 0;
  for (const p of closed) {
    running += p.pnlSol ?? 0;
    if (running > peak) peak = running;
    const dd = ((peak - running) / Math.max(peak, 1)) * 100;
    if (dd > drawdown) drawdown = dd;
  }

  // Avg hold time
  const holdTimes = closed.filter((p) => p.exitTime).map((p) => {
    const entry = new Date(p.entryTime).getTime();
    const exit = new Date(p.exitTime!).getTime();
    return (exit - entry) / 60_000;
  });
  const avgHold = holdTimes.length > 0 ? holdTimes.reduce((s, t) => s + t, 0) / holdTimes.length : 0;

  // Daily PNL
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dailyPnl = closed.filter((p) => p.exitTime && new Date(p.exitTime) >= today)
    .reduce((s, p) => s + (p.pnlSol ?? 0), 0);

  const unrealizedPnl = 0; // updated by price monitor

  return {
    totalTrades: closed.length,
    winRate,
    profitFactor,
    totalPnlSol: totalPnl,
    bestTrade,
    worstTrade,
    currentStreak,
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss,
    maxDrawdown: drawdown,
    avgHoldTimeMinutes: avgHold,
    dailyPnl,
    openPositionsCount: open.length,
    unrealizedPnl,
  };
}
