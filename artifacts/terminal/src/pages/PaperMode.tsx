import { useState } from "react";
import {
  FileText, Settings, X, TrendingUp, TrendingDown, RotateCcw,
  AlertTriangle, Wallet, ChevronRight, ExternalLink,
  BarChart2, Clock, Target, Shield, Sliders, Check, Download,
  ChevronDown, ChevronUp, Pencil, Trash2, Eye,
} from "lucide-react";
import {
  usePaperSniperStatus, usePaperSniperPositions, usePaperSniperHistory,
  usePaperSniperEvents, useResetPaperAccount,
  usePaperSniperConfig, useUpdatePaperSniperConfig, useClosePaperPosition,
  useEditHistoryPosition, useDeleteHistoryPosition,
} from "@/lib/api";
import { PaperConfig, PaperPosition, PaperSniperEvent } from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(v: number, d = 4) { return v.toFixed(d); }
function fmtPct(v: number) { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }
function fmtPct2(v: number) { return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; }
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
function holdStr(ms: number) {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function toDateTime(ts: number) {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true,
  });
}

// ── CSV export ─────────────────────────────────────────────────────────────────

function downloadPaperCsv(history: PaperPosition[]) {
  const headers = [
    "Symbol", "Mint",
    "Entry Time", "Close Time", "Hold Time",
    "Entry Price ($)", "Exit Price ($)", "Peak Price ($)",
    "Detection Price ($)", "Entry Drift %",
    "Size (SOL)", "Realized PNL (SOL)", "PNL %",
    "TP1 Hit", "TP1 Realized (SOL)",
    "TP2 Hit", "TP2 Realized (SOL)",
    "Runner Realized (SOL)",
    "Close Reason",
  ];
  const rows = history.map((p) => {
    const holdMs = p.closedAt && p.entryAt ? p.closedAt - p.entryAt : 0;
    const pnlPct = p.exitPrice && p.entryPrice
      ? ((p.exitPrice / p.entryPrice) - 1) * 100
      : p.pnlPct;
    return [
      p.symbol,
      p.mint,
      (p.detectedAt ?? p.entryAt) ? toDateTime(p.detectedAt ?? p.entryAt) : "",
      p.closedAt ? toDateTime(p.closedAt) : "",
      holdMs ? holdStr(holdMs) : "",
      p.entryPrice.toString(),
      p.exitPrice  ? p.exitPrice.toString()  : "",
      p.trailingHigh ? p.trailingHigh.toString() : "",
      p.detectionPrice != null ? p.detectionPrice.toString() : "",
      p.entryDriftPct != null  ? p.entryDriftPct.toFixed(2)  : "",
      p.sizeSol.toString(),
      p.realizedPnlSol.toFixed(6),
      pnlPct.toFixed(2),
      p.tp1Hit ? "Yes" : "No",
      p.tp1RealizedSol.toFixed(6),
      p.tp2Hit ? "Yes" : "No",
      p.tp2RealizedSol.toFixed(6),
      p.runnerRealizedSol.toFixed(6),
      p.closeReason ?? "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
  });
  const csv  = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `paper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
  type?: "number" | "boolean";
  toggleKey?: keyof PaperConfig; // for numeric fields paired with a boolean toggle
};

const FIELDS: FieldDef[] = [
  { section: "Position sizing", key: "positionSizeSol",  label: "Position size",         description: "SOL per virtual trade",                       suffix: "SOL", min: 0.001, max: 10,   step: 0.001 },
  { key: "maxOpenPositions",   label: "Max open positions",    description: "Max concurrent paper trades",                 suffix: "",    min: 1,     max: 20,   step: 1 },
  { section: "Take profit",    key: "tp1Pct",           label: "TP1 target",            description: "Sell % of position at this gain",             suffix: "%",   min: 10,    max: 2000, step: 10 },
  { key: "tp1ClosePct",        label: "TP1 close %",           description: "Portion of position to sell at TP1",          suffix: "%",   min: 1,     max: 100,  step: 1 },
  { key: "tp2Pct",             label: "TP2 target",            description: "Sell more at this gain",                      suffix: "%",   min: 50,    max: 5000, step: 10 },
  { key: "tp2ClosePct",        label: "TP2 close %",           description: "Portion of remaining to sell at TP2",         suffix: "%",   min: 1,     max: 100,  step: 1 },
  { key: "tp3Pct",             label: "TP3 target",            description: "Exit remaining runner at this gain (e.g. 600 = 6×)",          suffix: "%",   min: 200,   max: 10000, step: 50 },
  { key: "tp3ClosePct",        label: "TP3 close %",           description: "% of remaining to close at TP3 (100 = full exit)",             suffix: "%",   min: 10,    max: 100,  step: 5 },
  { key: "trailingStopPct",    label: "Trailing stop",         description: "Stop when price drops this % from peak",      suffix: "%",   min: 1,     max: 90,   step: 1 },
  { section: "Stop loss",      key: "slPhase1Pct",      label: "SL phase 1  (0–2 min)", description: "Max drawdown in the first 2 minutes",         suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slPhase2Pct",        label: "SL phase 2  (2–10 min)",description: "Max drawdown from peak, 2–10 min",           suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slPhase3Pct",        label: "SL phase 3  (10 min+)", description: "Max drawdown from peak after 10 min",        suffix: "%",   min: 1,     max: 90,   step: 1 },
  { key: "slAfterTp1Pct",        label: "SL after TP1",              description: "Trailing SL % from peak once TP1 is hit",       suffix: "%",   min: 1,      max: 90,     step: 1    },
  { section: "Entry drift filter", key: "simulatedExecDelayMs", label: "Exec delay (sim)",          description: "Wait this long after graduation before entering — simulates real buy latency", suffix: "s", min: 0, max: 30, step: 1 },
  { key: "maxFillDriftPct",       label: "Max fill drift",            description: "Skip entry if price drifted more than this % during exec delay", suffix: "%", min: 1, max: 50, step: 1 },
  { section: "Dead-coin filter", key: "deadCoinWindowMs",   label: "Dead-coin window",           description: "Auto-close if coin doesn't move enough within this window", suffix: "hrs", min: 0.5, max: 24, step: 0.5 },
  { key: "deadCoinMinMovePct",   label: "Min movement required",     description: "Peak must exceed this % from entry or coin is dead", suffix: "%",   min: 1,  max: 50, step: 1 },
  { section: "Quality filters",  key: "enableLiquidityFilter",    type: "boolean", label: "Min liquidity filter",       description: "Skip tokens with pool liquidity below threshold at graduation", suffix: "", min: 0, max: 1, step: 1 },
  { key: "minLiquidityUsd",      label: "Min liquidity",               description: "Skip graduation if pool < this USD (e.g. 5000)",              suffix: "$",   min: 100,   max: 50_000, step: 100, toggleKey: "enableLiquidityFilter" },
  { key: "minLiquiditySolQuality", label: "Min SOL liquidity (scoring)", description: "Quality gate: skip if on-chain pool SOL < this (scoring threshold, default 25)", suffix: "SOL", min: 5, max: 500, step: 5 },
  { key: "minUniqueBuyers",      label: "Min unique buyers",            description: "Quality gate: skip if unique buyers in first 60s < this count",                    suffix: "",    min: 0,     max: 200,    step: 1   },
  { key: "minBuyPressureRatio",  label: "Min buy pressure",            description: "Quality gate: skip if buys/sells ratio < this (1.3 = 30% more buys than sells)",  suffix: "x",   min: 0.5,   max: 5,      step: 0.1 },
  { key: "maxTopHolderPct",      label: "Max top holder %",            description: "Quality gate: skip if single wallet holds more than this % of supply",            suffix: "%",   min: 5,     max: 50,     step: 1   },
  { key: "enableBondingCurveFilter", type: "boolean", label: "Bonding curve speed filter", description: "Skip tokens whose bonding curve took too long to complete", suffix: "", min: 0, max: 1, step: 1 },
  { key: "maxBondingCurveMinutes",   label: "Max bonding curve time",     description: "Skip if curve took longer than N minutes to graduate (e.g. 30)", suffix: "min", min: 5, max: 240, step: 5, toggleKey: "enableBondingCurveFilter" },
  { key: "enableHolderFilter",   type: "boolean", label: "Min holder count filter",     description: "Skip tokens with too few holders at graduation",              suffix: "", min: 0, max: 1, step: 1 },
  { key: "minHolderCount",       label: "Min holder count",            description: "Skip graduation if holder count < this value (e.g. 150)",     suffix: "",    min: 10,    max: 2_000,  step: 10,  toggleKey: "enableHolderFilter" },
  { section: "Strategy exits",   key: "enableCreatorFilter",  type: "boolean", label: "Creator holdings filter",     description: "Skip tokens where creator still holds > threshold % (rug risk)", suffix: "", min: 0, max: 1, step: 1 },
  { key: "maxCreatorHoldingsPct", label: "Max creator holdings",       description: "Skip if creator wallet holds more than this % of supply",     suffix: "%",   min: 1,     max: 50,     step: 1,   toggleKey: "enableCreatorFilter" },
  { key: "enableSellPressureExit", type: "boolean", label: "Sell pressure exit",        description: "Emergency exit when sells > buys×1.5 for ≥60s (pre-TP1 only)",    suffix: "", min: 0, max: 1, step: 1 },
  { key: "enableWhaleDumpExit",    type: "boolean", label: "Whale dump exit",           description: "Emergency exit if liquidity drops 20–39% in one 3s tick AND ≥5 SOL pulled (pre-TP1)", suffix: "", min: 0, max: 1, step: 1 },
];

const DEFAULT_CFG: PaperConfig = {
  positionSizeSol: 0.001, maxOpenPositions: 8,
  tp1Pct: 150, tp1ClosePct: 40, tp2Pct: 400, tp2ClosePct: 40, tp3Pct: 600, tp3ClosePct: 100,
  trailingStopPct: 30, slPhase1Pct: 20, slPhase2Pct: 25, slPhase3Pct: 30, slAfterTp1Pct: 35,
  simulatedExecDelayMs: 5_500,
  maxFillDriftPct: 15,
  deadCoinWindowMs: 7_200_000, deadCoinMinMovePct: 5,
  enableLiquidityFilter: true, minLiquidityUsd: 5_000,
  enableBondingCurveFilter: true, maxBondingCurveMinutes: 30,
  enableHolderFilter: true, minHolderCount: 150,
  enableCreatorFilter: true, maxCreatorHoldingsPct: 5,
  enableSellPressureExit: true,
  enableWhaleDumpExit: true,
  minUniqueBuyers: 20, minBuyPressureRatio: 1.3, maxTopHolderPct: 25, minLiquiditySolQuality: 25,
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
            const isBoolean = f.type === "boolean";
            const boolVal = isBoolean ? !!(merged[f.key]) : false;
            // Dim numeric rows when their paired toggle is off
            const toggleActive = f.toggleKey ? !!(merged[f.toggleKey]) : true;
            return (
              <div key={f.key}>
                {showSection && (
                  <p className="text-[9px] font-black text-amber-400/60 uppercase tracking-[0.2em] pt-4 pb-2 border-b border-amber-500/10 mb-1">
                    {f.section}
                  </p>
                )}
                <div className={`flex items-center justify-between py-3 border-b border-white/4 last:border-0 transition-opacity ${!toggleActive ? "opacity-40 pointer-events-none" : ""}`}>
                  <div className="flex-1 mr-4">
                    <p className="text-[11px] font-semibold text-white/75">{f.label}</p>
                    <p className="text-[10px] text-white/30 mt-0.5">{f.description}</p>
                  </div>
                  {isBoolean ? (
                    <button
                      onClick={() => setDraft((d) => ({ ...d, [f.key]: !boolVal }))}
                      className={`relative w-10 h-5 rounded-full transition-colors ${boolVal ? "bg-amber-500" : "bg-white/10"}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${boolVal ? "translate-x-5" : "translate-x-0"}`} />
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        className="w-20 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5 text-xs font-black text-white text-right focus:outline-none focus:border-amber-500/50 focus:bg-amber-500/5 transition-colors tabular-nums"
                        value={
                          f.key === "deadCoinWindowMs"
                            ? ((draft[f.key] ?? merged[f.key]) as number) / 3_600_000
                            : f.key === "simulatedExecDelayMs"
                              ? ((draft[f.key] ?? merged[f.key]) as number) / 1_000
                              : (draft[f.key] ?? merged[f.key])
                        }
                        min={f.min}
                        max={f.max}
                        step={f.step}
                        onChange={(e) => {
                          const raw = parseFloat(e.target.value);
                          if (!isNaN(raw)) {
                            const v = f.key === "deadCoinWindowMs"
                              ? Math.round(raw * 3_600_000)
                              : f.key === "simulatedExecDelayMs"
                                ? Math.round(raw * 1_000)
                                : f.step < 1 ? raw : parseInt(e.target.value, 10);
                            setDraft((d) => ({ ...d, [f.key]: v }));
                          }
                        }}
                      />
                      {f.suffix && <span className="text-[10px] text-white/35 font-medium w-6">{f.suffix}</span>}
                    </div>
                  )}
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
  const pct       = pos.pnlPct;
  const isPos     = pct >= 0;
  const ageMs     = Date.now() - pos.entryAt;
  const drawPct   = pos.trailingHigh > 0 ? ((pos.currentPrice / pos.trailingHigh) - 1) * 100 : 0;
  const atPeak    = pos.trailingHigh > 0 && pos.currentPrice >= pos.trailingHigh * 0.995;
  const peakGain  = pos.trailingHigh > 0 && pos.entryPrice > 0
    ? ((pos.trailingHigh / pos.entryPrice) - 1) * 100
    : null;
  const remainPct = Math.round(pos.remainingFraction * 100);
  const totalPnl  = pos.unrealizedPnlSol + pos.realizedPnlSol;
  const closePos  = useClosePaperPosition();
  const [confirm, setConfirm] = useState(false);

  function handleClose() {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
    closePos.mutate(pos.id);
    setConfirm(false);
  }

  return (
    <div className={`rounded-2xl border p-4 ${isPos ? "bg-emerald-950/20 border-emerald-500/15" : "bg-red-950/20 border-red-500/15"}`}>
      {/* Top row */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/6 border border-white/10 flex items-center justify-center">
            <span className="text-sm font-black text-white/60">{pos.symbol.charAt(0)}</span>
          </div>
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-sm font-black text-white">{pos.symbol}</span>
              {pos.tp1Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-bold border border-violet-500/20">TP1</span>}
              {pos.tp2Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/20">TP2</span>}
              {atPeak    && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/20">ATH</span>}
            </div>
            <p className="text-[10px] text-white/30 font-medium mt-0.5">
              {ageStr(ageMs)} in trade · {fmt(pos.sizeSol, 3)} SOL · {remainPct}% pos remaining
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className={`text-right ${isPos ? "text-emerald-400" : "text-red-400"}`}>
            <p className="text-xl font-black leading-none">{fmtPct(pct)}</p>
            <p className={`text-[11px] font-bold mt-0.5 ${totalPnl >= 0 ? "text-emerald-300/70" : "text-red-300/70"}`}>
              {totalPnl >= 0 ? "+" : ""}{fmt(totalPnl)} SOL
            </p>
          </div>
          <button
            onClick={handleClose}
            disabled={closePos.isPending}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[9px] font-bold transition-all border ${
              confirm
                ? "bg-red-500/20 border-red-500/40 text-red-300 animate-pulse"
                : "bg-white/5 border-white/10 text-white/40 hover:bg-red-500/15 hover:border-red-500/25 hover:text-red-300"
            }`}
          >
            <X size={9} />
            {confirm ? "Confirm?" : "Close"}
          </button>
        </div>
      </div>

      {/* Price grid */}
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

      {/* SL price + peak gain row */}
      <div className="flex items-center justify-between mb-2.5 text-[10px]">
        <div className="flex items-center gap-1.5">
          <Shield size={9} className="text-white/20" />
          <span className="text-white/30">SL:</span>
          <span className="text-red-400/70 font-semibold tabular-nums">{fmtPrice(pos.effectiveSlPrice)}</span>
          {pos.tp1Hit && <span className="text-white/20 ml-1">(breakeven)</span>}
        </div>
        {peakGain !== null && (
          <span className="text-amber-300/70 font-semibold">Peak +{peakGain.toFixed(1)}%</span>
        )}
      </div>

      {/* Drift / execution row */}
      {pos.detectionPrice != null && (
        <div className="flex items-center gap-1 flex-wrap mb-2.5 text-[10px]">
          <span className="text-white/30">Detect {fmtPrice(pos.detectionPrice)}</span>
          <span className="text-white/20">→</span>
          <span className="text-white/30">Fill {fmtPrice(pos.entryPrice)}</span>
          {pos.entryDriftPct != null && (
            <span className={`font-semibold ${pos.entryDriftPct > 5 ? "text-amber-400/80" : pos.entryDriftPct < -2 ? "text-emerald-400/80" : "text-white/40"}`}>
              ({pos.entryDriftPct >= 0 ? "+" : ""}{pos.entryDriftPct.toFixed(1)}% drift)
            </span>
          )}
          {pos.msDetectionToFill != null && (
            <span className="text-white/25">{(pos.msDetectionToFill / 1000).toFixed(1)}s to fill</span>
          )}
        </div>
      )}

      {/* From-peak bar */}
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex-1 h-1 bg-white/6 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.max(0, Math.min(100, (pos.currentPrice / pos.trailingHigh) * 100))}%`, background: isPos ? "#34d399" : "#f87171" }}
          />
        </div>
        <span className="text-[9px] text-white/30 font-medium tabular-nums shrink-0">{drawPct.toFixed(1)}% from peak</span>
        <a href={`https://dexscreener.com/solana/${pos.mint}`} target="_blank" rel="noreferrer" title="DexScreener">
          <ExternalLink size={10} className="text-white/20 hover:text-violet-400 transition-colors" />
        </a>
      </div>

      {/* P&L breakdown — unrealized + realized split */}
      {(pos.tp1Hit || pos.tp2Hit || pos.realizedPnlSol > 0) && (
        <div className="mt-2.5 pt-2.5 border-t border-white/5 rounded-xl bg-white/2 p-2.5 space-y-1">
          <p className="text-[9px] font-black text-white/20 uppercase tracking-widest mb-1.5">P&L Breakdown</p>
          <div className="flex justify-between text-[10px]">
            <span className="text-white/30">Unrealized</span>
            <span className={`font-bold ${pos.unrealizedPnlSol >= 0 ? "text-blue-300" : "text-red-400"}`}>
              {pos.unrealizedPnlSol >= 0 ? "+" : ""}{fmt(pos.unrealizedPnlSol, 4)} SOL
            </span>
          </div>
          {pos.realizedPnlSol > 0 && (
            <div className="flex justify-between text-[10px]">
              <span className="text-white/30">Realized (banked)</span>
              <span className="text-violet-300 font-bold">+{fmt(pos.realizedPnlSol, 4)} SOL</span>
            </div>
          )}
          {pos.tp1Hit && pos.tp1RealizedSol > 0 && (
            <div className="flex justify-between text-[10px]">
              <span className="text-white/20 pl-2">↳ TP1</span>
              <span className="text-violet-300/70 font-bold">+{fmt(pos.tp1RealizedSol, 4)}</span>
            </div>
          )}
          {pos.tp2Hit && pos.tp2RealizedSol > 0 && (
            <div className="flex justify-between text-[10px]">
              <span className="text-white/20 pl-2">↳ TP2</span>
              <span className="text-amber-300/70 font-bold">+{fmt(pos.tp2RealizedSol, 4)}</span>
            </div>
          )}
          <div className="flex justify-between text-[10px] border-t border-white/5 pt-1 mt-1">
            <span className="text-white/40 font-bold">Total</span>
            <span className={`font-black ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {totalPnl >= 0 ? "+" : ""}{fmt(totalPnl, 4)} SOL
              <span className="text-white/30 font-medium ml-1">({fmtPct2(pct)})</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History card (expandable) ──────────────────────────────────────────────────

// ── Edit history modal ─────────────────────────────────────────────────────────
function EditHistoryModal({ pos, onClose }: { pos: PaperPosition; onClose: () => void }) {
  const editMutation = useEditHistoryPosition();
  const [form, setForm] = useState({
    entryPrice:     String(pos.entryPrice),
    exitPrice:      String(pos.exitPrice ?? ""),
    detectionPrice: String(pos.detectionPrice ?? ""),
    trailingHigh:   String(pos.trailingHigh ?? ""),
    sizeSol:        String(pos.sizeSol),
    realizedPnlSol: String(pos.realizedPnlSol),
    closeReason:    pos.closeReason ?? "",
  });

  function field(label: string, key: keyof typeof form, suffix?: string) {
    return (
      <div className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
        <span className="text-[11px] text-white/50">{label}</span>
        <div className="flex items-center gap-1.5">
          <input
            type={key === "closeReason" ? "text" : "number"}
            value={form[key]}
            onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            className="w-28 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs font-bold text-white text-right focus:outline-none focus:border-amber-500/50 tabular-nums"
          />
          {suffix && <span className="text-[10px] text-white/30 w-6">{suffix}</span>}
        </div>
      </div>
    );
  }

  function save() {
    const updates: Record<string, number | string> = {};
    const ep  = parseFloat(form.entryPrice);
    const xp  = parseFloat(form.exitPrice);
    const dp  = parseFloat(form.detectionPrice);
    const th  = parseFloat(form.trailingHigh);
    const sz  = parseFloat(form.sizeSol);
    const pnl = parseFloat(form.realizedPnlSol);
    if (!isNaN(ep)  && ep  !== pos.entryPrice)     updates.entryPrice     = ep;
    if (!isNaN(xp)  && xp  !== pos.exitPrice)      updates.exitPrice      = xp;
    if (!isNaN(dp)  && dp  !== pos.detectionPrice)  updates.detectionPrice = dp;
    if (!isNaN(th)  && th  !== pos.trailingHigh)    updates.trailingHigh   = th;
    if (!isNaN(sz)  && sz  !== pos.sizeSol)         updates.sizeSol        = sz;
    if (!isNaN(pnl) && pnl !== pos.realizedPnlSol) updates.realizedPnlSol = pnl;
    if (form.closeReason !== (pos.closeReason ?? "")) updates.closeReason  = form.closeReason;
    if (Object.keys(updates).length === 0) { onClose(); return; }
    editMutation.mutate({ id: pos.id, updates }, { onSuccess: () => onClose() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm bg-[#111] border border-white/10 rounded-t-2xl p-5 pb-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-black text-white">Edit Trade — {pos.symbol}</p>
            <p className="text-[10px] text-white/30 mt-0.5">Changes to Realized P&L adjust the virtual balance</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white"><X size={16} /></button>
        </div>
        <div className="space-y-0">
          {field("Entry price",      "entryPrice",     "USD")}
          {field("Exit price",       "exitPrice",      "USD")}
          {field("Detection price",  "detectionPrice", "USD")}
          {field("Peak price",       "trailingHigh",   "USD")}
          {field("Size",             "sizeSol",        "SOL")}
          {field("Realized P&L",     "realizedPnlSol", "SOL")}
          {field("Close reason",     "closeReason")}
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-white/10 text-xs font-bold text-white/50">Cancel</button>
          <button
            onClick={save}
            disabled={editMutation.isPending}
            className="flex-1 py-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-xs font-bold text-amber-300 disabled:opacity-50"
          >
            {editMutation.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryCard({ pos }: { pos: PaperPosition }) {
  const [expanded,    setExpanded]    = useState(false);
  const [showEdit,    setShowEdit]    = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const deleteMutation = useDeleteHistoryPosition();

  const isWin   = pos.realizedPnlSol >= 0;
  const holdMs  = pos.closedAt && pos.entryAt ? pos.closedAt - pos.entryAt : 0;
  const pnlPct  = pos.exitPrice && pos.entryPrice
    ? ((pos.exitPrice / pos.entryPrice) - 1) * 100
    : pos.pnlPct;
  const peakPct = pos.trailingHigh && pos.entryPrice
    ? ((pos.trailingHigh / pos.entryPrice) - 1) * 100
    : null;

  return (
    <>
      {showEdit && <EditHistoryModal pos={pos} onClose={() => setShowEdit(false)} />}

      <div className={`rounded-2xl border mb-2 overflow-hidden transition-colors ${isWin ? "bg-emerald-950/15 border-emerald-500/12" : "bg-red-950/15 border-red-500/12"}`}>
        {/* Summary row — always visible */}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="w-full flex items-center gap-3 p-3.5 text-left hover:bg-white/2 transition-colors"
        >
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${isWin ? "bg-emerald-500/15" : "bg-red-500/15"}`}>
            {isWin
              ? <TrendingUp size={14} className="text-emerald-400" />
              : <TrendingDown size={14} className="text-red-400" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-black text-white">{pos.symbol}</span>
              {pos.tp1Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-violet-500/18 text-violet-300 font-bold border border-violet-500/20">TP1</span>}
              {pos.tp2Hit && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-amber-500/18 text-amber-300 font-bold border border-amber-500/20">TP2</span>}
              {holdMs > 0 && <span className="text-[9px] text-white/25 font-medium">{holdStr(holdMs)}</span>}
            </div>
            <p className="text-[10px] text-white/25 truncate mt-0.5">{pos.closeReason ?? "—"}</p>
          </div>
          <div className="text-right shrink-0 mr-1">
            <p className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
              {isWin ? "+" : ""}{fmt(pos.realizedPnlSol)} SOL
            </p>
            <p className={`text-[11px] font-bold ${isWin ? "text-emerald-400/60" : "text-red-400/60"}`}>
              {fmtPct2(pnlPct)}
            </p>
          </div>
          {expanded
            ? <ChevronUp size={13} className="text-white/25 shrink-0" />
            : <ChevronDown size={13} className="text-white/25 shrink-0" />}
        </button>

        {/* Expanded detail panel */}
        {expanded && (
          <div className="border-t border-white/6 px-4 pb-4 pt-3 space-y-3">

            {/* Price grid */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "Entry",  val: fmtPrice(pos.entryPrice),   cl: "text-white/70" },
                { label: "Exit",   val: pos.exitPrice ? fmtPrice(pos.exitPrice) : "—", cl: isWin ? "text-emerald-300" : "text-red-300" },
                { label: "Peak",   val: pos.trailingHigh ? fmtPrice(pos.trailingHigh) : "—", cl: "text-amber-300/80" },
              ].map(({ label, val, cl }) => (
                <div key={label} className="bg-white/3 rounded-xl p-2.5">
                  <p className="text-[9px] text-white/30 font-medium mb-1">{label}</p>
                  <p className={`text-[11px] font-bold tabular-nums ${cl}`}>{val}</p>
                </div>
              ))}
            </div>

            {/* Peak gain */}
            {peakPct !== null && (
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-white/30">Peak gain from entry</span>
                <span className="text-amber-300 font-bold">{fmtPct2(peakPct)}</span>
              </div>
            )}

            {/* Drift + price mismatch warning */}
            {pos.detectionPrice != null && (
              <div className="space-y-1">
                <div className="flex items-center gap-1 flex-wrap text-[10px]">
                  <span className="text-white/30">Detect {fmtPrice(pos.detectionPrice)}</span>
                  <span className="text-white/20">→</span>
                  <span className="text-white/30">Fill {fmtPrice(pos.entryPrice)}</span>
                  {pos.entryDriftPct != null && (
                    <span className={`font-semibold ${pos.entryDriftPct > 5 ? "text-amber-400/80" : pos.entryDriftPct < -2 ? "text-emerald-400/80" : "text-white/40"}`}>
                      ({pos.entryDriftPct >= 0 ? "+" : ""}{pos.entryDriftPct.toFixed(1)}% drift)
                    </span>
                  )}
                </div>
                {/* Show mismatch warning when fill ≈ detection (likely stale DexScreener at entry time) */}
                {pos.entryDriftPct != null && pos.entryDriftPct < 1.6 && pos.entryDriftPct >= 0 && (
                  <div className="flex items-start gap-1.5 bg-amber-500/8 border border-amber-500/20 rounded-lg px-2.5 py-2">
                    <AlertTriangle size={10} className="text-amber-400/80 mt-0.5 shrink-0" />
                    <p className="text-[9px] text-amber-400/70 leading-relaxed">
                      <span className="font-bold text-amber-400/90">Possible price mismatch.</span>{" "}
                      Fill ≈ detection price ({pos.entryDriftPct.toFixed(1)}% drift) suggests DexScreener served a stale
                      pre-pump price at entry time. Actual fill in live trading would have been higher.
                      P&L shown may be overstated.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* P&L breakdown */}
            <div className="rounded-xl bg-white/3 border border-white/6 px-3 py-2.5 space-y-1.5">
              <p className="text-[9px] font-black text-white/25 uppercase tracking-widest mb-2">P&L Breakdown</p>
              <div className="flex justify-between text-[10px]">
                <span className="text-white/35">Size</span>
                <span className="text-white/65 font-bold">{fmt(pos.sizeSol, 4)} SOL</span>
              </div>
              <div className="flex justify-between text-[10px]">
                <span className="text-white/35">Total realized</span>
                <span className={`font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                  {isWin ? "+" : ""}{fmt(pos.realizedPnlSol, 4)} SOL
                  <span className="text-white/30 font-medium ml-1">({fmtPct2(pnlPct)})</span>
                </span>
              </div>
              {pos.tp1Hit && pos.tp1RealizedSol > 0 && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25 pl-2">↳ TP1</span>
                  <span className="text-violet-300 font-bold">+{fmt(pos.tp1RealizedSol, 4)} SOL</span>
                </div>
              )}
              {pos.tp2Hit && pos.tp2RealizedSol > 0 && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25 pl-2">↳ TP2</span>
                  <span className="text-amber-300 font-bold">+{fmt(pos.tp2RealizedSol, 4)} SOL</span>
                </div>
              )}
              {pos.runnerRealizedSol > 0 && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25 pl-2">↳ Runner</span>
                  <span className="text-emerald-300 font-bold">+{fmt(pos.runnerRealizedSol, 4)} SOL</span>
                </div>
              )}
            </div>

            {/* Timestamps */}
            <div className="space-y-1">
              {(pos.detectedAt ?? pos.entryAt) > 0 && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25">Entered</span>
                  <span className="text-white/45 font-medium tabular-nums">{toDateTime(pos.detectedAt ?? pos.entryAt)}</span>
                </div>
              )}
              {pos.closedAt && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25">Closed</span>
                  <span className="text-white/45 font-medium tabular-nums">{toDateTime(pos.closedAt)}</span>
                </div>
              )}
              {holdMs > 0 && (
                <div className="flex justify-between text-[10px]">
                  <span className="text-white/25">Hold time</span>
                  <span className="text-white/45 font-medium">{holdStr(holdMs)}</span>
                </div>
              )}
            </div>

            {/* DexScreener link + action buttons */}
            <div className="flex items-center justify-between">
              <a
                href={`https://dexscreener.com/solana/${pos.mint}`}
                target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 text-[10px] text-violet-400/55 hover:text-violet-400 transition-colors"
              >
                <ExternalLink size={10} /> View on DexScreener
              </a>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowEdit(true)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[10px] font-bold text-white/50 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/5 transition-colors"
                >
                  <Pencil size={9} /> Edit
                </button>
                {confirmDel ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => deleteMutation.mutate(pos.id, { onSuccess: () => setConfirmDel(false) })}
                      disabled={deleteMutation.isPending}
                      className="px-2.5 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 text-[10px] font-bold text-red-400 disabled:opacity-50"
                    >
                      {deleteMutation.isPending ? "…" : "Confirm"}
                    </button>
                    <button
                      onClick={() => setConfirmDel(false)}
                      className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[10px] text-white/40"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDel(true)}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[10px] font-bold text-white/50 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5 transition-colors"
                  >
                    <Trash2 size={9} /> Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Event row ──────────────────────────────────────────────────────────────────

function EventRow({ e }: { e: PaperSniperEvent }) {
  const isEnter    = e.action === "entered";
  const isClose    = e.action === "closed";
  const isWatching = e.action === "watching";
  const isWin      = (e.pnlSol ?? 0) >= 0;

  const buyerDelta = isWatching && e.baselineBuyers !== undefined && e.uniqueBuyers !== undefined
    ? e.uniqueBuyers - e.baselineBuyers
    : null;
  const liqDelta = isWatching && e.baselineLiq !== undefined && e.liquiditySol !== undefined
    ? e.liquiditySol - e.baselineLiq
    : null;

  return (
    <div className={`flex items-start gap-3 px-4 py-3 border-b border-white/4 last:border-0 ${isWatching ? "bg-amber-500/3" : ""}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
        isEnter      ? "bg-emerald-500/15"
        : isWatching ? "bg-amber-500/12"
        : isClose && isWin ? "bg-emerald-500/15"
        : isClose    ? "bg-red-500/15"
        : "bg-white/6"
      }`}>
        {isEnter    && <ChevronRight size={12} className="text-emerald-400" />}
        {isWatching && <Eye size={11} className="text-amber-400 animate-pulse" />}
        {isClose && isWin  && <TrendingUp   size={12} className="text-emerald-400" />}
        {isClose && !isWin && <TrendingDown  size={12} className="text-red-400" />}
        {e.action === "skipped" && <AlertTriangle size={11} className="text-white/30" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[11px] font-bold ${isWatching ? "text-amber-300/80" : "text-white/80"}`}>
            {e.symbol}
          </span>
          <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-full ${
            isEnter      ? "bg-emerald-500/15 text-emerald-300"
            : isWatching ? "bg-amber-500/15 text-amber-300"
            : isClose    ? "bg-violet-500/15 text-violet-300"
            : "bg-white/6 text-white/35"
          }`}>
            {isWatching ? `WATCHING ${e.watchStage ?? ""}` : e.action.toUpperCase()}
          </span>
          {e.qualityScore !== undefined && e.qualityScore > 0 && (
            <span className={`text-[8px] font-bold ${e.qualityScore >= 70 ? "text-yellow-400" : "text-white/35"}`}>
              Q:{e.qualityScore}
            </span>
          )}
          {e.pnlSol !== undefined && (
            <span className={`text-[10px] font-black ml-auto ${e.pnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {e.pnlSol >= 0 ? "+" : ""}{e.pnlSol.toFixed(4)} SOL
            </span>
          )}
        </div>

        {/* Watching: baseline metrics + improvement delta */}
        {isWatching && (
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {e.baselineBuyers !== undefined && (
              <span className="text-[9px] text-white/30">
                👥 {e.baselineBuyers} buyers
                {buyerDelta !== null && buyerDelta !== 0 && (
                  <span className={buyerDelta > 0 ? " text-emerald-400" : " text-red-400"}>
                    {" "}{buyerDelta > 0 ? "+" : ""}{buyerDelta}
                  </span>
                )}
              </span>
            )}
            {e.baselineLiq !== undefined && (
              <span className="text-[9px] text-white/30">
                💧 {e.baselineLiq.toFixed(1)} SOL
                {liqDelta !== null && Math.abs(liqDelta) > 0.5 && (
                  <span className={liqDelta > 0 ? " text-emerald-400" : " text-red-400"}>
                    {" "}{liqDelta > 0 ? "+" : ""}{liqDelta.toFixed(1)}
                  </span>
                )}
              </span>
            )}
            <span className="text-[9px] text-amber-400/45">⏱ re-check at {e.watchStage ?? "T+180s"}</span>
          </div>
        )}

        {!isWatching && (e.skipReason || e.closeReason) && (
          <p className="text-[10px] text-white/25 mt-0.5 truncate">{e.skipReason ?? e.closeReason}</p>
        )}
        <p className="text-[9px] text-white/20 mt-0.5">{new Date(e.detectedAt).toLocaleTimeString()}</p>
      </div>
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, pct, sub, accent = "neutral" }: {
  label: string; value: string; pct?: number | null; sub?: string;
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
      {pct != null && (
        <p className={`text-[11px] font-bold mt-1 ${pct >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
          {pct >= 0 ? "+" : ""}{pct.toFixed(1)}% of capital
        </p>
      )}
      {sub && <p className="text-[10px] text-white/30 mt-1 leading-relaxed">{sub}</p>}
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
            label="Combined P&L"
            value={`${combinedPnl >= 0 ? "+" : ""}${fmt(combinedPnl)} SOL`}
            pct={startBal > 0 ? ((combinedPnl / startBal) * 100) : null}
            sub={`Realized: ${realizedPnl >= 0 ? "+" : ""}${fmt(realizedPnl)} SOL`}
            accent={combinedPnl >= 0 ? "emerald" : "red"}
          />
          <StatCard
            label="Unrealized"
            value={`${unrealizedPnl >= 0 ? "+" : ""}${fmt(unrealizedPnl)} SOL`}
            pct={startBal > 0 ? ((unrealizedPnl / startBal) * 100) : null}
            sub={`${positions.length} position${positions.length !== 1 ? "s" : ""} open`}
            accent={unrealizedPnl === 0 ? "neutral" : unrealizedPnl > 0 ? "emerald" : "red"}
          />
          <StatCard
            label="Realized P&L"
            value={`${realizedPnl >= 0 ? "+" : ""}${fmt(realizedPnl)} SOL`}
            pct={startBal > 0 ? ((realizedPnl / startBal) * 100) : null}
            sub={`From ${status?.tradesTotal ?? 0} closed trade${(status?.tradesTotal ?? 0) !== 1 ? "s" : ""}`}
            accent={realizedPnl === 0 ? "neutral" : realizedPnl > 0 ? "emerald" : "red"}
          />
          <StatCard
            label="Win Rate"
            value={winRate}
            sub={`${status?.wins ?? 0}W · ${status?.losses ?? 0}L · ${config?.positionSizeSol ?? 0.05} SOL/trade`}
            accent={winRate === "—" ? "neutral" : parseInt(winRate) >= 50 ? "emerald" : "red"}
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
          <div>
            {history.length === 0 ? (
              <div className="rounded-2xl bg-white/3 border border-white/6 flex flex-col items-center justify-center py-16 gap-3">
                <BarChart2 size={26} className="text-white/12" />
                <p className="text-sm font-bold text-white/20">No closed trades yet</p>
              </div>
            ) : (
              <>
                {/* CSV download header */}
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] text-white/30 font-medium">
                    {history.length} closed trade{history.length !== 1 ? "s" : ""} · tap to expand
                  </p>
                  <button
                    onClick={() => downloadPaperCsv(history)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/12 hover:bg-amber-500/20 border border-amber-500/20 hover:border-amber-500/35 text-amber-400 text-[10px] font-bold transition-all"
                  >
                    <Download size={11} />
                    Export CSV
                  </button>
                </div>
                <div className="space-y-0">
                  {history.map((pos) => <HistoryCard key={pos.id} pos={pos} />)}
                </div>
              </>
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
