import { useState, useEffect } from "react";
import {
  Wifi, WifiOff, TrendingUp, Users, Activity, Zap,
  Shield, ShieldOff, Clock, DollarSign, Target, BarChart2,
  ChevronRight, Search,
} from "lucide-react";
import { useEDStatus, useEDTokens, useEDPositions, useWebSocket } from "@/lib/api";
import type { EDToken, EDPosition } from "@/lib/types";

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtAge(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

function fmtSol(v: number): string {
  return v >= 0 ? `+${v.toFixed(4)}` : v.toFixed(4);
}

function fmtMcap(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

const STATUS_COLOR: Record<string, string> = {
  tracking: "bg-white/10 text-white/50",
  eligible: "bg-amber-500/20 text-amber-400",
  entered:  "bg-violet-500/20 text-violet-400",
  rejected: "bg-red-500/10 text-red-400/60",
  exited:   "bg-white/10 text-white/30",
};

const STATUS_LABEL: Record<string, string> = {
  tracking: "TRACKING",
  eligible: "ELIGIBLE",
  entered:  "ACTIVE",
  rejected: "REJECTED",
  exited:   "EXITED",
};

// ── Sub-components ─────────────────────────────────────────────────────────────
function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-white/3 rounded-lg px-2 py-1.5 text-center border border-white/5">
      <div className={`text-base font-black font-mono ${color}`}>{value}</div>
      <div className="text-[9px] text-white/30 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  );
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-xs text-white/50">{label}</span>
        <span className="text-xs font-mono font-bold text-white/80">{value}/{max}</span>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TokenRow({ token, isSelected, onClick }: { token: EDToken; isSelected: boolean; onClick: () => void }) {
  const score = token.scores.finalScore;
  const scoreColor = score >= 110 ? "text-green-400" : score >= 95 ? "text-amber-400" : score >= 70 ? "text-blue-400" : "text-white/40";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors border ${
        isSelected
          ? "bg-violet-500/15 border-violet-500/40"
          : "bg-white/3 hover:bg-white/6 border-white/5 hover:border-white/10"
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-bold text-sm text-white truncate">${token.symbol}</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${STATUS_COLOR[token.status]}`}>
              {STATUS_LABEL[token.status]}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-white/40">
            <span>{fmtMcap(token.marketCapUsd)}</span>
            <span>•</span>
            <span>{token.uniqueBuyers} buyers</span>
            <span>•</span>
            <span>{fmtAge(token.launchAt)} ago</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-mono font-bold text-sm ${scoreColor}`}>{score}</div>
          <div className="text-[10px] text-white/30">/ 120</div>
        </div>
        <ChevronRight size={14} className="text-white/20 shrink-0" />
      </div>
    </button>
  );
}

function PositionCard({ pos }: { pos: EDPosition }) {
  const isProfit = pos.pnlPct >= 0;
  return (
    <div className={`rounded-xl p-3 border ${isProfit ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="font-bold text-sm text-white">${pos.symbol}</span>
          <span className="ml-2 text-xs text-white/40">Score: {pos.entryScore}</span>
        </div>
        <div className={`font-mono font-bold text-sm ${isProfit ? "text-green-400" : "text-red-400"}`}>
          {isProfit ? "+" : ""}{pos.pnlPct.toFixed(1)}%
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div>
          <div className="text-white/40 mb-0.5">Entry</div>
          <div className="text-white/70 font-mono">${pos.entryPrice.toExponential(2)}</div>
        </div>
        <div>
          <div className="text-white/40 mb-0.5">Current</div>
          <div className="text-white/70 font-mono">${pos.currentPrice.toExponential(2)}</div>
        </div>
        <div>
          <div className="text-white/40 mb-0.5">P&L</div>
          <div className={`font-mono font-bold ${isProfit ? "text-green-400" : "text-red-400"}`}>
            {fmtSol(pos.totalPnlSol)} SOL
          </div>
        </div>
      </div>
      <div className="flex gap-2 mt-2 text-[10px]">
        <span className={`px-1.5 py-0.5 rounded ${pos.tp1Hit ? "bg-green-500/20 text-green-400" : "bg-white/5 text-white/30"}`}>TP1</span>
        <span className={`px-1.5 py-0.5 rounded ${pos.tp2Hit ? "bg-green-500/20 text-green-400" : "bg-white/5 text-white/30"}`}>TP2</span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/30">{(pos.remainingFraction * 100).toFixed(0)}% rem</span>
        <span className="ml-auto text-white/30">{fmtAge(pos.entryAt)} ago</span>
      </div>
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 p-2 bg-white/3 rounded-lg">
      <span className="text-white/40 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] text-white/40">{label}</div>
        <div className="text-xs font-mono font-bold text-white/80 truncate">{value}</div>
      </div>
    </div>
  );
}

function TokenDetail({ token }: { token: EDToken }) {
  const score = token.scores.finalScore;
  const scoreColor = score >= 110 ? "text-green-400" : score >= 95 ? "text-amber-400" : score >= 70 ? "text-blue-400" : "text-white/50";
  const scoreRing  = score >= 110 ? "border-green-500/50"  : score >= 95  ? "border-amber-500/50"  : "border-white/10";

  return (
    <div className="space-y-4">
      {/* Token header */}
      <div className="flex items-center gap-4 p-4 bg-white/3 rounded-xl border border-white/8">
        <div className={`w-16 h-16 rounded-full border-2 ${scoreRing} flex items-center justify-center shrink-0`}>
          <div className="text-center">
            <div className={`text-2xl font-black font-mono ${scoreColor}`}>{score}</div>
            <div className="text-[9px] text-white/30">/ 120</div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-xl text-white">${token.symbol}</div>
          <div className="text-sm text-white/50 truncate">{token.name}</div>
          <div className="flex items-center gap-2 mt-1">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${STATUS_COLOR[token.status]}`}>
              {STATUS_LABEL[token.status]}
            </span>
            {token.rugcheckStatus === "passed" && (
              <span className="flex items-center gap-1 text-[10px] text-green-400/80"><Shield size={10}/> SAFE</span>
            )}
            {token.rugcheckStatus === "failed" && (
              <span className="flex items-center gap-1 text-[10px] text-red-400/80"><ShieldOff size={10}/> RISKY</span>
            )}
          </div>
        </div>
        <a
          href={`https://dexscreener.com/solana/${token.mint}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-violet-400 hover:text-violet-300 underline shrink-0"
        >
          Chart ↗
        </a>
      </div>

      {/* Score breakdown */}
      <div className="p-4 bg-white/3 rounded-xl border border-white/8 space-y-3">
        <div className="text-xs font-bold text-white/60 uppercase tracking-widest mb-3">Demand Scores</div>
        <ScoreBar label="Buyer Growth"    value={token.scores.buyerGrowthScore}   max={25} color="bg-violet-500" />
        <ScoreBar label="Volume"          value={token.scores.volumeScore}         max={25} color="bg-blue-500" />
        <ScoreBar label="Buy Pressure"    value={token.scores.buyPressureScore}    max={25} color="bg-cyan-500" />
        <ScoreBar label="Wallet Quality"  value={token.scores.walletQualityScore}  max={25} color="bg-green-500" />
        <ScoreBar label="Bonding Curve"   value={token.scores.bondingCurveScore}   max={20} color="bg-amber-500" />
      </div>

      {/* Live metrics */}
      <div className="p-4 bg-white/3 rounded-xl border border-white/8">
        <div className="text-xs font-bold text-white/60 uppercase tracking-widest mb-3">Live Metrics</div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <Metric label="Unique Buyers"  value={String(token.uniqueBuyers)}              icon={<Users size={12}/>} />
          <Metric label="Buyers/min"     value={token.buyersPerMinute.toFixed(1)}         icon={<TrendingUp size={12}/>} />
          <Metric label="Buy Volume"     value={`${token.buyVolumeSol.toFixed(2)} SOL`}   icon={<Activity size={12}/>} />
          <Metric label="Buy Pressure"   value={`${token.scores.buyPressureRatio.toFixed(1)}x`} icon={<Zap size={12}/>} />
          <Metric label="Bonding Curve"  value={`${token.bondingCurvePct.toFixed(1)}%`}  icon={<BarChart2 size={12}/>} />
          <Metric label="Market Cap"     value={fmtMcap(token.marketCapUsd)}              icon={<DollarSign size={12}/>} />
          <Metric label="Top Holder"     value={`${token.topHolderPct.toFixed(1)}%`}      icon={<Target size={12}/>} />
          <Metric label="Rugcheck"       value={token.rugcheckStatus}                     icon={<Shield size={12}/>} />
        </div>
      </div>

      {/* Status callouts */}
      {token.status === "eligible" && token.firstEligibleAt && (
        <div className="p-3 bg-amber-500/10 rounded-xl border border-amber-500/30 flex items-center gap-2">
          <Clock size={14} className="text-amber-400 shrink-0" />
          <div>
            <div className="text-xs font-bold text-amber-400">CONFIRMING ELIGIBILITY</div>
            <div className="text-xs text-amber-400/70">
              {Math.floor((Date.now() - token.firstEligibleAt) / 1000)}s / 120s window
            </div>
          </div>
        </div>
      )}
      {token.status === "rejected" && (
        <div className="p-3 bg-red-500/10 rounded-xl border border-red-500/30">
          <div className="text-xs font-bold text-red-400 mb-1">REJECTED</div>
          <div className="text-xs text-red-400/70">{token.rejectionReason || "Did not meet entry criteria"}</div>
        </div>
      )}
      {token.positionId && (
        <div className="p-3 bg-violet-500/10 rounded-xl border border-violet-500/30 flex items-center gap-2">
          <Target size={14} className="text-violet-400 shrink-0" />
          <div className="text-xs font-bold text-violet-400">PAPER TRADE ACTIVE</div>
        </div>
      )}

      <div className="px-1">
        <div className="text-xs text-white/30 font-mono break-all">{token.mint}</div>
        <div className="text-xs text-white/20 mt-1">Launched {fmtAge(token.launchAt)} ago · Poll #{token.pollCount}</div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  useWebSocket();
  const statusQ    = useEDStatus();
  const tokensQ    = useEDTokens();
  const positionsQ = useEDPositions();

  const status    = statusQ.data;
  const tokens    = tokensQ.data ?? [];
  const positions = positionsQ.data;
  const open      = positions?.open ?? [];
  const closed    = positions?.closed ?? [];

  useEffect(() => {
    if (!selectedMint && tokens.length > 0) {
      const best = tokens.find((t) => t.status === "eligible" || t.status === "entered") ?? tokens[0];
      if (best) setSelectedMint(best.mint);
    }
  }, [tokens, selectedMint]);

  const selectedToken = tokens.find((t) => t.mint === selectedMint);
  const activeTokens  = tokens.filter((t) => t.status !== "rejected");

  const totalPnl = (status?.totalRealizedPnlSol ?? 0) + (status?.totalUnrealizedPnlSol ?? 0);
  const pnlIsPos = totalPnl >= 0;
  const winRate  = (status?.tradesTotal ?? 0) > 0
    ? `${((status!.wins / status!.tradesTotal) * 100).toFixed(0)}%` : "—";

  return (
    <div className="flex flex-col h-screen bg-[#09090f] text-white pb-16">
      {/* Top status bar */}
      <div className="flex-shrink-0 border-b border-white/8 px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-violet-600 flex items-center justify-center">
              <Search size={12} className="text-white" />
            </div>
            <span className="font-black text-sm tracking-wider text-white">EARLY DISCOVERY</span>
          </div>
          <div className="flex items-center gap-1.5">
            {status?.wsConnected
              ? <><Wifi size={12} className="text-green-400"/><span className="text-[10px] text-green-400 font-bold ml-0.5">LIVE</span></>
              : <><WifiOff size={12} className="text-amber-400"/><span className="text-[10px] text-amber-400 ml-0.5">OFFLINE</span></>
            }
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 mb-2">
          <StatPill label="LAUNCHES"  value={String(status?.launchesDetected ?? 0)} color="text-white/70" />
          <StatPill label="TRACKING"  value={String(status?.trackedCount ?? 0)}     color="text-blue-400" />
          <StatPill label="ELIGIBLE"  value={String(status?.eligibleCount ?? 0)}    color="text-amber-400" />
          <StatPill label="ACTIVE"    value={String(status?.openCount ?? 0)}         color="text-violet-400" />
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-white/40">Balance </span>
            <span className="font-mono font-bold text-white">{(status?.virtualBalance ?? 0).toFixed(3)} SOL</span>
          </div>
          <div>
            <span className="text-white/40">PnL </span>
            <span className={`font-mono font-bold ${pnlIsPos ? "text-green-400" : "text-red-400"}`}>
              {fmtSol(totalPnl)} SOL
            </span>
          </div>
          <div>
            <span className="text-white/40">W/L </span>
            <span className="font-mono text-white/70">{status?.wins ?? 0}/{status?.losses ?? 0} ({winRate})</span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden flex min-h-0">
        {/* Left: Token feed */}
        <div className="w-1/2 flex flex-col border-r border-white/5 min-h-0">
          <div className="flex-shrink-0 px-3 pt-3 pb-2">
            <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
              Launch Feed ({activeTokens.length})
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
            {activeTokens.length === 0 ? (
              <div className="text-center py-12 text-white/20 text-sm">
                <Activity size={24} className="mx-auto mb-2 opacity-30" />
                <div>Waiting for launches…</div>
                <div className="text-xs mt-1">{status?.wsConnected ? "WebSocket connected" : "Paper mode (no API key)"}</div>
              </div>
            ) : (
              activeTokens.map((token) => (
                <TokenRow
                  key={token.mint}
                  token={token}
                  isSelected={token.mint === selectedMint}
                  onClick={() => setSelectedMint(token.mint)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right: Detail + positions */}
        <div className="w-1/2 flex flex-col min-h-0 overflow-y-auto">
          <div className="flex-shrink-0 p-3">
            {selectedToken ? (
              <TokenDetail token={selectedToken} />
            ) : (
              <div className="text-center py-12 text-white/20 text-sm">
                <Target size={24} className="mx-auto mb-2 opacity-30" />
                <div>Select a token to inspect</div>
              </div>
            )}
          </div>

          {open.length > 0 && (
            <div className="px-3 pb-3 border-t border-white/5 pt-3">
              <div className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-2">
                Open Trades ({open.length})
              </div>
              <div className="space-y-2">
                {open.map((pos) => <PositionCard key={pos.id} pos={pos} />)}
              </div>
            </div>
          )}

          {closed.length > 0 && (
            <div className="px-3 pb-3 border-t border-white/5 pt-3">
              <button
                onClick={() => setShowClosed(!showClosed)}
                className="text-[10px] font-bold text-white/40 uppercase tracking-widest hover:text-white/60 flex items-center gap-1"
              >
                History ({closed.length}) {showClosed ? "▲" : "▼"}
              </button>
              {showClosed && (
                <div className="mt-2 space-y-2">
                  {closed.slice(0, 20).map((pos) => <PositionCard key={pos.id} pos={pos} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
