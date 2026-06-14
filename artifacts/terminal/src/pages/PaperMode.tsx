import { useState } from "react";
import {
  FileText, Settings, X, TrendingUp, TrendingDown, RotateCcw,
  AlertTriangle, Wallet, ChevronRight, ExternalLink,
  BarChart2, Clock, Target, Shield, Sliders, Check,
} from "lucide-react";
import {
  usePaperSniperStatus, usePaperSniperPositions, usePaperSniperHistory,
  usePaperSniperEvents, useResetPaperAccount,
  usePaperSniperConfig, useUpdatePaperSniperConfig,
} from "@/lib/api";
import { PaperConfig, PaperPosition, PaperSniperEvent } from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(v: number, d = 4) { return v.toFixed(d); }
function fmtPct(v: number) { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }
function fmtPrice(p: number) {
  if (!p) return "$0";
  if (p < 0.000001) return `$${p.toExponential(2)}`;
  if (p < 0.0001)   return `$${p.toExponential(3)}`;
  return `$${p.toFixed(6)}`;
}
function ageStr(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── Settings modal ─────────────────────────────────────────────────────────────

type FieldDef = {
  key: keyof PaperConfig;
  label: string;
  description: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
  section?: string;
};

const FIELDS: FieldDef[] = [
  { section: "Position sizing", key: "positionSizeSol",  label: "Position size",         description: "SOL per virtual trade",                       suffix: "SOL", min: 0.001, max: 10,   step: 0.001 },
  { key: "maxOpenPositions",   label: "Max open positions",    description: "Max concurrent paper trades",                 suffix: "",    min: 1,     max: 20,   step: 1 },
  { section: "Take profit",    key: "tp1Pct",           label: "TP1 target",            description: "Sell % of position at this gain",             suffix: "%",   min: 10,    max: 2000, step: 10 },
  { key: "tp1ClosePct",        label: "TP1 close %",           description: "Portion of position to sell at TP1",          suffix: "%",   min: 1,     max: 100,  step: 1 },
  { key: "tp2Pct",             label: "TP2 target",            description: "Sell more at this gain",                      suffix: "%",   min: 50,    max: 5000, step: 10 },
  { key: "tp2ClosePct",        label: "TP2 close %",           description: "Portion of remaining to sell at TP2",         suffix: "%",   min: 1,     max: 100,  step: 1 },
  { key: "trailingStopPct",    label: "Trailing stop",         description: "Stop when price drops this % from peak",      suffix: "%",   min: 1,     max: 90,   step: 1 },
  { section: "Stop loss",      key: "slPhase1Pct",      label: "SL phase 1  (0–2 min)", description: "Max drawdown in the first 2 minutes",         suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slPhase2Pct",        label: "SL phase 2  (2–10 min)",description: "Max drawdown from peak, 2–10 min",           suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slPhase3Pct",        label: "SL phase 3  (10 min+)", description: "Max drawdown from peak after 10 min",        suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slAfterTp1Pct",      label: "SL after TP1",          description: "Trailing SL % from peak once TP1 is hit",    suffix: "%",   min: 1,     max: 90,   step: 1 },
];

const DEFAULT_CFG: PaperConfig = {
  positionSizeSol: 0.05, maxOpenPositions: 3,
  tp1Pct: 150, tp1ClosePct: 40, tp2Pct: 400, tp2ClosePct: 40,
  trailingStopPct: 30, slPhase1Pct: 20, slPhase2Pct: 25, slPhase3Pct: 30, slAfterTp1Pct: 35,
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { data: cfg } = usePaperSniperConfig();
  const update = useUpdatePaperSniperConfig();
  const [draft, setDraft] = useState<Partial<PaperConfig>>({});
  const merged = { ...DEFAULT_CFG, ...cfg, ...draft };
  const isDirty = Object.keys(draft).length > 0;

  function handleSave() {
    update.mutate(draft, { onSuccess: () => { setDraft({}); onClose(); } });
  }

  const sections: string[] = [];
  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-auto bg-[#111119] border border-amber-500/20 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center">
              <Sliders size={14} className="text-amber-400" />
            </div>
            <div>
              <p className="text-sm font-black text-white">Paper Settings</p>
              <p className="text-[10px] text-white/40 font-medium">Changes apply to new positions only</p>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-colors">
            <X size={14} className="text-white/50" />
          </button>
        </div>

        {/* Fields */}
        <div className="overflow-y-auto max-h-[72vh] px-5 py-3 space-y-0.5">
          {FIELDS.map((f) => {
            const showSection = f.section && !sections.includes(f.section);
            if (f.section && showSection) sections.push(f.section);
            return (
              <div key={f.key}>
                {showSection && (
                  <p className="text-[9px] font-black text-amber-400/60 uppercase tracking-[0.2em] pt-4 pb-2 border-b border-amber-500/10 mb-1">
                    {f.section}
                  </p>
                )}
                <div className="flex items-center justify-between py-3 border-b border-white/4 last:border-0">
                  <div className="flex-1 mr-4">
                    <p className="text-[11px] font-semibold text-white/75">{f.label}</p>
                    <p className="text-[10px] text-white/30 mt-0.5">{f.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      className="w-20 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5 text-xs font-black text-white text-right focus:outline-none focus:border-amber-500/50 focus:bg-amber-500/5 transition-colors tabular-nums"
                      value={draft[f.key] ?? merged[f.key]}
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      onChange={(e) => {
                        const v = f.step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
                        if (!isNaN(v)) setDraft((d) => ({ ...d, [f.key]: v }));
                      }}
                    />
                    {f.suffix && <span className="text-[10px] text-white/35 font-medium w-6">{f.suffix}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-white/6 bg-white/2">
          <button onClick={() => setDraft({})} disabled={!isDirty} className="text-[11px] text-white/35 hover:text-white/60 disabled:opacity-30 transition-colors font-medium">
            Discard changes
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || update.isPending}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-black text-xs font-black transition-colors"
          >
            {update.isPending
              ? <span className="w-3.5 h-3.5 rounded-full border-2 border-black/30 border-t-black animate-spin" />
              : <Check size={12} />}
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Open position card ─────────────────────────────────────────────────────────

function OpenPositionCard({ pos }: { pos: PaperPosition }) {
  const pct     = pos.pnlPct;
  const isPos   = pct >= 0;
  const ageMs   = Date.now() - pos.entryAt;
  const drawPct = pos.trailingHigh > 0 ? ((pos.currentPrice / pos.trailingHigh) - 1) * 100 : 0;
  const atPeak  = pos.trailingHigh > 0 && pos.currentPrice >= pos.trailingHigh * 0.995;

  return (
    <div className={`rounded-2xl border p-4 ${isPos ? "bg-emerald-950/20 border-emerald-500/15" : "bg-red-950/20 border-red-500/15"}`}>
      {/* Top row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/6 border border-white/10 flex items-center justify-center">
            <span className="text-sm font-black text-white/60">{pos.symbol.charAt(0)}</span>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-black text-white">{pos.symbol}</span>
              {pos.tp1Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-bold border border-violet-500/20">TP1</span>}
              {pos.tp2Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/20">TP2</span>}
              {atPeak    && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/20">ATH</span>}
            </div>
            <p className="text-[10px] text-white/30 font-medium mt-0.5">{ageStr(ageMs)} in trade · {fmt(pos.sizeSol, 3)} SOL</p>
          </div>
        </div>
        <div className={`text-right ${isPos ? "text-emerald-400" : "text-red-400"}`}>
          <p className="text-xl font-black leading-none">{fmtPct(pct)}</p>
          <p className={`text-[11px] font-bold mt-0.5 ${pos.unrealizedPnlSol >= 0 ? "text-emerald-300/70" : "text-red-300/70"}`}>
            {pos.unrealizedPnlSol >= 0 ? "+" : ""}{fmt(pos.unrealizedPnlSol)} SOL
          </p>
        </div>
      </div>

      {/* Price row */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: "Entry",  val: fmtPrice(pos.entryPrice),   cl: "text-white/70" },
          { label: "Now",    val: fmtPrice(pos.currentPrice), cl: isPos ? "text-emerald-300" : "text-red-300" },
          { label: "Peak",   val: fmtPrice(pos.trailingHigh), cl: "text-amber-300/80" },
        ].map(({ label, val, cl }) => (
          <div key={label} className="bg-white/3 rounded-xl p-2.5">
            <p className="text-[9px] text-white/30 font-medium mb-1">{label}</p>
            <p className={`text-[11px] font-bold tabular-nums ${cl}`}>{val}</p>
          </div>
        ))}
      </div>

      {/* SL bar */}
      <div className="flex items-center gap-2">
        <Shield size={10} className="text-white/20 shrink-0" />
        <div className="flex-1 h-1 bg-white/6 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.max(0, Math.min(100, (pos.currentPrice / pos.trailingHigh) * 100))}%`, background: isPos ? "#34d399" : "#f87171" }}
          />
        </div>
        <span className="text-[9px] text-white/30 font-medium tabular-nums">{drawPct.toFixed(1)}% from peak</span>
        <a href={`https://solscan.io/token/${pos.mint}`} target="_blank" rel="noreferrer">
          <ExternalLink size={10} className="text-white/20 hover:text-amber-400 transition-colors" />
        </a>
      </div>

      {/* Realized partials */}
      {pos.realizedPnlSol > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-white/5 flex items-center gap-2">
          <TrendingUp size={10} className="text-violet-400/60" />
          <p className="text-[10px] text-white/35">
            Banked: <span className="text-violet-300 font-bold">+{fmt(pos.realizedPnlSol)} SOL</span>
            {pos.tp1RealizedSol > 0 && <span className="text-white/25"> (TP1 +{fmt(pos.tp1RealizedSol)})</span>}
            {pos.tp2RealizedSol > 0 && <span className="text-white/25"> (TP2 +{fmt(pos.tp2RealizedSol)})</span>}
          </p>
        </div>
      )}
    </div>
  );
}

// ── History row ────────────────────────────────────────────────────────────────

function HistoryRow({ pos }: { pos: PaperPosition }) {
  const isWin  = pos.realizedPnlSol >= 0;
  const pnlPct = pos.exitPrice && pos.entryPrice ? ((pos.exitPrice / pos.entryPrice) - 1) * 100 : pos.pnlPct;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-white/4 last:border-0 hover:bg-white/2 rounded-xl px-1 transition-colors">
      <div className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 ${isWin ? "bg-emerald-500/12" : "bg-red-500/12"}`}>
        {isWin ? <TrendingUp size={13} className="text-emerald-400" /> : <TrendingDown size={13} className="text-red-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-black text-white">{pos.symbol}</span>
          {pos.tp1Hit && <span className="text-[8px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300 font-bold">TP1</span>}
          {pos.tp2Hit && <span className="text-[8px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 font-bold">TP2</span>}
        </div>
        <p className="text-[10px] text-white/25 truncate mt-0.5">{pos.closeReason ?? "—"}</p>
      </div>
      <div className="text-right shrink-0">
        <p className={`text-xs font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
          {isWin ? "+" : ""}{fmt(pos.realizedPnlSol)} SOL
        </p>
        <p className={`text-[10px] font-bold ${isWin ? "text-emerald-400/55" : "text-red-400/55"}`}>{fmtPct(pnlPct)}</p>
      </div>
    </div>
  );
}

// ── Event row ──────────────────────────────────────────────────────────────────

function EventRow({ e }: { e: PaperSniperEvent }) {
  const isEnter  = e.action === "entered";
  const isClose  = e.action === "closed";
  const isWin    = (e.pnlSol ?? 0) >= 0;

  return (
    <div className="flex items-start gap-3 px-4 py-3 border-b border-white/4 last:border-0">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
        isEnter ? "bg-emerald-500/15"
        : isClose && isWin ? "bg-emerald-500/15"
        : isClose ? "bg-red-500/15"
        : "bg-white/6"
      }`}>
        {isEnter && <ChevronRight size={12} className="text-emerald-400" />}
        {isClose && isWin  && <TrendingUp   size={12} className="text-emerald-400" />}
        {isClose && !isWin && <TrendingDown  size={12} className="text-red-400" />}
        {e.action === "skipped" && <AlertTriangle size={11} className="text-white/30" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold text-white/80">{e.symbol}</span>
          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-full ${
            isEnter ? "bg-emerald-500/15 text-emerald-300"
            : isClose ? "bg-violet-500/15 text-violet-300"
            : "bg-white/6 text-white/35"
          }`}>{e.action.toUpperCase()}</span>
          {e.pnlSol !== undefined && (
            <span className={`text-[10px] font-black ml-auto ${e.pnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {e.pnlSol >= 0 ? "+" : ""}{e.pnlSol.toFixed(4)} SOL
            </span>
          )}
        </div>
        {(e.skipReason || e.closeReason) && (
          <p className="text-[10px] text-white/25 mt-0.5 truncate">{e.skipReason ?? e.closeReason}</p>
        )}
        <p className="text-[9px] text-white/20 mt-0.5">{new Date(e.detectedAt).toLocaleTimeString()}</p>
      </div>
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent = "neutral" }: {
  label: string; value: string; sub?: string;
  accent?: "amber" | "emerald" | "red" | "violet" | "neutral";
}) {
  const cls: Record<string, string> = {
    amber:   "text-amber-400",
    emerald: "text-emerald-400",
    red:     "text-red-400",
    violet:  "text-violet-400",
    neutral: "text-white",
  };
  const bg: Record<string, string> = {
    amber:   "bg-amber-500/8  border-amber-500/15",
    emerald: "bg-emerald-500/8 border-emerald-500/15",
    red:     "bg-red-500/8   border-red-500/15",
    violet:  "bg-violet-500/8 border-violet-500/15",
    neutral: "bg-white/4     border-white/8",
  };
  return (
    <div className={`rounded-2xl border p-4 ${bg[accent]}`}>
      <p className="text-[9px] text-white/35 font-black uppercase tracking-widest mb-2">{label}</p>
      <p className={`text-xl font-black leading-none ${cls[accent]}`}>{value}</p>
      {sub && <p className="text-[10px] text-white/30 mt-1.5 leading-relaxed">{sub}</p>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function PaperMode() {
  const [showSettings, setShowSettings] = useState(false);
  const [showReset,    setShowReset]    = useState(false);
  const [tab,          setTab]          = useState<"open" | "history" | "events">("open");

  const { data: status }         = usePaperSniperStatus();
  const { data: positions = [] } = usePaperSniperPositions();
  const { data: history = []   } = usePaperSniperHistory();
  const { data: events = []    } = usePaperSniperEvents();
  const { data: config }         = usePaperSniperConfig();
  const resetMutation            = useResetPaperAccount();

  const realizedPnl   = status?.totalRealizedPnlSol   ?? 0;
  const unrealizedPnl = status?.totalUnrealizedPnlSol ?? 0;
  const combinedPnl   = status?.totalCombinedPnlSol   ?? 0;
  const vBal          = status?.virtualBalance         ?? 0;
  const startBal      = status?.startingBalance        ?? 0.1;
  const balPct        = ((vBal / startBal) - 1) * 100;
  const winRate       = status && status.tradesTotal > 0
    ? `${((status.wins / status.tradesTotal) * 100).toFixed(0)}%`
    : "—";

  return (
    <div className="min-h-screen bg-[#09090f]" style={{ fontFamily: "'Inter', sans-serif" }}>

      {/* Amber glow */}
      <div className="pointer-events-none absolute top-0 left-0 right-0 h-64 bg-gradient-to-b from-amber-500/7 via-amber-500/2 to-transparent" />

      {/* ── Header ── */}
      <div className="sticky top-0 z-40 bg-[#09090f]/92 backdrop-blur-xl border-b border-white/6">
        <div className="flex items-center justify-between px-4 py-3 max-w-screen-sm mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center">
              <FileText size={14} className="text-amber-400" />
            </div>
            <div>
              <h1 className="text-sm font-black text-white tracking-tight">Paper Mode</h1>
              <p className="text-[9px] text-white/35 font-semibold tracking-wider uppercase mt-0.5">
                Virtual trading · No real funds
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status && status.tradesTotal > 0 && (
              <div className="hidden sm:flex items-center gap-1 bg-white/5 border border-white/8 rounded-full px-2.5 py-1">
                <span className="text-emerald-400 text-[10px] font-black">{status.wins}W</span>
                <span className="text-white/25 text-[10px] mx-0.5">/</span>
                <span className="text-red-400 text-[10px] font-black">{status.losses}L</span>
              </div>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className="w-8 h-8 rounded-xl bg-white/5 hover:bg-amber-500/15 border border-white/8 hover:border-amber-500/20 flex items-center justify-center transition-all group"
            >
              <Settings size={13} className="text-white/40 group-hover:text-amber-400 transition-colors" />
            </button>
            <button
              onClick={() => setShowReset(true)}
              className="w-8 h-8 rounded-xl bg-white/5 hover:bg-red-500/15 border border-white/8 hover:border-red-500/20 flex items-center justify-center transition-all group"
            >
              <RotateCcw size={13} className="text-white/40 group-hover:text-red-400 transition-colors" />
            </button>
          </div>
        </div>
      </div>

      <div className="relative px-4 pt-5 pb-6 max-w-screen-sm mx-auto space-y-4">

        {/* ── Balance hero ── */}
        <div className="rounded-2xl bg-gradient-to-br from-amber-500/10 via-amber-600/4 to-transparent border border-amber-500/20 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] text-amber-400/65 font-black uppercase tracking-[0.18em] mb-1.5">Virtual Balance</p>
              <p className="text-4xl font-black text-white leading-none tracking-tight">
                {fmt(vBal)}
                <span className="text-xl font-bold text-white/35 ml-2">SOL</span>
              </p>
              <div className="flex items-center gap-2 mt-2.5">
                <div className={`w-1.5 h-1.5 rounded-full ${balPct >= 0 ? "bg-emerald-400" : "bg-red-400"}`} />
                <span className={`text-xs font-bold ${balPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {balPct >= 0 ? "+" : ""}{balPct.toFixed(1)}% from start
                </span>
                <span className="text-white/20 text-xs font-medium">(started {fmt(startBal, 3)} SOL)</span>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1 justify-end mb-1">
                <Wallet size={10} className="text-amber-400/50" />
                <span className="text-[10px] text-white/35 font-medium">In trades</span>
              </div>
              <p className="text-base font-black text-white/65">{fmt(status?.capitalInOpen ?? 0)} SOL</p>
              <p className="text-[10px] text-white/25 mt-0.5">{status?.openCount ?? 0} open</p>
            </div>
          </div>
        </div>

        {/* ── Stats grid ── */}
        <div className="grid grid-cols-2 gap-3">
          <StatCard
            label="Total P&L"
            value={`${combinedPnl >= 0 ? "+" : ""}${fmt(combinedPnl)} SOL`}
            sub={`Realized: ${realizedPnl >= 0 ? "+" : ""}${fmt(realizedPnl)}`}
            accent={combinedPnl >= 0 ? "emerald" : "red"}
          />
          <StatCard
            label="Unrealized"
            value={`${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl)} SOL`}
            sub={`${positions.length} position${positions.length !== 1 ? "s" : ""} open`}
            accent={unrealizedPnl === 0 ? "neutral" : unrealizedPnl > 0 ? "emerald" : "red"}
          />
          <StatCard
            label="Win Rate"
            value={winRate}
            sub={`${status?.wins ?? 0}W · ${status?.losses ?? 0}L of ${status?.tradesTotal ?? 0} total`}
            accent={winRate === "—" ? "neutral" : parseInt(winRate) >= 50 ? "emerald" : "red"}
          />
          <StatCard
            label="Config"
            value={`${config?.positionSizeSol ?? 0.05} SOL`}
            sub={`TP1 +${config?.tp1Pct ?? 150}% · TP2 +${config?.tp2Pct ?? 400}% · Max ${config?.maxOpenPositions ?? 3}`}
            accent="amber"
          />
        </div>

        {/* ── Tabs ── */}
        <div className="flex gap-1 bg-white/4 rounded-xl p-1">
          {(["open", "history", "events"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 rounded-lg text-[11px] font-bold transition-all capitalize ${
                tab === t
                  ? "bg-amber-500/18 text-amber-300 border border-amber-500/25"
                  : "text-white/30 hover:text-white/55"
              }`}
            >
              {t === "open"    && `Open (${positions.length})`}
              {t === "history" && `History (${history.length})`}
              {t === "events"  && `Events (${events.length})`}
            </button>
          ))}
        </div>

        {/* ── Open positions ── */}
        {tab === "open" && (
          <div className="space-y-3">
            {positions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/8 border border-amber-500/15 flex items-center justify-center">
                  <Target size={24} className="text-amber-400/40" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-white/25">Watching for graduations…</p>
                  <p className="text-[11px] text-white/15 mt-1 max-w-xs">
                    Paper trades fire automatically alongside live signals — no wallet needed.
                  </p>
                </div>
              </div>
            ) : (
              positions.map((pos) => <OpenPositionCard key={pos.id} pos={pos} />)
            )}
          </div>
        )}

        {/* ── History ── */}
        {tab === "history" && (
          <div className="rounded-2xl bg-white/3 border border-white/6 overflow-hidden">
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <BarChart2 size={26} className="text-white/12" />
                <p className="text-sm font-bold text-white/20">No closed trades yet</p>
              </div>
            ) : (
              <div className="px-3 py-1">
                {history.map((pos) => <HistoryRow key={pos.id} pos={pos} />)}
              </div>
            )}
          </div>
        )}

        {/* ── Events ── */}
        {tab === "events" && (
          <div className="rounded-2xl bg-white/3 border border-white/6 overflow-hidden">
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <Clock size={26} className="text-white/12" />
                <p className="text-sm font-bold text-white/20">No events yet</p>
              </div>
            ) : events.map((e) => <EventRow key={e.id} e={e} />)}
          </div>
        )}
      </div>

      {/* ── Settings modal ── */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── Reset confirm ── */}
      {showReset && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowReset(false)} />
          <div className="relative w-full max-w-sm bg-[#111119] border border-red-500/25 rounded-2xl shadow-2xl p-6">
            <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={20} className="text-red-400" />
            </div>
            <h3 className="text-base font-black text-white text-center mb-1.5">Reset Paper Account?</h3>
            <p className="text-xs text-white/35 text-center mb-6 leading-relaxed">
              All positions, history, and P&L will be permanently wiped.<br />
              Virtual balance returns to 0.1 SOL.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setShowReset(false)} className="flex-1 py-2.5 rounded-xl bg-white/5 hover:bg-white/8 border border-white/8 text-white/55 text-xs font-bold transition-colors">
                Cancel
              </button>
              <button
                onClick={() => { resetMutation.mutate(); setShowReset(false); }}
                disabled={resetMutation.isPending}
                className="flex-1 py-2.5 rounded-xl bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white text-xs font-black transition-colors"
              >
                {resetMutation.isPending ? "Resetting…" : "Reset Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
