import { useState, useMemo } from "react";
import {
  Telescope, Wifi, WifiOff, TrendingUp, TrendingDown,
  ChevronRight, ExternalLink, AlertTriangle, Clock,
  Activity, Users, Zap, Shield, Target, RotateCcw, FlaskConical,
  X, Trash2, Pencil, Check, XCircle,
} from "lucide-react";
import {
  useEDStatus, useEDTokens, useEDPositions, useResetPaperBalance, useInjectTestToken,
  useEDClosePosition, useEDDeletePosition, useEDEditPosition,
} from "@/lib/api";
import type { EDPositionPatch } from "@/lib/api";
import type { EDToken, EDPosition, EDTokenStatus } from "@/lib/types";

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function fmtMC(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtSol(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`;
}
function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/* ── Status badge ──────────────────────────────────────────────────────────── */
const STATUS_CONFIG: Record<EDTokenStatus, { label: string; color: string; bg: string }> = {
  tracking:  { label: "TRACKING",  color: "#94a3b8", bg: "rgba(148,163,184,0.12)" },
  rejected:  { label: "REJECTED",  color: "#f87171", bg: "rgba(248,113,113,0.12)" },
  eligible:  { label: "ELIGIBLE",  color: "#fbbf24", bg: "rgba(251,191,36,0.15)" },
  entered:   { label: "ENTERED",   color: "#34d399", bg: "rgba(52,211,153,0.15)" },
  exited:    { label: "EXITED",    color: "#818cf8", bg: "rgba(129,140,248,0.12)" },
};

function StatusBadge({ status }: { status: EDTokenStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className="text-[9px] font-black tracking-widest px-2 py-0.5 rounded-full"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      {cfg.label}
    </span>
  );
}

/* ── Score ring ───────────────────────────────────────────────────────────── */
function ScoreRing({ score, size = 48 }: { score: number; size?: number }) {
  const pct = score / 120;
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  const color = score >= 110 ? "#34d399" : score >= 100 ? "#fbbf24" : score >= 95 ? "#818cf8" : "#64748b";
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={5} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth={5} strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
      </svg>
      <span className="relative z-10 font-black text-xs" style={{ color }}>{score}</span>
    </div>
  );
}

/* ── Bonding curve bar ─────────────────────────────────────────────────────── */
function BondingBar({ pct }: { pct: number }) {
  const color = pct >= 80 ? "#34d399" : pct >= 70 ? "#fbbf24" : "#818cf8";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.08)" }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${Math.min(pct, 100)}%`, background: color }}
        />
      </div>
      <span className="text-[10px] font-bold tabular-nums" style={{ color, minWidth: 32 }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

/* ── Entry conditions checklist ────────────────────────────────────────────── */
const ENTRY_CONDITIONS = [
  { key: "score",    label: "Score ≥ threshold",       hint: (b: string[]) => b.find((x) => x.startsWith("Score")) ?? null },
  { key: "buyers",   label: "Unique buyers ≥ 10",      hint: (b: string[]) => b.find((x) => x.startsWith("Buyers")) ?? null },
  { key: "pressure", label: "Buy pressure ≥ 1.5×",     hint: (b: string[]) => b.find((x) => x.startsWith("Buy pressure")) ?? null },
  { key: "bonding",  label: "Bonding curve ≥ 60%",     hint: (b: string[]) => b.find((x) => x.startsWith("Bonding curve")) ?? null },
  { key: "rugcheck", label: "Rugcheck passed",          hint: (b: string[]) => b.find((x) => x.startsWith("Rugcheck")) ?? null },
  { key: "creator",  label: "Creator hold < 10%",       hint: (b: string[]) => b.find((x) => x.startsWith("Creator holds")) ?? null },
  { key: "holder",   label: "Top holder < 25%",         hint: (b: string[]) => b.find((x) => x.startsWith("Top holder")) ?? null },
  { key: "fomo",     label: "Price not pumped > 200%",  hint: (b: string[]) => b.find((x) => x.startsWith("Already pumped")) ?? null },
];

function EntryChecklist({ blockers }: { blockers: string[] }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-2.5">Entry Conditions</p>
      <div className="grid grid-cols-2 gap-1.5">
        {ENTRY_CONDITIONS.map(({ key, label, hint }) => {
          const blocker = hint(blockers);
          const passed = !blocker;
          return (
            <div
              key={key}
              className="flex items-start gap-1.5 rounded-lg px-2 py-1.5"
              style={{ background: passed ? "rgba(52,211,153,0.06)" : "rgba(248,113,113,0.06)", border: `1px solid ${passed ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)"}` }}
            >
              <span className="mt-0.5 shrink-0 text-[10px]" style={{ color: passed ? "#34d399" : "#f87171" }}>
                {passed ? "✓" : "✗"}
              </span>
              <div className="min-w-0">
                <p className="text-[9px] font-semibold truncate" style={{ color: passed ? "#34d399" : "#f87171" }}>{label}</p>
                {blocker && <p className="text-[8px] text-slate-500 truncate">{blocker}</p>}
              </div>
            </div>
          );
        })}
      </div>
      {blockers.length === 0 && (
        <div className="mt-2 text-center">
          <span className="text-[9px] font-bold text-emerald-400">✓ All conditions met — confirming entry…</span>
        </div>
      )}
    </div>
  );
}

/* ── Score breakdown panel ─────────────────────────────────────────────────── */
function ScorePanel({ token }: { token: EDToken }) {
  const { scores } = token;
  const bars = [
    { label: "Buyer Growth",  val: scores.buyerGrowthScore,   max: 25, color: "#818cf8" },
    { label: "Volume",        val: scores.volumeScore,         max: 25, color: "#34d399" },
    { label: "Buy Pressure",  val: scores.buyPressureScore,    max: 25, color: "#fbbf24" },
    { label: "Wallet Quality",val: scores.walletQualityScore,  max: 25, color: "#f472b6" },
    { label: "Bonding Curve", val: scores.bondingCurveScore,   max: 20, color: "#22d3ee" },
  ];
  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="flex items-center gap-3 mb-4">
        <ScoreRing score={scores.finalScore} size={52} />
        <div>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">Demand Score</p>
          <p className="text-xl font-black text-white">{scores.finalScore}<span className="text-slate-500 text-sm font-medium">/120</span></p>
          <p className="text-[10px]" style={{ color: "#fbbf24" }}>
            BP Ratio: {scores.buyPressureRatio.toFixed(2)}×
          </p>
        </div>
      </div>
      <div className="space-y-2.5">
        {bars.map(({ label, val, max, color }) => (
          <div key={label}>
            <div className="flex justify-between mb-1">
              <span className="text-[10px] text-slate-500">{label}</span>
              <span className="text-[10px] font-bold" style={{ color }}>{val}/{max}</span>
            </div>
            <div className="h-1.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${(val / max) * 100}%`, background: color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Live metrics panel ────────────────────────────────────────────────────── */
function MetricsPanel({ token }: { token: EDToken }) {
  const ratio = token.sellVolumeSol > 0 ? token.buyVolumeSol / token.sellVolumeSol : token.buyVolumeSol > 0 ? 99 : 0;
  const rugColor = token.rugcheckStatus === "passed" ? "#34d399" : token.rugcheckStatus === "failed" ? "#f87171" : "#fbbf24";
  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-3">Live Metrics</p>
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Unique Buyers", val: token.uniqueBuyers.toLocaleString(), icon: <Users size={11} /> },
          { label: "Buyers/min",    val: token.buyersPerMinute.toFixed(1),     icon: <Activity size={11} /> },
          { label: "Buy Volume",    val: `${token.buyVolumeSol.toFixed(2)} SOL`,icon: <TrendingUp size={11} /> },
          { label: "Sell Volume",   val: `${token.sellVolumeSol.toFixed(2)} SOL`,icon: <TrendingDown size={11} /> },
          { label: "Buy/Sell Ratio",val: `${ratio.toFixed(2)}×`,               icon: <Zap size={11} /> },
          { label: "Whale Activity",val: token.whaleParticipation ? "YES ⚡" : "None", icon: <Target size={11} /> },
          { label: "Creator Hold", val: `${token.creatorHoldingsPct.toFixed(1)}%`, icon: <Shield size={11} /> },
          { label: "Top Holder",   val: `${token.topHolderPct.toFixed(1)}%`,   icon: <Shield size={11} /> },
        ].map(({ label, val, icon }) => (
          <div key={label} className="rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <div className="flex items-center gap-1 text-slate-500 mb-1">{icon}<span className="text-[9px] uppercase tracking-wide">{label}</span></div>
            <p className="text-xs font-bold text-slate-200">{val}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between rounded-lg px-3 py-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
        <span className="text-[9px] text-slate-500 uppercase tracking-wide">Rugcheck</span>
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ background: rugColor }} />
          <span className="text-xs font-bold capitalize" style={{ color: rugColor }}>{token.rugcheckStatus}</span>
          {token.rugcheckReason && token.rugcheckStatus !== "passed" && (
            <span className="text-[9px] text-slate-500 truncate max-w-[100px]">{token.rugcheckReason}</span>
          )}
        </div>
      </div>
      <div className="mt-2">
        <p className="text-[9px] text-slate-500 mb-1">Bonding Curve Progress</p>
        <BondingBar pct={token.bondingCurvePct} />
      </div>
      {token.status === "rejected" && token.rejectionReason && (
        <div className="mt-2 rounded-lg px-3 py-2 flex items-center gap-2" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
          <AlertTriangle size={12} className="text-red-400 shrink-0" />
          <span className="text-[10px] text-red-400">{token.rejectionReason}</span>
        </div>
      )}
    </div>
  );
}

/* ── Confirm overlay ──────────────────────────────────────────────────────── */
function ConfirmBar({
  message, onConfirm, onCancel, danger = true, loading = false,
}: {
  message: string; onConfirm: () => void; onCancel: () => void; danger?: boolean; loading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-3 py-2 mt-2" style={{ background: danger ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)", border: `1px solid ${danger ? "rgba(248,113,113,0.25)" : "rgba(251,191,36,0.25)"}` }}>
      <span className="text-[10px]" style={{ color: danger ? "#f87171" : "#fbbf24" }}>{message}</span>
      <div className="flex gap-1.5 ml-2 shrink-0">
        <button
          onClick={onConfirm}
          disabled={loading}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all"
          style={{ background: danger ? "rgba(248,113,113,0.2)" : "rgba(251,191,36,0.2)", color: danger ? "#f87171" : "#fbbf24" }}
        >
          <Check size={10} />{loading ? "…" : "Yes"}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all"
          style={{ background: "rgba(255,255,255,0.05)", color: "#64748b" }}
        >
          <X size={10} />No
        </button>
      </div>
    </div>
  );
}

/* ── Full position edit modal ─────────────────────────────────────────────── */
function PositionEditModal({
  pos, onSave, onCancel, loading,
}: {
  pos: EDPosition;
  onSave: (patch: EDPositionPatch) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const isClosed = pos.status === "closed";

  const [entryPrice,       setEntryPrice]       = useState(String(pos.entryPrice));
  const [sizeSol,          setSizeSol]          = useState(String(pos.sizeSol));
  const [entryScore,       setEntryScore]       = useState(String(pos.entryScore));
  const [effectiveSlPrice, setEffectiveSlPrice] = useState(String(pos.effectiveSlPrice));
  const [trailingHigh,     setTrailingHigh]     = useState(String(pos.trailingHigh));
  const [tp1Hit,           setTp1Hit]           = useState(pos.tp1Hit);
  const [tp2Hit,           setTp2Hit]           = useState(pos.tp2Hit);
  const [exitPrice,        setExitPrice]        = useState(String(pos.exitPrice ?? ""));
  const [realizedPnlSol,   setRealizedPnlSol]   = useState(String(pos.realizedPnlSol));
  const [tp1RealizedSol,   setTp1RealizedSol]   = useState(String(pos.tp1RealizedSol));
  const [tp2RealizedSol,   setTp2RealizedSol]   = useState(String(pos.tp2RealizedSol));
  const [runnerRealized,   setRunnerRealized]   = useState(String(pos.runnerRealizedSol));
  const [closeReason,      setCloseReason]      = useState(pos.closeReason ?? "");
  const [closingScore,     setClosingScore]     = useState(String(pos.closingScore ?? ""));

  const numOr = (s: string, fallback: number) => { const n = parseFloat(s); return isNaN(n) ? fallback : n; };

  function handleSave() {
    const patch: EDPositionPatch = {
      entryPrice:       numOr(entryPrice, pos.entryPrice),
      sizeSol:          numOr(sizeSol, pos.sizeSol),
      entryScore:       numOr(entryScore, pos.entryScore),
      tp1Hit,
      tp2Hit,
      closeReason,
    };
    if (!isClosed) {
      patch.effectiveSlPrice = numOr(effectiveSlPrice, pos.effectiveSlPrice);
      patch.trailingHigh     = numOr(trailingHigh, pos.trailingHigh);
    } else {
      patch.exitPrice         = exitPrice ? numOr(exitPrice, pos.exitPrice ?? 0) : undefined;
      patch.realizedPnlSol    = numOr(realizedPnlSol, pos.realizedPnlSol);
      patch.tp1RealizedSol    = numOr(tp1RealizedSol, pos.tp1RealizedSol);
      patch.tp2RealizedSol    = numOr(tp2RealizedSol, pos.tp2RealizedSol);
      patch.runnerRealizedSol = numOr(runnerRealized, pos.runnerRealizedSol);
      patch.closingScore      = closingScore ? numOr(closingScore, pos.closingScore ?? 0) : undefined;
    }
    onSave(patch);
  }

  const inputCls = "w-full rounded-lg px-2.5 py-1.5 text-xs text-slate-200 outline-none";
  const inputStyle = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" };
  const labelCls = "text-[9px] text-slate-500 uppercase tracking-widest mb-1";

  function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
    return (
      <div>
        <p className={labelCls}>{label}</p>
        <input
          type="number"
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? "0"}
          className={inputCls}
          style={inputStyle}
        />
      </div>
    );
  }

  function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold transition-all w-full"
        style={{
          background: value ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.03)",
          border: `1px solid ${value ? "rgba(52,211,153,0.3)" : "rgba(255,255,255,0.08)"}`,
          color: value ? "#34d399" : "#64748b",
        }}
      >
        <div className="w-3 h-3 rounded-sm border flex items-center justify-center" style={{ borderColor: value ? "#34d399" : "#475569" }}>
          {value && <Check size={9} />}
        </div>
        {label}
      </button>
    );
  }

  const sectionTitle = (t: string) => (
    <p className="text-[9px] text-slate-500 uppercase tracking-widest pt-3 pb-1" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>{t}</p>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onCancel}>
      <div
        className="w-full max-w-lg rounded-t-2xl p-4 pb-6 overflow-y-auto"
        style={{ background: "#0d0d1e", border: "1px solid rgba(129,140,248,0.2)", maxHeight: "88vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="font-black text-white text-base">${pos.symbol}</p>
            <p className="text-[10px] text-slate-500">{pos.name} · {isClosed ? "Closed" : "Open"} position</p>
          </div>
          <button onClick={onCancel} className="p-2 rounded-lg" style={{ background: "rgba(255,255,255,0.04)" }}>
            <X size={14} className="text-slate-400" />
          </button>
        </div>

        {/* Entry & Size */}
        {sectionTitle("Entry & Size")}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Entry Price" value={entryPrice} onChange={setEntryPrice} />
          <Field label="Size (SOL)" value={sizeSol} onChange={setSizeSol} />
          <Field label="Entry Score" value={entryScore} onChange={setEntryScore} />
        </div>

        {/* Risk (open only) */}
        {!isClosed && (
          <>
            {sectionTitle("Risk Management")}
            <div className="grid grid-cols-2 gap-2 mb-2">
              <Field label="Stop Loss Price" value={effectiveSlPrice} onChange={setEffectiveSlPrice} />
              <Field label="Trailing High" value={trailingHigh} onChange={setTrailingHigh} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Toggle label="TP1 Hit" value={tp1Hit} onChange={setTp1Hit} />
              <Toggle label="TP2 Hit" value={tp2Hit} onChange={setTp2Hit} />
            </div>
          </>
        )}

        {/* Exit & P&L (closed only) */}
        {isClosed && (
          <>
            {sectionTitle("Exit & P&L")}
            <div className="grid grid-cols-2 gap-2 mb-2">
              <Field label="Exit Price" value={exitPrice} onChange={setExitPrice} placeholder="—" />
              <Field label="Realized P&L (SOL)" value={realizedPnlSol} onChange={setRealizedPnlSol} />
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <Field label="TP1 Realized (SOL)" value={tp1RealizedSol} onChange={setTp1RealizedSol} />
              <Field label="TP2 Realized (SOL)" value={tp2RealizedSol} onChange={setTp2RealizedSol} />
              <Field label="Runner (SOL)" value={runnerRealized} onChange={setRunnerRealized} />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <Toggle label="TP1 Hit" value={tp1Hit} onChange={setTp1Hit} />
              <Toggle label="TP2 Hit" value={tp2Hit} onChange={setTp2Hit} />
            </div>
            <Field label="Closing Score" value={closingScore} onChange={setClosingScore} placeholder="—" />
          </>
        )}

        {/* Notes */}
        {sectionTitle("Notes / Close Reason")}
        <textarea
          value={closeReason}
          onChange={(e) => setCloseReason(e.target.value)}
          rows={2}
          className="w-full rounded-lg px-2.5 py-2 text-xs text-slate-200 resize-none outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
          placeholder="Add a note or close reason…"
        />

        {/* Recalculation hint for closed */}
        {isClosed && (
          <p className="text-[9px] text-slate-600 mt-1">P&L % will be recalculated from Realized P&L ÷ Size</p>
        )}

        {/* Buttons */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{ background: "rgba(52,211,153,0.15)", color: "#34d399", border: "1px solid rgba(52,211,153,0.3)" }}
          >
            <Check size={12} />{loading ? "Saving…" : "Save Changes"}
          </button>
          <button
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl text-xs font-bold transition-all"
            style={{ background: "rgba(255,255,255,0.04)", color: "#64748b", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Active trade card ─────────────────────────────────────────────────────── */
function TradeCard({ pos }: { pos: EDPosition }) {
  const isUp = pos.pnlPct >= 0;
  const elapsed = fmtAge(pos.entryAt);
  const entryTime = new Date(pos.entryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const closePos = useEDClosePosition();
  const deletePos = useEDDeletePosition();
  const editPos = useEDEditPosition();
  const [confirm, setConfirm] = useState<"close" | "delete" | null>(null);
  const [editing, setEditing] = useState(false);

  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: isUp ? "rgba(52,211,153,0.05)" : "rgba(248,113,113,0.05)",
        border: `1px solid ${isUp ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)"}`,
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-black text-base text-white">${pos.symbol}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold" style={{ background: "rgba(129,140,248,0.15)", color: "#818cf8" }}>
              Score {pos.entryScore}
            </span>
            <a
              href={`https://dexscreener.com/solana/${pos.mint}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-[9px] font-bold"
              style={{ color: "#22d3ee" }}
            >
              DEX <ExternalLink size={8} />
            </a>
          </div>
          <p className="text-[10px] text-slate-500 mt-0.5">{pos.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[9px] text-slate-600 flex items-center gap-1"><Clock size={8} />{entryTime} · {elapsed} ago</span>
          </div>
        </div>
        <div className="text-right">
          <p className="font-black text-lg" style={{ color: isUp ? "#34d399" : "#f87171" }}>
            {fmtPct(pos.pnlPct)}
          </p>
          <p className="text-[10px]" style={{ color: isUp ? "#34d399" : "#f87171" }}>
            {fmtSol(pos.unrealizedPnlSol)}
          </p>
        </div>
      </div>

      {/* Entry details */}
      <div className="grid grid-cols-4 gap-1.5 mb-3 rounded-lg p-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
        {[
          { label: "Entry Price",   val: `$${pos.entryPrice.toExponential(3)}` },
          { label: "Entry MC",      val: fmtMC(pos.entryMcap) },
          { label: "Curve at Entry",val: `${(pos.entryBondingCurvePct ?? 0).toFixed(1)}%` },
          { label: "Size",          val: `${pos.sizeSol.toFixed(3)} SOL` },
        ].map(({ label, val }) => (
          <div key={label} className="text-center">
            <p className="text-[8px] text-slate-600 uppercase tracking-wide">{label}</p>
            <p className="text-[10px] font-bold text-slate-300">{val}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { label: "Current MC", val: fmtMC(pos.currentMcap) },
          { label: "Cur. Price", val: `$${pos.currentPrice.toExponential(3)}` },
          { label: "Remaining",  val: `${(pos.remainingFraction * 100).toFixed(0)}%` },
        ].map(({ label, val }) => (
          <div key={label} className="text-center">
            <p className="text-[9px] text-slate-500 uppercase tracking-wide">{label}</p>
            <p className="text-xs font-bold text-slate-200">{val}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mb-3">
        <div className="flex gap-2">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${pos.tp1Hit ? "text-green-400 bg-green-400/10" : "text-slate-600 bg-white/5"}`}>TP1</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${pos.tp2Hit ? "text-green-400 bg-green-400/10" : "text-slate-600 bg-white/5"}`}>TP2</span>
        </div>
        <div className="text-right">
          <p className="text-[9px] text-slate-500">SL @ {pos.effectiveSlPrice > 0 ? `$${pos.effectiveSlPrice.toExponential(3)}` : "—"}</p>
        </div>
      </div>

      {/* Action buttons */}
      {confirm === null && !editing && (
        <div className="flex gap-2 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <button
            onClick={() => setConfirm("close")}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24" }}
          >
            <XCircle size={11} /> Close Position
          </button>
          <button
            onClick={() => setEditing(true)}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(129,140,248,0.08)", border: "1px solid rgba(129,140,248,0.18)", color: "#818cf8" }}
            title="Edit position"
          >
            <Pencil size={11} />
          </button>
          <button
            onClick={() => setConfirm("delete")}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.18)", color: "#f87171" }}
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}

      {confirm === "close" && (
        <ConfirmBar
          message="Close at current price and record P&L?"
          danger={false}
          loading={closePos.isPending}
          onConfirm={() => closePos.mutate(pos.id, { onSuccess: () => setConfirm(null) })}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <ConfirmBar
          message="Delete this trade? Position size will be refunded."
          danger={true}
          loading={deletePos.isPending}
          onConfirm={() => deletePos.mutate(pos.id, { onSuccess: () => setConfirm(null) })}
          onCancel={() => setConfirm(null)}
        />
      )}

      {editing && (
        <PositionEditModal
          pos={pos}
          loading={editPos.isPending}
          onSave={(patch) => editPos.mutate({ id: pos.id, patch }, { onSuccess: () => setEditing(false) })}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

/* ── Closed position row ───────────────────────────────────────────────────── */
function ClosedRow({ pos }: { pos: EDPosition }) {
  const deletePos = useEDDeletePosition();
  const editPos = useEDEditPosition();
  const [mode, setMode] = useState<"idle" | "confirmDelete" | "edit" | "detail">("idle");
  const isWin = pos.realizedPnlSol >= 0;
  const entryTime = new Date(pos.entryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const closedTime = pos.closedAt ? new Date(pos.closedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <div className="rounded-xl px-4 py-3" style={{ background: isWin ? "rgba(52,211,153,0.03)" : "rgba(248,113,113,0.03)", border: `1px solid ${isWin ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)"}` }}>
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-white">${pos.symbol}</span>
            <span className="text-[9px] px-1 py-0.5 rounded font-bold" style={{ background: "rgba(129,140,248,0.1)", color: "#818cf8" }}>Score {pos.entryScore}</span>
            <a
              href={`https://dexscreener.com/solana/${pos.mint}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-[9px] font-bold"
              style={{ color: "#22d3ee" }}
              onClick={(e) => e.stopPropagation()}
            >
              DEX <ExternalLink size={8} />
            </a>
          </div>
          <button
            onClick={() => setMode(mode === "detail" ? "idle" : "detail")}
            className="text-[9px] text-slate-500 mt-0.5 truncate text-left hover:text-slate-300 transition-colors"
          >
            {pos.closeReason || "—"} · tap for details
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="text-right">
            <p className="font-black text-sm" style={{ color: isWin ? "#34d399" : "#f87171" }}>
              {fmtPct(pos.pnlPct)}
            </p>
            <p className="text-[10px]" style={{ color: isWin ? "#34d399" : "#f87171" }}>
              {fmtSol(pos.realizedPnlSol)}
            </p>
          </div>
          {mode === "idle" && (
            <div className="flex gap-1 ml-2">
              <button
                onClick={() => setMode("edit")}
                className="p-1.5 rounded-lg transition-all"
                style={{ background: "rgba(129,140,248,0.08)", border: "1px solid rgba(129,140,248,0.15)", color: "#818cf8" }}
                title="Edit notes"
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={() => setMode("confirmDelete")}
                className="p-1.5 rounded-lg transition-all"
                style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.15)", color: "#f87171" }}
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Expandable detail panel */}
      {mode === "detail" && (
        <div className="mt-2 grid grid-cols-4 gap-1.5 rounded-lg p-2" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
          {[
            { label: "Entry Time",    val: entryTime },
            { label: "Close Time",    val: closedTime },
            { label: "Entry Price",   val: `$${pos.entryPrice.toExponential(3)}` },
            { label: "Exit Price",    val: pos.exitPrice ? `$${pos.exitPrice.toExponential(3)}` : "—" },
            { label: "Entry MC",      val: fmtMC(pos.entryMcap) },
            { label: "Curve at Entry",val: `${(pos.entryBondingCurvePct ?? 0).toFixed(1)}%` },
            { label: "Size",          val: `${pos.sizeSol.toFixed(3)} SOL` },
            { label: "TP1/TP2",       val: `${pos.tp1Hit ? "✓" : "○"} / ${pos.tp2Hit ? "✓" : "○"}` },
          ].map(({ label, val }) => (
            <div key={label} className="text-center">
              <p className="text-[8px] text-slate-600 uppercase tracking-wide">{label}</p>
              <p className="text-[10px] font-bold text-slate-300">{val}</p>
            </div>
          ))}
        </div>
      )}

      {mode === "confirmDelete" && (
        <ConfirmBar
          message="Remove this trade from history?"
          danger={true}
          loading={deletePos.isPending}
          onConfirm={() => deletePos.mutate(pos.id, { onSuccess: () => setMode("idle") })}
          onCancel={() => setMode("idle")}
        />
      )}
      {mode === "edit" && (
        <PositionEditModal
          pos={pos}
          loading={editPos.isPending}
          onSave={(patch) => editPos.mutate({ id: pos.id, patch }, { onSuccess: () => setMode("idle") })}
          onCancel={() => setMode("idle")}
        />
      )}
    </div>
  );
}

/* ── Token row (in list) ───────────────────────────────────────────────────── */
function TokenRow({ token, onClick, selected }: { token: EDToken; onClick: () => void; selected: boolean }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-xl px-3 py-3 transition-all duration-200"
      style={{
        background: selected ? "rgba(129,140,248,0.08)" : "rgba(255,255,255,0.02)",
        border: selected ? "1px solid rgba(129,140,248,0.3)" : "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="flex items-center gap-3">
        <ScoreRing score={token.scores.finalScore} size={38} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-bold text-sm text-white truncate">${token.symbol}</span>
            <StatusBadge status={token.status} />
          </div>
          <BondingBar pct={token.bondingCurvePct} />
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[9px] text-slate-500 flex items-center gap-1">
              <Clock size={9} />{fmtAge(token.launchAt)}
            </span>
            <span className="text-[9px] text-slate-500">{fmtMC(token.marketCapUsd)}</span>
            <span className="text-[9px] text-slate-500">{token.uniqueBuyers} buyers</span>
          </div>
        </div>
        <ChevronRight size={14} className="text-slate-600 shrink-0" />
      </div>
    </button>
  );
}

/* ── Stats strip ───────────────────────────────────────────────────────────── */
function StatsStrip() {
  const { data: status } = useEDStatus();
  const { data: positions } = useEDPositions();
  const unrealPnl = positions?.open.reduce((s, p) => s + p.unrealizedPnlSol, 0) ?? 0;
  const realPnl   = status?.totalRealizedPnlSol ?? 0;
  const totalPnl  = realPnl + unrealPnl;

  return (
    <div className="grid grid-cols-4 gap-2 px-4 mb-4">
      {[
        { label: "Tracked",  val: String(status?.trackedCount ?? 0),  color: "#94a3b8" },
        { label: "Eligible", val: String(status?.eligibleCount ?? 0),  color: "#fbbf24" },
        { label: "Entered",  val: String(status?.enteredCount ?? 0),   color: "#34d399" },
        {
          label: "Balance",
          val: `${(status?.virtualBalance ?? 0).toFixed(2)}`,
          color: totalPnl >= 0 ? "#34d399" : "#f87171",
          sub: `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(3)}`,
        },
      ].map(({ label, val, color, sub }) => (
        <div key={label} className="rounded-xl p-2.5 text-center" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-[8px] text-slate-500 uppercase tracking-widest mb-1">{label}</p>
          <p className="text-sm font-black" style={{ color }}>{val}</p>
          {sub && <p className="text-[9px] font-bold" style={{ color }}>{sub}</p>}
        </div>
      ))}
    </div>
  );
}

/* ── Tabs ──────────────────────────────────────────────────────────────────── */
type Tab = "live" | "all" | "trades";

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function FeedPage() {
  const { data: status } = useEDStatus();
  const { data: tokens = [] } = useEDTokens();
  const { data: positions } = useEDPositions();
  const reset = useResetPaperBalance();
  const inject = useInjectTestToken();

  const [tab, setTab] = useState<Tab>("live");
  const [selected, setSelected] = useState<string | null>(null);

  const displayTokens = useMemo(() => {
    const sorted = [...tokens].sort((a, b) => b.scores.finalScore - a.scores.finalScore);
    if (tab === "live") return sorted.filter((t) => t.status === "tracking" || t.status === "eligible");
    if (tab === "all") return sorted;
    return [];
  }, [tokens, tab]);

  const openPositions  = positions?.open ?? [];
  const allClosed      = positions?.closed ?? [];
  const selectedToken  = selected ? tokens.find((t) => t.mint === selected) ?? null : null;

  const connSrc  = status?.connectionSource ?? "offline";
  const wsOk     = connSrc !== "offline";
  const connLabel = connSrc === "pumpportal" ? "PUMPPORTAL" : connSrc === "helius" ? "HELIUS" : "OFFLINE";

  return (
    <div className="min-h-screen">
      {/* ── Header ── */}
      <div className="sticky top-0 z-40" style={{ background: "rgba(5,5,13,0.92)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Telescope size={18} className="text-indigo-400" />
            <span className="font-black text-sm text-white tracking-tight">APEX MEME TRADER</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{
              background: wsOk ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)",
              border: `1px solid ${wsOk ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"}`
            }}>
              {wsOk ? <Wifi size={10} className="text-emerald-400" /> : <WifiOff size={10} className="text-red-400" />}
              <span className="text-[9px] font-bold" style={{ color: wsOk ? "#34d399" : "#f87171" }}>{connLabel}</span>
            </div>
            <div className="px-2 py-1 rounded-full" style={{ background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.2)" }}>
              <span className="text-[9px] font-bold text-indigo-400">PAPER MODE</span>
            </div>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex px-4 pb-2 gap-1">
          {(["live", "all", "trades"] as Tab[]).map((t) => {
            const labels: Record<Tab, string> = {
              live:   `Live (${tokens.filter((tk) => tk.status === "tracking" || tk.status === "eligible").length})`,
              all:    `All Tokens (${tokens.length})`,
              trades: `Trades (${openPositions.length + allClosed.length})`,
            };
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-3 py-1 rounded-full text-[10px] font-bold tracking-wide transition-all"
                style={{
                  background: tab === t ? "rgba(129,140,248,0.2)" : "rgba(255,255,255,0.04)",
                  border: `1px solid ${tab === t ? "rgba(129,140,248,0.4)" : "rgba(255,255,255,0.07)"}`,
                  color: tab === t ? "#818cf8" : "#64748b",
                }}
              >
                {labels[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-4 pt-4">
        <StatsStrip />

        {/* ── Split view: list + detail ── */}
        {tab !== "trades" ? (
          <div>
            {/* Detail panel */}
            {selectedToken && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-white">${selectedToken.symbol}</span>
                    <StatusBadge status={selectedToken.status} />
                    {selectedToken.firstEligibleAt && (
                      <span className="text-[9px] text-amber-400">
                        Eligible {fmtAge(selectedToken.firstEligibleAt)}
                      </span>
                    )}
                  </div>
                  <a
                    href={`https://dexscreener.com/solana/${selectedToken.mint}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300"
                  >
                    Chart <ExternalLink size={10} />
                  </a>
                </div>
                <div className="grid gap-3">
                  <ScorePanel token={selectedToken} />
                  <EntryChecklist blockers={selectedToken.entryBlockers ?? []} />
                  <MetricsPanel token={selectedToken} />
                </div>
              </div>
            )}

            {/* Token list */}
            {displayTokens.length === 0 ? (
              <div className="text-center py-12">
                <Telescope size={32} className="text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">Scanning for new launches…</p>
                <p className="text-slate-600 text-xs mt-1">
                  {wsOk ? `${connLabel} connected — scanning for new Pump.fun launches` : "Connecting to PumpPortal WebSocket…"}
                </p>
                <button
                  onClick={() => inject.mutate(`TESTDEMO${Date.now().toString(36)}1111111111111111111111111111111111`)}
                  className="mt-4 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 mx-auto transition-all"
                  style={{ background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.2)", color: "#818cf8" }}
                >
                  <FlaskConical size={12} /> Inject Test Token
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {displayTokens.map((token) => (
                  <TokenRow
                    key={token.mint}
                    token={token}
                    selected={selected === token.mint}
                    onClick={() => setSelected(selected === token.mint ? null : token.mint)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          /* ── Trades tab ── */
          <div>
            {openPositions.length === 0 && allClosed.length === 0 ? (
              <div className="text-center py-12">
                <Target size={32} className="text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">No trades yet</p>
                <p className="text-slate-600 text-xs mt-1">Waiting for entry signals…</p>
              </div>
            ) : (
              <>
                {openPositions.length > 0 && (
                  <div className="mb-5">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Open Positions</p>
                    <div className="space-y-3">
                      {openPositions.map((pos) => <TradeCard key={pos.id} pos={pos} />)}
                    </div>
                  </div>
                )}

                {allClosed.length > 0 && (
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">
                      Closed ({allClosed.length})
                    </p>
                    <div className="space-y-2">
                      {allClosed.map((pos) => (
                        <ClosedRow key={pos.id} pos={pos} />
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => reset.mutate()}
                    disabled={reset.isPending}
                    className="flex items-center gap-1.5 text-[10px] font-bold px-3 py-2 rounded-xl transition-all"
                    style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", color: "#f87171" }}
                  >
                    <RotateCcw size={10} /> Reset Paper Balance
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
