import { paperTradingService } from "./paper-trading.service.js";
import { pumpfunTraderService } from "./pumpfun-trader.service.js";
import type { AnalyticsSnapshot } from "../types/index.js";

const INITIAL_BALANCE_SOL = 100;

function dateKey(ts: number): string {
  return new Date(ts).toISOString().split("T")[0]!;
}

function startOf(unit: "day" | "week" | "month"): number {
  const now = new Date();
  if (unit === "day") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (unit === "week") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(now.getFullYear(), now.getMonth(), diff).getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

interface UnifiedTrade {
  pnlSol: number;
  closedAtMs: number;
  holdTimeMs: number;
}

export function computeAnalytics(): AnalyticsSnapshot {
  const paperClosed = paperTradingService.getClosedTrades();
  const pfClosed    = pumpfunTraderService.getClosedPositions();

  const paperUnified: UnifiedTrade[] = paperClosed.map((t) => ({
    pnlSol:     t.pnlSol ?? 0,
    closedAtMs: t.closedAt ? new Date(t.closedAt).getTime() : 0,
    holdTimeMs: t.holdTimeMs ?? 0,
  }));

  const pfUnified: UnifiedTrade[] = pfClosed.map((p) => ({
    pnlSol:     p.realizedPnlSol,
    closedAtMs: p.closedAt ?? 0,
    holdTimeMs: (p.closedAt && p.entryAt) ? (p.closedAt - p.entryAt) : 0,
  }));

  const closed = [...paperUnified, ...pfUnified];

  const wins   = closed.filter((t) => t.pnlSol > 0);
  const losses = closed.filter((t) => t.pnlSol <= 0);
  const totalPnlSol = closed.reduce((sum, t) => sum + t.pnlSol, 0);

  const dayStart   = startOf("day");
  const weekStart  = startOf("week");
  const monthStart = startOf("month");

  const dailyPnl   = closed.filter((t) => t.closedAtMs >= dayStart).reduce((s, t) => s + t.pnlSol, 0);
  const weeklyPnl  = closed.filter((t) => t.closedAtMs >= weekStart).reduce((s, t) => s + t.pnlSol, 0);
  const monthlyPnl = closed.filter((t) => t.closedAtMs >= monthStart).reduce((s, t) => s + t.pnlSol, 0);

  const sortedByPnl = [...closed].sort((a, b) => b.pnlSol - a.pnlSol);
  const bestTradePnl  = sortedByPnl[0]?.pnlSol ?? 0;
  const worstTradePnl = sortedByPnl[sortedByPnl.length - 1]?.pnlSol ?? 0;

  const grossWins   = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));

  const avgWinSol  = wins.length   > 0 ? grossWins   / wins.length   : 0;
  const avgLossSol = losses.length > 0 ? grossLosses / losses.length : 0;
  const avgRR          = avgLossSol > 0 ? avgWinSol / avgLossSol : 0;
  const profitFactor   = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 99 : 0);

  const avgHoldTimeMinutes =
    closed.length > 0
      ? closed.reduce((sum, t) => sum + (t.holdTimeMs / 60_000), 0) / closed.length
      : 0;

  const sortedByDate = [...closed].sort((a, b) => b.closedAtMs - a.closedAtMs);
  let currentStreak = 0;
  let currentStreakType: "win" | "loss" | "none" = "none";
  for (const t of sortedByDate) {
    const isWin = t.pnlSol > 0;
    if (currentStreak === 0) {
      currentStreak = 1;
      currentStreakType = isWin ? "win" : "loss";
    } else if ((isWin && currentStreakType === "win") || (!isWin && currentStreakType === "loss")) {
      currentStreak++;
    } else {
      break;
    }
  }

  const last10 = sortedByDate.slice(0, 10);
  const winRateLast10 = last10.length > 0
    ? (last10.filter(t => t.pnlSol > 0).length / last10.length) * 100
    : 0;

  const calendarPnl: Record<string, number> = {};
  for (const trade of closed) {
    if (!trade.closedAtMs) continue;
    const key = dateKey(trade.closedAtMs);
    calendarPnl[key] = (calendarPnl[key] ?? 0) + trade.pnlSol;
  }

  return {
    totalTrades:      closed.length,
    winCount:         wins.length,
    lossCount:        losses.length,
    winRate:          closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalPnlSol,
    totalPnlPercent:  (totalPnlSol / INITIAL_BALANCE_SOL) * 100,
    dailyPnl,
    weeklyPnl,
    monthlyPnl,
    bestTradePnl,
    worstTradePnl,
    avgRR,
    avgWinSol,
    avgLossSol,
    avgHoldTimeMinutes,
    profitFactor,
    currentStreak,
    currentStreakType,
    winRateLast10,
    calendarPnl,
  };
}
