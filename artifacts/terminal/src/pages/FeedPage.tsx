import { useState, useMemo } from "react";
import {
  Telescope, Wifi, WifiOff, TrendingUp, TrendingDown,
  ExternalLink, AlertTriangle, Clock,
  Activity, Users, Zap, Shield, Target, RotateCcw, FlaskConical,
  CheckCircle2, XCircle, Circle, Pencil, X, Trash2, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  useEDStatus, useEDTokens, useEDPositions, useResetPaperBalance,
  useInjectTestToken, useEDClosePosition, useEDDeletePosition, useEDEditPosition,
} from "@/lib/api";
import type { EDToken, EDPosition, EDTokenStatus, EntryChecklistItem, EDPositionPatch } from "@/lib/types";

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
  const pct = Math.min(score / 100, 1);
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  const color = score >= 80 ? "#34d399" : score >= 60 ? "#fbbf24" : score >= 40 ? "#818cf8" : "#64748b";
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

/* ── Entry Checklist Panel ─────────────────────────────────────────────────── */
function EntryChecklistPanel({ checklist }: { checklist: EntryChecklistItem[] }) {
  if (!checklist || checklist.length === 0) {
    return (
      <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Entry Checklist</p>
        <p className="text-[10px] text-slate-600">Waiting for first poll cycle…</p>
      </div>
    );
  }

  const allPass  = checklist.every((c) => c.pass);
  const passCount = checklist.filter((c) => c.pass).length;

  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-widest">Entry Checklist</p>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold" style={{ color: allPass ? "#34d399" : "#fbbf24" }}>
            {passCount}/{checklist.length} passing
          </span>
          {allPass && (
            <span className="text-[9px] font-black px-2 py-0.5 rounded-full" style={{ background: "rgba(52,211,153,0.15)", color: "#34d399" }}>
              ENTRY READY
            </span>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        {checklist.map((item) => {
          const iconColor   = item.pass ? "#34d399" : item.borderline ? "#fbbf24" : "#f87171";
          const bgColor     = item.pass ? "rgba(52,211,153,0.05)" : item.borderline ? "rgba(251,191,36,0.05)" : "rgba(248,113,113,0.05)";
          const borderColor = item.pass ? "rgba(52,211,153,0.12)" : item.borderline ? "rgba(251,191,36,0.15)" : "rgba(248,113,113,0.12)";
          return (
            <div
              key={item.label}
              className="flex items-center justify-between rounded-lg px-2.5 py-1.5"
              style={{ background: bgColor, border: `1px solid ${borderColor}` }}
            >
              <div className="flex items-center gap-2">
                {item.pass
                  ? <CheckCircle2 size={12} style={{ color: iconColor, flexShrink: 0 }} />
                  : item.borderline
                    ? <Circle size={12} style={{ color: iconColor, flexShrink: 0 }} />
                    : <XCircle size={12} style={{ color: iconColor, flexShrink: 0 }} />
                }
                <span className="text-[10px] font-medium" style={{ color: item.pass ? "#94a3b8" : "#cbd5e1" }}>
                  {item.label}
                </span>
              </div>
              <div className="text-right">
                <span className="text-[10px] font-bold tabular-nums" style={{ color: iconColor }}>
                  {item.current}
                </span>
                {!item.pass && (
                  <span className="text-[9px] text-slate-600 ml-1">(need {item.threshold})</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Score breakdown panel ─────────────────────────────────────────────────── */
function ScorePanel({ token }: { token: EDToken }) {
  const { scores } = token;
  const bars = [
    { label: "Buyer Growth",   val: scores.buyerGrowthScore,   max: 25, color: "#818cf8" },
    { label: "Volume",         val: scores.volumeScore,         max: 25, color: "#34d399" },
    { label: "Buy Pressure",   val: scores.buyPressureScore,    max: 25, color: "#fbbf24" },
    { label: "Wallet Quality", val: scores.walletQualityScore,  max: 25, color: "#f472b6" },
  ];
  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="flex items-center gap-3 mb-4">
        <ScoreRing score={scores.finalScore} size={52} />
        <div>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest">Demand Score</p>
          <p className="text-xl font-black text-white">
            {scores.finalScore}<span className="text-slate-500 text-sm font-medium">/100</span>
          </p>
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
  const ratio = token.sellVolumeSol > 0
    ? token.buyVolumeSol / token.sellVolumeSol
    : token.buyVolumeSol > 0 ? 99 : 0;
  const rugColor = token.rugcheckStatus === "passed" ? "#34d399" : token.rugcheckStatus === "failed" ? "#f87171" : "#fbbf24";

  return (
    <div className="rounded-xl p-4" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-3">Live Metrics</p>
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "Unique Buyers",  val: token.uniqueBuyers.toLocaleString(), icon: <Users size={11} /> },
          { label: "Buyers/min",     val: token.buyersPerMinute.toFixed(1),    icon: <Activity size={11} /> },
          { label: "Buy Volume",     val: `${token.buyVolumeSol.toFixed(2)} SOL`,  icon: <TrendingUp size={11} /> },
          { label: "Sell Volume",    val: `${token.sellVolumeSol.toFixed(2)} SOL`, icon: <TrendingDown size={11} /> },
          { label: "Buy/Sell Ratio", val: `${ratio.toFixed(2)}×`,              icon: <Zap size={11} /> },
          { label: "Whale Activity", val: token.whaleParticipation ? "YES ⚡" : "None", icon: <Target size={11} /> },
          { label: "Creator Hold",   val: `${token.creatorHoldingsPct.toFixed(1)}%`, icon: <Shield size={11} /> },
          { label: "Top Holder",     val: `${token.topHolderPct.toFixed(1)}%`,       icon: <Shield size={11} /> },
        ].map(({ label, val, icon }) => (
          <div key={label} className="rounded-lg p-2.5" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <div className="flex items-center gap-1 text-slate-500 mb-1">
              {icon}
              <span className="text-[9px] uppercase tracking-wide">{label}</span>
            </div>
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

      {token.status === "rejected" && token.rejectionReason && (
        <div className="mt-2 rounded-lg px-3 py-2 flex items-center gap-2" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)" }}>
          <AlertTriangle size={12} className="text-red-400 shrink-0" />
          <span className="text-[10px] text-red-400">{token.rejectionReason}</span>
        </div>
      )}
    </div>
  );
}

/* ── Edit Position Modal ───────────────────────────────────────────────────── */
function EditPositionModal({ pos, onClose }: { pos: EDPosition; onClose: () => void }) {
  const edit   = useEDEditPosition();
  const isOpen = pos.status === "open";

  const [form, setForm] = useState<EDPositionPatch>({
    entryPrice:    pos.entryPrice,
    entryScore:    pos.entryScore,
    sizeSol:       pos.sizeSol,
    effectiveSlPrice: pos.effectiveSlPrice,
    tp1Hit:        pos.tp1Hit,
    tp2Hit:        pos.tp2Hit,
    ...(isOpen ? {} : {
      exitPrice:      pos.exitPrice ?? 0,
      realizedPnlSol: pos.realizedPnlSol,
      closeReason:    pos.closeReason,
    }),
  });

  const handleSubmit = () => {
    edit.mutate({ id: pos.id, patch: form }, { onSuccess: onClose });
  };

  const field = (label: string, fkey: keyof EDPositionPatch, type = "number") => (
    <div key={String(fkey)}>
      <label className="text-[9px] text-slate-500 uppercase tracking-wide block mb-1">{label}</label>
      {type === "boolean" ? (
        <div className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              onClick={() => setForm((f: EDPositionPatch) => ({ ...f, [fkey]: v }))}
              className="px-3 py-1 rounded-lg text-[10px] font-bold transition-all"
              style={{
                background: form[fkey] === v ? (v ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)") : "rgba(255,255,255,0.05)",
                border: `1px solid ${form[fkey] === v ? (v ? "rgba(52,211,153,0.4)" : "rgba(248,113,113,0.4)") : "rgba(255,255,255,0.1)"}`,
                color: form[fkey] === v ? (v ? "#34d399" : "#f87171") : "#64748b",
              }}
            >
              {v ? "YES" : "NO"}
            </button>
          ))}
        </div>
      ) : type === "text" ? (
        <input
          className="w-full rounded-lg px-3 py-1.5 text-xs text-white bg-transparent focus:outline-none"
          style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          value={String(form[fkey] ?? "")}
          onChange={(e) => setForm((f: EDPositionPatch) => ({ ...f, [fkey]: e.target.value }))}
        />
      ) : (
        <input
          type="number"
          step="any"
          className="w-full rounded-lg px-3 py-1.5 text-xs text-white bg-transparent focus:outline-none"
          style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          value={Number(form[fkey] ?? 0)}
          onChange={(e) => setForm((f: EDPositionPatch) => ({ ...f, [fkey]: parseFloat(e.target.value) || 0 }))}
        />
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: "rgba(10,10,25,0.98)", border: "1px solid rgba(255,255,255,0.1)" }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-black text-white text-sm">${pos.symbol} — Edit Position</h3>
            <p className="text-[10px] text-slate-500">{isOpen ? "Open" : "Closed"} position</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-500 hover:text-white transition-colors" style={{ border: "1px solid rgba(255,255,255,0.08)" }}>
            <X size={14} />
          </button>
        </div>
        <div className="space-y-3 mb-4">
          {field("Entry Price (USD)", "entryPrice")}
          {field("Entry Score", "entryScore")}
          {field("Size (SOL)", "sizeSol")}
          {isOpen && field("SL Price (USD)", "effectiveSlPrice")}
          {isOpen && field("TP1 Hit", "tp1Hit", "boolean")}
          {isOpen && field("TP2 Hit", "tp2Hit", "boolean")}
          {!isOpen && field("Exit Price (USD)", "exitPrice")}
          {!isOpen && field("Realized PnL (SOL)", "realizedPnlSol")}
          {!isOpen && field("Close Reason", "closeReason", "text")}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 rounded-xl text-[11px] font-bold transition-all"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#64748b" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={edit.isPending}
            className="flex-1 py-2 rounded-xl text-[11px] font-bold transition-all"
            style={{ background: "rgba(129,140,248,0.2)", border: "1px solid rgba(129,140,248,0.4)", color: "#818cf8" }}
          >
            {edit.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Confirm Dialog ────────────────────────────────────────────────────────── */
function ConfirmDialog({
  title, message, confirmLabel, confirmColor = "#f87171",
  onConfirm, onCancel, loading,
}: {
  title: string; message: string; confirmLabel: string;
  confirmColor?: string; onConfirm: () => void; onCancel: () => void; loading?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4" style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)" }}>
      <div className="w-full max-w-sm rounded-2xl p-5" style={{ background: "rgba(10,10,25,0.98)", border: "1px solid rgba(255,255,255,0.1)" }}>
        <h3 className="font-black text-white text-sm mb-2">{title}</h3>
        <p className="text-[11px] text-slate-400 mb-4">{message}</p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-xl text-[11px] font-bold transition-all"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#64748b" }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 py-2 rounded-xl text-[11px] font-bold transition-all"
            style={{ background: `${confirmColor}22`, border: `1px solid ${confirmColor}55`, color: confirmColor }}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Active trade card ─────────────────────────────────────────────────────── */
function TradeCard({ pos }: { pos: EDPosition }) {
  const isUp  = pos.pnlPct >= 0;
  const close = useEDClosePosition();
  const del   = useEDDeletePosition();
  const [showEdit,   setShowEdit]   = useState(false);
  const [showClose,  setShowClose]  = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  return (
    <>
      <div
        className="rounded-xl p-4"
        style={{
          background: isUp ? "rgba(52,211,153,0.05)" : "rgba(248,113,113,0.05)",
          border: `1px solid ${isUp ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)"}`,
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-black text-base text-white">${pos.symbol}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold" style={{ background: "rgba(129,140,248,0.15)", color: "#818cf8" }}>
                Score {pos.entryScore}
              </span>
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">{pos.name} · {fmtAge(pos.entryAt)}</p>
          </div>
          <div className="text-right">
            <p className="font-black text-lg" style={{ color: isUp ? "#34d399" : "#f87171" }}>{fmtPct(pos.pnlPct)}</p>
            <p className="text-[10px]" style={{ color: isUp ? "#34d399" : "#f87171" }}>{fmtSol(pos.unrealizedPnlSol)}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {[
            { label: "Entry MC",   val: fmtMC(pos.entryMcap) },
            { label: "Current MC", val: fmtMC(pos.currentMcap) },
            { label: "Size",       val: `${pos.sizeSol.toFixed(3)} SOL` },
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
            <p className="text-[9px] text-slate-500">{(pos.remainingFraction * 100).toFixed(0)}% remaining</p>
          </div>
        </div>
        <div className="flex gap-1.5 pt-2 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <button
            onClick={() => setShowEdit(true)}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.2)", color: "#818cf8" }}
          >
            <Pencil size={10} /> Edit
          </button>
          <button
            onClick={() => setShowClose(true)}
            className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)", color: "#fbbf24" }}
          >
            <X size={10} /> Close
          </button>
          <button
            onClick={() => setShowDelete(true)}
            className="flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all"
            style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)", color: "#f87171" }}
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>

      {showEdit && <EditPositionModal pos={pos} onClose={() => setShowEdit(false)} />}
      {showClose && (
        <ConfirmDialog
          title={`Close $${pos.symbol}?`}
          message={`Closes the position at the current price ($${pos.currentPrice.toExponential(3)}). Paper mode only — no real trade.`}
          confirmLabel="Close Position"
          confirmColor="#fbbf24"
          loading={close.isPending}
          onConfirm={() => close.mutate(pos.id, { onSuccess: () => setShowClose(false) })}
          onCancel={() => setShowClose(false)}
        />
      )}
      {showDelete && (
        <ConfirmDialog
          title={`Delete $${pos.symbol}?`}
          message="Removes this position entirely. The position size will be refunded to your paper balance."
          confirmLabel="Delete Position"
          loading={del.isPending}
          onConfirm={() => del.mutate(pos.id, { onSuccess: () => setShowDelete(false) })}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </>
  );
}

/* ── Closed position row ───────────────────────────────────────────────────── */
function ClosedPositionRow({ pos }: { pos: EDPosition }) {
  const del = useEDDeletePosition();
  const [showEdit,   setShowEdit]   = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  return (
    <>
      <div className="rounded-xl px-3 py-3 flex items-center justify-between" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm text-white">${pos.symbol}</span>
            <span className="text-[9px] text-slate-500">Score {pos.entryScore}</span>
          </div>
          <p className="text-[9px] text-slate-500 mt-0.5 truncate">{pos.closeReason}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <p className="font-black text-sm" style={{ color: pos.realizedPnlSol >= 0 ? "#34d399" : "#f87171" }}>
              {fmtPct(pos.pnlPct)}
            </p>
            <p className="text-[10px]" style={{ color: pos.realizedPnlSol >= 0 ? "#34d399" : "#f87171" }}>
              {fmtSol(pos.realizedPnlSol)}
            </p>
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setShowEdit(true)}
              className="p-1.5 rounded-lg transition-all"
              style={{ background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.2)", color: "#818cf8" }}
            >
              <Pencil size={10} />
            </button>
            <button
              onClick={() => setShowDelete(true)}
              className="p-1.5 rounded-lg transition-all"
              style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.2)", color: "#f87171" }}
            >
              <Trash2 size={10} />
            </button>
          </div>
        </div>
      </div>

      {showEdit && <EditPositionModal pos={pos} onClose={() => setShowEdit(false)} />}
      {showDelete && (
        <ConfirmDialog
          title={`Delete $${pos.symbol} from history?`}
          message="Permanently removes this trade from history. Cannot be undone."
          confirmLabel="Delete Permanently"
          loading={del.isPending}
          onConfirm={() => del.mutate(pos.id, { onSuccess: () => setShowDelete(false) })}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </>
  );
}

/* ── Token row (in list) ───────────────────────────────────────────────────── */
function TokenRow({ token, onClick, selected }: { token: EDToken; onClick: () => void; selected: boolean }) {
  const failCount = token.entryChecklist?.filter((c) => !c.pass).length ?? 0;
  const passCount = token.entryChecklist?.filter((c) => c.pass).length ?? 0;
  const total     = token.entryChecklist?.length ?? 0;

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
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-sm text-white truncate">${token.symbol}</span>
            <StatusBadge status={token.status} />
            {total > 0 && (
              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{
                background: failCount === 0 ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.1)",
                color: failCount === 0 ? "#34d399" : "#f87171",
              }}>
                {failCount === 0 ? "✓ ALL PASS" : `✗ ${failCount} fail`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[9px] text-slate-500 flex items-center gap-1">
              <Clock size={9} />{fmtAge(token.launchAt)}
            </span>
            <span className="text-[9px] text-slate-500">{fmtMC(token.marketCapUsd)}</span>
            <span className="text-[9px] text-slate-500">{token.uniqueBuyers} buyers</span>
            {total > 0 && (
              <span className="text-[9px] text-slate-600">{passCount}/{total} checks</span>
            )}
          </div>
        </div>
        {selected
          ? <ChevronUp size={14} className="text-slate-600 shrink-0" />
          : <ChevronDown size={14} className="text-slate-600 shrink-0" />
        }
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
  const { data: positions }   = useEDPositions();
  const reset  = useResetPaperBalance();
  const inject = useInjectTestToken();

  const [tab,      setTab]      = useState<Tab>("live");
  const [selected, setSelected] = useState<string | null>(null);

  const displayTokens = useMemo(() => {
    if (tab === "live") return tokens.filter((t) => t.status === "tracking" || t.status === "eligible");
    if (tab === "all")  return tokens;
    return [];
  }, [tokens, tab]);

  const openPositions = positions?.open   ?? [];
  const closedAll     = positions?.closed ?? [];
  const selectedToken = selected ? tokens.find((t) => t.mint === selected) ?? null : null;

  const connSrc = status?.connectionSource ?? "offline";
  const wsOk    = connSrc !== "offline";
  const connLabel =
    connSrc === "pumpportal" ? "PUMPPORTAL" :
    connSrc === "helius"     ? "HELIUS" :
    connSrc === "http-poll"  ? "SCANNING" : "OFFLINE";

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
              border: `1px solid ${wsOk ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"}`,
            }}>
              {wsOk ? <Wifi size={10} className="text-emerald-400" /> : <WifiOff size={10} className="text-red-400" />}
              <span className="text-[9px] font-bold" style={{ color: wsOk ? "#34d399" : "#f87171" }}>{connLabel}</span>
            </div>
            <div className="px-2 py-1 rounded-full" style={{ background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.2)" }}>
              <span className="text-[9px] font-bold text-indigo-400">PAPER MODE</span>
            </div>
          </div>
        </div>

        <div className="flex px-4 pb-2 gap-1">
          {(["live", "all", "trades"] as Tab[]).map((t) => {
            const labels: Record<Tab, string> = {
              live:   `Live (${tokens.filter((tk) => tk.status === "tracking" || tk.status === "eligible").length})`,
              all:    `All Tokens (${tokens.length})`,
              trades: `Trades (${openPositions.length})`,
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

        {tab !== "trades" ? (
          <div>
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
                  <EntryChecklistPanel checklist={selectedToken.entryChecklist ?? []} />
                  <ScorePanel token={selectedToken} />
                  <MetricsPanel token={selectedToken} />
                </div>
              </div>
            )}

            {displayTokens.length === 0 ? (
              <div className="text-center py-12">
                <Telescope size={32} className="text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">Scanning for new launches…</p>
                <p className="text-slate-600 text-xs mt-1">
                  {wsOk ? `${connLabel} connected — watching Pump.fun` : "Connecting…"}
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
          <div>
            {openPositions.length === 0 && closedAll.length === 0 ? (
              <div className="text-center py-12">
                <Target size={32} className="text-slate-700 mx-auto mb-3" />
                <p className="text-slate-500 text-sm">No trades yet</p>
                <p className="text-slate-600 text-xs mt-1">Waiting for entry signals…</p>
              </div>
            ) : (
              <>
                {openPositions.length > 0 && (
                  <div className="mb-4">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">Open Positions</p>
                    <div className="space-y-3">
                      {openPositions.map((pos) => <TradeCard key={pos.id} pos={pos} />)}
                    </div>
                  </div>
                )}
                {closedAll.length > 0 && (
                  <div>
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-2">
                      Trade History ({closedAll.length})
                    </p>
                    <div className="space-y-2">
                      {closedAll.map((pos) => <ClosedPositionRow key={pos.id} pos={pos} />)}
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
