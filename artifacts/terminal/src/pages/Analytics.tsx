import { useState } from "react";
import {
  useAnalytics, useClosedPositions, useLossJournal,
  useDeleteJournalEntry, useClearJournal, useEditClosedTrade,
  useAutoTraderStatus, usePumpfunHistory,
} from "@/lib/api";
import type { LossInsights, LossJournalEntry, FilterSuggestion, MarketHealthStatus } from "@/lib/types";
import {
  TrendingUp, TrendingDown, Award, Target, Clock, BarChart2,
  BookOpen, AlertTriangle, Lightbulb, ChevronDown, ChevronUp,
  Trash2, Pencil, Trophy, ThumbsDown, ThumbsUp, Activity, Rocket,
} from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";

function fmt(v: number | undefined, d = 4) {
  if (v === undefined || v === null) return "—";
  return (v >= 0 ? "+" : "") + Math.abs(v).toFixed(d);
}
function fmtMcap(mcap: number): string {
  if (!mcap) return "—";
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}
function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}
function holdLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const WIN_TAGS = ["quick_tp", "strong_win", "high_score_win", "good_liquidity_win", "momentum_win"];
const TAG_LABELS: Record<string, { label: string; color: string }> = {
  rug_speed: { label: "Instant Rug <5m", color: "bg-red-500/20 text-red-400 border-red-500/30" },
  fast_rug: { label: "Fast Rug 5–15m", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  slow_dump: { label: "Slow Dump 15–60m", color: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  no_ai_recovery: { label: "Long Bleed >60m", color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  borderline_score: { label: "Borderline Score", color: "bg-violet-500/20 text-violet-400 border-violet-500/30" },
  borderline_conf: { label: "Low Confidence", color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  thin_liquidity: { label: "Thin Liquidity", color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  micro_cap: { label: "Micro Cap", color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  large_cap: { label: "Already Pumped", color: "bg-pink-500/20 text-pink-400 border-pink-500/30" },
  high_fdv_risk: { label: "FDV Risk", color: "bg-rose-500/20 text-rose-400 border-rose-500/30" },
  fake_price: { label: "Manual Note", color: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
  quick_tp: { label: "Quick TP <30m", color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
  strong_win: { label: "Strong Gain >15%", color: "bg-green-500/20 text-green-400 border-green-500/30" },
  high_score_win: { label: "High AI Score", color: "bg-violet-500/20 text-violet-300 border-violet-500/30" },
  good_liquidity_win: { label: "Deep Liquidity", color: "bg-teal-500/20 text-teal-400 border-teal-500/30" },
  momentum_win: { label: "Momentum Win", color: "bg-sky-500/20 text-sky-400 border-sky-500/30" },
};

function TagBadge({ tag }: { tag: string }) {
  const meta = TAG_LABELS[tag] ?? { label: tag, color: "bg-white/10 text-white/50 border-white/10" };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function SuggestionCard({ s }: { s: FilterSuggestion }) {
  const priorityColor = s.priority === "high" ? "border-red-500/30 bg-red-500/5"
    : s.priority === "medium" ? "border-amber-500/30 bg-amber-500/5"
    : "border-white/8 bg-white/3";
  const priorityText = s.priority === "high" ? "text-red-400" : s.priority === "medium" ? "text-amber-400" : "text-white/30";
  return (
    <div className={`rounded-xl border p-3.5 ${priorityColor}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Lightbulb className={`w-3.5 h-3.5 shrink-0 ${priorityText}`} />
          <span className="text-white font-bold text-xs">{s.filter}</span>
        </div>
        <span className={`text-[9px] font-black uppercase tracking-wide ${priorityText}`}>{s.priority}</span>
      </div>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-white/30 line-through">{s.currentValue}</span>
        <span className="text-white/20">→</span>
        <span className="text-emerald-400 font-bold">{s.suggestedValue}</span>
        <span className="ml-auto text-white/25 text-[9px]">{s.confidence}% conf</span>
      </div>
      <p className="text-white/40 text-[11px] leading-relaxed">{s.reason}</p>
    </div>
  );
}

function WinRateRing({ winRate }: { winRate: number }) {
  const r = 36;
  const circ = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, winRate / 100)) * circ;
  const color = winRate >= 60 ? "#10b981" : winRate >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" style={{ transform: "rotate(-90deg)" }}>
      <circle cx="42" cy="42" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="7" />
      <circle cx="42" cy="42" r={r} fill="none" stroke={color} strokeWidth="7"
        strokeDasharray={circ} strokeDashoffset={circ - dash} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.8s ease" }}
      />
    </svg>
  );
}

function MarketHealthCard({ health }: { health: MarketHealthStatus }) {
  const { state, passCount, conditions } = health;
  const stateColor = state === "ACTIVE" ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-400"
    : state === "NEUTRAL" ? "border-amber-500/25 bg-amber-500/5 text-amber-400"
    : "border-red-500/25 bg-red-500/5 text-red-400";
  const dotColor = state === "ACTIVE" ? "bg-emerald-400" : state === "NEUTRAL" ? "bg-amber-400" : "bg-red-400";
  const stateLabel = state === "ACTIVE" ? "Trading Normally" : state === "NEUTRAL" ? "Filters Tightened" : "New Entries Paused";
  return (
    <div className={`rounded-xl border p-3.5 ${stateColor}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotColor} animate-pulse`} />
          <span className="font-bold text-xs uppercase tracking-wider">Market Health</span>
        </div>
        <div className="text-right">
          <span className="font-black text-sm">{state}</span>
          <p className="text-[9px] opacity-60">{stateLabel}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          { label: "1h Up", val: `${conditions.positiveTokensCount}/20`, pass: conditions.positiveTokensPassed },
          { label: "Buy Ratio", val: `${(conditions.avgBuyRatio * 100).toFixed(0)}%`, pass: conditions.avgBuyRatioPassed },
          { label: "New 2h", val: `${conditions.recentPairsCount}`, pass: conditions.recentPairsPassed },
        ].map(({ label, val, pass }) => (
          <div key={label} className={`rounded-lg p-2 text-center ${pass ? "bg-emerald-500/10" : "bg-white/3"}`}>
            <div className={`font-black text-sm ${pass ? "" : "text-white/30"}`}>{val}</div>
            <div className={`text-[9px] ${pass ? "opacity-70" : "text-white/25"}`}>{label} {pass ? "✓" : "✗"}</div>
          </div>
        ))}
      </div>
      <p className="text-[9px] opacity-30 mt-2 text-right">{passCount}/3 met · refreshes every 30m</p>
    </div>
  );
}

function NoteModal({ symbol, closedAt, note: initialNote, positionId, onSave, onClose, isPending }: {
  symbol: string; closedAt: string; note: string; positionId: string;
  onSave: (id: string, note: string) => void; onClose: () => void; isPending: boolean;
}) {
  const [note, setNote] = useState(initialNote);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0d0d18] border border-amber-500/30 rounded-2xl p-5 w-full max-w-sm space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Pencil className="w-5 h-5 text-amber-400" />
          <h2 className="text-white font-bold text-base">Edit Note — ${symbol}</h2>
        </div>
        <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Note…" autoFocus
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-amber-500/40" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl bg-white/8 text-white/50 text-sm font-semibold">Cancel</button>
          <button onClick={() => onSave(positionId, note)} disabled={isPending}
            className="flex-1 py-2.5 rounded-xl bg-amber-500/20 border border-amber-500/30 text-amber-400 text-sm font-bold disabled:opacity-50">
            {isPending ? "Saving…" : "Save Note"}
          </button>
        </div>
      </div>
    </div>
  );
}

function JournalCard({ entry, onDelete, onEdit, isDeleting }: {
  entry: LossJournalEntry; onDelete: (id: string) => void;
  onEdit: (entry: LossJournalEntry) => void; isDeleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isWin = entry.isWin;
  return (
    <div className={`bg-[#0d0d18] border rounded-xl p-3.5 ${isWin ? "border-emerald-500/15" : "border-red-500/10"}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {isWin ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
          <span className="font-black text-white text-sm">${entry.symbol}</span>
          <span className="text-[9px] text-white/25">⏱ {holdLabel(entry.holdTimeMs)}</span>
        </div>
        <div className="text-right">
          <p className={`font-black text-sm ${isWin ? "text-emerald-400" : "text-red-400"}`}>
            {isWin ? "+" : ""}{entry.pnlSol.toFixed(4)} SOL
          </p>
          <p className={`text-[9px] ${isWin ? "text-emerald-400/50" : "text-red-400/50"}`}>
            {isWin ? "+" : ""}{entry.pnlPercent.toFixed(1)}%
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-2">
        {entry.tags.map(tag => <TagBadge key={tag} tag={tag} />)}
      </div>
      <div className="grid grid-cols-3 gap-2 text-[9px] mb-2 text-white/35">
        <div>Score <span className="text-white/60 font-bold">{entry.aiScore}</span></div>
        <div>Conf <span className="text-white/60 font-bold">{entry.confidence}%</span></div>
        <div>Liq <span className="text-white/60 font-bold">{fmtMcap(entry.entryLiquidityUsd)}</span></div>
      </div>
      {entry.warnings.length > 0 && (
        <button onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-[9px] text-white/25 hover:text-white/50 mt-1 transition-colors">
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Hide" : "Show"} details
        </button>
      )}
      {expanded && (
        <div className="mt-2 space-y-1">
          {entry.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[9px] text-white/40">
              {isWin ? <ThumbsUp className="w-3 h-3 text-emerald-400/50 shrink-0 mt-0.5" /> : <AlertTriangle className="w-3 h-3 text-amber-400/50 shrink-0 mt-0.5" />}
              <span>{w}</span>
            </div>
          ))}
          {entry.note && (
            <div className="flex items-start gap-1.5 text-[9px] text-violet-400/60 mt-1">
              <BookOpen className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{entry.note}</span>
            </div>
          )}
          <div className="text-[8px] text-white/15 mt-1">{toIST(entry.closedAt)}</div>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-white/5">
        <button onClick={() => onEdit(entry)} className="flex items-center gap-1 text-[9px] text-amber-400/50 hover:text-amber-400 transition-colors px-1.5 py-1 rounded">
          <Pencil className="w-3 h-3" /> Note
        </button>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] text-white/30">Remove?</span>
            <button onClick={() => { onDelete(entry.positionId); setConfirmDelete(false); }} disabled={isDeleting}
              className="text-[9px] font-bold px-2 py-1 rounded-md bg-red-500/20 text-red-400 border border-red-500/30">Yes</button>
            <button onClick={() => setConfirmDelete(false)} className="text-[9px] font-bold px-2 py-1 rounded-md bg-white/8 text-white/40">No</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 text-[9px] text-white/20 hover:text-red-400 transition-colors px-1.5 py-1 rounded">
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

type AnalysisTab = "overview" | "journal" | "suggestions" | "trades";

export default function Analytics() {
  const { data: analytics } = useAnalytics();
  const { data: closedPositions = [] } = useClosedPositions();
  const { data: pfHistory = [] } = usePumpfunHistory();
  const { data: lossData } = useLossJournal();
  const { data: botStatus } = useAutoTraderStatus();
  const deleteEntry = useDeleteJournalEntry();
  const clearJournal = useClearJournal();
  const editClosedTrade = useEditClosedTrade();

  const [tab, setTab] = useState<AnalysisTab>("overview");
  const [journalFilter, setJournalFilter] = useState<"all" | "wins" | "losses">("all");
  const [noteModal, setNoteModal] = useState<{ entry: LossJournalEntry } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const winRate = analytics?.winRate ?? 0;

  const chartData = closedPositions.slice(-20).map((p) => ({
    name: p.symbol,
    pnl: p.pnlSol ?? 0,
  }));

  const journalEntries = lossData
    ? (journalFilter === "wins" ? lossData.recentWins
      : journalFilter === "losses" ? lossData.recentLosses
      : lossData.allEntries)
    : [];

  const winTagRows = lossData && lossData.totalWins > 0
    ? Object.entries(lossData.winTagPercentage ?? lossData.tagPercentage)
      .filter(([tag]) => WIN_TAGS.includes(tag)).sort((a, b) => b[1] - a[1])
      .map(([tag, pct]) => ({ tag, label: TAG_LABELS[tag]?.label ?? tag, pct }))
    : [];

  const lossTagRows = lossData && lossData.totalLosses > 0
    ? Object.entries(lossData.lossTagPercentage ?? lossData.tagPercentage)
      .filter(([tag]) => !WIN_TAGS.includes(tag)).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([tag, pct]) => ({ tag, label: TAG_LABELS[tag]?.label ?? tag, pct }))
    : [];

  return (
    <div className="px-3 py-4 space-y-4 pb-6">

      {/* ── Header ── */}
      <div className="flex items-center gap-2">
        <BarChart2 className="w-4 h-4 text-violet-400" />
        <h2 className="text-base font-black text-white">Trade Analysis</h2>
      </div>

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 bg-white/5 p-1 rounded-xl">
        {([
          { key: "overview" as AnalysisTab, label: "Overview" },
          { key: "journal" as AnalysisTab, label: `Journal (${lossData?.totalTrades ?? 0})` },
          { key: "suggestions" as AnalysisTab, label: "Tips" },
          { key: "trades" as AnalysisTab, label: `Trades (${closedPositions.length + pfHistory.length})` },
        ]).map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 py-2 rounded-lg text-[9px] font-bold transition-all ${
              tab === t.key ? "bg-violet-500/25 text-violet-300" : "text-white/30"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && (
        <div className="space-y-4">
          {/* Win Rate Ring */}
          {analytics && (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4 flex items-center gap-4">
              <div className="relative">
                <WinRateRing winRate={winRate} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={`text-xl font-black ${winRate >= 60 ? "text-emerald-400" : winRate >= 40 ? "text-amber-400" : "text-red-400"}`}>
                    {winRate.toFixed(0)}%
                  </span>
                  <span className="text-[9px] text-white/30">win rate</span>
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 gap-2">
                {[
                  { label: "Total Trades", val: String(analytics.totalTrades), cls: "text-white" },
                  { label: "Wins", val: String(analytics.winCount), cls: "text-emerald-400" },
                  { label: "Losses", val: String(analytics.lossCount), cls: "text-red-400" },
                  { label: "Avg Hold", val: analytics.avgHoldTimeMinutes ? `${analytics.avgHoldTimeMinutes.toFixed(0)}m` : "—", cls: "text-white/70" },
                ].map((s) => (
                  <div key={s.label} className="bg-white/4 rounded-lg p-2 text-center">
                    <p className={`text-sm font-black ${s.cls}`}>{s.val}</p>
                    <p className="text-[9px] text-white/25 mt-0.5">{s.label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* P&L Stats */}
          {analytics && (
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { label: "Total P&L", val: fmt(analytics.totalPnlSol) + " SOL", cls: (analytics.totalPnlSol ?? 0) >= 0 ? "text-emerald-400" : "text-red-400" },
                { label: "Avg Win", val: fmt(analytics.avgWinSol) + " SOL", cls: "text-emerald-400" },
                { label: "Avg Loss", val: fmt(analytics.avgLossSol) + " SOL", cls: "text-red-400" },
                { label: "Best Trade", val: fmt(analytics.bestTradeSol) + " SOL", cls: "text-violet-400" },
              ].map((s) => (
                <div key={s.label} className="bg-[#0d0d18] border border-white/6 rounded-xl p-3.5">
                  <p className="text-[10px] text-white/35 mb-1">{s.label}</p>
                  <p className={`text-base font-black ${s.cls}`}>{s.val}</p>
                </div>
              ))}
            </div>
          )}

          {/* Recent trades chart */}
          {chartData.length > 0 && (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
              <p className="text-[10px] font-bold text-white/40 uppercase tracking-wider mb-3">Last {chartData.length} Trades</p>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <XAxis dataKey="name" tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 8 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "rgba(255,255,255,0.2)", fontSize: 8 }} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: "#0d0d18", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 10 }}
                      formatter={(val: number) => [`${val >= 0 ? "+" : ""}${val.toFixed(4)} SOL`, "P&L"]}
                    />
                    <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl >= 0 ? "#10b981" : "#ef4444"} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Market Health */}
          {analytics?.marketHealth && <MarketHealthCard health={analytics.marketHealth} />}

          {/* Win vs Loss patterns */}
          {lossData && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-gradient-to-br from-emerald-900/25 to-[#0d0d18] border border-emerald-500/15 p-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <Trophy className="w-3.5 h-3.5 text-emerald-400" />
                  <p className="text-[10px] font-bold text-emerald-400/60 uppercase tracking-widest">Wins</p>
                </div>
                <p className="text-3xl font-black text-white">{lossData.totalWins}</p>
                <p className="text-emerald-400 text-[11px] mt-0.5 font-bold">+{lossData.totalWinSol.toFixed(4)} SOL</p>
                <p className="text-white/25 text-[9px] mt-1">avg hold {lossData.avgWinHoldMinutes.toFixed(0)}m</p>
              </div>
              <div className="rounded-2xl bg-gradient-to-br from-red-900/25 to-[#0d0d18] border border-red-500/15 p-4">
                <div className="flex items-center gap-1.5 mb-1">
                  <ThumbsDown className="w-3.5 h-3.5 text-red-400" />
                  <p className="text-[10px] font-bold text-red-400/60 uppercase tracking-widest">Losses</p>
                </div>
                <p className="text-3xl font-black text-white">{lossData.totalLosses}</p>
                <p className="text-red-400 text-[11px] mt-0.5 font-bold">{lossData.totalLossSol.toFixed(4)} SOL</p>
                <p className="text-white/25 text-[9px] mt-1">avg hold {lossData.avgLossHoldMinutes.toFixed(0)}m</p>
              </div>
            </div>
          )}

          {winTagRows.length > 0 && (
            <div className="bg-[#0d0d18] border border-emerald-500/10 rounded-xl p-4">
              <p className="text-[10px] font-bold text-emerald-400/50 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <ThumbsUp className="w-3.5 h-3.5" /> Win Patterns
              </p>
              <div className="space-y-2">
                {winTagRows.map(({ tag, label, pct }) => (
                  <div key={tag}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-white/50 text-[11px]">{label}</span>
                      <span className="text-emerald-400/60 text-[9px] font-bold">{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lossTagRows.length > 0 && (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
              <p className="text-[10px] font-bold text-red-400/50 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Loss Patterns
              </p>
              <div className="space-y-2">
                {lossTagRows.map(({ tag, label, pct }) => (
                  <div key={tag}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-white/50 text-[11px]">{label}</span>
                      <span className="text-red-400/60 text-[9px] font-bold">{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-red-500 to-orange-400" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Journal Tab ── */}
      {tab === "journal" && (
        <div className="space-y-3">
          {!lossData || lossData.totalTrades === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <BookOpen className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-white/30 text-sm">No trades recorded yet</p>
              <p className="text-white/15 text-[11px] mt-1">Every trade will be automatically analyzed here.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="flex gap-1.5">
                  {(["all", "wins", "losses"] as const).map((f) => (
                    <button key={f} onClick={() => setJournalFilter(f)}
                      className={`px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                        journalFilter === f ? "bg-violet-500/25 text-violet-300" : "bg-white/5 text-white/30"
                      }`}>
                      {f === "all" ? `All (${lossData.totalTrades})` : f === "wins" ? `Wins (${lossData.totalWins})` : `Losses (${lossData.totalLosses})`}
                    </button>
                  ))}
                </div>
                {confirmClear ? (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => { clearJournal.mutate(); setConfirmClear(false); }}
                      className="text-[10px] px-2 py-1 rounded-md bg-red-500/20 text-red-400 font-bold border border-red-500/30">Clear</button>
                    <button onClick={() => setConfirmClear(false)} className="text-[10px] px-2 py-1 rounded-md bg-white/8 text-white/40">No</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmClear(true)} className="text-[9px] text-white/20 hover:text-red-400 transition-colors px-2 py-1 rounded">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="space-y-2.5">
                {journalEntries.map((entry) => (
                  <JournalCard key={entry.positionId} entry={entry}
                    onDelete={(id) => deleteEntry.mutate(id)}
                    onEdit={(e) => setNoteModal({ entry: e })}
                    isDeleting={deleteEntry.isPending}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Suggestions Tab ── */}
      {tab === "suggestions" && (
        <div className="space-y-3">
          {(!lossData?.filterSuggestions || lossData.filterSuggestions.length === 0) ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <Lightbulb className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-white/30 text-sm">No suggestions yet</p>
              <p className="text-white/15 text-[11px] mt-1">More trades are needed to generate filter recommendations.</p>
            </div>
          ) : (
            lossData.filterSuggestions.map((s, i) => <SuggestionCard key={i} s={s} />)
          )}
        </div>
      )}

      {/* ── Trades Tab ── */}
      {tab === "trades" && (
        <div className="space-y-2">
          {closedPositions.length === 0 && pfHistory.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <Activity className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-white/30 text-sm">No closed trades yet</p>
            </div>
          ) : null}

          {/* Paper trading closed trades */}
          {closedPositions.map((p) => {
            const pnl = p.pnlSol ?? 0;
            const pnlPct = p.pnlPercent ?? 0;
            const isWin = pnl >= 0;
            return (
              <div key={p.positionId} className={`bg-[#0d0d18] border rounded-xl p-3.5 ${isWin ? "border-emerald-500/15" : "border-red-500/10"}`}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black text-white">${p.symbol}</span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                        {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                      </span>
                      {p.tradeSource === "rss" && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-400">TG</span>
                      )}
                    </div>
                    <p className="text-[9px] text-white/25 mt-0.5">{p.closeReason ?? "manual"} · {p.closedAt ? toIST(p.closedAt) : "—"}</p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                      {isWin ? "+" : ""}{Math.abs(pnl).toFixed(4)} SOL
                    </p>
                    {p.holdTimeMs && (
                      <p className="text-[9px] text-white/25 flex items-center gap-1 justify-end mt-0.5">
                        <Clock className="w-2.5 h-2.5" />
                        {holdLabel(p.holdTimeMs)}
                      </p>
                    )}
                  </div>
                </div>
                {(p.llmProvider && p.llmProvider !== "none") && (
                  <div className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                    p.llmVerdict === "TRADE" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    : p.llmVerdict === "RISKY" ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                    : "bg-red-500/10 text-red-400 border-red-500/20"
                  }`}>
                    {p.llmProvider.toUpperCase()} · {p.llmVerdict}
                    {p.llmConfidence !== undefined && <span className="opacity-50"> · {p.llmConfidence}%</span>}
                  </div>
                )}
              </div>
            );
          })}

          {/* Pump.fun closed trades */}
          {pfHistory.length > 0 && (
            <>
              {closedPositions.length > 0 && (
                <div className="flex items-center gap-2 pt-1">
                  <div className="h-px flex-1 bg-white/6" />
                  <span className="text-[9px] text-violet-400/50 font-bold uppercase tracking-wider flex items-center gap-1">
                    <Rocket className="w-2.5 h-2.5" /> Pump.fun Trades
                  </span>
                  <div className="h-px flex-1 bg-white/6" />
                </div>
              )}
              {pfHistory.map((p) => {
                const pnl = p.realizedPnlSol;
                const isWin = pnl >= 0;
                const pnlPct = p.entryPrice > 0 && p.exitPrice ? ((p.exitPrice / p.entryPrice) - 1) * 100 : 0;
                return (
                  <div key={p.id} className={`bg-[#0d0d18] border rounded-xl p-3.5 ${isWin ? "border-emerald-500/15" : "border-red-500/10"}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <Rocket className="w-3 h-3 text-violet-400/60" />
                          <span className="text-sm font-black text-white">${p.symbol}</span>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                            {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                          </span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-violet-500/15 text-violet-400">PF</span>
                        </div>
                        <p className="text-[9px] text-white/25 mt-0.5">
                          {p.closeReason ?? "closed"} · {p.closedAt ? new Date(p.closedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) : "—"}
                        </p>
                      </div>
                      <p className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{Math.abs(pnl).toFixed(4)} SOL
                      </p>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* Note modal */}
      {noteModal && (
        <NoteModal
          symbol={noteModal.entry.symbol}
          closedAt={noteModal.entry.closedAt}
          note={noteModal.entry.note ?? ""}
          positionId={noteModal.entry.positionId}
          onSave={(id, note) => editClosedTrade.mutate({ positionId: id, note }, { onSuccess: () => setNoteModal(null) })}
          onClose={() => setNoteModal(null)}
          isPending={editClosedTrade.isPending}
        />
      )}
    </div>
  );
}
