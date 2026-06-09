import { useState } from "react";
import {
  usePumpfunStatus, usePumpfunTokens, usePumpfunPositions,
  usePumpfunHistory, usePumpfunEvents, usePumpfunConfig, useUpdatePumpfunConfig,
} from "@/lib/api";
import { PumpfunTrackedToken, PumpfunPosition, PumpfunTokenStatus, PumpfunConfig } from "@/lib/types";
import { Rocket, Wifi, WifiOff, TrendingUp, TrendingDown, Settings, AlertTriangle, Zap, Target, BarChart3, ChevronDown, ChevronUp, Clock } from "lucide-react";
import { Switch } from "@/components/ui/switch";

function fmtMcap(v: number | undefined): string {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPct(v: number): string { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }
function fmtSol(v: number): string { return `${v >= 0 ? "+" : ""}${v.toFixed(4)}`; }
function fmtPrice(p: number): string {
  if (!p) return "—";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.001) return p.toFixed(8);
  if (p < 1) return p.toFixed(6);
  return p.toFixed(4);
}
function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  return `${(s / 3600) | 0}h`;
}
function toIST(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function StatusBadge({ status }: { status: PumpfunTokenStatus }) {
  const map: Record<PumpfunTokenStatus, { label: string; cls: string }> = {
    watching: { label: "Watch", cls: "bg-white/8 text-white/40" },
    candidate: { label: "Candidate", cls: "bg-amber-500/20 text-amber-400 border border-amber-500/30" },
    buySignal: { label: "🔥 Signal", cls: "bg-violet-500/25 text-violet-300 border border-violet-500/40 animate-pulse" },
    bought: { label: "✓ Bought", cls: "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" },
    graduated: { label: "Graduated", cls: "bg-blue-500/15 text-blue-400 border border-blue-500/30" },
    exited: { label: "Exited", cls: "bg-white/8 text-white/40" },
    rejected: { label: "Rejected", cls: "bg-red-500/10 text-red-400/60" },
  };
  const m = map[status];
  return <span className={`px-2 py-0.5 rounded-md text-[9px] font-bold whitespace-nowrap ${m.cls}`}>{m.label}</span>;
}

function ScoreDot({ score }: { score: number }) {
  const cls = score >= 80 ? "text-emerald-400 font-black" : score >= 60 ? "text-amber-400 font-bold" : "text-white/30";
  return <span className={`text-xs ${cls}`}>{score}</span>;
}

function GradBar({ pct }: { pct: number }) {
  const clamped = Math.min(pct, 100);
  const cls = clamped >= 95 ? "bg-emerald-500" : clamped >= 85 ? "bg-amber-400" : clamped >= 70 ? "bg-blue-400" : "bg-white/15";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${cls}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={`text-[9px] font-bold w-8 text-right shrink-0 ${clamped >= 85 ? "text-amber-400" : "text-white/40"}`}>{clamped.toFixed(0)}%</span>
    </div>
  );
}

function TokenCard({ token }: { token: PumpfunTrackedToken }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-[#0d0d18] border border-white/6 rounded-xl overflow-hidden">
      <button
        className="w-full px-3.5 py-3 flex items-start gap-3 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-black text-white truncate">${token.symbol}</span>
            <StatusBadge status={token.status} />
          </div>
          <GradBar pct={token.graduationPct} />
        </div>
        <div className="text-right shrink-0">
          <ScoreDot score={token.score} />
          <p className="text-[9px] text-white/25 mt-0.5">{fmtMcap(token.mcap)}</p>
          <p className="text-[9px] text-white/20">{timeAgo(token.firstSeen)} ago</p>
        </div>
      </button>

      {expanded && (
        <div className="px-3.5 pb-3.5 pt-0 space-y-2.5 border-t border-white/5">
          {token.status === "rejected" && token.rejectionReason && (
            <div className="flex items-start gap-1.5 text-red-400 text-[11px] bg-red-500/8 rounded-lg px-2.5 py-2">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{token.rejectionReason}</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
            {(Object.entries({
              "Grad Speed": token.scoreBreakdown.graduationSpeed,
              "Vol Accel": token.scoreBreakdown.volumeAcceleration,
              "Buyers": token.scoreBreakdown.uniqueBuyerGrowth,
              "TX Vel": token.scoreBreakdown.txVelocity,
              "MCap Acc": token.scoreBreakdown.mcapAcceleration,
              "Distribution": token.scoreBreakdown.holderDistribution,
              "Whale": token.scoreBreakdown.whaleAccumulation,
              "Creator": token.scoreBreakdown.creatorRisk,
              "Momentum": token.scoreBreakdown.momentumStrength,
            }) as [string, number][]).map(([label, val]) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-[9px] text-white/25">{label}</span>
                <span className={`text-[9px] font-bold ${val >= 70 ? "text-emerald-400" : val >= 40 ? "text-amber-400" : "text-red-400/60"}`}>{val.toFixed(0)}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 text-[9px]">
            <span className="text-white/25">Price: ${fmtPrice(token.priceUsd)}</span>
            <span className="text-white/25">{token.uniqueBuyers?.length ?? 0} buyers</span>
            {token.creatorSold && <span className="text-red-400">⚠ Creator sold</span>}
          </div>
          {token.mint && (
            <div className="flex items-center gap-2">
              <code className="text-[9px] text-white/30 font-mono truncate flex-1">{token.mint.slice(0, 20)}…</code>
              {token.pairAddress && (
                <a href={`https://dexscreener.com/solana/${token.pairAddress}`} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] text-violet-400 shrink-0">DEX ↗</a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PositionCard({ pos }: { pos: PumpfunPosition }) {
  const pnl = pos.totalPnlSol;
  const pnlPos = pnl >= 0;
  const progress = ((pos.currentPrice / pos.entryPrice) - 1) * 100;
  return (
    <div className={`bg-[#0d0d18] border rounded-xl overflow-hidden ${pnlPos ? "border-emerald-500/20" : "border-red-500/15"}`}>
      <div className={`px-4 py-2.5 flex items-center justify-between ${pnlPos ? "bg-emerald-500/6" : "bg-red-500/6"}`}>
        <div className="flex items-center gap-2">
          {pnlPos ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
          <span className="text-sm font-black text-white">${pos.symbol}</span>
          <span className={`text-xs font-bold ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{fmtPct(pos.pnlPct)}</span>
        </div>
        <span className={`text-sm font-black ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>{fmtSol(pnl)} SOL</span>
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <div className="text-[10px] text-white/30">
          Entry {fmtMcap(pos.entryMcap)} · {pos.entryGraduationPct.toFixed(1)}% grad · Score {pos.entryScore}
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-[9px] text-white/30">
            <span>Entry ${fmtPrice(pos.entryPrice)}</span>
            <span>Now ${fmtPrice(pos.currentPrice)}</span>
          </div>
          <div className="relative h-1.5 bg-white/8 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${progress >= 1000 ? "bg-violet-400" : progress >= 300 ? "bg-emerald-400" : progress >= 0 ? "bg-blue-400" : "bg-red-400"}`}
              style={{ width: `${Math.min(Math.max((progress + 40) / 1040 * 100, 0), 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px]">
            <span className={pos.tp1Hit ? "text-emerald-400" : "text-white/15"}>TP1 +200%</span>
            <span className={pos.tp2Hit ? "text-violet-400" : "text-white/15"}>TP2 +500%</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {pos.tp1Hit && <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-bold">✓ TP1</span>}
          {pos.tp2Hit && <span className="text-[9px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 font-bold">✓ TP2 Moonbag</span>}
          <span className="text-[9px] text-white/25">{(pos.remainingFraction * 100).toFixed(0)}% remaining</span>
          <span className="text-[9px] text-white/25">{timeAgo(pos.entryAt)} ago</span>
        </div>
      </div>
    </div>
  );
}

function ClosedRow({ pos }: { pos: PumpfunPosition }) {
  const isWin = pos.realizedPnlSol > 0;
  return (
    <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/4 last:border-0">
      <div className="min-w-0 flex-1">
        <span className="text-xs font-bold text-white">${pos.symbol}</span>
        <p className="text-[9px] text-white/25 truncate">{pos.closeReason ?? "closed"} · {pos.closedAt ? toIST(pos.closedAt) : "—"}</p>
      </div>
      <span className={`text-xs font-bold ml-2 ${isWin ? "text-emerald-400" : "text-red-400"}`}>
        {fmtSol(pos.realizedPnlSol)}
        <span className="text-[9px] font-normal text-white/25 ml-1">({fmtPct(pos.pnlPct)})</span>
      </span>
    </div>
  );
}

function ConfigPanel({ config, onSave }: { config: PumpfunConfig; onSave: (c: Partial<PumpfunConfig>) => void }) {
  const [local, setLocal] = useState({ ...config });
  function update<K extends keyof PumpfunConfig>(key: K, val: PumpfunConfig[K]) {
    setLocal((prev) => ({ ...prev, [key]: val }));
  }
  const row = (label: string, key: keyof PumpfunConfig, step = 0.1, min = 0, max = 100) => (
    <div className="flex items-center justify-between py-2.5 border-b border-white/4">
      <span className="text-xs text-white/50">{label}</span>
      <input type="number" step={step} min={min} max={max} value={(local[key] as number)}
        onChange={(e) => update(key, parseFloat(e.target.value) as PumpfunConfig[keyof PumpfunConfig])}
        className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white text-right focus:outline-none focus:border-violet-500/50" />
    </div>
  );
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-white">Strategy Config</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/40">Enabled</span>
          <Switch checked={local.enabled} onCheckedChange={(v) => { update("enabled", v); onSave({ enabled: v }); }} />
        </div>
      </div>
      {row("Min AI Score", "minAiScore", 1, 0, 100)}
      {row("Position Size (SOL)", "positionSizeSol", 0.01, 0.01, 100)}
      {row("Max Open Positions", "maxOpenPositions", 1, 1, 20)}
      {row("Grad Min %", "graduationMinPct", 0.5, 50, 99)}
      {row("Grad Max %", "graduationMaxPct", 0.5, 85, 99.9)}
      {row("Virtual Balance (SOL)", "virtualBalanceSol", 1, 1, 1000)}
      <button onClick={() => onSave(local)}
        className="w-full mt-4 py-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold transition-colors">
        Save Config
      </button>
    </div>
  );
}

type TabKey = "live" | "tokens" | "history" | "config";

export default function PumpfunTrader() {
  const { data: status } = usePumpfunStatus();
  const { data: tokens = [] } = usePumpfunTokens();
  const { data: positions = [] } = usePumpfunPositions();
  const { data: history = [] } = usePumpfunHistory();
  const { data: events = [] } = usePumpfunEvents();
  const { data: config } = usePumpfunConfig();
  const updateConfig = useUpdatePumpfunConfig();

  const [tab, setTab] = useState<TabKey>("live");
  const [filterStatus, setFilterStatus] = useState<PumpfunTokenStatus | "all">("all");

  const filteredTokens = tokens.filter((t) => filterStatus === "all" ? true : t.status === filterStatus);
  const wins = history.filter((p) => p.realizedPnlSol > 0).length;
  const losses = history.filter((p) => p.realizedPnlSol <= 0).length;
  const totalPnl = history.reduce((s, p) => s + p.realizedPnlSol, 0) + positions.reduce((s, p) => s + p.totalPnlSol, 0);
  const winRate = history.length > 0 ? (wins / history.length) * 100 : 0;

  const statusFilters: Array<{ key: PumpfunTokenStatus | "all"; label: string }> = [
    { key: "all", label: "All" },
    { key: "candidate", label: "Candidate" },
    { key: "buySignal", label: "Signal" },
    { key: "bought", label: "Bought" },
    { key: "graduated", label: "Grad" },
    { key: "rejected", label: "Rejected" },
    { key: "watching", label: "Watching" },
  ];

  return (
    <div className="px-3 py-4 space-y-4 pb-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Rocket className="w-4 h-4 text-violet-400" />
            <h2 className="text-base font-black text-white">Pump.fun Tracker</h2>
          </div>
          <p className="text-[10px] text-white/30 mt-0.5">Pre-graduation AI entry · 85–99.5% target</p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold ${
            status?.ppConnected ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
          }`}>
            {status?.ppConnected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
            {status?.ppConnected ? "Live" : "Conn…"}
          </div>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold ${
            status?.enabled ? "bg-violet-500/15 text-violet-400" : "bg-white/8 text-white/25"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status?.enabled ? "bg-violet-400 animate-pulse" : "bg-white/20"}`} />
            {status?.enabled ? "ON" : "OFF"}
          </div>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: "Trades", val: history.length.toString(), cls: "text-white" },
          { label: "Win Rate", val: `${winRate.toFixed(0)}%`, cls: winRate >= 50 ? "text-emerald-400" : "text-red-400" },
          { label: "Total PnL", val: fmtSol(totalPnl), cls: totalPnl >= 0 ? "text-emerald-400" : "text-red-400" },
          { label: "Open", val: positions.length.toString(), cls: "text-white" },
        ].map((s) => (
          <div key={s.label} className="bg-[#0d0d18] border border-white/6 rounded-xl p-2.5 text-center">
            <p className={`text-base font-black ${s.cls}`}>{s.val}</p>
            <p className="text-[9px] text-white/30 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── Live stats strip ── */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
        {[
          { label: "Tracked", val: status?.trackedCount ?? 0 },
          { label: "Candidates", val: status?.candidateCount ?? 0 },
          { label: "W/L", val: `${wins}W/${losses}L` },
          { label: "Balance", val: `${(status?.virtualBalance ?? 0).toFixed(3)} SOL` },
        ].map((s) => (
          <div key={s.label} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-white/5 rounded-lg border border-white/5">
            <span className="text-[10px] text-white/30">{s.label}</span>
            <span className="text-[10px] font-bold text-white/70">{s.val}</span>
          </div>
        ))}
      </div>

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 bg-white/5 p-1 rounded-xl">
        {([
          { key: "live" as TabKey, label: `Live (${positions.length})` },
          { key: "tokens" as TabKey, label: `Tokens (${tokens.length})` },
          { key: "history" as TabKey, label: `History (${history.length})` },
          { key: "config" as TabKey, label: "Config" },
        ]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-2 rounded-lg text-[10px] font-bold transition-all ${
              tab === t.key ? "bg-violet-500/25 text-violet-300" : "text-white/30"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Live Positions Tab ── */}
      {tab === "live" && (
        <div className="space-y-2.5">
          {positions.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <Rocket className="w-8 h-8 text-violet-400/20 mx-auto mb-2" />
              <p className="text-white/25 text-sm">No active positions</p>
              <p className="text-white/15 text-[11px] mt-1">Watching {status?.trackedCount ?? 0} tokens for entry…</p>
            </div>
          ) : (
            positions.map((pos) => <PositionCard key={pos.id} pos={pos} />)
          )}
          {/* Recent closed in live tab */}
          {history.length > 0 && (
            <div>
              <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Recent Closed</p>
              <div className="bg-[#0d0d18] border border-white/6 rounded-xl overflow-hidden">
                {history.slice(0, 5).map((pos) => <ClosedRow key={pos.id} pos={pos} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Tokens Tab ── */}
      {tab === "tokens" && (
        <div className="space-y-3">
          <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
            {statusFilters.map(({ key, label }) => {
              const count = key === "all" ? tokens.length : tokens.filter(t => t.status === key).length;
              return (
                <button key={key} onClick={() => setFilterStatus(key)}
                  className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                    filterStatus === key
                      ? "bg-violet-500/25 text-violet-300 border border-violet-500/30"
                      : "bg-white/5 text-white/35 border border-white/5"
                  }`}>
                  {label} {count > 0 && <span className="opacity-60">({count})</span>}
                </button>
              );
            })}
          </div>
          <div className="space-y-2">
            {filteredTokens.length === 0 ? (
              <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-8 text-center">
                <p className="text-white/25 text-sm">No tokens in this category</p>
              </div>
            ) : filteredTokens.map((t) => <TokenCard key={t.mint} token={t} />)}
          </div>
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div>
          {history.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <p className="text-white/25 text-sm">No trade history yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Summary card */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-[#0d0d18] border border-emerald-500/15 rounded-xl p-3 text-center">
                  <p className="text-xl font-black text-emerald-400">{wins}</p>
                  <p className="text-[9px] text-white/30 mt-0.5">Wins</p>
                  <p className="text-[9px] text-emerald-400/60">
                    +{history.filter(p => p.realizedPnlSol > 0).reduce((s, p) => s + p.realizedPnlSol, 0).toFixed(4)}
                  </p>
                </div>
                <div className="bg-[#0d0d18] border border-red-500/15 rounded-xl p-3 text-center">
                  <p className="text-xl font-black text-red-400">{losses}</p>
                  <p className="text-[9px] text-white/30 mt-0.5">Losses</p>
                  <p className="text-[9px] text-red-400/60">
                    {history.filter(p => p.realizedPnlSol <= 0).reduce((s, p) => s + p.realizedPnlSol, 0).toFixed(4)}
                  </p>
                </div>
                <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
                  <p className={`text-xl font-black ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{winRate.toFixed(0)}%</p>
                  <p className="text-[9px] text-white/30 mt-0.5">Win Rate</p>
                  <p className={`text-[9px] ${totalPnl >= 0 ? "text-emerald-400/60" : "text-red-400/60"}`}>{fmtSol(totalPnl)} SOL</p>
                </div>
              </div>

              <div className="bg-[#0d0d18] border border-white/6 rounded-xl overflow-hidden">
                {history.map((pos) => <ClosedRow key={pos.id} pos={pos} />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Config Tab ── */}
      {tab === "config" && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          {config ? (
            <ConfigPanel config={config} onSave={(c) => updateConfig.mutate(c)} />
          ) : (
            <p className="text-white/25 text-sm text-center py-6">Loading config…</p>
          )}
        </div>
      )}
    </div>
  );
}
