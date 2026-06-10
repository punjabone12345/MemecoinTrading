import { useState } from "react";
import { Target, Wifi, WifiOff, TrendingUp, TrendingDown, RefreshCw, Settings, X, CheckCircle2, XCircle, Clock, Zap, Trash2, Pencil, RotateCcw, AlertTriangle, Download, ExternalLink, Activity, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useSniperStatus, useSniperPositions, useSniperHistory, useSniperEvents, useUpdateSniperConfig,
  useDeleteSniperPosition, useEditSniperPosition, useDeleteSniperEvent, useResetSniperAccount,
  useRecalculateSniperPnl, useCloseSniperPosition,
} from "@/lib/api";
import { SniperPosition, SniperEvent, SniperConfig } from "@/lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 4): string { return n.toFixed(d); }
function fmtPct(n: number): string { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function mintShort(mint: string): string { return `${mint.slice(0, 4)}…${mint.slice(-4)}`; }
function solscanUrl(mint: string): string { return `https://solscan.io/token/${mint}`; }
function fmtPrice(p: number): string { return p < 0.0001 ? p.toExponential(3) : fmt(p, 6); }
function holdTime(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function toIST(ts: number): string {
  return new Date(ts).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

// ── CSV export ────────────────────────────────────────────────────────────────

function downloadSniperCsv(history: SniperPosition[]) {
  const headers = [
    "Symbol", "Mint", "Entry Time (IST)", "Close Time (IST)", "Hold Time",
    "Entry Price ($)", "Exit Price ($)", "Size (SOL)", "Realized PNL (SOL)",
    "PNL %", "TP1 Hit", "TP2 Hit", "Close Reason", "TX Signature",
  ];
  const rows = history.map((p) => {
    const holdMs = p.closedAt && p.entryAt ? p.closedAt - p.entryAt : 0;
    const pnlPct = p.sizeSol > 0 ? (p.realizedPnlSol / p.sizeSol * 100).toFixed(2) : "";
    return [
      p.symbol,
      p.mint,
      p.entryAt   ? toIST(p.entryAt)   : "",
      p.closedAt  ? toIST(p.closedAt)  : "",
      holdMs ? holdTime(holdMs) : "",
      p.entryPrice.toString(),
      p.exitPrice  ? p.exitPrice.toString() : "",
      p.sizeSol.toString(),
      p.realizedPnlSol.toFixed(6),
      pnlPct,
      p.tp1Hit ? "Yes" : "No",
      p.tp2Hit ? "Yes" : "No",
      p.closeReason ?? "",
      p.txSignature ?? "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");
  });
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `sniper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Settings panel ────────────────────────────────────────────────────────────

interface SettingsField {
  key: keyof SniperConfig;
  label: string;
  description: string;
  type: "number" | "boolean";
  min?: number; max?: number; step?: number;
}

const SETTINGS_FIELDS: SettingsField[] = [
  { key: "enabled",           label: "Enable Sniper",          description: "Master switch — starts/stops catching graduations", type: "boolean" },
  { key: "positionSizeSol",   label: "Position Size (SOL)",    description: "Virtual SOL per paper trade",          type: "number", min: 0.01, max: 10,   step: 0.01 },
  { key: "maxOpenPositions",  label: "Max Open Positions",     description: "Halt entries above this count",        type: "number", min: 1,    max: 20,   step: 1    },
  { key: "slPct",             label: "Stop Loss %",            description: "Exit whole position at this loss",     type: "number", min: 5,    max: 90,   step: 1    },
  { key: "tp1Pct",            label: "TP1 Target %",           description: "First take-profit — sell TP1 Close %", type: "number", min: 20, max: 1000, step: 5 },
  { key: "tp1ClosePct",       label: "TP1 Close %",            description: "% of position to sell at TP1",        type: "number", min: 10,   max: 90,   step: 5    },
  { key: "tp2Pct",            label: "TP2 Target %",           description: "Second take-profit — sell TP2 Close %", type: "number", min: 50, max: 5000, step: 25 },
  { key: "tp2ClosePct",       label: "TP2 Close %",            description: "% of original position to sell at TP2", type: "number", min: 5,  max: 80,   step: 5    },
  { key: "trailingStopPct",   label: "Trailing Stop %",        description: "Runner trailing stop below peak",      type: "number", min: 5,    max: 80,   step: 5    },
  { key: "waitBeforeEntryMs", label: "Entry Delay (ms)",       description: "Wait after detection before buying",   type: "number", min: 0,    max: 30000, step: 500 },
  { key: "virtualBalanceSol", label: "Virtual Balance (SOL)",  description: "Starting virtual wallet size",         type: "number", min: 1,    max: 1000, step: 0.5  },
];

function SettingsPanel({ config, onClose }: { config: SniperConfig; onClose: () => void }) {
  const [draft, setDraft] = useState<SniperConfig>({ ...config });
  const [saved, setSaved] = useState(false);
  const update = useUpdateSniperConfig();

  function handleSave() {
    update.mutate(draft, {
      onSuccess: () => {
        setSaved(true);
        setTimeout(() => { setSaved(false); onClose(); }, 800);
      },
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm px-2 pb-2">
      {/* Modal — flex column so footer is always visible */}
      <div className="w-full max-w-md bg-[#12121e] border border-white/10 rounded-2xl shadow-2xl flex flex-col"
        style={{ maxHeight: "calc(100dvh - 32px)" }}>
        {/* Header — fixed */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-bold text-white">Sniper Settings</span>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>

        {/* Scrollable fields */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
          {SETTINGS_FIELDS.map((f) => (
            <div key={f.key}>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-white/80">{f.label}</label>
                {f.type === "boolean" ? (
                  <button onClick={() => setDraft((d) => ({ ...d, [f.key]: !d[f.key] }))}
                    className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${draft[f.key] ? "bg-violet-500" : "bg-white/15"}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${draft[f.key] ? "translate-x-5" : "translate-x-0"}`} />
                  </button>
                ) : (
                  <input type="number" value={draft[f.key] as number} min={f.min} max={f.max} step={f.step}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: parseFloat(e.target.value) || 0 }))}
                    className="w-24 px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-white text-xs text-right focus:outline-none focus:border-violet-500 flex-shrink-0"
                  />
                )}
              </div>
              <p className="text-[10px] text-white/35">{f.description}</p>
            </div>
          ))}
        </div>

        {/* Footer — always visible, never scrolls away */}
        <div className="flex-shrink-0 px-5 py-4 border-t border-white/10 flex gap-3">
          <Button variant="ghost" size="sm" onClick={onClose} className="flex-1 text-white/50 hover:text-white">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={update.isPending}
            className={`flex-1 font-bold transition-colors ${saved ? "bg-emerald-500 hover:bg-emerald-600" : "bg-violet-500 hover:bg-violet-600"} text-white`}>
            {update.isPending ? "Saving…" : saved ? "✓ Saved!" : "Save Settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Position modal ────────────────────────────────────────────────────────

function EditPositionModal({ pos, onClose }: { pos: SniperPosition; onClose: () => void }) {
  const edit = useEditSniperPosition();
  const [entryPrice,   setEntryPrice]   = useState(String(pos.entryPrice));
  const [exitPrice,    setExitPrice]    = useState(String(pos.exitPrice ?? ""));
  const [realizedPnl,  setRealizedPnl]  = useState(String(pos.realizedPnlSol));
  const [closeReason,  setCloseReason]  = useState(pos.closeReason ?? "");

  function handleSave() {
    const patch: Parameters<typeof edit.mutate>[0] = { id: pos.id };
    const ep = parseFloat(entryPrice);
    if (!isNaN(ep) && ep > 0) patch.entryPrice = ep;
    const xp = parseFloat(exitPrice);
    if (!isNaN(xp) && xp > 0) patch.exitPrice = xp;
    const rp = parseFloat(realizedPnl);
    if (!isNaN(rp)) patch.realizedPnlSol = rp;
    if (closeReason.trim()) patch.closeReason = closeReason.trim();
    edit.mutate(patch, { onSuccess: onClose });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-3">
      <div className="w-full max-w-sm bg-[#12121e] border border-white/10 rounded-2xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Pencil className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-white">Edit — {pos.symbol}</span>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {[
            { label: "Entry Price ($)", value: entryPrice, set: setEntryPrice },
            { label: "Exit Price ($)", value: exitPrice, set: setExitPrice, note: pos.status === "open" ? "Leave blank for open positions" : undefined },
            { label: "Realized PNL (SOL)", value: realizedPnl, set: setRealizedPnl },
          ].map(({ label, value, set, note }) => (
            <div key={label}>
              <label className="text-xs font-semibold text-white/70 block mb-1">{label}</label>
              <input type="number" step="any" value={value} onChange={(e) => set(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs focus:outline-none focus:border-amber-400"
              />
              {note && <p className="text-[10px] text-white/30 mt-0.5">{note}</p>}
            </div>
          ))}
          <div>
            <label className="text-xs font-semibold text-white/70 block mb-1">Close Reason</label>
            <input type="text" value={closeReason} onChange={(e) => setCloseReason(e.target.value)}
              placeholder="e.g. Trailing Stop (runner)"
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white text-xs focus:outline-none focus:border-amber-400"
            />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-white/10 flex gap-3">
          <Button variant="ghost" size="sm" onClick={onClose} className="flex-1 text-white/50 hover:text-white">Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={edit.isPending}
            className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-bold">
            {edit.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Reset Account confirm modal ───────────────────────────────────────────────

function ResetConfirmModal({ onClose }: { onClose: () => void }) {
  const reset = useResetSniperAccount();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-3">
      <div className="w-full max-w-sm bg-[#12121e] border border-red-500/30 rounded-2xl overflow-hidden shadow-2xl">
        <div className="px-5 py-5 text-center">
          <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
          <p className="text-sm font-bold text-white mb-1">Reset Sniper Account?</p>
          <p className="text-xs text-white/50">Permanently deletes all positions, history, and events and restores the virtual balance. This cannot be undone.</p>
        </div>
        <div className="px-5 pb-5 flex gap-3">
          <Button variant="ghost" size="sm" onClick={onClose} className="flex-1 text-white/50 hover:text-white">Cancel</Button>
          <Button size="sm" disabled={reset.isPending}
            onClick={() => reset.mutate(undefined, { onSuccess: onClose })}
            className="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold">
            {reset.isPending ? "Resetting…" : "Yes, Reset"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Position row (open) ───────────────────────────────────────────────────────

function PositionRow({ pos }: { pos: SniperPosition }) {
  const [showEdit,    setShowEdit]    = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const deletePos = useDeleteSniperPosition();
  const closePos  = useCloseSniperPosition();
  const pct  = pos.pnlPct;
  const pos_ = pct >= 0;

  const stage = pos.tp2Hit
    ? <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] px-1 py-0">Runner</Badge>
    : pos.tp1Hit
    ? <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[9px] px-1 py-0">TP1✓ BE-SL</Badge>
    : <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[9px] px-1 py-0">Live</Badge>;

  return (
    <>
      <div className="px-4 py-3 border-b border-white/5 last:border-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <a href={solscanUrl(pos.mint)} target="_blank" rel="noreferrer"
                className="text-sm font-bold text-violet-300 hover:text-violet-200 leading-none">{pos.symbol}</a>
              {stage}
            </div>
            <div className="text-[10px] text-white/35 mt-0.5 font-mono">{mintShort(pos.mint)}</div>
            <div className="text-[10px] text-white/40 mt-1">
              Detected {timeAgo(pos.detectedAt)} · Entry ${fmtPrice(pos.entryPrice)}
            </div>
            <div className="text-[10px] text-white/40">
              SL ${fmtPrice(pos.effectiveSlPrice)}{pos.tp1Hit && " (breakeven)"}
              {pos.tp2Hit && ` · Peak $${fmtPrice(pos.trailingHigh)}`}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <div className={`text-base font-black ${pos_ ? "text-emerald-400" : "text-red-400"}`}>{fmtPct(pct)}</div>
            <div className={`text-xs font-bold ${pos_ ? "text-emerald-400/80" : "text-red-400/80"}`}>
              {pos_ ? "+" : ""}{fmt(pos.totalPnlSol, 4)} SOL
            </div>
            <div className="text-[10px] text-white/30">Cur ${fmtPrice(pos.currentPrice)}</div>
            <div className="text-[10px] text-white/25">{fmt(pos.remainingFraction * 100, 0)}% pos</div>
            <div className="flex gap-1 mt-1">
              <button onClick={() => setConfirmClose(true)}
                className="p-1 rounded bg-white/5 hover:bg-orange-500/20 text-white/40 hover:text-orange-400 transition-colors" title="Close at market price">
                <LogOut className="w-3 h-3" />
              </button>
              <button onClick={() => setShowEdit(true)}
                className="p-1 rounded bg-white/5 hover:bg-amber-500/20 text-white/40 hover:text-amber-400 transition-colors" title="Edit">
                <Pencil className="w-3 h-3" />
              </button>
              <button onClick={() => setConfirmDel(true)}
                className="p-1 rounded bg-white/5 hover:bg-red-500/20 text-white/40 hover:text-red-400 transition-colors" title="Delete">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
        {/* Live P&L breakdown — shown once at least one TP has been hit */}
        {(pos.tp1Hit || pos.tp2Hit) && (
          <div className="mt-2 rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
            <div className="text-[9px] font-bold text-white/30 uppercase tracking-wider mb-1.5">P&amp;L Breakdown</div>
            <div className="flex gap-3 flex-wrap items-end">
              {pos.tp1Hit && (
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-white/25">TP1</span>
                  <span className={`text-[10px] font-bold ${pos.tp1RealizedSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.tp1RealizedSol >= 0 ? "+" : ""}{fmt(pos.tp1RealizedSol, 4)}
                  </span>
                </div>
              )}
              {pos.tp2Hit && (
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-white/25">TP2</span>
                  <span className={`text-[10px] font-bold ${pos.tp2RealizedSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.tp2RealizedSol >= 0 ? "+" : ""}{fmt(pos.tp2RealizedSol, 4)}
                  </span>
                </div>
              )}
              <div className="flex flex-col items-center">
                <span className="text-[9px] text-white/25">Unrealized</span>
                <span className={`text-[10px] font-bold ${pos.unrealizedPnlSol >= 0 ? "text-blue-400" : "text-red-400"}`}>
                  {pos.unrealizedPnlSol >= 0 ? "+" : ""}{fmt(pos.unrealizedPnlSol, 4)}
                </span>
              </div>
              <div className="flex flex-col items-center ml-auto">
                <span className="text-[9px] text-white/25">Total</span>
                <span className={`text-[10px] font-bold ${pos.totalPnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {pos.totalPnlSol >= 0 ? "+" : ""}{fmt(pos.totalPnlSol, 4)}
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-2">
          <a href={`https://dexscreener.com/solana/${pos.mint}`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-violet-400/60 hover:text-violet-400 transition-colors">
            <ExternalLink className="w-3 h-3" /> View on DexScreener
          </a>
        </div>
        {confirmClose && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-orange-500/10 border border-orange-500/20 px-3 py-2">
            <span className="text-[10px] text-orange-300 flex-1">Close at current price (${fmtPrice(pos.currentPrice)})?</span>
            <button onClick={() => closePos.mutate(pos.id, { onSuccess: () => setConfirmClose(false) })}
              className="text-[10px] font-bold text-orange-400 hover:text-orange-300 px-2 py-0.5 rounded bg-orange-500/20">
              {closePos.isPending ? "…" : "Close"}
            </button>
            <button onClick={() => setConfirmClose(false)} className="text-[10px] text-white/40 hover:text-white">Cancel</button>
          </div>
        )}
        {confirmDel && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
            <span className="text-[10px] text-red-300 flex-1">Delete this position?</span>
            <button onClick={() => deletePos.mutate(pos.id, { onSuccess: () => setConfirmDel(false) })}
              className="text-[10px] font-bold text-red-400 hover:text-red-300 px-2 py-0.5 rounded bg-red-500/20">
              {deletePos.isPending ? "…" : "Delete"}
            </button>
            <button onClick={() => setConfirmDel(false)} className="text-[10px] text-white/40 hover:text-white">Cancel</button>
          </div>
        )}
      </div>
      {showEdit && <EditPositionModal pos={pos} onClose={() => setShowEdit(false)} />}
    </>
  );
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ evt }: { evt: SniperEvent }) {
  const deleteEvt = useDeleteSniperEvent();
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/5 last:border-0">
      <div className="flex-shrink-0">
        {evt.action === "entered"
          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          : <XCircle className="w-3.5 h-3.5 text-white/25" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${evt.action === "entered" ? "text-white/90" : "text-white/40"}`}>
            {evt.symbol || mintShort(evt.mint)}
          </span>
          {evt.action === "entered"
            ? <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/20 text-[9px] px-1 py-0">ENTERED</Badge>
            : <Badge className="bg-white/5 text-white/30 border-white/10 text-[9px] px-1 py-0">SKIPPED</Badge>}
        </div>
        {evt.skipReason && <div className="text-[10px] text-white/30 mt-0.5">{evt.skipReason}</div>}
        <div className="text-[10px] text-white/20 font-mono">{mintShort(evt.mint)}</div>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-[10px] text-white/30">{timeAgo(evt.detectedAt)}</div>
        <button onClick={() => deleteEvt.mutate(evt.id)}
          className="p-1 rounded bg-white/5 hover:bg-red-500/20 text-white/25 hover:text-red-400 transition-colors" title="Delete event">
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ── History row (closed trade — rich info) ────────────────────────────────────

function HistoryRow({ pos }: { pos: SniperPosition }) {
  const [showEdit,    setShowEdit]    = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const deletePos    = useDeleteSniperPosition();
  const recalculate  = useRecalculateSniperPnl();

  const win     = pos.realizedPnlSol > 0;
  const holdMs  = pos.closedAt && pos.entryAt ? pos.closedAt - pos.entryAt : 0;
  // Weighted-average return: accounts for TP1/TP2 partial closes at different prices
  const pnlPct  = pos.sizeSol > 0 ? (pos.realizedPnlSol / pos.sizeSol) * 100 : 0;

  // Stage label
  const stageLabel = pos.tp2Hit
    ? "TP1+TP2 hit"
    : pos.tp1Hit
    ? "TP1 hit"
    : null;

  // Close reason badge
  const reasonBadge = (() => {
    const r = pos.closeReason ?? "";
    if (r.includes("Trailing")) return { label: "🎯 Trailing SL", cls: "bg-amber-500/15 text-amber-400" };
    if (r.includes("Stop Loss") || r.includes("SL")) return { label: "🛑 Stop Loss", cls: "bg-red-500/15 text-red-400" };
    if (r.includes("TP1") || r.includes("TP2")) return { label: "✅ TP Hit", cls: "bg-emerald-500/15 text-emerald-400" };
    if (r.includes("manual") || r.includes("Manual")) return { label: "⚪ Manual", cls: "bg-white/10 text-white/50" };
    return { label: r.slice(0, 18) || "Closed", cls: "bg-white/8 text-white/40" };
  })();

  return (
    <>
      <div className="px-4 py-3 border-b border-white/5 last:border-0">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <a href={solscanUrl(pos.mint)} target="_blank" rel="noreferrer"
                className="text-xs font-bold text-white/80 hover:text-white">{pos.symbol}</a>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${reasonBadge.cls}`}>
                {reasonBadge.label}
              </span>
              {stageLabel && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400 font-bold">
                  {stageLabel}
                </span>
              )}
            </div>
            <div className="text-[10px] text-white/25 font-mono mt-0.5">{mintShort(pos.mint)}</div>
          </div>
          {/* PNL */}
          <div className="text-right flex-shrink-0">
            <div className={`text-sm font-black ${win ? "text-emerald-400" : "text-red-400"}`}>
              {win ? "+" : ""}{fmt(pos.realizedPnlSol, 4)} SOL
            </div>
            <div className={`text-[11px] font-bold ${win ? "text-emerald-400/70" : "text-red-400/70"}`}>
              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* P&L Breakdown — only show if any stage data is non-zero */}
        {(pos.tp1RealizedSol !== 0 || pos.tp2RealizedSol !== 0 || pos.runnerRealizedSol !== 0) && (
          <div className="mb-2 rounded-lg bg-white/[0.03] border border-white/[0.06] px-3 py-2">
            <div className="text-[9px] font-bold text-white/35 uppercase tracking-wider mb-1.5">P&amp;L Breakdown</div>
            <div className="flex gap-3 flex-wrap">
              {pos.tp1Hit && (
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-white/30">TP1 ({Math.round((pos.sizeSol > 0 ? 40 : 0))}%)</span>
                  <span className={`text-[11px] font-bold ${pos.tp1RealizedSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.tp1RealizedSol >= 0 ? "+" : ""}{fmt(pos.tp1RealizedSol, 4)}
                  </span>
                </div>
              )}
              {pos.tp2Hit && (
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-white/30">TP2 (40%)</span>
                  <span className={`text-[11px] font-bold ${pos.tp2RealizedSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.tp2RealizedSol >= 0 ? "+" : ""}{fmt(pos.tp2RealizedSol, 4)}
                  </span>
                </div>
              )}
              {pos.runnerRealizedSol !== 0 && (
                <div className="flex flex-col items-center">
                  <span className="text-[9px] text-white/30">Runner</span>
                  <span className={`text-[11px] font-bold ${pos.runnerRealizedSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {pos.runnerRealizedSol >= 0 ? "+" : ""}{fmt(pos.runnerRealizedSol, 4)}
                  </span>
                </div>
              )}
              <div className="flex flex-col items-center ml-auto">
                <span className="text-[9px] text-white/30">Total</span>
                <span className={`text-[11px] font-bold ${pos.realizedPnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {pos.realizedPnlSol >= 0 ? "+" : ""}{fmt(pos.realizedPnlSol, 4)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Detail grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] mb-2">
          <div className="flex justify-between">
            <span className="text-white/35">Entry</span>
            <span className="text-white/70 font-mono">${fmtPrice(pos.entryPrice)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/35">Exit</span>
            <span className="text-white/70 font-mono">{pos.exitPrice ? `$${fmtPrice(pos.exitPrice)}` : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/35">Hold Time</span>
            <span className="text-white/60">{holdMs ? holdTime(holdMs) : "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-white/35">Size</span>
            <span className="text-white/60">{pos.sizeSol} SOL</span>
          </div>
          {pos.closedAt && (
            <div className="col-span-2 flex justify-between">
              <span className="text-white/35">Closed</span>
              <span className="text-white/50">{toIST(pos.closedAt)} IST</span>
            </div>
          )}
        </div>

        {/* Action row: dexscreener + edit + delete always visible */}
        <div className="flex items-center justify-between gap-2">
          <a href={`https://dexscreener.com/solana/${pos.mint}`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] text-violet-400/60 hover:text-violet-400 transition-colors">
            <ExternalLink className="w-3 h-3" /> DexScreener
          </a>
          <div className="flex gap-1.5 flex-wrap justify-end">
            {pos.exitPrice && (
              <button
                onClick={() => recalculate.mutate(pos.id)}
                disabled={recalculate.isPending}
                title="Recalculate P&L from entry/exit prices using config TP levels"
                className="flex items-center gap-1 text-[10px] text-white/40 hover:text-cyan-400 px-2 py-1 rounded bg-white/5 hover:bg-cyan-500/15 transition-colors disabled:opacity-40">
                <RefreshCw className={`w-3 h-3 ${recalculate.isPending ? "animate-spin" : ""}`} />
                {recalculate.isPending ? "…" : "Correct P&L"}
              </button>
            )}
            <button onClick={() => setShowEdit(true)}
              className="flex items-center gap-1 text-[10px] text-white/40 hover:text-amber-400 px-2 py-1 rounded bg-white/5 hover:bg-amber-500/15 transition-colors">
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button onClick={() => setConfirmDel(true)}
              className="flex items-center gap-1 text-[10px] text-white/40 hover:text-red-400 px-2 py-1 rounded bg-white/5 hover:bg-red-500/15 transition-colors">
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </div>
        </div>

        {confirmDel && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
            <span className="text-[10px] text-red-300 flex-1">Delete this trade record?</span>
            <button onClick={() => deletePos.mutate(pos.id, { onSuccess: () => setConfirmDel(false) })}
              className="text-[10px] font-bold text-red-400 hover:text-red-300 px-2 py-0.5 rounded bg-red-500/20">
              {deletePos.isPending ? "…" : "Delete"}
            </button>
            <button onClick={() => setConfirmDel(false)} className="text-[10px] text-white/40 hover:text-white">Cancel</button>
          </div>
        )}
      </div>
      {showEdit && <EditPositionModal pos={pos} onClose={() => setShowEdit(false)} />}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GraduationSniper() {
  const [showSettings, setShowSettings] = useState(false);
  const [showReset,    setShowReset]    = useState(false);
  const { data: status, isLoading: statusLoading } = useSniperStatus();
  const { data: positions = [] } = useSniperPositions();
  const { data: history = []   } = useSniperHistory();
  const { data: events = []    } = useSniperEvents();

  const config        = status?.config;
  const totalPnl      = status?.totalRealizedPnlSol ?? 0;
  const unrealizedPnl = status?.totalUnrealizedPnlSol ?? 0;
  const combinedPnl   = status?.totalCombinedPnlSol ?? 0;
  const pnlPos        = totalPnl >= 0;
  const combinedPos   = combinedPnl >= 0;
  const winRate       = status && (status.wins + status.losses) > 0
    ? Math.round((status.wins / (status.wins + status.losses)) * 100)
    : null;

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 bg-[#0d0d15]/95 backdrop-blur-md border-b border-white/8 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <Target className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-black text-white leading-none">Graduation Sniper</h1>
              <p className="text-[9px] text-white/35 leading-none mt-0.5">Pump.fun → Raydium · Paper Mode</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${
              status?.wsConnected ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
            }`}>
              {status?.wsConnected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              {status?.wsConnected ? "LIVE" : "DISCONNECTED"}
            </div>
            <button onClick={() => setShowReset(true)} title="Reset account"
              className="p-1.5 rounded-lg bg-white/5 hover:bg-red-500/15 text-white/30 hover:text-red-400 transition-colors">
              <RotateCcw className="w-4 h-4" />
            </button>
            {config && (
              <button onClick={() => setShowSettings(true)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white transition-colors">
                <Settings className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 mt-2 text-[10px] text-white/30">
          <span>{(status?.wsReconnects ?? 0) > 0 ? `${status!.wsReconnects} reconnect${status!.wsReconnects > 1 ? "s" : ""}` : "Stable connection"}</span>
          <span>·</span>
          <span>{status?.enabled ? "Sniping enabled" : "Sniping paused"}</span>
          <span>·</span>
          <span className="text-amber-400/60">TP1 +{config?.tp1Pct ?? 150}% ({config?.tp1ClosePct ?? 40}%) · TP2 +{config?.tp2Pct ?? 400}% ({config?.tp2ClosePct ?? 40}%) · Runner 20%</span>
          {!status?.wsConnected && !statusLoading && (
            <><span>·</span><span className="text-amber-400/70">Check HELIUS_API_KEY</span></>
          )}
        </div>
      </div>

      <div className="px-3 py-4 space-y-4">

        {/* ── Live Combined P&L Banner ── */}
        <div className={`rounded-xl border p-4 ${combinedPos ? "border-emerald-500/25 bg-gradient-to-br from-emerald-500/8 to-transparent" : "border-red-500/25 bg-gradient-to-br from-red-500/8 to-transparent"}`}>
          <div className="flex items-center gap-1.5 mb-3">
            <Activity className={`w-3.5 h-3.5 ${combinedPos ? "text-emerald-400" : "text-red-400"}`} />
            <span className="text-[9px] font-bold uppercase tracking-widest text-white/40">Live Portfolio P&amp;L</span>
            <span className="text-[9px] text-white/20 ml-auto">updates every 10s</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {/* Realized */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-white/35 uppercase tracking-wide">Realized</span>
              <span className={`text-sm font-black leading-none ${pnlPos ? "text-emerald-400" : "text-red-400"}`}>
                {pnlPos ? "+" : ""}{fmt(totalPnl, 4)}
              </span>
              <span className="text-[9px] text-white/25">SOL · closed + TPs</span>
            </div>
            {/* Unrealized */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-white/35 uppercase tracking-wide">Unrealized</span>
              <span className={`text-sm font-black leading-none ${unrealizedPnl >= 0 ? "text-sky-400" : "text-orange-400"}`}>
                {unrealizedPnl >= 0 ? "+" : ""}{fmt(unrealizedPnl, 4)}
              </span>
              <span className="text-[9px] text-white/25">SOL · {status?.openCount ?? 0} open pos</span>
            </div>
            {/* Combined */}
            <div className="flex flex-col gap-0.5">
              <span className="text-[9px] text-white/35 uppercase tracking-wide">Combined</span>
              <span className={`text-base font-black leading-none ${combinedPos ? "text-emerald-300" : "text-red-300"}`}>
                {combinedPos ? "+" : ""}{fmt(combinedPnl, 4)}
              </span>
              <span className="text-[9px] text-white/25">SOL · total</span>
            </div>
          </div>
          {/* Balance context */}
          <div className="mt-3 pt-2.5 border-t border-white/6 flex items-center justify-between text-[9px] text-white/30">
            <span>Starting balance: <span className="text-white/50 font-semibold">{fmt(config?.virtualBalanceSol ?? 10, 1)} SOL</span></span>
            <span>Current wallet: <span className="text-amber-400/80 font-semibold">{fmt(status?.virtualBalance ?? 0, 3)} SOL</span></span>
            <span>In positions: <span className="text-white/50 font-semibold">{fmt(status?.capitalInOpen ?? 0, 3)} SOL</span></span>
          </div>
        </div>

        {/* ── Stats grid ── */}
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="Virtual Balance" value={`${fmt(status?.virtualBalance ?? 0, 3)} SOL`} sub="paper wallet"
            icon={<Zap className="w-3.5 h-3.5 text-amber-400" />} accent="amber" />
          <StatCard label="Today's Grads" value={String(status?.graduationsToday ?? 0)} sub="detected"
            icon={<RefreshCw className="w-3.5 h-3.5 text-blue-400" />} accent="blue" />
          <StatCard label="Open Positions" value={String(status?.openCount ?? 0)} sub={`of ${config?.maxOpenPositions ?? 5} max`}
            icon={<Target className="w-3.5 h-3.5 text-violet-400" />} accent="violet" />
          <StatCard label="Realized PNL" value={`${pnlPos ? "+" : ""}${fmt(totalPnl, 4)} SOL`} sub="closed + partial TPs"
            icon={pnlPos ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
            accent={pnlPos ? "green" : "red"} valueColor={pnlPos ? "text-emerald-400" : "text-red-400"} />
          <StatCard label="Win Rate" value={winRate !== null ? `${winRate}%` : "—"} sub={`${status?.wins ?? 0}W / ${status?.losses ?? 0}L`}
            icon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />} accent="green" />
          <StatCard label="Total Trades" value={String(status?.tradesTotal ?? 0)} sub="all time"
            icon={<Clock className="w-3.5 h-3.5 text-white/40" />} accent="default" />
        </div>

        {/* ── Active positions ── */}
        <Section title="Active Positions" count={positions.length} emptyMsg="No open sniper positions">
          {positions.map((p) => <PositionRow key={p.id} pos={p} />)}
        </Section>

        {/* ── Event feed ── */}
        <Section title="Recent Graduations Detected" count={events.length} emptyMsg="Waiting for pump.fun graduations…">
          {events.slice(0, 15).map((e) => <EventRow key={e.id} evt={e} />)}
        </Section>

        {/* ── Trade history ── */}
        <SectionWithActions
          title="Trade History"
          count={history.length}
          emptyMsg="No closed sniper trades yet"
          actions={history.length > 0 ? (
            <button onClick={() => downloadSniperCsv(history)}
              className="flex items-center gap-1 text-[10px] text-white/40 hover:text-emerald-400 px-2 py-1 rounded bg-white/5 hover:bg-emerald-500/10 transition-colors">
              <Download className="w-3 h-3" /> CSV
            </button>
          ) : null}
        >
          {history.slice(0, 50).map((p) => <HistoryRow key={p.id} pos={p} />)}
        </SectionWithActions>
      </div>

      {showSettings && config && <SettingsPanel config={config} onClose={() => setShowSettings(false)} />}
      {showReset && <ResetConfirmModal onClose={() => setShowReset(false)} />}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon, accent, valueColor }: {
  label: string; value: string; sub: string; icon: React.ReactNode;
  accent: "amber" | "blue" | "violet" | "green" | "red" | "default";
  valueColor?: string;
}) {
  const bg: Record<string, string> = {
    amber:   "from-amber-500/10 to-transparent",
    blue:    "from-blue-500/10 to-transparent",
    violet:  "from-violet-500/10 to-transparent",
    green:   "from-emerald-500/10 to-transparent",
    red:     "from-red-500/10 to-transparent",
    default: "from-white/5 to-transparent",
  };
  return (
    <div className={`rounded-xl bg-gradient-to-br ${bg[accent] ?? bg.default} border border-white/8 p-3`}>
      <div className="flex items-center gap-1 mb-1.5">{icon}
        <span className="text-[9px] text-white/35 font-semibold uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-sm font-black leading-none ${valueColor ?? "text-white"}`}>{value}</div>
      <div className="text-[9px] text-white/30 mt-0.5">{sub}</div>
    </div>
  );
}

function Section({ title, count, emptyMsg, children }: {
  title: string; count: number; emptyMsg: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-[#0d0d18] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/8 bg-white/2">
        <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">{title}</span>
        {count > 0 && (
          <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-[9px] px-1.5 py-0">{count}</Badge>
        )}
      </div>
      {count === 0
        ? <div className="px-4 py-6 text-center text-xs text-white/20">{emptyMsg}</div>
        : children}
    </div>
  );
}

function SectionWithActions({ title, count, emptyMsg, children, actions }: {
  title: string; count: number; emptyMsg: string; children: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-[#0d0d18] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/8 bg-white/2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-white/70 uppercase tracking-wider">{title}</span>
          {count > 0 && (
            <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-[9px] px-1.5 py-0">{count}</Badge>
          )}
        </div>
        {actions}
      </div>
      {count === 0
        ? <div className="px-4 py-6 text-center text-xs text-white/20">{emptyMsg}</div>
        : children}
    </div>
  );
}
