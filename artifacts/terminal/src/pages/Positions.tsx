import { useState } from "react";
import { usePositions, useClosedPositions, useClosePosition, useDeleteClosedTrade, useEditClosedTrade } from "@/lib/api";
import { TrendingUp, TrendingDown, Clock, ExternalLink, X, Trash2, Pencil, AlertTriangle } from "lucide-react";

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

export default function Positions() {
  const [tab, setTab] = useState<"Open" | "Closed">("Open");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editLoss, setEditLoss] = useState<EditLossState | null>(null);
  const [editNote, setEditNote] = useState("");

  const { data: positionsData } = usePositions();
  const { data: closedPositions = [] } = useClosedPositions();
  const closePosition = useClosePosition();
  const deleteClosedTrade = useDeleteClosedTrade();
  const editClosedTrade = useEditClosedTrade();

  const openPositions = positionsData?.positions ?? [];

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

  function submitMarkAsLoss() {
    if (!editLoss) return;
    // Compute the full SL loss: sizeSol × (slPercent / 100) with fees
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

            return (
              <div key={p.positionId} className={`bg-[#0d0d18] border rounded-2xl overflow-hidden ${isWin ? "border-emerald-500/20" : "border-red-500/20"}`}>
                <div className={`px-4 py-3 flex items-center justify-between ${isWin ? "bg-emerald-500/8" : "bg-red-500/8"}`}>
                  <div className="flex items-center gap-2">
                    {isWin ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                    <span className="font-black text-white text-base">${p.symbol}</span>
                    <span className="text-white/40 text-xs">{p.tokenName}</span>
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
                      <span className="text-red-400">SL Price</span>
                      <span className="font-mono text-red-400">${formatPrice(p.slPrice)} (-{p.slPercent}%)</span>
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
            const reasonColor = p.closeReason === "take_profit" ? "text-emerald-400 bg-emerald-500/15" : p.closeReason === "stop_loss" ? "text-red-400 bg-red-500/15" : "text-white/50 bg-white/8";
            const reasonLabel = p.closeReason === "take_profit" ? "✅ TP Hit" : p.closeReason === "stop_loss" ? "🛑 SL Hit" : "⚪ Manual";
            const isConfirming = confirmDeleteId === p.positionId;

            return (
              <div key={p.positionId} className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
                <div className="px-4 py-3 flex items-center justify-between border-b border-white/5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-white">${p.symbol}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${reasonColor}`}>{reasonLabel}</span>
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
                    {/* Mark as loss button */}
                    {!isConfirming && (
                      <button
                        onClick={() => openEditLoss(p)}
                        className="flex items-center gap-1 text-[10px] text-amber-400/60 hover:text-amber-400 transition-colors py-1 px-1.5 rounded"
                        title="Mark this trade as a loss (e.g. fake price from DexScreener)"
                      >
                        <Pencil className="w-3 h-3" />
                        Mark Loss
                      </button>
                    )}

                    {/* Delete trade with confirm */}
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
    </div>
  );
}
