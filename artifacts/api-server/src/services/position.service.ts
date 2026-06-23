import { query } from '../lib/db.js';
import { Position } from '../types/index.js';
import { getSettings, getBalance, setBalance } from './settings.service.js';
import { markTokenEntered, markTokenAvailable, getTokenByMint } from './scanner.service.js';
import { notifyBought, notifyClosed, notifyTPHit, notifyEmergencyExit } from '../lib/telegram.js';
import { logger } from '../lib/logger.js';
import { broadcastPositions, broadcastBalance } from '../websocket/server.js';

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
  };
}

export async function openPosition(params: {
  mint: string; name: string; symbol: string; score: number;
  price: number; mc: number; dexUrl?: string;
}): Promise<Position | null> {
  const settings = await getSettings();
  const open = await getOpenPositions();

  if (open.length >= settings.maxOpenPositions) {
    logger.info('Max positions reached, skipping');
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
    logger.info({ dailyPnl, dailyLossLimit }, 'Daily loss limit hit, no new entries');
    return null;
  }

  let sizePct: number;
  if (params.score >= 90) sizePct = settings.sizeScore90;
  else if (params.score >= 80) sizePct = settings.sizeScore80;
  else sizePct = settings.sizeScore70;

  const sizeSol = balance * sizePct / 100;
  if (sizeSol > balance) {
    logger.warn('Insufficient balance');
    return null;
  }

  const slPrice = params.price * (1 - settings.slPct / 100);

  const rows = await query<Record<string, unknown>>(`
    INSERT INTO positions (mint, name, symbol, entry_price, entry_mc, size_sol, score_at_entry, peak_price, sl_current, mode, dex_url, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN')
    RETURNING *
  `, [params.mint, params.name, params.symbol, params.price, params.mc, sizeSol, params.score, params.price, slPrice, process.env.TRADING_MODE || 'paper', params.dexUrl ?? null]);

  const position = rowToPosition(rows[0]);
  await setBalance(balance - sizeSol);
  markTokenEntered(params.mint);

  await notifyBought({ name: params.name, symbol: params.symbol, price: params.price, mc: params.mc, score: params.score, sizeSol });
  await broadcastPositions();
  await broadcastBalance();

  logger.info({ mint: params.mint, sizeSol, score: params.score }, 'Position opened');
  return position;
}

export async function closePosition(id: string, currentPrice: number, reason: string): Promise<Position | null> {
  const pos = await getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return null;

  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlSol = pos.sizeSol * (pnlPct / 100);
  const currentMc = pos.entryMc * (currentPrice / pos.entryPrice);

  const rows = await query<Record<string, unknown>>(`
    UPDATE positions SET
      exit_price = $1, exit_mc = $2, exit_time = NOW(),
      pnl_sol = $3, pnl_pct = $4, close_reason = $5, status = 'CLOSED'
    WHERE id = $6 RETURNING *
  `, [currentPrice, currentMc, pnlSol, pnlPct, reason, id]);

  const balance = await getBalance();
  await setBalance(balance + pos.sizeSol + pnlSol);
  markTokenAvailable(pos.mint);

  await notifyClosed({ name: pos.name, symbol: pos.symbol, pnlSol, pnlPct, reason });
  await broadcastPositions();
  await broadcastBalance();

  return rowToPosition(rows[0]);
}

export async function updatePositionPrice(id: string, currentPrice: number): Promise<void> {
  const pos = await getPositionById(id);
  if (!pos || pos.status !== 'OPEN') return;

  const settings = await getSettings();
  let newPeak = Math.max(pos.peakPrice, currentPrice);
  let newSL = pos.slCurrent;
  let tp1Hit = pos.tp1Hit;
  let tp2Hit = pos.tp2Hit;
  let tp3Hit = pos.tp3Hit;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // TP1
  if (!tp1Hit && pnlPct >= settings.tp1Pct) {
    tp1Hit = true;
    newSL = pos.entryPrice; // breakeven
    const partialPnl = pos.sizeSol * (settings.tp1ClosePct / 100) * (pnlPct / 100);
    await notifyTPHit({ name: pos.name, symbol: pos.symbol, level: 1, gainPct: pnlPct, profitSol: partialPnl, newSL: 0 });
  }

  // TP2
  if (!tp2Hit && pnlPct >= settings.tp2Pct) {
    tp2Hit = true;
    newSL = pos.entryPrice * (1 + settings.tp1Pct / 100);
    const partialPnl = pos.sizeSol * (settings.tp2ClosePct / 100) * (pnlPct / 100);
    await notifyTPHit({ name: pos.name, symbol: pos.symbol, level: 2, gainPct: pnlPct, profitSol: partialPnl, newSL: settings.tp1Pct });
  }

  // TP3
  if (!tp3Hit && pnlPct >= settings.tp3Pct) {
    tp3Hit = true;
    const partialPnl = pos.sizeSol * (settings.tp3ClosePct / 100) * (pnlPct / 100);
    await notifyTPHit({ name: pos.name, symbol: pos.symbol, level: 3, gainPct: pnlPct, profitSol: partialPnl, newSL: settings.tp1Pct });
  }

  // Trailing SL after TP3
  if (tp3Hit) {
    const trailSL = newPeak * (1 - settings.trailingSLPct / 100);
    newSL = Math.max(newSL, trailSL);
  }

  await query(`
    UPDATE positions SET peak_price = $1, sl_current = $2, tp1_hit = $3, tp2_hit = $4, tp3_hit = $5
    WHERE id = $6
  `, [newPeak, newSL, tp1Hit, tp2Hit, tp3Hit, id]);

  // Check SL hit
  if (currentPrice <= newSL) {
    await closePosition(id, currentPrice, tp1Hit ? 'SL (moved to breakeven/TP)' : 'Stop Loss');
    return;
  }

  // Emergency exit checks
  const token = getTokenByMint(pos.mint);
  if (token) {
    const emergencyReasons: string[] = [];
    if (!token.rugcheck) emergencyReasons.push('Rugcheck failed');
    if (token.buySellRatio < 0.8) emergencyReasons.push('Buy/sell ratio < 0.8');
    if (token.score < 40) emergencyReasons.push('Score dropped below 40');

    if (emergencyReasons.length > 0) {
      const reason = emergencyReasons.join(', ');
      const pnl = pos.sizeSol * (pnlPct / 100);
      await notifyEmergencyExit({ name: pos.name, symbol: pos.symbol, reason, pnlSol: pnl });
      await closePosition(id, currentPrice, `EMERGENCY: ${reason}`);
    }
  }
}

export async function editPosition(id: string, updates: {
  entryPrice?: number; sizeSol?: number; slCurrent?: number;
  tp1Hit?: boolean; tp2Hit?: boolean; tp3Hit?: boolean; notes?: string;
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
