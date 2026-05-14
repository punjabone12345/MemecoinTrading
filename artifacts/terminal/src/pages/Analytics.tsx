import { useState } from "react";
import { useAnalytics, useClosedPositions, useLossJournal } from "@/lib/api";
import { LossInsights, LossJournalEntry, FilterSuggestion } from "@/lib/types";
import { TrendingUp, TrendingDown, Award, Target, Clock, BarChart2, CheckCircle2, XCircle, MinusCircle, BookOpen, AlertTriangle, Lightbulb, Tag, ChevronDown, ChevronUp } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";

function fmt(v: number | undefined, d = 4) {
  if (v === undefined || v === null) return "—";
  return (v >= 0 ? "+" : "") + Math.abs(v).toFixed(d);
}

function formatPrice(price: number): string {
  if (!price) return "—";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

function formatMcap(mcap: number): string {
  if (!mcap) return "—";
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function holdLabel(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const TAG_LABELS: Record<string, { label: string; color: string }> = {
  rug_speed:         { label: "Instant Rug (<5m)",    color: "bg-red-500/20 text-red-400 border-red-500/30" },
  fast_rug:          { label: "Fast Rug (5–15m)",     color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  slow_dump:         { label: "Slow Dump (15–60m)",   color: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  no_ai_recovery:    { label: "Stalled (>60m)",       color: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" },
  borderline_score:  { label: "Borderline AI Score",  color: "bg-violet-500/20 text-violet-400 border-violet-500/30" },
  borderline_conf:   { label: "Borderline Confidence",color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  thin_liquidity:    { label: "Thin Liquidity",       color: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  micro_cap:         { label: "Micro Cap",            color: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30" },
  large_cap:         { label: "Already Pumped",       color: "bg-pink-500/20 text-pink-400 border-pink-500/30" },
  high_fdv_risk:     { label: "Wide TP / FDV Risk",   color: "bg-rose-500/20 text-rose-400 border-rose-500/30" },
  fake_price:        { label: "Fake Price",           color: "bg-gray-500/20 text-gray-400 border-gray-500/30" },
};

// ─── Sub-components ─────────────────────────────────────────────────────────

function TagBadge({ tag }: { tag: string }) {
  const meta = TAG_LABELS[tag] ?? { label: tag, color: "bg-white/10 text-white/50 border-white/10" };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-bold border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function SuggestionCard({ s }: { s: FilterSuggestion }) {
  const priorityColor = s.priority === "high"
    ? "border-red-500/30 bg-red-500/5"
    : s.priority === "medium"
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-white/10 bg-white/3";
  const priorityText = s.priority === "high"
    ? "text-red-400"
    : s.priority === "medium"
      ? "text-amber-400"
      : "text-white/40";

  return (
    <div className={`rounded-xl border p-3.5 ${priorityColor}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Lightbulb className={`w-3.5 h-3.5 shrink-0 ${priorityText}`} />
          <span className="text-white font-bold text-xs">{s.filter}</span>
        </div>
        <span className={`text-[10px] font-black uppercase tracking-wide ${priorityText}`}>{s.priority}</span>
      </div>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-white/30 line-through">{s.currentValue}</span>
        <span className="text-white/20">→</span>
        <span className="text-emerald-400 font-bold">{s.suggestedValue}</span>
        <span className="ml-auto text-white/30 text-[10px]">{s.confidence}% confidence</span>
      </div>
      <p className="text-white/50 text-[11px] leading-relaxed">{s.reason}</p>
    </div>
  );
}

function LossEntryCard({ entry }: { entry: LossJournalEntry }) {
  const [expanded, setExpanded] = useState(false);
  const holdMin = Math.round(entry.holdTimeMs / 60_000);

  return (
    <div className="bg-[#0d0d18] border border-red-500/10 rounded-xl p-3.5">
      <div className="flex items-start justify-between mb-2">
        <div>
          <span className="font-black text-white text-sm">${entry.symbol}</span>
          <span className="ml-2 text-[10px] text-white/30">⏱ {holdLabel(entry.holdTimeMs)}</span>
        </div>
        <div className="text-right">
          <p className="font-black text-sm text-red-400">{entry.pnlSol.toFixed(4)} SOL</p>
          <p className="text-[10px] text-red-400/60">{entry.pnlPercent.toFixed(1)}%</p>
        </div>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1 mb-2">
        {entry.tags.map(tag => <TagBadge key={tag} tag={tag} />)}
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-3 gap-2 text-[10px] mb-2 text-white/40">
        <div>AI Score <span className="text-white/70 font-bold">{entry.aiScore}</span></div>
        <div>Confidence <span className="text-white/70 font-bold">{entry.confidence}%</span></div>
        <div>Liquidity <span className="text-white/70 font-bold">{formatMcap(entry.entryLiquidityUsd)}</span></div>
      </div>

      {/* Expand warnings */}
      {entry.warnings.length > 0 && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 mt-1 transition-colors"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Hide" : "Show"} pattern details
        </button>
      )}

      {expanded && (
        <div className="mt-2 space-y-1">
          {entry.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px] text-white/50">
              <AlertTriangle className="w-3 h-3 text-amber-400/60 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
          {entry.note && (
            <div className="flex items-start gap-1.5 text-[10px] text-violet-400/70 mt-1">
              <BookOpen className="w-3 h-3 shrink-0 mt-0.5" />
              <span>Note: {entry.note}</span>
            </div>
          )}
          <div className="text-[9px] text-white/20 mt-1">{toIST(entry.closedAt)}</div>
        </div>
      )}
    </div>
  );
}

function LossJournalTab({ data }: { data: LossInsights }) {
  if (data.totalLosses === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <BookOpen className="w-10 h-10 text-white/15 mx-auto mb-3" />
        <p className="text-white/40 text-sm font-semibold">No losses recorded yet</p>
        <p className="text-white/20 text-xs mt-1">Every losing trade will be automatically analyzed and logged here so the bot can learn from patterns.</p>
      </div>
    );
  }

  // Build sorted tag frequency for the pattern bar chart
  const tagRows = Object.entries(data.tagPercentage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, pct]) => ({
      tag,
      label: TAG_LABELS[tag]?.label ?? tag,
      pct,
    }));

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Summary Hero */}
      <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-red-900/30 to-[#0d0d18] border border-red-500/20 p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest font-semibold">Total Losses</p>
            <p className="text-4xl font-black text-white mt-1">{data.totalLosses}</p>
            <p className="text-red-400 text-xs mt-1 font-bold">{data.totalLossSol.toFixed(4)} SOL lost total</p>
          </div>
          <div className="w-14 h-14 rounded-2xl bg-red-500/15 flex items-center justify-center">
            <BookOpen className="w-7 h-7 text-red-400" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-white/5">
          <div>
            <p className="text-white/30 text-[10px]">Avg Loss</p>
            <p className="text-red-400 font-bold text-sm">{data.avgLossSol.toFixed(4)} SOL</p>
          </div>
          <div>
            <p className="text-white/30 text-[10px]">Avg Hold</p>
            <p className="text-white font-bold text-sm">{data.avgHoldMinutes.toFixed(0)}m</p>
          </div>
          <div>
            <p className="text-white/30 text-[10px]">Avg AI Score</p>
            <p className="text-violet-400 font-bold text-sm">{data.avgAiScore.toFixed(0)}</p>
          </div>
        </div>
      </div>

      {/* Hold-time breakdown */}
      <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
        <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">How Fast Did They Rug?</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "Instant Rug", sub: "< 5 min", count: data.instantRugs, color: "text-red-400", bar: "bg-red-500" },
            { label: "Fast Dump",   sub: "5–15 min", count: data.fastRugs,   color: "text-orange-400", bar: "bg-orange-500" },
            { label: "Slow Drain",  sub: "15–60 min", count: data.slowDumps, color: "text-amber-400", bar: "bg-amber-500" },
            { label: "Long Bleed",  sub: "> 60 min",  count: data.longLosses,color: "text-yellow-400", bar: "bg-yellow-500" },
          ].map(({ label, sub, count, color, bar }) => {
            const pct = data.totalLosses > 0 ? (count / data.totalLosses) * 100 : 0;
            return (
              <div key={label} className="bg-white/3 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/50 text-[10px]">{label}</span>
                  <span className={`font-black text-sm ${color}`}>{count}</span>
                </div>
                <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="text-white/20 text-[9px] mt-1">{sub} · {pct.toFixed(0)}%</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pattern frequency */}
      {tagRows.length > 0 && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">
            <Tag className="w-3.5 h-3.5 inline mr-1.5 mb-0.5" />
            Loss Pattern Breakdown
          </p>
          <div className="space-y-2">
            {tagRows.map(({ tag, label, pct }) => (
              <div key={tag}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-white/60 text-[11px]">{label}</span>
                  <span className="text-white/50 text-[10px] font-bold">{pct}%</span>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-red-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter Suggestions */}
      {data.suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-white/40 uppercase tracking-wider px-0.5">
            <Lightbulb className="w-3.5 h-3.5 inline mr-1.5 mb-0.5 text-amber-400" />
            AI Filter Recommendations
          </p>
          {data.suggestions.map((s, i) => (
            <SuggestionCard key={i} s={s} />
          ))}
        </div>
      )}

      {/* No suggestions yet */}
      {data.suggestions.length === 0 && data.totalLosses > 0 && data.totalLosses < 3 && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4 text-center">
          <Lightbulb className="w-6 h-6 text-white/20 mx-auto mb-2" />
          <p className="text-white/30 text-xs">Collecting data… recommendations appear after 3+ losses</p>
        </div>
      )}

      {/* Recent Loss Entries */}
      {data.recentLosses.length > 0 && (
        <div>
          <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-2">Recent Losing Trades</p>
          <div className="space-y-2">
            {data.recentLosses.map(entry => (
              <LossEntryCard key={entry.positionId} entry={entry} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Analytics component ───────────────────────────────────────────────

export default function Analytics() {
  const [tab, setTab] = useState<"overview" | "journal">("overview");
  const { data: analytics } = useAnalytics();
  const { data: closedTrades = [] } = useClosedPositions();
  const { data: lossInsights } = useLossJournal();

  if (!analytics) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const pnlData = Object.entries(analytics.calendarPnl || {})
    .slice(-14)
    .map(([date, pnl]) => ({ date: date.slice(5), pnl }));

  const winRate = analytics.winRate.toFixed(1);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-white/8 px-4 pt-3 shrink-0">
        <button
          onClick={() => setTab("overview")}
          className={`flex items-center gap-1.5 pb-2.5 px-1 mr-5 text-xs font-bold border-b-2 transition-colors ${
            tab === "overview"
              ? "border-violet-500 text-violet-400"
              : "border-transparent text-white/30 hover:text-white/60"
          }`}
        >
          <BarChart2 className="w-3.5 h-3.5" />
          Overview
        </button>
        <button
          onClick={() => setTab("journal")}
          className={`flex items-center gap-1.5 pb-2.5 px-1 text-xs font-bold border-b-2 transition-colors relative ${
            tab === "journal"
              ? "border-red-500 text-red-400"
              : "border-transparent text-white/30 hover:text-white/60"
          }`}
        >
          <BookOpen className="w-3.5 h-3.5" />
          Loss Journal
          {(lossInsights?.totalLosses ?? 0) > 0 && (
            <span className="ml-1 bg-red-500/20 text-red-400 text-[9px] font-black px-1.5 py-0.5 rounded-full border border-red-500/30">
              {lossInsights!.totalLosses}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "overview" && (
          <div className="px-4 py-4 space-y-4">
            {/* Win Rate Hero */}
            <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-violet-900/40 to-[#0d0d18] border border-violet-500/20 p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-white/40 text-xs uppercase tracking-widest font-semibold">Win Rate</p>
                  <p className="text-5xl font-black text-white mt-1">{winRate}<span className="text-2xl text-violet-400">%</span></p>
                  <p className="text-white/40 text-xs mt-1">{analytics.winCount}W / {analytics.lossCount}L — {analytics.totalTrades} total</p>
                </div>
                <div className="w-14 h-14 rounded-2xl bg-violet-500/20 flex items-center justify-center">
                  <Award className="w-7 h-7 text-violet-400" />
                </div>
              </div>
            </div>

            {/* PNL Stats */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard icon={<TrendingUp className="w-4 h-4 text-emerald-400" />} bg="bg-emerald-500/10" label="Total P&L" value={`${fmt(analytics.totalPnlSol)} SOL`} valueClass={analytics.totalPnlSol >= 0 ? "text-emerald-400" : "text-red-400"} />
              <StatCard icon={<BarChart2 className="w-4 h-4 text-blue-400" />} bg="bg-blue-500/10" label="Today's P&L" value={`${fmt(analytics.dailyPnl)} SOL`} valueClass={analytics.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"} />
              <StatCard icon={<Award className="w-4 h-4 text-amber-400" />} bg="bg-amber-500/10" label="Best Trade" value={`+${analytics.bestTradePnl.toFixed(4)} SOL`} valueClass="text-emerald-400" />
              <StatCard icon={<TrendingDown className="w-4 h-4 text-red-400" />} bg="bg-red-500/10" label="Worst Trade" value={`${analytics.worstTradePnl.toFixed(4)} SOL`} valueClass="text-red-400" />
              <StatCard icon={<Target className="w-4 h-4 text-violet-400" />} bg="bg-violet-500/10" label="Avg Win" value={`+${analytics.avgWinSol.toFixed(4)} SOL`} valueClass="text-emerald-400" />
              <StatCard icon={<Clock className="w-4 h-4 text-white/40" />} bg="bg-white/5" label="Avg Hold" value={`${analytics.avgHoldTimeMinutes.toFixed(0)}m`} valueClass="text-white" />
            </div>

            {/* Period PNL */}
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
              <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">Period Breakdown</p>
              <div className="space-y-2">
                {[
                  { label: "Today", val: analytics.dailyPnl },
                  { label: "This Week", val: analytics.weeklyPnl },
                  { label: "This Month", val: analytics.monthlyPnl },
                ].map(({ label, val }) => (
                  <div key={label} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                    <span className="text-white/50 text-sm">{label}</span>
                    <span className={`font-bold text-sm ${val >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {val >= 0 ? "+" : ""}{val.toFixed(4)} SOL
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Daily PNL Chart */}
            {pnlData.length > 0 && (
              <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
                <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-4">Daily P&L (Last 14 Days)</p>
                <div className="h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pnlData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                      <XAxis dataKey="date" stroke="#ffffff20" fontSize={9} tickLine={false} axisLine={false} />
                      <YAxis stroke="#ffffff20" fontSize={9} tickLine={false} axisLine={false} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "#0d0d18", borderColor: "#ffffff15", color: "#fff", fontSize: 11, borderRadius: 8 }}
                        formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`, "P&L"]}
                      />
                      <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                        {pnlData.map((entry, i) => (
                          <Cell key={i} fill={entry.pnl >= 0 ? "rgba(52,211,153,0.8)" : "rgba(248,113,113,0.8)"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Trade History */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white/80 uppercase tracking-wider">Trade History</h3>
                <span className="text-xs text-white/30">{closedTrades.length} closed</span>
              </div>

              {closedTrades.length === 0 ? (
                <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-8 text-center">
                  <BarChart2 className="w-8 h-8 text-white/20 mx-auto mb-2" />
                  <p className="text-white/30 text-sm">No closed trades yet</p>
                  <p className="text-white/20 text-xs mt-1">Trades will appear here once the bot closes positions</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {closedTrades.map((trade) => {
                    const pnl = trade.pnlSol ?? 0;
                    const pnlPct = trade.pnlPercent ?? 0;
                    const isWin = pnl > 0;
                    const reason = trade.closeReason;
                    const ReasonIcon = reason === "take_profit" ? CheckCircle2 : reason === "stop_loss" ? XCircle : MinusCircle;
                    const reasonColor = reason === "take_profit" ? "text-emerald-400" : reason === "stop_loss" ? "text-red-400" : "text-white/40";
                    const reasonLabel = reason === "take_profit" ? "TP Hit" : reason === "stop_loss" ? "SL Hit" : "Manual";

                    return (
                      <div key={trade.positionId} className={`bg-[#0d0d18] border rounded-xl p-3.5 ${isWin ? "border-emerald-500/15" : "border-red-500/15"}`}>
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-white text-sm">${trade.symbol}</span>
                            <div className={`flex items-center gap-1 text-[10px] font-semibold ${reasonColor}`}>
                              <ReasonIcon className="w-3 h-3" />
                              {reasonLabel}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className={`font-black text-sm ${isWin ? "text-emerald-400" : "text-red-400"}`}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} SOL</p>
                            <p className={`text-xs font-bold ${isWin ? "text-emerald-400/70" : "text-red-400/70"}`}>{pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[10px] mb-2">
                          <div>
                            <p className="text-white/30">Entry</p>
                            <p className="text-white font-mono">${formatPrice(trade.entryPrice)}</p>
                          </div>
                          <div>
                            <p className="text-white/30">Exit</p>
                            <p className={`font-mono ${isWin ? "text-emerald-400" : "text-red-400"}`}>${formatPrice(trade.exitPrice ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-white/30">Entry MCap</p>
                            <p className="text-white/60">{formatMcap(trade.entryMarketCap)}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-white/30">
                          <div className="flex items-center gap-3">
                            <span>SL -{trade.slPercent}% / TP +{trade.tpPercent}%</span>
                            {trade.holdTimeMs !== undefined && <span>⏱ {holdLabel(trade.holdTimeMs)}</span>}
                          </div>
                          <span>{trade.closedAt ? toIST(trade.closedAt) : "—"}</span>
                        </div>
                        {trade.contractAddress && (
                          <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between">
                            <p className="text-[9px] font-mono text-white/20 truncate max-w-[180px]">{trade.contractAddress}</p>
                            <a href={`https://dexscreener.com/solana/${trade.contractAddress}`} target="_blank" rel="noopener noreferrer" className="text-[10px] text-violet-400/60 hover:text-violet-400 shrink-0 ml-2">DEX ↗</a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "journal" && lossInsights && <LossJournalTab data={lossInsights} />}

        {tab === "journal" && !lossInsights && (
          <div className="flex items-center justify-center h-40">
            <div className="w-6 h-6 rounded-full border-2 border-red-500 border-t-transparent animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, bg, label, value, valueClass }: {
  icon: React.ReactNode;
  bg: string;
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
      <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center mb-2`}>
        {icon}
      </div>
      <p className="text-white/40 text-xs mb-0.5">{label}</p>
      <p className={`font-black text-sm ${valueClass}`}>{value}</p>
    </div>
  );
}
