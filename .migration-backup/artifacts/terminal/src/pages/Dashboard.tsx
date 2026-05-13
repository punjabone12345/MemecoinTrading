import { usePortfolio, usePositions, useAutoTraderStatus, useResetAccount, useAnalytics } from "@/lib/api";
import { TrendingUp, TrendingDown, Activity, Wallet, Target, Shield, RefreshCw } from "lucide-react";

function formatSol(v: number | undefined) {
  if (v === undefined || v === null) return "0.0000";
  return Math.abs(v).toFixed(4);
}

function formatMcap(mcap: number): string {
  if (!mcap) return "—";
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

function formatPrice(price: number): string {
  if (!price) return "—";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

function toIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export default function Dashboard() {
  const { data: portfolio } = usePortfolio();
  const { data: positionsData } = usePositions();
  const { data: status } = useAutoTraderStatus();
  const { data: analytics } = useAnalytics();
  const resetAccount = useResetAccount();

  const positions = positionsData?.positions ?? [];
  const totalLivePnl = positions.reduce((s, p) => s + (p.livePnlSol ?? 0), 0);
  const totalPnl = (portfolio?.totalPnlSol ?? 0) + totalLivePnl;
  const pnlPositive = totalPnl >= 0;
  const isRunning = status && !status.paused;

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Hero Balance Card */}
      <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-violet-900/60 via-purple-900/40 to-[#0d0d18] border border-violet-500/20 p-5">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.15),transparent_60%)]" />
        <div className="relative">
          <p className="text-white/50 text-xs font-semibold uppercase tracking-widest">Total Balance</p>
          <p className="text-4xl font-black text-white mt-1">
            {portfolio ? portfolio.solBalance.toFixed(4) : "0.0000"}
            <span className="text-lg font-semibold text-white/50 ml-1">SOL</span>
          </p>
          <div className={`flex items-center gap-1.5 mt-2 ${pnlPositive ? "text-emerald-400" : "text-red-400"}`}>
            {pnlPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            <span className="text-sm font-bold">
              {pnlPositive ? "+" : "-"}{formatSol(Math.abs(totalPnl))} SOL
            </span>
            <span className="text-xs text-white/40">all-time P&L</span>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center">
              <Target className="w-3.5 h-3.5 text-violet-400" />
            </div>
            <span className="text-white/50 text-xs font-medium">Open Positions</span>
          </div>
          <p className="text-2xl font-black text-white">{portfolio?.openPositionsCount ?? 0}<span className="text-sm text-white/30">/{status?.config.maxConcurrentTrades ?? 5}</span></p>
        </div>

        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 flex items-center justify-center">
              <Activity className="w-3.5 h-3.5 text-blue-400" />
            </div>
            <span className="text-white/50 text-xs font-medium">Scanner Pool</span>
          </div>
          <p className="text-2xl font-black text-white">{status?.scannerPoolSize ?? 0}<span className="text-xs text-white/30 ml-1">tokens</span></p>
        </div>

        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <Wallet className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <span className="text-white/50 text-xs font-medium">Live P&L</span>
          </div>
          <p className={`text-2xl font-black ${totalLivePnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {totalLivePnl >= 0 ? "+" : "-"}{formatSol(Math.abs(totalLivePnl))}
            <span className="text-xs text-white/30 ml-1">SOL</span>
          </p>
        </div>

        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center">
              <Shield className="w-3.5 h-3.5 text-amber-400" />
            </div>
            <span className="text-white/50 text-xs font-medium">Win Rate</span>
          </div>
          <p className="text-2xl font-black text-white">
            {analytics ? `${(analytics.winRate * 100).toFixed(1)}%` : "—"}
          </p>
        </div>
      </div>

      {/* Live Positions */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-bold text-white/80 uppercase tracking-wider">Live Positions</h3>
          <span className="text-xs text-white/30">{positions.length} open</span>
        </div>

        {positions.length === 0 ? (
          <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-6 text-center">
            <div className="w-10 h-10 rounded-full bg-violet-500/10 flex items-center justify-center mx-auto mb-2">
              <Activity className="w-5 h-5 text-violet-400/50" />
            </div>
            <p className="text-white/30 text-sm">No open positions</p>
            <p className="text-white/20 text-xs mt-1">Bot is scanning for signals...</p>
          </div>
        ) : (
          <div className="space-y-3">
            {positions.map((p) => {
              const pnl = p.livePnlSol ?? 0;
              const pnlPct = p.livePnlPercent ?? 0;
              const isWin = pnl >= 0;
              const priceProgress = p.currentPrice && p.entryPrice && p.tpPrice
                ? Math.min(100, Math.max(0, ((p.currentPrice - p.entryPrice) / (p.tpPrice - p.entryPrice)) * 100))
                : 0;

              return (
                <div key={p.positionId} className={`bg-[#0d0d18] border rounded-xl p-4 ${isWin ? "border-emerald-500/20" : "border-red-500/20"}`}>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-black text-white">${p.symbol}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${isWin ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                          {isWin ? "+" : ""}{pnlPct.toFixed(1)}%
                        </span>
                      </div>
                      <p className="text-white/40 text-xs mt-0.5">{p.tokenName}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-base font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
                        {isWin ? "+" : ""}{formatSol(Math.abs(pnl))} SOL
                      </p>
                      <p className="text-white/30 text-xs">{toIST(p.openedAt)}</p>
                    </div>
                  </div>

                  {/* Price bar */}
                  <div className="relative h-1.5 bg-white/8 rounded-full overflow-hidden mb-3">
                    <div
                      className={`absolute left-0 top-0 h-full rounded-full transition-all ${isWin ? "bg-emerald-500" : "bg-red-500"}`}
                      style={{ width: `${priceProgress}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <p className="text-white/30">Entry</p>
                      <p className="text-white font-mono font-semibold">${formatPrice(p.entryPrice)}</p>
                    </div>
                    <div>
                      <p className="text-white/30">Current</p>
                      <p className={`font-mono font-semibold ${isWin ? "text-emerald-400" : "text-red-400"}`}>${formatPrice(p.currentPrice ?? p.entryPrice)}</p>
                    </div>
                    <div>
                      <p className="text-white/30">MCap</p>
                      <p className="text-white font-semibold">{formatMcap(p.entryMarketCap)}</p>
                    </div>
                  </div>

                  <div className="mt-2 flex justify-between items-center">
                    <div className="flex gap-3 text-xs">
                      <span className="text-emerald-400">TP +{p.tpPercent}% → {formatMcap(p.tpMarketCap)}</span>
                      <span className="text-red-400">SL -{p.slPercent}%</span>
                    </div>
                    <a
                      href={`https://dexscreener.com/solana/${p.contractAddress || p.pairAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-violet-400 underline"
                    >
                      DEX ↗
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Quick stats */}
      {analytics && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <h3 className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3">Performance Summary</h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-lg font-black text-white">{analytics.totalTrades}</p>
              <p className="text-[10px] text-white/40">Total Trades</p>
            </div>
            <div>
              <p className="text-lg font-black text-emerald-400">{analytics.winCount}</p>
              <p className="text-[10px] text-white/40">Wins</p>
            </div>
            <div>
              <p className="text-lg font-black text-red-400">{analytics.lossCount}</p>
              <p className="text-[10px] text-white/40">Losses</p>
            </div>
          </div>
        </div>
      )}

      {/* Reset Account */}
      <div className="bg-[#0d0d18] border border-red-500/15 rounded-xl p-4">
        <h3 className="text-xs font-bold text-red-400/80 uppercase tracking-wider mb-1">Danger Zone</h3>
        <p className="text-white/40 text-xs mb-3">Reset account to 100 SOL and clear all trade history.</p>
        <button
          onClick={() => {
            if (confirm("Reset account to 100 SOL? This will clear all positions and history.")) {
              resetAccount.mutate();
            }
          }}
          disabled={resetAccount.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-semibold active:scale-95 transition-all"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reset Account
        </button>
      </div>
    </div>
  );
}
