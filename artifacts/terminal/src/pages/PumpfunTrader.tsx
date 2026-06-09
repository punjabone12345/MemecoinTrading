import { useState } from "react";
import {
  usePumpfunStatus, usePumpfunTokens, usePumpfunPositions,
  usePumpfunHistory, usePumpfunEvents, usePumpfunConfig, useUpdatePumpfunConfig,
  useInjectPumpfunToken,
} from "@/lib/api";
import { PumpfunTrackedToken, PumpfunPosition, PumpfunTokenStatus, PumpfunConfig } from "@/lib/types";
import { Rocket, Wifi, WifiOff, TrendingUp, TrendingDown, Settings, ChevronDown, ChevronUp, AlertTriangle, Zap, Target, Users, BarChart3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtMcap(v: number | undefined): string {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}
function fmtSol(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)}`;
}
function fmtPrice(p: number): string {
  if (!p) return "—";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.001)    return p.toFixed(8);
  if (p < 1)        return p.toFixed(6);
  return p.toFixed(4);
}
function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60)   return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  return `${(s / 3600) | 0}h ago`;
}
function toIST(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: PumpfunTokenStatus }) {
  const map: Record<PumpfunTokenStatus, { label: string; cls: string }> = {
    watching:   { label: "Watching",   cls: "bg-white/8 text-white/40" },
    candidate:  { label: "Candidate",  cls: "bg-amber-500/15 text-amber-400 border border-amber-500/30" },
    buySignal:  { label: "Buy Signal", cls: "bg-violet-500/20 text-violet-300 border border-violet-500/40 animate-pulse" },
    bought:     { label: "Bought",     cls: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" },
    graduated:  { label: "Graduated",  cls: "bg-blue-500/15 text-blue-400 border border-blue-500/30" },
    exited:     { label: "Exited",     cls: "bg-white/8 text-white/50" },
    rejected:   { label: "Rejected",   cls: "bg-red-500/10 text-red-400/70" },
  };
  const m = map[status];
  return (
    <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold whitespace-nowrap ${m.cls}`}>
      {m.label}
    </span>
  );
}

// ── Score badge ───────────────────────────────────────────────────────────────
function ScoreBadge({ score }: { score: number }) {
  const cls = score >= 80 ? "text-emerald-400 bg-emerald-500/15"
            : score >= 60 ? "text-amber-400 bg-amber-500/15"
            : "text-white/40 bg-white/8";
  return (
    <span className={`px-2 py-0.5 rounded-lg text-xs font-black ${cls}`}>{score}</span>
  );
}

// ── Graduation progress bar ───────────────────────────────────────────────────
function GradBar({ pct }: { pct: number }) {
  const clamped = Math.min(pct, 100);
  const cls = clamped >= 95 ? "bg-emerald-500"
            : clamped >= 85 ? "bg-amber-400"
            : clamped >= 70 ? "bg-blue-400"
            : "bg-white/20";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${cls}`} style={{ width: `${clamped}%` }} />
      </div>
      <span className={`text-[10px] font-bold w-10 text-right ${clamped >= 85 ? "text-amber-400" : "text-white/50"}`}>
        {clamped.toFixed(1)}%
      </span>
    </div>
  );
}

// ── Token row ─────────────────────────────────────────────────────────────────
function TokenRow({ token }: { token: PumpfunTrackedToken }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className="grid gap-2 px-3 py-2.5 border-b border-white/5 cursor-pointer hover:bg-white/3 transition-colors"
        style={{ gridTemplateColumns: "1fr 52px 1fr 76px 64px 80px" }}
        onClick={() => setExpanded(!expanded)}
      >
        {/* Token */}
        <div className="min-w-0">
          <div className="text-xs font-bold text-white truncate">{token.symbol}</div>
          <div className="text-[10px] text-white/30 truncate">{token.name}</div>
        </div>

        {/* AI Score */}
        <div className="flex items-center">
          <ScoreBadge score={token.score} />
        </div>

        {/* Graduation */}
        <div className="flex items-center">
          <GradBar pct={token.graduationPct} />
        </div>

        {/* MCap */}
        <div className="flex items-center justify-end">
          <span className="text-xs font-semibold text-white/80">{fmtMcap(token.mcap)}</span>
        </div>

        {/* Buyers */}
        <div className="flex items-center justify-end">
          <span className="text-xs text-white/60">{token.uniqueBuyers.length}</span>
        </div>

        {/* Status */}
        <div className="flex items-center justify-end">
          <StatusBadge status={token.status} />
        </div>
      </div>

      {/* Expanded row */}
      {expanded && (
        <div className="px-3 py-3 bg-white/3 border-b border-white/5 space-y-2">
          {/* Rejection reason */}
          {token.status === "rejected" && token.rejectionReason && (
            <div className="flex items-center gap-1.5 text-red-400 text-[11px] bg-red-500/10 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{token.rejectionReason}</span>
            </div>
          )}

          {/* Score breakdown */}
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries({
              "Grad Speed":    token.scoreBreakdown.graduationSpeed,
              "Vol Accel":     token.scoreBreakdown.volumeAcceleration,
              "Buyer Growth":  token.scoreBreakdown.uniqueBuyerGrowth,
              "TX Velocity":   token.scoreBreakdown.txVelocity,
              "MCap Accel":    token.scoreBreakdown.mcapAcceleration,
              "Distribution":  token.scoreBreakdown.holderDistribution,
              "Whale Accum":   token.scoreBreakdown.whaleAccumulation,
              "Creator Risk":  token.scoreBreakdown.creatorRisk,
              "Momentum":      token.scoreBreakdown.momentumStrength,
            }) as [string, number][]).map(([label, val]) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-[10px] text-white/30">{label}</span>
                <span className={`text-[10px] font-bold ${val >= 70 ? "text-emerald-400" : val >= 40 ? "text-amber-400" : "text-red-400/70"}`}>
                  {val.toFixed(0)}
                </span>
              </div>
            ))}
          </div>

          {/* CA */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/30">CA:</span>
            <code className="text-[10px] text-white/50 font-mono truncate">{token.mint}</code>
            {token.pairAddress && (
              <a
                href={`https://dexscreener.com/solana/${token.pairAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-violet-400 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                DexScreener ↗
              </a>
            )}
          </div>

          <div className="flex items-center gap-4 text-[10px] text-white/40">
            <span>Price: ${fmtPrice(token.priceUsd)}</span>
            <span>First seen: {timeAgo(token.firstSeen)}</span>
            {token.creatorSold && <span className="text-red-400">⚠ Creator sold</span>}
          </div>
        </div>
      )}
    </>
  );
}

// ── Position card ─────────────────────────────────────────────────────────────
function PositionCard({ pos }: { pos: PumpfunPosition }) {
  const pnl     = pos.totalPnlSol;
  const pnlPos  = pnl >= 0;
  const progress = ((pos.currentPrice / pos.entryPrice) - 1) * 100;
  const tp1Pct   = 300;
  const tp2Pct   = 1000;

  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-white">${pos.symbol}</span>
            <span className={`text-xs font-bold ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
              {fmtPct(pos.pnlPct)}
            </span>
          </div>
          <div className="text-[10px] text-white/30 mt-0.5">
            Entry: {fmtMcap(pos.entryMcap)} · {pos.entryGraduationPct.toFixed(1)}% grad · Score {pos.entryScore}
          </div>
        </div>
        <div className={`text-sm font-black ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
          {fmtSol(pnl)} SOL
        </div>
      </div>

      {/* TP progress bar */}
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-white/30">
          <span>Entry ${fmtPrice(pos.entryPrice)}</span>
          <span>Now ${fmtPrice(pos.currentPrice)}</span>
        </div>
        <div className="relative h-2 bg-white/10 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${progress >= tp2Pct ? "bg-violet-400" : progress >= tp1Pct ? "bg-emerald-400" : progress >= 0 ? "bg-blue-400" : "bg-red-400"}`}
            style={{ width: `${Math.min(Math.max((progress + 40) / (tp2Pct + 40) * 100, 0), 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px]">
          <span className={`${pos.tp1Hit ? "text-emerald-400" : "text-white/20"}`}>TP1 +300%</span>
          <span className={`${pos.tp2Hit ? "text-violet-400" : "text-white/20"}`}>TP2 +1000%</span>
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {pos.tp1Hit && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-bold">✓ TP1 Hit</span>
        )}
        {pos.tp2Hit && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 font-bold">✓ TP2 — Moonbag Active</span>
        )}
        {!pos.tp1Hit && !pos.tp2Hit && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/30">
            SL: ${fmtPrice(pos.effectiveSlPrice)}
          </span>
        )}
        <span className="text-[10px] text-white/30">{(pos.remainingFraction * 100).toFixed(0)}% remaining</span>
        <span className="text-[10px] text-white/30">{timeAgo(pos.entryAt)}</span>
      </div>
    </div>
  );
}

// ── Closed position row ────────────────────────────────────────────────────────
function ClosedRow({ pos }: { pos: PumpfunPosition }) {
  const isWin = pos.realizedPnlSol > 0;
  return (
    <div className="flex items-center justify-between px-3 py-2.5 border-b border-white/5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-white">${pos.symbol}</div>
        <div className="text-[10px] text-white/30 truncate">
          {pos.closeReason ?? "closed"} · {pos.closedAt ? toIST(pos.closedAt) : "—"}
        </div>
      </div>
      <div className={`text-xs font-bold ml-3 ${isWin ? "text-emerald-400" : "text-red-400"}`}>
        {fmtSol(pos.realizedPnlSol)} SOL
        <span className="ml-1 text-[10px] font-normal text-white/30">
          ({fmtPct(pos.pnlPct)})
        </span>
      </div>
    </div>
  );
}

// ── Config panel ──────────────────────────────────────────────────────────────
function ConfigPanel({ config, onSave }: { config: PumpfunConfig; onSave: (c: Partial<PumpfunConfig>) => void }) {
  const [local, setLocal] = useState({ ...config });

  function update<K extends keyof PumpfunConfig>(key: K, val: PumpfunConfig[K]) {
    setLocal((prev) => ({ ...prev, [key]: val }));
  }

  const row = (label: string, key: keyof PumpfunConfig, step = 0.1, min = 0, max = 100) => (
    <div className="flex items-center justify-between py-2 border-b border-white/5">
      <span className="text-xs text-white/60">{label}</span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={(local[key] as number)}
        onChange={(e) => update(key, parseFloat(e.target.value) as PumpfunConfig[keyof PumpfunConfig])}
        className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white text-right focus:outline-none focus:border-violet-500/50"
      />
    </div>
  );

  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4 space-y-1">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-white">Strategy Config</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/40">Enabled</span>
          <Switch
            checked={local.enabled}
            onCheckedChange={(v) => { update("enabled", v); onSave({ enabled: v }); }}
          />
        </div>
      </div>

      {row("Min AI Score (0-100)",     "minAiScore",      1, 0, 100)}
      {row("Position Size (SOL)",      "positionSizeSol", 0.01, 0.01, 100)}
      {row("Max Open Positions",       "maxOpenPositions",1, 1, 20)}
      {row("Grad Min % (entry lower)", "graduationMinPct",0.5, 50, 99)}
      {row("Grad Max % (entry upper)", "graduationMaxPct",0.5, 85, 99.9)}
      {row("Virtual Balance (SOL)",    "virtualBalanceSol",1, 1, 1000)}

      <div className="pt-3">
        <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2">Score Weights (must sum ≈ 1.0)</p>
        {([
          ["Graduation Speed",    "graduationSpeed"],
          ["Volume Acceleration", "volumeAcceleration"],
          ["Unique Buyer Growth", "uniqueBuyerGrowth"],
          ["TX Velocity",         "txVelocity"],
          ["MCap Acceleration",   "mcapAcceleration"],
          ["Holder Distribution", "holderDistribution"],
          ["Whale Accumulation",  "whaleAccumulation"],
          ["Creator Risk",        "creatorRisk"],
          ["Momentum Strength",   "momentumStrength"],
        ] as [string, keyof PumpfunConfig["scoreWeights"]][]).map(([label, key]) => (
          <div key={key} className="flex items-center justify-between py-1.5 border-b border-white/5">
            <span className="text-[11px] text-white/50">{label}</span>
            <input
              type="number"
              step={0.01}
              min={0}
              max={1}
              value={local.scoreWeights[key]}
              onChange={(e) => update("scoreWeights", { ...local.scoreWeights, [key]: parseFloat(e.target.value) })}
              className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[11px] text-white text-right focus:outline-none focus:border-violet-500/50"
            />
          </div>
        ))}
      </div>

      <button
        onClick={() => onSave(local)}
        className="w-full mt-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition-colors"
      >
        Save Config
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
type TabKey = "tokens" | "positions" | "history" | "events" | "config";

export default function PumpfunTrader() {
  const { data: status }    = usePumpfunStatus();
  const { data: tokens = [] }  = usePumpfunTokens();
  const { data: positions = [] } = usePumpfunPositions();
  const { data: history = [] }   = usePumpfunHistory();
  const { data: events = [] }    = usePumpfunEvents();
  const { data: config }         = usePumpfunConfig();
  const updateConfig = useUpdatePumpfunConfig();

  const [tab, setTab] = useState<TabKey>("tokens");
  const [filterStatus, setFilterStatus] = useState<PumpfunTokenStatus | "all">("all");

  const filteredTokens = tokens.filter((t) =>
    filterStatus === "all" ? true : t.status === filterStatus,
  );

  const wins     = history.filter((p) => p.realizedPnlSol > 0).length;
  const losses   = history.filter((p) => p.realizedPnlSol <= 0).length;
  const totalPnl = history.reduce((s, p) => s + p.realizedPnlSol, 0) +
                   positions.reduce((s, p) => s + p.totalPnlSol, 0);
  const winRate  = history.length > 0 ? (wins / history.length) * 100 : 0;

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Rocket className="w-4 h-4 text-violet-400" />
            <h2 className="text-base font-black text-white">Pump.fun Pre-Grad Trader</h2>
          </div>
          <p className="text-white/30 text-xs mt-0.5">
            AI-powered entry before graduation · Target: 85–99.5%
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* PumpPortal status */}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold ${
            status?.ppConnected
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-amber-500/15 text-amber-400"
          }`}>
            {status?.ppConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
            {status?.ppConnected ? "PumpPortal Live" : "Connecting…"}
          </div>
          {/* Helius WS status — only show if connected */}
          {status?.wsConnected && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold bg-blue-500/15 text-blue-400">
              <Wifi className="w-3 h-3" />
              Helius
            </div>
          )}
          {/* Bot enabled */}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold ${
            status?.enabled
              ? "bg-violet-500/15 text-violet-400"
              : "bg-white/8 text-white/30"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${status?.enabled ? "bg-violet-400 animate-pulse" : "bg-white/20"}`} />
            {status?.enabled ? "ACTIVE" : "PAUSED"}
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-2">
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
          <p className="text-lg font-black text-white">{history.length}</p>
          <p className="text-[10px] text-white/30 mt-0.5">Trades</p>
        </div>
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
          <p className={`text-lg font-black ${winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}>
            {winRate.toFixed(0)}%
          </p>
          <p className="text-[10px] text-white/30 mt-0.5">Win Rate</p>
        </div>
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
          <p className={`text-base font-black ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {fmtSol(totalPnl)}
          </p>
          <p className="text-[10px] text-white/30 mt-0.5">Total PnL</p>
        </div>
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
          <p className="text-lg font-black text-white">{positions.length}</p>
          <p className="text-[10px] text-white/30 mt-0.5">Open</p>
        </div>
      </div>

      {/* Additional stats: tracked / candidates / balance */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {[
          { label: "Tracked",    val: status?.trackedCount ?? 0,    icon: <Zap className="w-3 h-3" /> },
          { label: "Candidates", val: status?.candidateCount ?? 0,  icon: <Target className="w-3 h-3" /> },
          { label: "Balance",    val: `${(status?.virtualBalance ?? 0).toFixed(3)} SOL`, icon: <BarChart3 className="w-3 h-3" /> },
          { label: "W/L",        val: `${wins}W / ${losses}L`,      icon: <TrendingUp className="w-3 h-3" /> },
        ].map((s) => (
          <div key={s.label} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-white/5 rounded-lg">
            <span className="text-violet-400/70">{s.icon}</span>
            <span className="text-[11px] text-white/40">{s.label}:</span>
            <span className="text-[11px] font-bold text-white/80">{s.val}</span>
          </div>
        ))}
      </div>

      {/* Open positions (always visible if any) */}
      {positions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-white/50 uppercase tracking-widest">
            Open Positions ({positions.length})
          </p>
          {positions.map((pos) => <PositionCard key={pos.id} pos={pos} />)}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 bg-white/5 p-1 rounded-xl">
        {(["tokens", "positions", "history", "events", "config"] as TabKey[]).map((t) => {
          const labels: Record<TabKey, string> = {
            tokens: `Tokens (${tokens.length})`,
            positions: `Active (${positions.length})`,
            history: `History (${history.length})`,
            events: `Events (${events.length})`,
            config: "Config",
          };
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                tab === t ? "bg-violet-500/20 text-violet-400" : "text-white/30 hover:text-white/60"
              }`}
            >
              {labels[t]}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === "tokens" && (
        <div className="space-y-2">
          {/* Status filters */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {(["all", "buySignal", "candidate", "watching", "rejected"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`flex-shrink-0 px-3 py-1 rounded-lg text-[10px] font-bold transition-all ${
                  filterStatus === s
                    ? "bg-violet-500/20 text-violet-400 border border-violet-500/30"
                    : "bg-white/5 text-white/40"
                }`}
              >
                {s === "all" ? `All (${tokens.length})`
                  : s === "buySignal" ? `Buy Signal (${tokens.filter((t) => t.status === "buySignal").length})`
                  : s === "candidate" ? `Candidate (${tokens.filter((t) => t.status === "candidate").length})`
                  : s === "watching" ? `Watching (${tokens.filter((t) => t.status === "watching").length})`
                  : `Rejected (${tokens.filter((t) => t.status === "rejected").length})`}
              </button>
            ))}
          </div>

          {filteredTokens.length === 0 ? (
            <div className="text-center py-12 text-white/20">
              <Rocket className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-semibold">No tokens tracked yet</p>
              <p className="text-xs mt-1">
                {process.env.NODE_ENV !== "production"
                  ? "Connect HELIUS_API_KEY to start monitoring pump.fun"
                  : "Monitoring pump.fun program for new tokens…"}
              </p>
            </div>
          ) : (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
              {/* Header */}
              <div
                className="grid gap-2 px-3 py-2 border-b border-white/10"
                style={{ gridTemplateColumns: "1fr 52px 1fr 76px 64px 80px" }}
              >
                {["Token", "Score", "Graduation %", "MCap", "Buyers", "Status"].map((h) => (
                  <span key={h} className="text-[10px] text-white/30 font-semibold uppercase tracking-wider">
                    {h}
                  </span>
                ))}
              </div>
              {filteredTokens.map((t) => <TokenRow key={t.mint} token={t} />)}
            </div>
          )}
        </div>
      )}

      {tab === "positions" && (
        <div className="space-y-2">
          {positions.length === 0 ? (
            <div className="text-center py-12 text-white/20">
              <Target className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-semibold">No open positions</p>
              <p className="text-xs mt-1">Waiting for buy signal with score ≥ {status?.config.minAiScore ?? 80}</p>
            </div>
          ) : (
            positions.map((pos) => <PositionCard key={pos.id} pos={pos} />)
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-3">
          {/* Summary */}
          {history.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
                <p className="text-base font-black text-emerald-400">{wins}</p>
                <p className="text-[10px] text-white/30">Wins</p>
              </div>
              <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
                <p className="text-base font-black text-red-400">{losses}</p>
                <p className="text-[10px] text-white/30">Losses</p>
              </div>
              <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 text-center">
                <p className={`text-base font-black ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {fmtSol(history.reduce((s, p) => s + p.realizedPnlSol, 0))}
                </p>
                <p className="text-[10px] text-white/30">Closed PnL</p>
              </div>
            </div>
          )}

          {history.length === 0 ? (
            <div className="text-center py-12 text-white/20">
              <BarChart3 className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-semibold">No closed trades yet</p>
            </div>
          ) : (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
              {history.map((pos) => <ClosedRow key={pos.id} pos={pos} />)}
            </div>
          )}
        </div>
      )}

      {tab === "events" && (
        <div className="space-y-1">
          {events.length === 0 ? (
            <div className="text-center py-12 text-white/20">
              <Zap className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-semibold">No events yet</p>
            </div>
          ) : (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
              {events.map((ev) => (
                <div
                  key={ev.id}
                  className="flex items-center gap-3 px-3 py-2.5 border-b border-white/5 last:border-0"
                >
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    ev.action === "entered" ? "bg-emerald-400"
                    : ev.action === "rejected" ? "bg-red-400"
                    : "bg-amber-400"
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">{ev.symbol}</span>
                      {ev.action === "entered" && (
                        <span className="text-[10px] text-emerald-400 font-semibold">ENTERED</span>
                      )}
                      {ev.action === "rejected" && (
                        <span className="text-[10px] text-red-400 font-semibold">REJECTED</span>
                      )}
                      {ev.action === "skipped" && (
                        <span className="text-[10px] text-amber-400 font-semibold">SKIPPED</span>
                      )}
                    </div>
                    {ev.skipReason && (
                      <p className="text-[10px] text-white/30 truncate">{ev.skipReason}</p>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    {ev.score !== undefined && (
                      <div className="text-[10px] font-bold text-white/60">Score {ev.score}</div>
                    )}
                    {ev.graduationPct !== undefined && (
                      <div className="text-[10px] text-amber-400/70">{ev.graduationPct.toFixed(1)}%</div>
                    )}
                    <div className="text-[9px] text-white/20">{timeAgo(ev.ts)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "config" && config && (
        <ConfigPanel
          config={config}
          onSave={(patch) => updateConfig.mutate(patch)}
        />
      )}

      {/* TP Structure Info */}
      <div className="bg-[#0d0d18] border border-violet-500/20 rounded-xl p-4">
        <p className="text-xs font-bold text-violet-400 mb-3 flex items-center gap-1.5">
          <Rocket className="w-3.5 h-3.5" />
          Pre-Graduation TP Structure
        </p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-lg font-black text-amber-400">+300%</div>
            <div className="text-[10px] text-white/40 mt-0.5">TP1</div>
            <div className="text-[10px] text-white/30">Sell 25%</div>
          </div>
          <div>
            <div className="text-lg font-black text-emerald-400">+1000%</div>
            <div className="text-[10px] text-white/40 mt-0.5">TP2</div>
            <div className="text-[10px] text-white/30">Sell 25%</div>
          </div>
          <div>
            <div className="text-lg font-black text-violet-400">50%</div>
            <div className="text-[10px] text-white/40 mt-0.5">Moonbag</div>
            <div className="text-[10px] text-white/30">40% trail</div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-white/5 text-center text-[10px] text-white/30">
          SL: -40% · Early exit if -30% in first 60s
        </div>
      </div>
    </div>
  );
}
