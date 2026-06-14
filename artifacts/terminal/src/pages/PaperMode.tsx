import { useState } from "react";
import { useLocation } from "wouter";
import { FileText, TrendingUp, TrendingDown, RotateCcw, CheckCircle2, XCircle, Clock, ExternalLink, Target, Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { usePaperSniperStatus, usePaperSniperPositions, usePaperSniperHistory, usePaperSniperEvents, useResetPaperAccount } from "@/lib/api";
import { PaperPosition, PaperSniperEvent } from "@/lib/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 4): string { return n.toFixed(d); }
function fmtSigned(n: number, d = 4): string { return (n >= 0 ? "+" : "") + n.toFixed(d); }
function fmtPct(n: number): string { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function fmtPrice(p: number): string { return p < 0.0001 ? p.toExponential(3) : p.toFixed(6); }
function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function holdTime(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
function mintShort(mint: string): string { return `${mint.slice(0, 4)}…${mint.slice(-4)}`; }
function solscanUrl(mint: string): string { return `https://solscan.io/token/${mint}`; }

// ── Tab nav ───────────────────────────────────────────────────────────────────

function TabNav() {
  const [location, navigate] = useLocation();
  return (
    <div className="flex gap-1 bg-[#12121a] border border-[#1e1e2e] rounded-lg p-1">
      <button
        onClick={() => navigate("/sniper")}
        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
          location === "/" || location === "/sniper"
            ? "bg-violet-600 text-white"
            : "text-gray-400 hover:text-white hover:bg-[#1e1e2e]"
        }`}
      >
        <Target size={14} />
        LIVE SNIPER
      </button>
      <button
        onClick={() => navigate("/paper")}
        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
          location === "/paper"
            ? "bg-amber-500 text-black"
            : "text-gray-400 hover:text-white hover:bg-[#1e1e2e]"
        }`}
      >
        <FileText size={14} />
        PAPER MODE
      </button>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, positive }: {
  label: string; value: string; sub?: string; positive?: boolean;
}) {
  return (
    <div className="bg-[#12121a] border border-[#1e1e2e] rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${
        positive === true ? "text-green-400" : positive === false ? "text-red-400" : "text-amber-400"
      }`}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Open position row ─────────────────────────────────────────────────────────

function OpenPositionRow({ pos }: { pos: PaperPosition }) {
  const pnl = pos.unrealizedPnlSol + pos.realizedPnlSol;
  const pnlPct = pos.pnlPct;
  const isUp = pnl >= 0;
  const ageMs = Date.now() - pos.entryAt;

  return (
    <tr className="border-b border-[#1e1e2e] hover:bg-[#0f0f18] transition-colors">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-amber-400">{pos.symbol || mintShort(pos.mint)}</span>
          <a href={solscanUrl(pos.mint)} target="_blank" rel="noopener noreferrer"
            className="text-gray-600 hover:text-gray-400">
            <ExternalLink size={11} />
          </a>
        </div>
        <div className="text-xs text-gray-600 font-mono">{mintShort(pos.mint)}</div>
      </td>
      <td className="px-3 py-3 font-mono text-xs text-gray-300">
        ${fmtPrice(pos.entryPrice)}
      </td>
      <td className="px-3 py-3 font-mono text-xs text-gray-300">
        {pos.currentPrice > 0 ? `$${fmtPrice(pos.currentPrice)}` : "—"}
      </td>
      <td className="px-3 py-3">
        <span className={`font-mono text-sm font-bold ${isUp ? "text-green-400" : "text-red-400"}`}>
          {fmtPct(pnlPct)}
        </span>
      </td>
      <td className="px-3 py-3">
        <span className={`font-mono text-sm font-bold ${isUp ? "text-green-400" : "text-red-400"}`}>
          {fmtSigned(pnl)} SOL
        </span>
        <div className="text-xs text-gray-600">{fmt(pos.sizeSol)} SOL in</div>
      </td>
      <td className="px-3 py-3">
        <div className="flex gap-1">
          {pos.tp1Hit && <Badge className="bg-green-900/40 text-green-400 border-green-800 text-xs px-1">TP1</Badge>}
          {pos.tp2Hit && <Badge className="bg-green-900/40 text-green-400 border-green-800 text-xs px-1">TP2</Badge>}
          {!pos.tp1Hit && !pos.tp2Hit && <span className="text-gray-600 text-xs">—</span>}
        </div>
      </td>
      <td className="px-3 py-3 text-xs text-gray-500">
        {holdTime(ageMs)}
      </td>
    </tr>
  );
}

// ── Closed position row ───────────────────────────────────────────────────────

function HistoryRow({ pos }: { pos: PaperPosition }) {
  const isWin = pos.realizedPnlSol >= 0;
  const holdMs = pos.closedAt && pos.entryAt ? pos.closedAt - pos.entryAt : 0;

  return (
    <tr className="border-b border-[#1e1e2e] hover:bg-[#0f0f18] transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {isWin ? <CheckCircle2 size={12} className="text-green-400" /> : <XCircle size={12} className="text-red-400" />}
          <span className="font-bold text-sm text-white">{pos.symbol || mintShort(pos.mint)}</span>
          <a href={solscanUrl(pos.mint)} target="_blank" rel="noopener noreferrer"
            className="text-gray-600 hover:text-gray-400">
            <ExternalLink size={10} />
          </a>
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-gray-400">
        ${fmtPrice(pos.entryPrice)}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-gray-400">
        {pos.exitPrice ? `$${fmtPrice(pos.exitPrice)}` : "—"}
      </td>
      <td className="px-3 py-2.5">
        <span className={`font-mono text-sm font-bold ${isWin ? "text-green-400" : "text-red-400"}`}>
          {fmtSigned(pos.realizedPnlSol)} SOL
        </span>
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500 max-w-[180px] truncate">
        {pos.closeReason ?? "—"}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-500">
        {holdMs ? holdTime(holdMs) : "—"}
      </td>
      <td className="px-3 py-2.5 text-xs text-gray-600">
        {pos.closedAt ? timeAgo(pos.closedAt) : "—"}
      </td>
    </tr>
  );
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ ev }: { ev: PaperSniperEvent }) {
  const icon = ev.action === "entered"
    ? <Activity size={12} className="text-amber-400" />
    : ev.action === "closed"
      ? (ev.pnlSol != null && ev.pnlSol >= 0
          ? <CheckCircle2 size={12} className="text-green-400" />
          : <XCircle size={12} className="text-red-400" />)
      : <XCircle size={12} className="text-gray-500" />;

  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-[#1a1a24] text-xs">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <span className="text-gray-300 font-mono font-bold">{ev.symbol || mintShort(ev.mint)}</span>
        {" "}
        {ev.action === "entered" && <span className="text-amber-400">PAPER ENTRY</span>}
        {ev.action === "closed" && (
          <span className={ev.pnlSol != null && ev.pnlSol >= 0 ? "text-green-400" : "text-red-400"}>
            CLOSED {ev.pnlSol != null ? `(${fmtSigned(ev.pnlSol, 4)} SOL)` : ""}
          </span>
        )}
        {ev.action === "skipped" && <span className="text-gray-500">SKIPPED — {ev.skipReason}</span>}
      </div>
      <span className="text-gray-700 shrink-0">{timeAgo(ev.detectedAt)}</span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PaperMode() {
  const [confirmReset, setConfirmReset] = useState(false);

  const { data: status }    = usePaperSniperStatus();
  const { data: positions } = usePaperSniperPositions();
  const { data: history }   = usePaperSniperHistory();
  const { data: events }    = usePaperSniperEvents();
  const resetMut            = useResetPaperAccount();

  const openPositions  = positions ?? [];
  const closedHistory  = history  ?? [];
  const recentEvents   = events   ?? [];

  const totalTrades   = status?.tradesTotal ?? 0;
  const wins          = status?.wins ?? 0;
  const losses        = status?.losses ?? 0;
  const winRate       = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "—";
  const realizedPnl   = status?.totalRealizedPnlSol ?? 0;
  const unrealizedPnl = status?.totalUnrealizedPnlSol ?? 0;
  const combinedPnl   = status?.totalCombinedPnlSol ?? 0;
  const balance       = status?.virtualBalance ?? 0;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white p-4 max-w-[1400px] mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
            <FileText size={18} className="text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Paper Mode</h1>
            <p className="text-xs text-gray-500">Simulated sniper — same filters, real prices, no real capital</p>
          </div>
        </div>
        <TabNav />
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        <StatCard
          label="Paper Balance"
          value={`${fmt(balance, 4)} SOL`}
          sub="virtual SOL"
        />
        <StatCard
          label="Realized P&L"
          value={`${fmtSigned(realizedPnl, 4)} SOL`}
          positive={realizedPnl >= 0}
        />
        <StatCard
          label="Unrealized P&L"
          value={`${fmtSigned(unrealizedPnl, 4)} SOL`}
          positive={unrealizedPnl >= 0}
        />
        <StatCard
          label="Combined P&L"
          value={`${fmtSigned(combinedPnl, 4)} SOL`}
          positive={combinedPnl >= 0}
        />
        <StatCard
          label="Win Rate"
          value={winRate === "—" ? "—" : `${winRate}%`}
          sub={`${wins}W / ${losses}L`}
          positive={wins > losses ? true : losses > wins ? false : undefined}
        />
        <StatCard
          label="Open Positions"
          value={String(status?.openCount ?? 0)}
          sub={`max ${status?.config.maxOpenPositions ?? 3}`}
        />
        <StatCard
          label="Total Trades"
          value={String(totalTrades)}
        />
      </div>

      {/* Open Positions */}
      <div className="bg-[#0d0d14] border border-[#1e1e2e] rounded-xl mb-6">
        <div className="px-4 py-3 border-b border-[#1e1e2e] flex items-center gap-2">
          <Clock size={14} className="text-amber-400" />
          <span className="font-semibold text-sm text-white">Open Paper Positions</span>
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/40 ml-1 text-xs">
            {openPositions.length}
          </Badge>
        </div>
        {openPositions.length === 0 ? (
          <div className="text-gray-600 text-sm text-center py-10">
            No open paper positions — waiting for next graduation...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-xs text-gray-600 border-b border-[#1e1e2e]">
                  <th className="text-left px-3 py-2">Token</th>
                  <th className="text-left px-3 py-2">Entry</th>
                  <th className="text-left px-3 py-2">Current</th>
                  <th className="text-left px-3 py-2">P&L %</th>
                  <th className="text-left px-3 py-2">P&L SOL</th>
                  <th className="text-left px-3 py-2">TPs</th>
                  <th className="text-left px-3 py-2">Age</th>
                </tr>
              </thead>
              <tbody>
                {openPositions.map((pos) => (
                  <OpenPositionRow key={pos.id} pos={pos} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Trade History */}
        <div className="lg:col-span-2 bg-[#0d0d14] border border-[#1e1e2e] rounded-xl">
          <div className="px-4 py-3 border-b border-[#1e1e2e] flex items-center gap-2">
            {combinedPnl >= 0
              ? <TrendingUp size={14} className="text-green-400" />
              : <TrendingDown size={14} className="text-red-400" />}
            <span className="font-semibold text-sm text-white">Paper Trade History</span>
            <Badge className="bg-[#1e1e2e] text-gray-400 border-[#2a2a3e] ml-1 text-xs">
              {closedHistory.length}
            </Badge>
          </div>
          {closedHistory.length === 0 ? (
            <div className="text-gray-600 text-sm text-center py-10">
              No closed paper trades yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-gray-600 border-b border-[#1e1e2e]">
                    <th className="text-left px-3 py-2">Token</th>
                    <th className="text-left px-3 py-2">Entry</th>
                    <th className="text-left px-3 py-2">Exit</th>
                    <th className="text-left px-3 py-2">P&L</th>
                    <th className="text-left px-3 py-2">Reason</th>
                    <th className="text-left px-3 py-2">Hold</th>
                    <th className="text-left px-3 py-2">When</th>
                  </tr>
                </thead>
                <tbody>
                  {closedHistory.map((pos) => (
                    <HistoryRow key={pos.id} pos={pos} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Events + Reset */}
        <div className="flex flex-col gap-4">
          {/* Events */}
          <div className="bg-[#0d0d14] border border-[#1e1e2e] rounded-xl flex-1">
            <div className="px-4 py-3 border-b border-[#1e1e2e] flex items-center gap-2">
              <Activity size={14} className="text-amber-400" />
              <span className="font-semibold text-sm text-white">Events</span>
            </div>
            <div className="px-4 py-2 max-h-[320px] overflow-y-auto">
              {recentEvents.length === 0 ? (
                <div className="text-gray-600 text-xs text-center py-6">No events yet</div>
              ) : (
                recentEvents.map((ev) => <EventRow key={ev.id} ev={ev} />)
              )}
            </div>
          </div>

          {/* Reset card */}
          <div className="bg-[#0d0d14] border border-[#1e1e2e] rounded-xl p-4">
            <div className="text-xs text-gray-500 mb-2">Reset paper account back to 0.1 SOL. All history will be cleared.</div>
            {!confirmReset ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-amber-700/40 text-amber-400 hover:bg-amber-900/20 hover:text-amber-300"
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw size={13} className="mr-1.5" />
                Reset Paper Account
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  disabled={resetMut.isPending}
                  onClick={() => {
                    resetMut.mutate(undefined, {
                      onSettled: () => setConfirmReset(false),
                    });
                  }}
                >
                  {resetMut.isPending ? "Resetting…" : "Confirm Reset"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 border-[#2a2a3e]"
                  onClick={() => setConfirmReset(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
