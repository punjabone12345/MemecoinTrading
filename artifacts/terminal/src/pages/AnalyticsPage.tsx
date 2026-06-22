import { useEDStatus, useEDPositions, useWebSocket } from "@/lib/api";
import type { EDPosition } from "@/lib/types";
import { TrendingUp, TrendingDown, BarChart2, Target, Award, AlertTriangle } from "lucide-react";

function fmtSol(v: number, always = false): string {
  if (always && v >= 0) return `+${v.toFixed(4)}`;
  return v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4);
}
function fmtPct(v: number): string {
  return v >= 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`;
}
function fmtAge(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function StatCard({ label, value, sub, color, icon }: {
  label: string; value: string; sub?: string; color: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={color}>{icon}</span>
        <span className="text-xs text-white/50 uppercase tracking-wider">{label}</span>
      </div>
      <div className={`text-2xl font-black font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-white/40 mt-1">{sub}</div>}
    </div>
  );
}

function PositionRow({ pos }: { pos: EDPosition }) {
  const isProfit = pos.realizedPnlSol >= 0;
  return (
    <div className="grid grid-cols-7 gap-2 px-3 py-2.5 rounded-lg hover:bg-white/3 text-sm items-center border-b border-white/5">
      <div className="col-span-2">
        <div className="font-bold text-white">${pos.symbol}</div>
        <div className="text-[10px] text-white/30 mt-0.5">{fmtAge(pos.entryAt)}</div>
      </div>
      <div className="text-xs text-white/50">{pos.entryScore}/120</div>
      <div className="text-xs font-mono text-white/60">${pos.entryPrice.toExponential(2)}</div>
      <div className="text-xs font-mono text-white/60">${pos.exitPrice ? pos.exitPrice.toExponential(2) : "—"}</div>
      <div className={`text-xs font-mono font-bold ${isProfit ? "text-green-400" : "text-red-400"}`}>
        {fmtSol(pos.realizedPnlSol, true)}
      </div>
      <div>
        <div className="flex gap-1 text-[10px]">
          <span className={`px-1 rounded ${pos.tp1Hit ? "bg-green-500/20 text-green-400" : "bg-white/5 text-white/20"}`}>T1</span>
          <span className={`px-1 rounded ${pos.tp2Hit ? "bg-green-500/20 text-green-400" : "bg-white/5 text-white/20"}`}>T2</span>
        </div>
        <div className="text-[10px] text-white/30 mt-0.5 truncate">{pos.closeReason.slice(0, 20)}</div>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  useWebSocket();
  const statusQ    = useEDStatus();
  const positionsQ = useEDPositions();

  const status  = statusQ.data;
  const closed  = positionsQ.data?.closed ?? [];
  const open    = positionsQ.data?.open ?? [];

  const allClosed = closed.filter((p) => p.status === "closed");
  const wins   = allClosed.filter((p) => p.realizedPnlSol > 0);
  const losses = allClosed.filter((p) => p.realizedPnlSol <= 0);
  const totalRealized = allClosed.reduce((s, p) => s + p.realizedPnlSol, 0);
  const totalUnrealized = open.reduce((s, p) => s + p.unrealizedPnlSol, 0);
  const winRate = allClosed.length > 0 ? ((wins.length / allClosed.length) * 100).toFixed(1) : "—";
  const avgWin  = wins.length > 0 ? wins.reduce((s, p) => s + p.realizedPnlSol, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, p) => s + p.realizedPnlSol, 0) / losses.length : 0;
  const profitFactor = losses.length > 0 && avgLoss !== 0
    ? (wins.reduce((s, p) => s + p.realizedPnlSol, 0) / Math.abs(losses.reduce((s, p) => s + p.realizedPnlSol, 0))).toFixed(2)
    : wins.length > 0 ? "∞" : "—";

  const avgScore   = allClosed.length > 0 ? Math.round(allClosed.reduce((s, p) => s + p.entryScore, 0) / allClosed.length) : 0;
  const maxDrawdown = allClosed.reduce((dd, p) => Math.min(dd, p.realizedPnlSol), 0);

  return (
    <div className="flex flex-col h-screen bg-[#09090f] text-white pb-16 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-cyan-600 flex items-center justify-center">
            <BarChart2 size={12} className="text-white" />
          </div>
          <span className="font-black text-sm tracking-wider text-white">PERFORMANCE STATS</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-4 space-y-4">
          {/* KPI grid */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Win Rate"
              value={`${winRate}%`}
              sub={`${wins.length}W / ${losses.length}L`}
              color="text-green-400"
              icon={<Award size={14}/>}
            />
            <StatCard
              label="Profit Factor"
              value={String(profitFactor)}
              sub="gross profit / gross loss"
              color="text-violet-400"
              icon={<Target size={14}/>}
            />
            <StatCard
              label="Realized PnL"
              value={`${fmtSol(totalRealized)} SOL`}
              sub={`Unrealized: ${fmtSol(totalUnrealized)} SOL`}
              color={totalRealized >= 0 ? "text-green-400" : "text-red-400"}
              icon={<TrendingUp size={14}/>}
            />
            <StatCard
              label="Balance"
              value={`${(status?.virtualBalance ?? 0).toFixed(3)} SOL`}
              sub="from 1.000 SOL start"
              color="text-cyan-400"
              icon={<BarChart2 size={14}/>}
            />
            <StatCard
              label="Avg Entry Score"
              value={avgScore > 0 ? `${avgScore}/120` : "—"}
              sub={`${status?.launchesDetected ?? 0} launches scanned`}
              color="text-amber-400"
              icon={<Target size={14}/>}
            />
            <StatCard
              label="Max Drawdown"
              value={maxDrawdown < 0 ? `${maxDrawdown.toFixed(4)} SOL` : "—"}
              sub="worst single trade"
              color="text-red-400"
              icon={<AlertTriangle size={14}/>}
            />
          </div>

          {/* Avg win/loss */}
          {allClosed.length > 0 && (
            <div className="bg-white/3 rounded-xl border border-white/8 p-4">
              <div className="text-xs font-bold text-white/40 uppercase tracking-widest mb-3">Trade Averages</div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-1 mb-1">
                    <TrendingUp size={12} className="text-green-400"/>
                    <span className="text-xs text-white/50">Avg Win</span>
                  </div>
                  <div className="text-xl font-black font-mono text-green-400">{fmtSol(avgWin)} SOL</div>
                </div>
                <div>
                  <div className="flex items-center gap-1 mb-1">
                    <TrendingDown size={12} className="text-red-400"/>
                    <span className="text-xs text-white/50">Avg Loss</span>
                  </div>
                  <div className="text-xl font-black font-mono text-red-400">{fmtSol(avgLoss)} SOL</div>
                </div>
              </div>
            </div>
          )}

          {/* Trade history table */}
          <div className="bg-white/3 rounded-xl border border-white/8 overflow-hidden">
            <div className="px-3 py-2.5 border-b border-white/8">
              <div className="text-xs font-bold text-white/40 uppercase tracking-widest">
                Trade History ({allClosed.length})
              </div>
            </div>
            {allClosed.length === 0 ? (
              <div className="text-center py-10 text-white/20 text-sm">
                <BarChart2 size={20} className="mx-auto mb-2 opacity-30" />
                No closed trades yet
              </div>
            ) : (
              <div>
                {/* Table header */}
                <div className="grid grid-cols-7 gap-2 px-3 py-2 text-[10px] font-bold text-white/30 uppercase tracking-wide border-b border-white/5">
                  <div className="col-span-2">Token</div>
                  <div>Score</div>
                  <div>Entry</div>
                  <div>Exit</div>
                  <div>PnL</div>
                  <div>TPs</div>
                </div>
                {allClosed.map((pos) => <PositionRow key={pos.id} pos={pos} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
