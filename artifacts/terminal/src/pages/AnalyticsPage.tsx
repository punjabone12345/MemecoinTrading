import { BarChart3, TrendingUp, TrendingDown, Target, Award, Clock, AlertTriangle } from "lucide-react";
import { useEDAnalytics } from "@/lib/api";
import type { EDPosition } from "@/lib/types";

function fmtSol(v: number, d = 4): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)} SOL`;
}
function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function fmtMin(m: number): string {
  if (m < 1) return "<1m";
  if (m < 60) return `${m.toFixed(0)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function StatCard({ label, value, sub, color = "#818cf8", icon }: {
  label: string; value: string; sub?: string; color?: string; icon: React.ReactNode;
}) {
  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[9px] text-slate-500 uppercase tracking-widest">{label}</p>
        <div className="text-slate-600">{icon}</div>
      </div>
      <p className="text-2xl font-black" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function ScoreRow({ range, trades, winRate, avgPnl, totalPnl }: {
  range: string; trades: number; winRate: number; avgPnl: number; totalPnl: number;
}) {
  const color = winRate >= 60 ? "#34d399" : winRate >= 50 ? "#fbbf24" : "#f87171";
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-[80px]">
          <span className="text-xs font-bold text-white">Score {range}</span>
          <p className="text-[9px] text-slate-500 mt-0.5">{trades} trade{trades !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex-1">
          <div className="h-1.5 rounded-full mb-1" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(winRate, 100)}%`, background: color }} />
          </div>
          <p className="text-[10px] font-bold" style={{ color }}>{winRate.toFixed(0)}% win rate</p>
        </div>
        <div className="text-right min-w-[80px]">
          <p className="text-xs font-bold" style={{ color: totalPnl >= 0 ? "#34d399" : "#f87171" }}>
            {fmtSol(totalPnl, 3)}
          </p>
          <p className="text-[9px] text-slate-500">avg {fmtSol(avgPnl, 3)}</p>
        </div>
      </div>
    </div>
  );
}

function TradeRow({ pos }: { pos: EDPosition }) {
  const holdMin = pos.closedAt ? (pos.closedAt - pos.entryAt) / 60_000 : 0;
  const isWin = pos.realizedPnlSol > 0;
  return (
    <div className="flex items-center justify-between py-2.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div className="flex items-center gap-3">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
          style={{ background: isWin ? "rgba(52,211,153,0.12)" : "rgba(248,113,113,0.12)" }}
        >
          {isWin
            ? <TrendingUp size={12} className="text-emerald-400" />
            : <TrendingDown size={12} className="text-red-400" />}
        </div>
        <div>
          <p className="text-xs font-bold text-white">
            ${pos.symbol} <span className="text-slate-600 font-normal text-[10px]">score {pos.entryScore}</span>
          </p>
          <p className="text-[9px] text-slate-500 truncate max-w-[160px]">{pos.closeReason || "—"}</p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-sm font-black" style={{ color: isWin ? "#34d399" : "#f87171" }}>
          {fmtPct(pos.pnlPct)}
        </p>
        <p className="text-[9px] text-slate-500">{holdMin > 0 ? fmtMin(holdMin) : "—"}</p>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: analytics, isLoading } = useEDAnalytics();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3">
        <BarChart3 size={32} className="text-slate-700 animate-pulse" />
        <p className="text-slate-500 text-sm">Loading analytics…</p>
      </div>
    );
  }

  const a = analytics;

  if (!a || a.total === 0) {
    return (
      <div className="px-4 pt-6">
        <div className="mb-6">
          <h1 className="text-xl font-black text-white">Analytics</h1>
          <p className="text-xs text-slate-500 mt-0.5">Early Demand Discovery · Paper Mode</p>
        </div>
        <div className="text-center py-16">
          <BarChart3 size={40} className="text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">No completed trades yet</p>
          <p className="text-slate-600 text-xs mt-1">Analytics populate once positions close</p>
        </div>
      </div>
    );
  }

  const winColor  = a.winRate >= 55 ? "#34d399" : a.winRate >= 45 ? "#fbbf24" : "#f87171";
  const pfColor   = a.profitFactor >= 1.5 ? "#34d399" : a.profitFactor >= 1 ? "#fbbf24" : "#f87171";
  const pnlColor  = a.totalRealizedPnl >= 0 ? "#34d399" : "#f87171";
  const avgColor  = a.avgPnl >= 0 ? "#34d399" : "#f87171";

  return (
    <div className="px-4 pt-6 pb-6">
      <div className="mb-5">
        <h1 className="text-xl font-black text-white">Analytics</h1>
        <p className="text-xs text-slate-500 mt-0.5">Early Demand Discovery · {a.total} closed trades</p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <StatCard
          label="Win Rate"
          value={`${a.winRate.toFixed(1)}%`}
          sub={`${a.wins} wins · ${a.losses} losses`}
          color={winColor}
          icon={<Award size={14} />}
        />
        <StatCard
          label="Profit Factor"
          value={a.profitFactor >= 999 ? "∞" : a.profitFactor.toFixed(2)}
          sub={`Gross: +${a.grossProfit.toFixed(4)} / -${a.grossLoss.toFixed(4)}`}
          color={pfColor}
          icon={<TrendingUp size={14} />}
        />
        <StatCard
          label="Total Realized P&L"
          value={`${a.totalRealizedPnl >= 0 ? "+" : ""}${a.totalRealizedPnl.toFixed(4)}`}
          sub={a.openCount > 0 ? `${a.unrealizedPnl >= 0 ? "+" : ""}${a.unrealizedPnl.toFixed(4)} unrealized` : `${a.total} closed`}
          color={pnlColor}
          icon={<Target size={14} />}
        />
        <StatCard
          label="Max Drawdown"
          value={`-${a.maxDrawdown.toFixed(4)}`}
          sub="Peak-to-trough equity"
          color="#f87171"
          icon={<AlertTriangle size={14} />}
        />
        <StatCard
          label="Avg P&L / Trade"
          value={`${a.avgPnl >= 0 ? "+" : ""}${a.avgPnl.toFixed(4)}`}
          sub={`Median: ${a.medianPnl >= 0 ? "+" : ""}${a.medianPnl.toFixed(4)}`}
          color={avgColor}
          icon={<BarChart3 size={14} />}
        />
        <StatCard
          label="Hold Time (Wins)"
          value={fmtMin(a.avgHoldTimeWins)}
          sub={`Losses: ${fmtMin(a.avgHoldTimeLosses)}`}
          color="#818cf8"
          icon={<Clock size={14} />}
        />
      </div>

      {/* By score range */}
      <div className="mb-5">
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Performance by Score Range</p>
        {a.byScore.every((r) => r.trades === 0) ? (
          <p className="text-slate-600 text-xs py-4 text-center">No data by score range yet</p>
        ) : (
          <div className="space-y-2">
            {a.byScore.map((row) => (
              <ScoreRow key={row.range} {...row} />
            ))}
          </div>
        )}
      </div>

      {/* Open positions banner */}
      {a.openCount > 0 && (
        <div className="mb-5 rounded-xl px-4 py-3 flex items-center justify-between"
          style={{ background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.18)" }}>
          <div>
            <p className="text-[9px] text-emerald-400 uppercase tracking-widest">Open Now</p>
            <p className="text-sm font-bold text-white">{a.openCount} position{a.openCount > 1 ? "s" : ""}</p>
          </div>
          <p className="text-sm font-black" style={{ color: a.unrealizedPnl >= 0 ? "#34d399" : "#f87171" }}>
            {fmtSol(a.unrealizedPnl, 4)} unrealized
          </p>
        </div>
      )}

      {/* Recent trades */}
      {a.recentTrades.length > 0 && (
        <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-3">Recent Trades</p>
          {a.recentTrades.map((t) => (
            <TradeRow key={t.id} pos={t} />
          ))}
        </div>
      )}
    </div>
  );
}
