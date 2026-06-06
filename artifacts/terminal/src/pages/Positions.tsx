import { useState } from "react";
import { usePositions, useClosedPositions, useClosePosition, useDeleteClosedTrade, useEditClosedTrade } from "@/lib/api";
import { TrendingUp, TrendingDown, Clock, ExternalLink, X, Trash2, Pencil, AlertTriangle, ChevronDown, ChevronUp, ShieldCheck, ShieldAlert } from "lucide-react";

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

function formatHoldTime(ms: number | undefined): string {
  if (!ms) return "—";
  const mins = Math.floor(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function ProviderBadge({ provider, verdict, confidence }: {
  provider?: string;
  verdict?: string;
  confidence?: number;
}) {
  if (!provider || provider === "none") return null;
  const colors: Record<string, string> = {
    gemini: "bg-blue-500/15 text-blue-400 border-blue-500/20",
    groq: "bg-purple-500/15 text-purple-400 border-purple-500/20",
    heuristic: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  };
  const icons: Record<string, string> = {
    gemini: "✦",
    groq: "⚡",
    heuristic: "⚙",
  };
  const cls = colors[provider] ?? "bg-white/10 text-white/50 border-white/10";
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded border ${cls}`}>
      {icons[provider] ?? "•"} {provider.toUpperCase()}
      {verdict && <span className="opacity-70">· {verdict}</span>}
      {confidence !== undefined && <span className="opacity-50">· {confidence}%</span>}
    </span>
  );
}

function AiAnalysisPanel({ reasoning, risks, strengths, provider, verdict, confidence, durationMs }: {
  reasoning?: string;
  risks?: string[];
  strengths?: string[];
  provider?: string;
  verdict?: string;
  confidence?: number;
  durationMs?: number;
}) {
  if (!reasoning && (!risks?.length) && (!strengths?.length)) return null;

  const verdictColor =
    verdict === "TRADE" ? "text-emerald-400" :
    verdict === "RISKY" ? "text-yellow-400" :
    verdict === "SKIP" ? "text-red-400" : "text-white/50";

  return (
    <div className="bg-white/3 border border-white/8 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">AI Analysis</span>
          <ProviderBadge provider={provider} verdict={verdict} confidence={confidence} />
        </div>
        {durationMs && (
          <span className="text-[9px] text-white/20">{(durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {reasoning && (
        <p className="text-[11px] text-white/70 leading-relaxed">{reasoning}</p>
      )}

      {(strengths?.length || risks?.length) ? (
        <div className="grid grid-cols-2 gap-2">
          {strengths && strengths.length > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] font-bold text-emerald-400/70 uppercase tracking-wider">Strengths</p>
              {strengths.map((s, i) => (
                <p key={i} className="text-[10px] text-emerald-400/80 flex gap-1">
                  <span className="shrink-0">↑</span>
                  <span>{s}</span>
                </p>
              ))}
            </div>
          )}
          {risks && risks.length > 0 && (
            <div className="space-y-1">
              <p className="text-[9px] font-bold text-red-400/70 uppercase tracking-wider">Risks</p>
              {risks.map((r, i) => (
                <p key={i} className="text-[10px] text-red-400/80 flex gap-1">
                  <span className="shrink-0">↓</span>
                  <span>{r}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

const TABS = ["Open", "Closed"] as const;

interface EditLossState {
  positionId: string;
  symbol: string;
  sizeSol: number;
  slPercent: number;
  slPrice: number;
  entryPrice: number;
  currentPnlSol: number;
}

interface MarkTpState {
  positionId: string;
  symbol: string;
  sizeSol: number;
  tpPercent: number;
  tpPrice: number;
  entryPrice: number;
  currentPnlSol: number;
}

interface EditPricesState {
  positionId: string;
  symbol: string;
  sizeSol: number;
  entryPrice: number;
  exitPrice: number;
  currentPnlSol: number;
}

export default function Positions() {
  const [tab, setTab] = useState<"Open" | "Closed">("Open");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editLoss, setEditLoss] = useState<EditLossState | null>(null);
  const [markTp, setMarkTp] = useState<MarkTpState | null>(null);
  const [editPrices, setEditPrices] = useState<EditPricesState | null>(null);
  const [editPricesEntry, setEditPricesEntry] = useState("");
  const [editPricesExit, setEditPricesExit] = useState("");
  const [editNote, setEditNote] = useState("");
  const [expandedAi, setExpandedAi] = useState<Set<string>>(new Set());

  const { data: positionsData } = usePositions();
  const { data: closedPositions = [] } = useClosedPositions();
  const closePosition = useClosePosition();
  const deleteClosedTrade = useDeleteClosedTrade();
  const editClosedTrade = useEditClosedTrade();

  const openPositions = positionsData?.positions ?? [];

  function toggleAi(id: string) {
    setExpandedAi((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openEditLoss(p: typeof closedPositions[0]) {
    setEditNote(p.note ?? "");
    setEditLoss({
      positionId: p.positionId,
      symbol: p.symbol,
      sizeSol: p.sizeSol,
      slPercent: p.slPercent,
      slPrice: p.slPrice,
      entryPrice: p.entryPrice,
      currentPnlSol: p.pnlSol ?? 0,
    });
  }

  function openMarkTpModal(p: typeof closedPositions[0]) {
    setEditNote("");
    setMarkTp({
      positionId: p.positionId,
      symbol: p.symbol,
      sizeSol: p.sizeSol,
      tpPercent: p.tpPercent,
      tpPrice: p.tpPrice,
      entryPrice: p.entryPrice,
      currentPnlSol: p.pnlSol ?? 0,
    });
  }

  function openEditPricesModal(p: typeof closedPositions[0]) {
    setEditNote(p.note ?? "");
    setEditPricesEntry(String(p.entryPrice ?? ""));
    setEditPricesExit(String(p.exitPrice ?? ""));
    setEditPrices({
      positionId: p.positionId,
      symbol: p.symbol,
      sizeSol: p.sizeSol,
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice ?? p.entryPrice,
      currentPnlSol: p.pnlSol ?? 0,
    });
  }

  function submitEditPrices() {
    if (!editPrices) return;
    const newEntry = parseFloat(editPricesEntry);
    const newExit = parseFloat(editPricesExit);
    if (!newEntry || newEntry <= 0 || !newExit || newExit <= 0) return;
    const grossReturn = editPrices.sizeSol * (newExit / newEntry);
    const fees = (grossReturn + editPrices.sizeSol) * 0.003 + editPrices.sizeSol * 0.005;
    const newPnlSol = grossReturn - editPrices.sizeSol - fees;
    const newPnlPercent = ((newExit - newEntry) / newEntry) * 100;
    editClosedTrade.mutate({
      positionId: editPrices.positionId,
      pnlSol: newPnlSol,
      pnlPercent: newPnlPercent,
      entryPrice: newEntry,
      exitPrice: newExit,
      closeReason: "manual",
      note: editNote || "Prices manually corrected",
    }, {
      onSuccess: () => setEditPrices(null),
    });
  }

  function submitMarkAsTp() {
    if (!markTp) return;
    const grossReturn = markTp.sizeSol * (markTp.tpPrice / markTp.entryPrice);
    const fees = (grossReturn + markTp.sizeSol) * 0.003 + markTp.sizeSol * 0.005;
    const tpPnlSol = grossReturn - markTp.sizeSol - fees;
    const tpPnlPercent = markTp.tpPercent;

    editClosedTrade.mutate({
      positionId: markTp.positionId,
      pnlSol: tpPnlSol,
      pnlPercent: tpPnlPercent,
      exitPrice: markTp.tpPrice,
      closeReason: "take_profit",
      note: editNote || "Manually marked as TP (checker missed the peak)",
    }, {
      onSuccess: () => setMarkTp(null),
    });
  }

  function submitMarkAsLoss() {
    if (!editLoss) return;
    const slPnlPercent = -(editLoss.slPercent);
    const grossReturn = editLoss.sizeSol * (editLoss.slPrice / editLoss.entryPrice);
    const fees = (grossReturn + editLoss.sizeSol) * 0.003 + editLoss.sizeSol * 0.005;
    const slPnlSol = grossReturn - editLoss.sizeSol - fees;

    editClosedTrade.mutate({
      positionId: editLoss.positionId,
      pnlSol: slPnlSol,
      pnlPercent: slPnlPercent,
      exitPrice: editLoss.slPrice,
      closeReason: "stop_loss",
      note: editNote || "Manually marked as loss (fake price on DexScreener)",
    }, {
      onSuccess: () => setEditLoss(null),
    });
  }

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Tab Switcher */}
      <div className="flex bg-[#0d0d18] border border-white/8 rounded-xl p-1 gap-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all ${
              tab === t
                ? "bg-violet-500/20 text-violet-400 shadow-sm"
                : "text-white/40"
            }`}
          >
            {t} {t === "Open" ? `(${openPositions.length})` : `(${closedPositions.length})`}
          </button>
        ))}
      </div>

      {/* Open Positions */}
      {tab === "Open" && (
        <div className="space-y-3">
          {openPositions.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-10 text-center">
              <p className="text-white/30 text-sm">No open positions</p>
            </div>
          ) : openPositions.map((p) => {
            const pnl = p.livePnlSol ?? 0;
            const pnlPct = p.livePnlPercent ?? 0;
            const isWin = pnl >= 0;
            const aiExpanded = expandedAi.has(p.positionId);
            const hasAi = !!(p.llmReasoning || p.llmRisks?.length || p.llmStrengths?.length);

            return (
              <div key={p.positionId} className={`bg-[#0d0d18] border rounded-2xl overflow-hidden ${isWin ? "border-emerald-500/20" : "border-red-500/20"}`}>
                <div className={`px-4 py-3 flex items-center justify-between ${isWin ? "bg-emerald-500/8" : "bg-red-500/8"}`}>
                  <div className="flex items-center gap-2">
                    {isWin ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                    <span className="font-black text-white text-base">${p.symbol}</span>
                    <span className="text-white/40 text-xs">{p.tokenName}</span>
                    {p.llmProvider && (
                      <ProviderBadge provider={p.llmProvider} verdict={p.llmVerdict} confidence={p.llmConfidence} />
                    )}
                  </div>
                  <div className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                    {isWin ? "+" : ""}{pnl.toFixed(4)} SOL
                  </div>
                </div>

                <div className="px-4 py-3 space-y-3">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-white/40">Entry Price</span>
                      <span className="font-mono text-white">${formatPrice(p.entryPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-white/40">Current</span>
                      <span className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>${formatPrice(p.currentPrice ?? p.entryPrice)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-emerald-400">TP Price</span>
                      <span className="font-mono text-emerald-400">${formatPrice(p.tpPrice)} (+{p.tpPercent}%)</span>
                    </div>
                    <div className="flex justify-between">
                      {p.slPrice > p.entryPrice * 1.01 ? (
                        <>
                          <span className="text-amber-400 flex items-center gap-1 font-semibold">
                            🔒 Trailing SL
                          </span>
                          <span className="font-mono text-amber-400 font-bold">
                            ${formatPrice(p.slPrice)} (+{((p.slPrice / p.entryPrice - 1) * 100).toFixed(0)}% locked)
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-red-400">SL Price</span>
                          <span className="font-mono text-red-400">${formatPrice(p.slPrice)} (-{p.slPercent}%)</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-xs bg-white/4 rounded-lg p-2">
                    <div className="text-center">
                      <p className="text-white/30 text-[10px]">Entry MCap</p>
                      <p className="text-white font-bold">{formatMcap(p.entryMarketCap)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-emerald-400/60 text-[10px]">TP MCap</p>
                      <p className="text-emerald-400 font-bold">{formatMcap(p.tpMarketCap)}</p>
                    </div>
                    <div className="text-center">
                      <p className="text-red-400/60 text-[10px]">SL MCap</p>
                      <p className="text-red-400 font-bold">{formatMcap(p.slMarketCap)}</p>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className={`px-2.5 py-1 rounded-lg text-xs font-bold ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                      {isWin ? "+" : ""}{pnlPct.toFixed(2)}% live P&L
                    </div>
                    <div className="flex items-center gap-1 text-white/30 text-xs">
                      <Clock className="w-3 h-3" />
                      {toIST(p.openedAt)} IST
                    </div>
                  </div>

                  {/* AI Analysis expandable */}
                  {hasAi && (
                    <div>
                      <button
                        onClick={() => toggleAi(p.positionId)}
                        className="flex items-center gap-1.5 text-[10px] text-white/30 hover:text-white/60 transition-colors py-1"
                      >
                        {aiExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {aiExpanded ? "Hide" : "Show"} AI reasoning
                      </button>
                      {aiExpanded && (
                        <AiAnalysisPanel
                          reasoning={p.llmReasoning}
                          risks={p.llmRisks}
                          strengths={p.llmStrengths}
                          provider={p.llmProvider}
                          verdict={p.llmVerdict}
                          confidence={p.llmConfidence}
                          durationMs={p.llmDurationMs}
                        />
                      )}
                    </div>
                  )}

                  {/* RugCheck safety summary */}
                  {(p.rugScore !== undefined || p.rugLpLockedPct !== undefined) && (
                    <div className="bg-white/4 rounded-lg px-3 py-2 space-y-1.5">
                      <div className="flex items-center gap-1.5 mb-1">
                        {(p.rugScore ?? 0) < 400 ? (
                          <ShieldCheck className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <ShieldAlert className="w-3 h-3 text-amber-400" />
                        )}
                        <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wide">RugCheck</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {p.rugScore !== undefined && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono font-bold ${
                            p.rugScore < 300 ? "bg-emerald-500/15 text-emerald-400" :
                            p.rugScore < 600 ? "bg-amber-500/15 text-amber-400" :
                            "bg-red-500/15 text-red-400"
                          }`}>
                            Score {p.rugScore}/1000
                          </span>
                        )}
                        {p.rugLpLockedPct !== undefined && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                            p.rugLpLockedPct > 50 ? "bg-emerald-500/15 text-emerald-400" :
                            p.rugLpLockedPct > 0  ? "bg-amber-500/15 text-amber-400" :
                            "bg-orange-500/15 text-orange-400"
                          }`}>
                            LP {p.rugLpLockedPct.toFixed(0)}% locked
                          </span>
                        )}
                        {p.rugTopHolderPct !== undefined && p.rugTopHolderPct > 3 && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${
                            p.rugTopHolderPct < 10 ? "bg-amber-500/15 text-amber-400" :
                            p.rugTopHolderPct < 20 ? "bg-orange-500/15 text-orange-400" :
                            "bg-red-500/15 text-red-400"
                          }`}>
                            Top holder {p.rugTopHolderPct.toFixed(1)}%
                          </span>
                        )}
                        {p.rugWarnRisks?.map((risk) => (
                          <span key={risk} className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/80 italic">
                            {risk}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="bg-white/4 rounded-lg px-3 py-2">
                    <p className="text-white/30 text-[10px] mb-0.5">Contract Address</p>
                    <p className="font-mono text-[10px] text-white/70 break-all">{p.contractAddress || p.pairAddress}</p>
                  </div>

                  <div className="flex gap-2">
                    <a
                      href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      DexScreener
                    </a>
                    <button
                      onClick={() => closePosition.mutate(p.positionId)}
                      disabled={closePosition.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-semibold active:scale-95 transition-all"
                    >
                      <X className="w-3.5 h-3.5" />
                      Close Trade
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Closed Positions */}
      {tab === "Closed" && (
        <div className="space-y-3">
          {closedPositions.length === 0 ? (
            <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-10 text-center">
              <p className="text-white/30 text-sm">No closed trades yet</p>
            </div>
          ) : closedPositions.map((p) => {
            const pnl = p.pnlSol ?? 0;
            const pnlPct = p.pnlPercent ?? 0;
            const isWin = pnl >= 0;
            const isFakeLooking = isWin && pnl > p.sizeSol * 2;
            const reasonColor = p.closeReason === "take_profit" ? "text-emerald-400 bg-emerald-500/15" : p.closeReason === "rug_detected" ? "text-red-400 bg-red-500/20" : p.closeReason === "stop_loss" ? "text-red-400 bg-red-500/15" : "text-white/50 bg-white/8";
            const reasonLabel = p.closeReason === "take_profit" ? "✅ TP Hit" : p.closeReason === "rug_detected" ? "☠️ Rug" : p.closeReason === "stop_loss" ? "🛑 SL Hit" : "⚪ Manual";
            const isConfirming = confirmDeleteId === p.positionId;
            const aiExpanded = expandedAi.has(p.positionId);
            const hasAi = !!(p.llmReasoning || p.llmRisks?.length || p.llmStrengths?.length);

            return (
              <div key={p.positionId} className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between border-b border-white/5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-white">${p.symbol}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${reasonColor}`}>{reasonLabel}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${p.tradeSource === "rss" ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/20" : "bg-violet-500/15 text-violet-400 border-violet-500/20"}`}>
                      {p.tradeSource === "rss" ? "📡 Telegram" : "🤖 Bot"}
                    </span>
                    {p.llmProvider && (
                      <ProviderBadge provider={p.llmProvider} verdict={p.llmVerdict} confidence={p.llmConfidence} />
                    )}
                    {p.note && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" />
                        {p.note.length > 30 ? p.note.slice(0, 30) + "…" : p.note}
                      </span>
                    )}
                    {isFakeLooking && !p.note && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70">
                        ⚠ unusually high
                      </span>
                    )}
                  </div>
                  <span className={`font-black text-sm ml-2 shrink-0 ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                    {isWin ? "+" : ""}{pnl.toFixed(4)} SOL
                  </span>
                </div>
                <div className="px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-white/40">Entry</span>
                    <span className="font-mono text-white">${formatPrice(p.entryPrice)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Exit</span>
                    <span className="font-mono text-white">${formatPrice(p.exitPrice ?? 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">P&L %</span>
                    <span className={`font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>{isWin ? "+" : ""}{pnlPct.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Hold Time</span>
                    <span className="text-white">{formatHoldTime(p.holdTimeMs)}</span>
                  </div>
                  {p.closedAt && (
                    <div className="col-span-2 flex justify-between">
                      <span className="text-white/40">Closed</span>
                      <span className="text-white/60">{toIST(p.closedAt)} IST</span>
                    </div>
                  )}
                </div>

                {/* AI Analysis expandable for closed trades */}
                {hasAi && (
                  <div className="px-4 pb-2">
                    <button
                      onClick={() => toggleAi(p.positionId)}
                      className="flex items-center gap-1.5 text-[10px] text-white/30 hover:text-white/60 transition-colors py-1"
                    >
                      {aiExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      {aiExpanded ? "Hide" : "Show"} AI reasoning
                    </button>
                    {aiExpanded && (
                      <AiAnalysisPanel
                        reasoning={p.llmReasoning}
                        risks={p.llmRisks}
                        strengths={p.llmStrengths}
                        provider={p.llmProvider}
                        verdict={p.llmVerdict}
                        confidence={p.llmConfidence}
                        durationMs={p.llmDurationMs}
                      />
                    )}
                  </div>
                )}

                <div className="px-4 pb-3 flex items-center justify-between gap-2">
                  <a
                    href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-violet-400 underline"
                  >
                    View on DexScreener ↗
                  </a>

                  <div className="flex items-center gap-1.5">
                    {!isConfirming && (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openMarkTpModal(p)}
                          className="flex items-center gap-1 text-[10px] text-emerald-400/60 hover:text-emerald-400 transition-colors py-1 px-1.5 rounded"
                          title="Mark this trade as a TP win (checker missed the peak)"
                        >
                          <TrendingUp className="w-3 h-3" />
                          Mark TP
                        </button>
                        <button
                          onClick={() => openEditLoss(p)}
                          className="flex items-center gap-1 text-[10px] text-amber-400/60 hover:text-amber-400 transition-colors py-1 px-1.5 rounded"
                          title="Mark this trade as a loss (e.g. fake price from DexScreener)"
                        >
                          <Pencil className="w-3 h-3" />
                          Mark Loss
                        </button>
                        <button
                          onClick={() => openEditPricesModal(p)}
                          className="flex items-center gap-1 text-[10px] text-blue-400/60 hover:text-blue-400 transition-colors py-1 px-1.5 rounded"
                          title="Manually set entry and exit price"
                        >
                          <Pencil className="w-3 h-3" />
                          Edit Prices
                        </button>
                        <button
                          onClick={() => editClosedTrade.mutate({ positionId: p.positionId, tradeSource: p.tradeSource === "rss" ? "bot" : "rss" })}
                          disabled={editClosedTrade.isPending}
                          className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors py-1 px-1.5 rounded"
                          title={p.tradeSource === "rss" ? "Switch to Bot trade" : "Switch to Telegram trade"}
                        >
                          {p.tradeSource === "rss" ? "🤖" : "📡"}
                        </button>
                      </div>
                    )}

                    {isConfirming ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-white/50">Remove & restore balance?</span>
                        <button
                          onClick={() => {
                            deleteClosedTrade.mutate(p.positionId);
                            setConfirmDeleteId(null);
                          }}
                          disabled={deleteClosedTrade.isPending}
                          className="text-[10px] font-bold px-2 py-1 rounded-md bg-red-500/20 text-red-400 border border-red-500/30 active:scale-95"
                        >
                          Yes, delete
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-[10px] font-bold px-2 py-1 rounded-md bg-white/8 text-white/50 active:scale-95"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(p.positionId)}
                        className="flex items-center gap-1 text-[10px] text-white/30 hover:text-red-400 transition-colors py-1 px-1.5 rounded"
                        title="Remove this trade and restore its balance impact"
                      >
                        <Trash2 className="w-3 h-3" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Mark as Loss modal */}
      {editLoss && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEditLoss(null)}>
          <div
            className="bg-[#0d0d18] border border-amber-500/30 rounded-2xl p-5 w-full max-w-sm space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h2 className="text-white font-bold text-base">Mark as Full Loss</h2>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-300 space-y-1">
              <p className="font-semibold">${editLoss.symbol} — Fake profit correction</p>
              <p className="text-amber-300/70">
                This will set the P&L to the full stop-loss amount ({-editLoss.slPercent}%) and mark it as a real loss.
                Use this when DexScreener showed a fake high price but the coin actually dumped to -100%.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-white/4 rounded-lg p-2.5">
                <p className="text-white/40 mb-1">Current P&L</p>
                <p className={`font-bold ${editLoss.currentPnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {editLoss.currentPnlSol >= 0 ? "+" : ""}{editLoss.currentPnlSol.toFixed(4)} SOL
                </p>
              </div>
              <div className="bg-red-500/10 rounded-lg p-2.5">
                <p className="text-white/40 mb-1">Will become</p>
                <p className="font-bold text-red-400">-{editLoss.slPercent}% (SL)</p>
              </div>
            </div>

            <div>
              <label className="text-xs text-white/40 mb-1.5 block">Note (optional)</label>
              <input
                type="text"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="e.g. Fake price shown on DexScreener"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-amber-500/40"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setEditLoss(null)}
                className="flex-1 py-2.5 rounded-xl bg-white/8 text-white/50 text-sm font-semibold active:scale-95 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkAsLoss}
                disabled={editClosedTrade.isPending}
                className="flex-1 py-2.5 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 text-sm font-bold active:scale-95 transition-all disabled:opacity-50"
              >
                {editClosedTrade.isPending ? "Saving…" : "Confirm Loss"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Prices modal */}
      {editPrices && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEditPrices(null)}>
          <div
            className="bg-[#0d0d18] border border-blue-500/30 rounded-2xl p-5 w-full max-w-sm space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-blue-400" />
              <h2 className="text-white font-bold text-base">Edit Entry / Exit Prices</h2>
            </div>

            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300 space-y-1">
              <p className="font-semibold">${editPrices.symbol} — Manual price correction</p>
              <p className="text-blue-300/70">
                Recalculates P&L from the prices you enter. Fees (0.3% + 0.5%) are automatically deducted.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Entry Price ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editPricesEntry}
                  onChange={(e) => setEditPricesEntry(e.target.value)}
                  placeholder="e.g. 0.00000123"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/40"
                />
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1.5 block">Exit Price ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editPricesExit}
                  onChange={(e) => setEditPricesExit(e.target.value)}
                  placeholder="e.g. 0.00000089"
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/40"
                />
              </div>
            </div>

            {(() => {
              const entry = parseFloat(editPricesEntry);
              const exit = parseFloat(editPricesExit);
              if (!entry || !exit || entry <= 0 || exit <= 0) return null;
              const gross = editPrices.sizeSol * (exit / entry);
              const fees = (gross + editPrices.sizeSol) * 0.003 + editPrices.sizeSol * 0.005;
              const pnl = gross - editPrices.sizeSol - fees;
              const pct = ((exit - entry) / entry) * 100;
              return (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-white/4 rounded-lg p-2.5">
                    <p className="text-white/40 mb-1">New P&L</p>
                    <p className={`font-bold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {pnl >= 0 ? "+" : ""}{pnl.toFixed(4)} SOL
                    </p>
                  </div>
                  <div className="bg-white/4 rounded-lg p-2.5">
                    <p className="text-white/40 mb-1">Return</p>
                    <p className={`font-bold ${pct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(1)}%
                    </p>
                  </div>
                </div>
              );
            })()}

            <div>
              <label className="text-xs text-white/40 mb-1.5 block">Note (optional)</label>
              <input
                type="text"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="e.g. Price on DexScreener was incorrect"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/40"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setEditPrices(null)}
                className="flex-1 py-2.5 rounded-xl bg-white/8 text-white/50 text-sm font-semibold active:scale-95 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={submitEditPrices}
                disabled={editClosedTrade.isPending || !parseFloat(editPricesEntry) || !parseFloat(editPricesExit)}
                className="flex-1 py-2.5 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-400 text-sm font-bold active:scale-95 transition-all disabled:opacity-50"
              >
                {editClosedTrade.isPending ? "Saving…" : "Save Prices"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mark as TP modal */}
      {markTp && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setMarkTp(null)}>
          <div
            className="bg-[#0d0d18] border border-emerald-500/30 rounded-2xl p-5 w-full max-w-sm space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
              <h2 className="text-white font-bold text-base">Mark as TP Win</h2>
            </div>

            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-xs text-emerald-300 space-y-1">
              <p className="font-semibold">${markTp.symbol} — Missed peak correction</p>
              <p className="text-emerald-300/70">
                This will set the P&L to the full take-profit amount (+{markTp.tpPercent}%) and mark it as a win.
                Use this when the token reached its target but the checker missed the spike.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-white/4 rounded-lg p-2.5">
                <p className="text-white/40 mb-1">Current P&L</p>
                <p className={`font-bold ${markTp.currentPnlSol >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {markTp.currentPnlSol >= 0 ? "+" : ""}{markTp.currentPnlSol.toFixed(4)} SOL
                </p>
              </div>
              <div className="bg-emerald-500/10 rounded-lg p-2.5">
                <p className="text-white/40 mb-1">Will become</p>
                <p className="font-bold text-emerald-400">+{markTp.tpPercent}% (TP)</p>
              </div>
            </div>

            <div>
              <label className="text-xs text-white/40 mb-1.5 block">Note (optional)</label>
              <input
                type="text"
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="e.g. Checker missed the peak — token hit target"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-white/25 focus:outline-none focus:border-emerald-500/40"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setMarkTp(null)}
                className="flex-1 py-2.5 rounded-xl bg-white/8 text-white/50 text-sm font-semibold active:scale-95 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkAsTp}
                disabled={editClosedTrade.isPending}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-bold active:scale-95 transition-all disabled:opacity-50"
              >
                {editClosedTrade.isPending ? "Saving…" : "Confirm TP Win"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
