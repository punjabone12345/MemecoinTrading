import { useState } from "react";
import { usePositions, useClosedPositions, useClosePosition, useDeleteClosedTrade, useEditClosedTrade, usePumpfunPositions, usePumpfunHistory } from "@/lib/api";
import { TrendingUp, TrendingDown, Clock, ExternalLink, X, Trash2, Pencil, ChevronDown, ChevronUp, ShieldCheck, ShieldAlert, Download, Target, Rocket } from "lucide-react";

function fmtPrice(price: number): string {
  if (!price) return "—";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}
function fmtMcap(mcap: number): string {
  if (!mcap) return "—";
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}
function fmtHold(ms: number | undefined): string {
  if (!ms) return "—";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function downloadCsv(trades: ReturnType<typeof useClosedPositions>["data"]) {
  if (!trades?.length) return;
  const headers = ["Symbol", "Token Name", "Source", "Opened (IST)", "Closed (IST)", "Hold Time",
    "Entry Price ($)", "Exit Price ($)", "Size (SOL)", "PNL (SOL)", "PNL %", "Close Reason", "AI Provider", "AI Verdict", "AI Confidence %"];
  const rows = trades.map((p) => [
    p.symbol, p.tokenName ?? "", p.tradeSource === "rss" ? "Telegram" : "Bot",
    p.openedAt ? toIST(p.openedAt) : "", p.closedAt ? toIST(p.closedAt) : "",
    fmtHold(p.holdTimeMs), p.entryPrice?.toString() ?? "", p.exitPrice?.toString() ?? "",
    p.sizeSol?.toString() ?? "", (p.pnlSol ?? 0).toFixed(6), (p.pnlPercent ?? 0).toFixed(2),
    p.closeReason ?? "", p.llmProvider ?? "", p.llmVerdict ?? "", p.llmConfidence?.toString() ?? "",
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function ProviderBadge({ provider, verdict, confidence }: { provider?: string; verdict?: string; confidence?: number }) {
  if (!provider || provider === "none") return null;
  const colors: Record<string, string> = {
    gemini: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    groq: "bg-purple-500/15 text-purple-400 border-purple-500/20",
    heuristic: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  };
  const icons: Record<string, string> = { gemini: "✦", groq: "⚡", heuristic: "⚙" };
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${colors[provider] ?? "bg-white/10 text-white/50 border-white/10"}`}>
      {icons[provider] ?? "•"} {provider.toUpperCase()}
      {verdict && <span className="opacity-60">· {verdict}</span>}
      {confidence !== undefined && <span className="opacity-40">· {confidence}%</span>}
    </span>
  );
}

export default function Positions() {
  const [tab, setTab] = useState<"Open" | "Closed">("Open");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedAi, setExpandedAi] = useState<Set<string>>(new Set());
  const [expandedRug, setExpandedRug] = useState<Set<string>>(new Set());
  const [editNoteId, setEditNoteId] = useState<string | null>(null);
  const [editNoteValue, setEditNoteValue] = useState("");

  const { data: positionsData } = usePositions();
  const { data: closedPositions = [] } = useClosedPositions();
  const { data: pfOpenPositions = [] } = usePumpfunPositions();
  const { data: pfHistory = [] } = usePumpfunHistory();
  const closePosition = useClosePosition();
  const deleteClosedTrade = useDeleteClosedTrade();
  const editClosedTrade = useEditClosedTrade();

  const openPositions = positionsData?.positions ?? [];
  const totalLivePnl = openPositions.reduce((s, p) => s + (p.livePnlSol ?? 0), 0);
  const pfOpenFiltered = pfOpenPositions.filter((p) => p.status === "open");
  const totalOpenCount = openPositions.length + pfOpenFiltered.length;
  const totalClosedCount = closedPositions.length + pfHistory.length;

  function toggleAi(id: string) {
    setExpandedAi((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleRug(id: string) {
    setExpandedRug((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  return (
    <div className="px-3 py-4 space-y-4 pb-6">

      {/* ── Header stats ── */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-3 text-center">
          <p className="text-xl font-black text-white">{totalOpenCount}</p>
          <p className="text-[9px] text-white/30 mt-0.5">Open</p>
        </div>
        <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-3 text-center">
          <p className={`text-xl font-black ${totalLivePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {totalLivePnl >= 0 ? "+" : ""}{Math.abs(totalLivePnl).toFixed(4)}
          </p>
          <p className="text-[9px] text-white/30 mt-0.5">Live P&L</p>
        </div>
        <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-3 text-center">
          <p className="text-xl font-black text-white">{totalClosedCount}</p>
          <p className="text-[9px] text-white/30 mt-0.5">Closed</p>
        </div>
      </div>

      {/* ── Tab Switcher ── */}
      <div className="flex bg-[#0d0d18] border border-white/8 rounded-xl p-1 gap-1">
        {(["Open", "Closed"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
              tab === t ? "bg-violet-500/20 text-violet-400" : "text-white/35"
            }`}>
            {t} ({t === "Open" ? totalOpenCount : totalClosedCount})
          </button>
        ))}
      </div>

      {/* ── Open Positions ── */}
      {tab === "Open" && (
        <div className="space-y-3">
          {openPositions.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <Target className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-white/25 text-sm">No open positions</p>
              <p className="text-white/15 text-[11px] mt-1">Bot is scanning for entry signals...</p>
            </div>
          ) : openPositions.map((p) => {
            const pnl = p.livePnlSol ?? 0;
            const pnlPct = p.livePnlPercent ?? 0;
            const isWin = pnl >= 0;
            const aiExpanded = expandedAi.has(p.positionId);
            const rugExpanded = expandedRug.has(p.positionId);
            const hasAi = !!(p.llmReasoning || p.llmRisks?.length || p.llmStrengths?.length);
            const hasRug = p.rugScore !== undefined || p.rugLpLockedPct !== undefined;
            return (
              <div key={p.positionId} className={`rounded-2xl overflow-hidden border ${isWin ? "border-emerald-500/20" : "border-red-500/20"}`}>
                {/* Header */}
                <div className={`px-4 py-3 flex items-center justify-between ${isWin ? "bg-emerald-500/8" : "bg-red-500/8"}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    {isWin ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                    <span className="font-black text-white text-base">${p.symbol}</span>
                    <span className="text-white/35 text-xs">{p.tokenName}</span>
                    {p.llmProvider && <ProviderBadge provider={p.llmProvider} verdict={p.llmVerdict} confidence={p.llmConfidence} />}
                  </div>
                  <div className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                    {isWin ? "+" : ""}{pnl.toFixed(4)} SOL
                  </div>
                </div>

                <div className="bg-[#0d0d18] px-4 py-3 space-y-3">
                  {/* Price grid */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-white/35">Entry</span>
                      <span className="font-mono text-white">${fmtPrice(p.entryPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/35">Current</span>
                      <span className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>${fmtPrice(p.currentPrice ?? p.entryPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-emerald-400/70">TP Price</span>
                      <span className="font-mono text-emerald-400">${fmtPrice(p.tpPrice)} (+{p.tpPercent}%)</span>
                    </div>
                    <div className="flex justify-between">
                      {p.slPrice > p.entryPrice * 1.01 ? (
                        <>
                          <span className="text-amber-400 font-semibold">🔒 Trailing SL</span>
                          <span className="font-mono text-amber-400 font-bold">${fmtPrice(p.slPrice)}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-red-400/70">SL Price</span>
                          <span className="font-mono text-red-400">${fmtPrice(p.slPrice)} (-{p.slPercent}%)</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* MCap row */}
                  <div className="grid grid-cols-3 gap-2 text-xs bg-white/4 rounded-lg p-2">
                    <div className="text-center">
                      <p className="text-white/25 text-[9px]">Entry MCap</p>
                      <p className="text-white font-bold">{fmtMcap(p.entryMarketCap)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-emerald-400/50 text-[9px]">TP MCap</p>
                      <p className="text-emerald-400 font-bold">{fmtMcap(p.tpMarketCap)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-red-400/50 text-[9px]">SL MCap</p>
                      <p className="text-red-400 font-bold">{fmtMcap(p.slMarketCap)}</p>
                    </div>
                  </div>

                  {/* P&L badge + time */}
                  <div className="flex items-center justify-between">
                    <div className={`px-2.5 py-1 rounded-lg text-xs font-bold ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                      {isWin ? "+" : ""}{pnlPct.toFixed(2)}% live
                    </div>
                    <div className="flex items-center gap-1 text-white/25 text-[10px]">
                      <Clock className="w-3 h-3" />
                      {toIST(p.openedAt)}
                    </div>
                  </div>

                  {/* AI Reasoning */}
                  {hasAi && (
                    <div>
                      <button onClick={() => toggleAi(p.positionId)} className="flex items-center gap-1.5 text-[9px] text-white/25 hover:text-white/50 py-1 transition-colors">
                        {aiExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {aiExpanded ? "Hide" : "Show"} AI reasoning
                      </button>
                      {aiExpanded && (
                        <div className="bg-white/3 border border-white/8 rounded-xl p-3 space-y-2 mt-1">
                          {p.llmReasoning && <p className="text-[11px] text-white/60 leading-relaxed">{p.llmReasoning}</p>}
                          {(p.llmStrengths?.length || p.llmRisks?.length) ? (
                            <div className="grid grid-cols-2 gap-2">
                              {p.llmStrengths?.length ? (
                                <div className="space-y-1">
                                  <p className="text-[9px] font-bold text-emerald-400/60 uppercase">Strengths</p>
                                  {p.llmStrengths.map((s, i) => <p key={i} className="text-[10px] text-emerald-400/70 flex gap-1"><span>↑</span><span>{s}</span></p>)}
                                </div>
                              ) : null}
                              {p.llmRisks?.length ? (
                                <div className="space-y-1">
                                  <p className="text-[9px] font-bold text-red-400/60 uppercase">Risks</p>
                                  {p.llmRisks.map((r, i) => <p key={i} className="text-[10px] text-red-400/70 flex gap-1"><span>↓</span><span>{r}</span></p>)}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )}

                  {/* RugCheck */}
                  {hasRug && (
                    <div>
                      <button onClick={() => toggleRug(p.positionId)} className="flex items-center gap-1.5 text-[9px] text-white/25 hover:text-white/50 py-1 transition-colors">
                        {(p.rugScore ?? 0) < 400 ? <ShieldCheck className="w-3 h-3 text-emerald-400" /> : <ShieldAlert className="w-3 h-3 text-amber-400" />}
                        RugCheck {(p.rugScore ?? 0) < 400 ? "Safe" : "Warning"}
                        {rugExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      </button>
                      {rugExpanded && (
                        <div className="bg-white/4 rounded-lg px-3 py-2 flex flex-wrap gap-1.5 mt-1">
                          {p.rugScore !== undefined && (
                            <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-bold ${
                              p.rugScore < 300 ? "bg-emerald-500/15 text-emerald-400" : p.rugScore < 600 ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"
                            }`}>Score {p.rugScore}/1000</span>
                          )}
                          {p.rugLpLockedPct !== undefined && (
                            <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono ${
                              p.rugLpLockedPct > 50 ? "bg-emerald-500/15 text-emerald-400" : p.rugLpLockedPct > 0 ? "bg-amber-500/15 text-amber-400" : "bg-orange-500/15 text-orange-400"
                            }`}>LP {p.rugLpLockedPct.toFixed(0)}% locked</span>
                          )}
                          {p.rugTopHolderPct !== undefined && p.rugTopHolderPct > 3 && (
                            <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono ${
                              p.rugTopHolderPct < 10 ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400"
                            }`}>Top {p.rugTopHolderPct.toFixed(1)}%</span>
                          )}
                          {p.rugWarnRisks?.map((risk) => (
                            <span key={risk} className="text-[9px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70 italic">{risk}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* CA */}
                  <div className="bg-white/4 rounded-lg px-3 py-2">
                    <p className="text-white/25 text-[9px] mb-0.5">Contract</p>
                    <p className="font-mono text-[9px] text-white/50 break-all">{p.contractAddress || p.pairAddress}</p>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2">
                    <a href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`} target="_blank" rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold">
                      <ExternalLink className="w-3.5 h-3.5" /> DEX
                    </a>
                    <button onClick={() => closePosition.mutate(p.positionId)} disabled={closePosition.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold active:scale-95 transition-all">
                      <X className="w-3.5 h-3.5" /> Close
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Closed Positions ── */}
      {tab === "Closed" && (
        <div className="space-y-3">
          {(closedPositions.length > 0 || pfHistory.length > 0) && (
            <div className="flex items-center justify-between">
              <div className="text-[10px] text-white/30">
                {totalClosedCount} trades · {closedPositions.filter(p => (p.pnlSol ?? 0) >= 0).length + pfHistory.filter(p => p.realizedPnlSol >= 0).length}W / {closedPositions.filter(p => (p.pnlSol ?? 0) < 0).length + pfHistory.filter(p => p.realizedPnlSol < 0).length}L
              </div>
              <button onClick={() => downloadCsv(closedPositions)}
                className="flex items-center gap-1.5 text-[10px] text-white/35 hover:text-emerald-400 px-3 py-1.5 rounded-lg bg-white/5 border border-white/6 transition-colors">
                <Download className="w-3.5 h-3.5" /> CSV
              </button>
            </div>
          )}

          {closedPositions.length === 0 && pfHistory.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-10 text-center">
              <p className="text-white/25 text-sm">No closed trades yet</p>
            </div>
          ) : closedPositions.map((p) => {
            const pnl = p.pnlSol ?? 0;
            const pnlPct = p.pnlPercent ?? 0;
            const isWin = pnl >= 0;
            const confirmDelete = confirmDeleteId === p.positionId;
            const isEditingNote = editNoteId === p.positionId;
            return (
              <div key={p.positionId} className={`bg-[#0d0d18] border rounded-xl overflow-hidden ${isWin ? "border-emerald-500/15" : "border-red-500/10"}`}>
                <div className={`px-4 py-2.5 flex items-center justify-between ${isWin ? "bg-emerald-500/5" : "bg-red-500/5"}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-white text-sm">${p.symbol}</span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                      {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                    </span>
                    {p.tradeSource === "rss" && <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-400">TG</span>}
                    {p.llmProvider && <ProviderBadge provider={p.llmProvider} verdict={p.llmVerdict} confidence={p.llmConfidence} />}
                  </div>
                  <span className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                    {isWin ? "+" : ""}{Math.abs(pnl).toFixed(4)} SOL
                  </span>
                </div>

                <div className="px-4 py-3 space-y-2">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-white/30">Entry</span><span className="font-mono text-white">${fmtPrice(p.entryPrice)}</span></div>
                    <div className="flex justify-between"><span className="text-white/30">Exit</span><span className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>${fmtPrice(p.exitPrice ?? 0)}</span></div>
                    <div className="flex justify-between"><span className="text-white/30">Size</span><span className="text-white">{(p.sizeSol ?? 0).toFixed(4)} SOL</span></div>
                    {p.holdTimeMs && <div className="flex justify-between"><span className="text-white/30">Hold</span><span className="text-white">{fmtHold(p.holdTimeMs)}</span></div>}
                  </div>
                  <div className="flex items-center justify-between text-[9px] text-white/25">
                    <span>{p.closeReason ?? "manual"}</span>
                    <span>{p.closedAt ? toIST(p.closedAt) : "—"}</span>
                  </div>
                  {p.note && (
                    <div className="bg-amber-500/8 border border-amber-500/15 rounded-lg px-2.5 py-1.5">
                      <p className="text-[10px] text-amber-400/70 italic">{p.note}</p>
                    </div>
                  )}

                  {/* Edit note inline */}
                  {isEditingNote ? (
                    <div className="space-y-2">
                      <input value={editNoteValue} onChange={e => setEditNoteValue(e.target.value)} placeholder="Add note…" autoFocus
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-white/20 focus:outline-none focus:border-amber-500/40" />
                      <div className="flex gap-2">
                        <button onClick={() => setEditNoteId(null)} className="flex-1 py-2 rounded-lg bg-white/8 text-white/40 text-xs">Cancel</button>
                        <button onClick={() => editClosedTrade.mutate({ positionId: p.positionId, note: editNoteValue }, { onSuccess: () => setEditNoteId(null) })}
                          disabled={editClosedTrade.isPending}
                          className="flex-1 py-2 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-400 text-xs font-bold disabled:opacity-50">
                          {editClosedTrade.isPending ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex gap-2">
                        <a href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[9px] text-violet-400/60 hover:text-violet-400 transition-colors">
                          <ExternalLink className="w-3 h-3" /> DEX
                        </a>
                        <button onClick={() => { setEditNoteId(p.positionId); setEditNoteValue(p.note ?? ""); }}
                          className="flex items-center gap-1 text-[9px] text-amber-400/50 hover:text-amber-400 transition-colors">
                          <Pencil className="w-3 h-3" /> Note
                        </button>
                      </div>
                      {confirmDelete ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] text-white/30">Delete?</span>
                          <button onClick={() => { deleteClosedTrade.mutate(p.positionId); setConfirmDeleteId(null); }}
                            className="text-[9px] font-bold px-2 py-1 rounded-md bg-red-500/20 text-red-400 border border-red-500/30">Yes</button>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-[9px] font-bold px-2 py-1 rounded-md bg-white/8 text-white/40">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(p.positionId)} className="text-[9px] text-white/20 hover:text-red-400 transition-colors p-1">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
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
                    <Rocket className="w-2.5 h-2.5" /> Pump.fun
                  </span>
                  <div className="h-px flex-1 bg-white/6" />
                </div>
              )}
              {pfHistory.map((p) => {
                const pnl = p.realizedPnlSol;
                const isWin = pnl >= 0;
                const pnlPct = p.entryPrice > 0 && p.exitPrice ? ((p.exitPrice / p.entryPrice) - 1) * 100 : 0;
                const holdMs = p.closedAt && p.entryAt ? p.closedAt - p.entryAt : undefined;
                return (
                  <div key={p.id} className={`bg-[#0d0d18] border rounded-xl overflow-hidden ${isWin ? "border-emerald-500/15" : "border-red-500/10"}`}>
                    <div className={`px-4 py-2.5 flex items-center justify-between ${isWin ? "bg-emerald-500/5" : "bg-red-500/5"}`}>
                      <div className="flex items-center gap-2">
                        <Rocket className="w-3.5 h-3.5 text-violet-400" />
                        <span className="font-black text-white text-sm">${p.symbol}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                          {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-violet-500/15 text-violet-400">PF Pre-Grad</span>
                      </div>
                      <span className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{Math.abs(pnl).toFixed(4)} SOL
                      </span>
                    </div>
                    <div className="px-4 py-3 space-y-2">
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                        <div className="flex justify-between"><span className="text-white/30">Entry</span><span className="font-mono text-white">${p.entryPrice < 0.0001 ? p.entryPrice.toFixed(10) : p.entryPrice.toFixed(6)}</span></div>
                        <div className="flex justify-between"><span className="text-white/30">Exit</span><span className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>{p.exitPrice ? `$${p.exitPrice < 0.0001 ? p.exitPrice.toFixed(10) : p.exitPrice.toFixed(6)}` : "—"}</span></div>
                        <div className="flex justify-between"><span className="text-white/30">Size</span><span className="text-white">{p.sizeSol.toFixed(4)} SOL</span></div>
                        {holdMs && <div className="flex justify-between"><span className="text-white/30">Hold</span><span className="text-white">{fmtHold(holdMs)}</span></div>}
                      </div>
                      <div className="flex items-center justify-between text-[9px] text-white/25">
                        <span>{p.closeReason ?? "closed"}</span>
                        <span>{p.closedAt ? new Date(p.closedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) : "—"}</span>
                      </div>
                      <a href={`https://dexscreener.com/solana/${p.mint}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[9px] text-violet-400/60 hover:text-violet-400 transition-colors">
                        <ExternalLink className="w-3 h-3" /> DEX
                      </a>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
