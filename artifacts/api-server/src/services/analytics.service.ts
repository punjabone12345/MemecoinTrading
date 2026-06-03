import { paperTradingService } from "./paper-trading.service.js";
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

export function computeAnalytics(): AnalyticsSnapshot {
  const closed = paperTradingService.getClosedTrades();

  const wins   = closed.filter((t) => (t.pnlSol ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnlSol ?? 0) <= 0);
  const totalPnlSol = closed.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);

  const dayStart   = startOf("day");
  const weekStart  = startOf("week");
  const monthStart = startOf("month");

  const tsOf = (t: { closedAt?: string }) => t.closedAt ? new Date(t.closedAt).getTime() : 0;

  const dailyPnl   = closed.filter((t) => tsOf(t) >= dayStart).reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  const weeklyPnl  = closed.filter((t) => tsOf(t) >= weekStart).reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  const monthlyPnl = closed.filter((t) => tsOf(t) >= monthStart).reduce((s, t) => s + (t.pnlSol ?? 0), 0);

  const sortedByPnl = [...closed].sort((a, b) => (b.pnlSol ?? 0) - (a.pnlSol ?? 0));
  const bestTradePnl  = sortedByPnl[0]?.pnlSol ?? 0;
  const worstTradePnl = sortedByPnl[sortedByPnl.length - 1]?.pnlSol ?? 0;

  const grossWins   = wins.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnlSol ?? 0), 0));

  const avgWinSol  = wins.length   > 0 ? grossWins   / wins.length   : 0;
  const avgLossSol = losses.length > 0 ? grossLosses / losses.length : 0;
  const avgRR          = avgLossSol > 0 ? avgWinSol / avgLossSol : 0;
  const profitFactor   = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 99 : 0);

  const avgHoldTimeMinutes =
    closed.length > 0
      ? closed.reduce((sum, t) => sum + ((t.holdTimeMs ?? 0) / 60_000), 0) / closed.length
      : 0;

  // Current streak
  const sortedByDate = [...closed].sort((a, b) => tsOf(b) - tsOf(a));
  let currentStreak = 0;
  let currentStreakType: "win" | "loss" | "none" = "none";
  for (const t of sortedByDate) {
    const isWin = (t.pnlSol ?? 0) > 0;
    if (currentStreak === 0) {
      currentStreak = 1;
      currentStreakType = isWin ? "win" : "loss";
    } else if ((isWin && currentStreakType === "win") || (!isWin && currentStreakType === "loss")) {
      currentStreak++;
    } else {
      break;
    }
  }

  // Win rate of last 10 trades
  const last10 = sortedByDate.slice(0, 10);
  const winRateLast10 = last10.length > 0
    ? (last10.filter(t => (t.pnlSol ?? 0) > 0).length / last10.length) * 100
    : 0;

  const calendarPnl: Record<string, number> = {};
  for (const trade of closed) {
    if (!trade.closedAt) continue;
    const key = dateKey(new Date(trade.closedAt).getTime());
    calendarPnl[key] = (calendarPnl[key] ?? 0) + (trade.pnlSol ?? 0);
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
