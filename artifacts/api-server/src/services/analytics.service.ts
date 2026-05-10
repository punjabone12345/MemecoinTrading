import { paperTradingService } from "./paper-trading.service.js";
import type { AnalyticsSnapshot } from "../types/index.js";

function dateKey(ts: number): string {
  return new Date(ts).toISOString().split("T")[0]!;
}

function startOf(unit: "day" | "week" | "month"): number {
  const now = new Date();
  if (unit === "day") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (unit === "week") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(now.getFullYear(), now.getMonth(), diff).getTime();
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function computeAnalytics(): AnalyticsSnapshot {
  const closed = paperTradingService.getClosedTrades();

  const wins = closed.filter((t) => (t.pnlSol ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnlSol ?? 0) <= 0);

  const totalPnlSol = closed.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);
  const initialBalance = 100;
  const totalPnlPercent = (totalPnlSol / initialBalance) * 100;

  const dayStart = startOf("day");
  const weekStart = startOf("week");
  const monthStart = startOf("month");

  const dailyPnl = closed
    .filter((t) => (t.closedAt ?? 0) >= dayStart)
    .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);

  const weeklyPnl = closed
    .filter((t) => (t.closedAt ?? 0) >= weekStart)
    .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);

  const monthlyPnl = closed
    .filter((t) => (t.closedAt ?? 0) >= monthStart)
    .reduce((sum, t) => sum + (t.pnlSol ?? 0), 0);

  const sortedByPnl = [...closed].sort(
    (a, b) => (b.pnlSol ?? 0) - (a.pnlSol ?? 0),
  );
  const bestTradePnl = sortedByPnl[0]?.pnlSol ?? 0;
  const worstTradePnl = sortedByPnl[sortedByPnl.length - 1]?.pnlSol ?? 0;

  const avgWinSol =
    wins.length > 0
      ? wins.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0) / wins.length
      : 0;
  const avgLossSol =
    losses.length > 0
      ? Math.abs(losses.reduce((sum, t) => sum + (t.pnlSol ?? 0), 0)) /
        losses.length
      : 0;

  const avgRR = avgLossSol > 0 ? avgWinSol / avgLossSol : 0;

  const avgHoldTimeMinutes =
    closed.length > 0
      ? closed.reduce((sum, t) => {
          const held = ((t.closedAt ?? t.openedAt) - t.openedAt) / 60_000;
          return sum + held;
        }, 0) / closed.length
      : 0;

  const calendarPnl: Record<string, number> = {};
  for (const trade of closed) {
    if (!trade.closedAt) continue;
    const key = dateKey(trade.closedAt);
    calendarPnl[key] = (calendarPnl[key] ?? 0) + (trade.pnlSol ?? 0);
  }

  return {
    totalTrades: closed.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    totalPnlSol,
    totalPnlPercent,
    dailyPnl,
    weeklyPnl,
    monthlyPnl,
    bestTradePnl,
    worstTradePnl,
    avgRR,
    avgWinSol,
    avgLossSol,
    avgHoldTimeMinutes,
    calendarPnl,
  };
}
