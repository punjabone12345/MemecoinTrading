import { usePortfolio, usePositions, useAutoTraderStatus, useResetAccount, useAnalytics, usePumpfunStatus, usePumpfunTokens, usePumpfunPositions, usePumpfunHistory } from "@/lib/api";
import { TrendingUp, TrendingDown, Activity, Wallet, Target, Shield, RefreshCw, Rocket, Zap, BarChart3, ExternalLink } from "lucide-react";

function fmtSol(v: number | undefined) {
  if (v === undefined || v === null) return "0.0000";
  return Math.abs(v).toFixed(4);
}
function fmtMcap(mcap: number): string {
  if (!mcap) return "—";
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}
function fmtPrice(price: number): string {
  if (!price) return "—";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}
function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}
function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return `${s | 0}s ago`;
  if (s < 3600) return `${(s / 60) | 0}m ago`;
  return `${(s / 3600) | 0}h ago`;
}

export default function Dashboard() {
  const { data: portfolio } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: status } = useAutoTraderStatus();
  const { data: analytics } = useAnalytics();
  const resetAccount = useResetAccount();
  const { data: pfStatus } = usePumpfunStatus();
  const { data: pfTokens = [] } = usePumpfunTokens();
  const { data: pfHistory = [] } = usePumpfunHistory();
  const { data: pfPositions = [] } = usePumpfunPositions();

  const positions = positionsData?.positions ?? [];
  const totalLivePnl = positions.reduce((s, p) => s + (p.livePnlSol ?? 0), 0);
  const totalPnl = (portfolio?.totalPnlSol ?? 0) + totalLivePnl;
  const pnlPositive = totalPnl >= 0;

  const pfWins = pfHistory.filter((p) => p.realizedPnlSol > 0).length;
  const pfPnl = pfHistory.reduce((s, p) => s + p.realizedPnlSol, 0) +
    pfPositions.reduce((s, p) => s + (p.totalPnlSol ?? 0), 0);

  const hotTokens = pfTokens
    .filter((t) => t.status === "candidate" || t.status === "buySignal" || t.status === "bought")
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const recentTokens = pfTokens
    .filter((t) => t.status === "watching" || t.status === "rejected")
    .sort((a, b) => b.firstSeen - a.firstSeen)
    .slice(0, 12);

  return (
    <div className="px-3 py-4 space-y-4 pb-6">

      {/* ── Hero Balance ── */}
      <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-violet-950 via-purple-900/60 to-[#0d0d18] border border-violet-500/25 p-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.2),transparent_65%)]" />
        <div className="relative">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-white/40 text-[10px] font-bold uppercase tracking-widest">Total Balance</p>
              <p className="text-4xl font-black text-white mt-0.5 tracking-tight">
                {portfolio ? portfolio.solBalance.toFixed(4) : "—"}
                <span className="text-base font-semibold text-white/40 ml-1.5">SOL</span>
              </p>
              <div className={`flex items-center gap-1.5 mt-2 ${pnlPositive ? "text-emerald-400" : "text-red-400"}`}>
                {pnlPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                <span className="text-sm font-bold">
                  {pnlPositive ? "+" : "-"}{fmtSol(Math.abs(totalPnl))} SOL
                </span>
                <span className="text-[10px] text-white/30">all-time P&L</span>
              </div>
            </div>
            <div className="text-right">
              <div className={`px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1.5 ${
                status && !status.paused ? "bg-emerald-500/20 text-emerald-400" : "bg-white/8 text-white/40"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status && !status.paused ? "bg-emerald-400 animate-pulse" : "bg-white/30"}`} />
                {status && !status.paused ? "BOT LIVE" : "PAUSED"}
              </div>
            </div>
          </div>

          {/* Mini PnL breakdown */}
          <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-white/8">
            <div className="text-center">
              <p className="text-xs font-black text-white">{analytics ? `${analytics.winRate.toFixed(0)}%` : "—"}</p>
              <p className="text-[9px] text-white/30 mt-0.5">Win Rate</p>
            </div>
            <div className="text-center">
              <p className="text-xs font-black text-white">{analytics?.totalTrades ?? 0}</p>
              <p className="text-[9px] text-white/30 mt-0.5">Total Trades</p>
            </div>
            <div className="text-center">
              <p className="text-xs font-black text-white">{status?.scannerPoolSize ?? 0}</p>
              <p className="text-[9px] text-white/30 mt-0.5">Scanned</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Quick Stats ── */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-lg bg-violet-500/15 flex items-center justify-center">
              <Target className="w-3 h-3 text-violet-400" />
            </div>
            <span className="text-white/40 text-[10px] font-semibold">Open Positions</span>
          </div>
          <p className="text-2xl font-black text-white">
            {portfolio?.openPositionsCount ?? 0}
            <span className="text-sm text-white/25 font-normal">/{status?.config?.maxConcurrentTrades ?? 5}</span>
          </p>
        </div>

        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <Wallet className="w-3 h-3 text-emerald-400" />
            </div>
            <span className="text-white/40 text-[10px] font-semibold">Live P&L</span>
          </div>
          <p className={`text-2xl font-black ${totalLivePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {totalLivePnl >= 0 ? "+" : "-"}{fmtSol(Math.abs(totalLivePnl))}
            <span className="text-[10px] text-white/30 ml-0.5 font-normal">SOL</span>
          </p>
        </div>

        <div className="bg-[#0d0d18] border border-violet-500/15 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-lg bg-violet-500/15 flex items-center justify-center">
              <Rocket className="w-3 h-3 text-violet-400" />
            </div>
            <span className="text-white/40 text-[10px] font-semibold">PF Active</span>
          </div>
          <p className="text-2xl font-black text-white">
            {pfPositions.length}
            <span className="text-sm text-white/25 font-normal"> pos</span>
          </p>
          <p className={`text-[10px] font-bold mt-0.5 ${pfPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {pfPnl >= 0 ? "+" : ""}{pfPnl.toFixed(4)} SOL
          </p>
        </div>

        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded-lg bg-amber-500/15 flex items-center justify-center">
              <Shield className="w-3 h-3 text-amber-400" />
            </div>
            <span className="text-white/40 text-[10px] font-semibold">PF Win Rate</span>
          </div>
          <p className="text-2xl font-black text-white">
            {pfHistory.length > 0 ? `${((pfWins / pfHistory.length) * 100).toFixed(0)}%` : "—"}
          </p>
          <p className="text-[10px] text-white/30 mt-0.5">{pfHistory.length} trades</p>
        </div>
      </div>

      {/* ── Live Positions ── */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-violet-400" />
            <h3 className="text-xs font-bold text-white/70 uppercase tracking-wider">Running Positions</h3>
          </div>
          <span className="text-[10px] text-white/25">{positions.length} open</span>
        </div>

        {positions.length === 0 ? (
          <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-violet-500/8 flex items-center justify-center mx-auto mb-2">
              <Activity className="w-5 h-5 text-violet-400/30" />
            </div>
            <p className="text-white/25 text-sm">No open positions</p>
            <p className="text-white/15 text-[11px] mt-1">Bot is scanning for signals...</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {positions.map((p) => {
              const pnl = p.livePnlSol ?? 0;
              const pnlPct = p.livePnlPercent ?? 0;
              const isWin = pnl >= 0;
              const priceProgress = p.currentPrice && p.entryPrice && p.tpPrice
                ? Math.min(100, Math.max(0, ((p.currentPrice - p.entryPrice) / (p.tpPrice - p.entryPrice)) * 100))
                : 0;
              return (
                <div key={p.positionId} className={`rounded-xl overflow-hidden border ${isWin ? "border-emerald-500/25" : "border-red-500/20"}`}>
                  <div className={`px-4 py-2.5 flex items-center justify-between ${isWin ? "bg-emerald-500/8" : "bg-red-500/8"}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black text-white">${p.symbol}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md ${isWin ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                        {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                      </span>
                    </div>
                    <span className={`text-sm font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                      {isWin ? "+" : "-"}{fmtSol(Math.abs(pnl))} SOL
                    </span>
                  </div>
                  <div className="bg-[#0d0d18] px-4 py-3 space-y-2.5">
                    <div className="h-1 bg-white/6 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${isWin ? "bg-emerald-500" : "bg-red-500"}`} style={{ width: `${priceProgress}%` }} />
                    </div>
                    <div className="grid grid-cols-4 gap-1 text-[10px]">
                      <div>
                        <p className="text-white/30">Entry</p>
                        <p className="text-white font-mono font-semibold">${fmtPrice(p.entryPrice)}</p>
                      </div>
                      <div>
                        <p className="text-white/30">Now</p>
                        <p className={`font-mono font-bold ${isWin ? "text-emerald-400" : "text-red-400"}`}>${fmtPrice(p.currentPrice ?? p.entryPrice)}</p>
                      </div>
                      <div>
                        <p className="text-emerald-400/60">TP</p>
                        <p className="text-emerald-400 font-mono">+{p.tpPercent}%</p>
                      </div>
                      <div>
                        <p className="text-white/30">MCap</p>
                        <p className="text-white font-semibold">{fmtMcap(p.entryMarketCap)}</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex gap-2 text-[10px]">
                        {p.slPrice > p.entryPrice * 1.01 ? (
                          <span className="text-amber-400 font-semibold">🔒 SL locked +{((p.slPrice / p.entryPrice - 1) * 100).toFixed(0)}%</span>
                        ) : (
                          <span className="text-red-400/70">SL -{p.slPercent}%</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-white/25">{toIST(p.openedAt)}</span>
                        <a href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`} target="_blank" rel="noopener noreferrer"
                          className="text-[9px] text-violet-400">DEX ↗</a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pump.fun Live Signals ── */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-violet-400" />
            <h3 className="text-xs font-bold text-white/70 uppercase tracking-wider">Pump.fun Hot Signals</h3>
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`w-1.5 h-1.5 rounded-full ${pfStatus?.ppConnected ? "bg-emerald-400 animate-pulse" : "bg-white/20"}`} />
            <span className="text-[10px] text-white/30">{pfTokens.length} tracked</span>
          </div>
        </div>

        {hotTokens.length === 0 ? (
          <div className="bg-[#0d0d18] border border-white/6 rounded-xl p-6 text-center">
            <Rocket className="w-8 h-8 text-violet-400/20 mx-auto mb-2" />
            <p className="text-white/25 text-sm">No hot signals yet</p>
            <p className="text-white/15 text-[11px] mt-1">Watching {pfStatus?.trackedCount ?? 0} tokens...</p>
          </div>
        ) : (
          <div className="space-y-2">
            {hotTokens.map((t) => {
              const statusColor = t.status === "bought" ? "text-emerald-400 bg-emerald-500/15"
                : t.status === "buySignal" ? "text-violet-300 bg-violet-500/20 animate-pulse"
                : "text-amber-400 bg-amber-500/15";
              const statusLabel = t.status === "bought" ? "BOUGHT" : t.status === "buySignal" ? "SIGNAL" : "CANDIDATE";
              const grad = Math.min(t.graduationPct, 100);
              const gradColor = grad >= 95 ? "bg-emerald-500" : grad >= 85 ? "bg-amber-400" : "bg-blue-400";
              return (
                <div key={t.mint} className="bg-[#0d0d18] border border-white/8 rounded-xl p-3.5">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white">${t.symbol}</span>
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md ${statusColor}`}>{statusLabel}</span>
                      </div>
                      <p className="text-[10px] text-white/30 truncate max-w-[160px]">{t.name}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm font-black ${t.score >= 80 ? "text-emerald-400" : t.score >= 60 ? "text-amber-400" : "text-white/50"}`}>{t.score}</p>
                      <p className="text-[9px] text-white/25">AI score</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${gradColor}`} style={{ width: `${grad}%` }} />
                    </div>
                    <span className={`text-[10px] font-bold w-10 text-right ${grad >= 85 ? "text-amber-400" : "text-white/40"}`}>{grad.toFixed(1)}%</span>
                  </div>
                  <div className="flex items-center justify-between text-[9px] text-white/30">
                    <span>MCap {t.mcap ? fmtMcap(t.mcap) : "—"}</span>
                    <span>{t.uniqueBuyers?.length ?? 0} buyers</span>
                    <span>{timeAgo(t.firstSeen)}</span>
                    {t.pairAddress && (
                      <a href={`https://dexscreener.com/solana/${t.pairAddress}`} target="_blank" rel="noopener noreferrer"
                        className="text-violet-400">DEX ↗</a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pump.fun Recently Scanned ── */}
      {recentTokens.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <BarChart3 className="w-3.5 h-3.5 text-white/30" />
            <h3 className="text-xs font-bold text-white/40 uppercase tracking-wider">Recently Scanned</h3>
          </div>
          <div className="bg-[#0d0d18] border border-white/6 rounded-xl overflow-hidden divide-y divide-white/4">
            {recentTokens.map((t) => (
              <div key={t.mint} className="flex items-center justify-between px-3.5 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-xs font-bold text-white truncate">${t.symbol}</span>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                    t.status === "rejected" ? "bg-red-500/10 text-red-400/60" : "bg-white/6 text-white/30"
                  }`}>{t.status}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[10px] text-white/40">{t.graduationPct.toFixed(0)}% grad</span>
                  <span className={`text-[10px] font-bold ${t.score >= 60 ? "text-amber-400" : "text-white/25"}`}>{t.score}</span>
                  <span className="text-[9px] text-white/20">{timeAgo(t.firstSeen)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Danger Zone ── */}
      <div className="bg-[#0d0d18] border border-red-500/10 rounded-xl p-4">
        <h3 className="text-[10px] font-bold text-red-400/60 uppercase tracking-wider mb-1">Danger Zone</h3>
        <p className="text-white/30 text-[11px] mb-3">Reset to 100 SOL and clear all trade history.</p>
        <button
          onClick={() => { if (confirm("Reset account to 100 SOL? All positions and history will be cleared.")) resetAccount.mutate(); }}
          disabled={resetAccount.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/15 text-red-400 text-xs font-semibold active:scale-95 transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reset Account
        </button>
      </div>
    </div>
  );
}
