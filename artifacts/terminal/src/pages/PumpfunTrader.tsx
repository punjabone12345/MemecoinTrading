import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wifi, WifiOff, TrendingUp, TrendingDown, RefreshCw, Settings, X,
  Activity, Zap, ChevronRight, ExternalLink,
} from "lucide-react";
import { PumpfunStatus, PumpfunTrackedToken, PumpfunPosition, PumpfunEvent, PumpfunConfig } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";

// ── API ───────────────────────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";
function apiUrl(p: string) { return `${API_BASE}${p}`; }

function usePumpfunStatus() {
  return useQuery<PumpfunStatus>({
    queryKey: ["pumpfun-status"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/status"));
      const j = await r.json() as { data: PumpfunStatus };
      return j.data;
    },
    refetchInterval: 5_000,
  });
}

function usePumpfunTokens() {
  return useQuery<PumpfunTrackedToken[]>({
    queryKey: ["pumpfun-tokens"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/tokens"));
      const j = await r.json() as { data: PumpfunTrackedToken[] };
      return j.data ?? [];
    },
    refetchInterval: 5_000,
  });
}

function usePumpfunPositions() {
  return useQuery<PumpfunPosition[]>({
    queryKey: ["pumpfun-positions"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/positions"));
      const j = await r.json() as { data: PumpfunPosition[] };
      return j.data ?? [];
    },
    refetchInterval: 5_000,
  });
}

function usePumpfunHistory() {
  return useQuery<PumpfunPosition[]>({
    queryKey: ["pumpfun-history"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/history"));
      const j = await r.json() as { data: PumpfunPosition[] };
      return j.data ?? [];
    },
    refetchInterval: 15_000,
  });
}

function usePumpfunEvents() {
  return useQuery<PumpfunEvent[]>({
    queryKey: ["pumpfun-events"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/events"));
      const j = await r.json() as { data: PumpfunEvent[] };
      return j.data ?? [];
    },
    refetchInterval: 5_000,
  });
}

function usePumpfunConfig() {
  return useQuery<PumpfunConfig>({
    queryKey: ["pumpfun-config"],
    queryFn: async () => {
      const r = await fetch(apiUrl("/api/pumpfun/config"));
      const j = await r.json() as { data: PumpfunConfig };
      return j.data;
    },
    staleTime: 30_000,
  });
}

function useUpdatePumpfunConfig() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (patch: Partial<PumpfunConfig>) => {
      const r = await fetch(apiUrl("/api/pumpfun/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error("Config update failed");
      return r.json() as Promise<PumpfunConfig>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pumpfun-config"] });
      qc.invalidateQueries({ queryKey: ["pumpfun-status"] });
      toast({ title: "Settings saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number, d = 4) { return (n >= 0 ? "+" : "") + n.toFixed(d); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function fmtMcap(v: number) {
  if (!v) return "—";
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "K";
  return "$" + v.toFixed(0);
}
function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function solscan(mint: string) { return `https://solscan.io/token/${mint}`; }
function pumpfunUrl(mint: string) { return `https://pump.fun/${mint}`; }

const STATUS_COLORS: Record<string, string> = {
  watching:   "text-white/40",
  candidate:  "text-blue-400",
  buySignal:  "text-amber-400",
  bought:     "text-emerald-400",
  graduated:  "text-violet-400",
  exited:     "text-white/50",
  rejected:   "text-red-400/60",
};

function GradBar({ pct }: { pct: number }) {
  const color = pct >= 95 ? "bg-red-500" : pct >= 90 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <div className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className={`text-[10px] font-bold tabular-nums shrink-0 ${pct >= 95 ? "text-red-400" : pct >= 90 ? "text-amber-400" : "text-emerald-400"}`}>
        {pct.toFixed(1)}%
      </span>
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const color = score >= 70 ? "text-emerald-400" : score >= 45 ? "text-amber-400" : "text-red-400/70";
  return <span className={`text-xs font-black tabular-nums ${color}`}>{score.toFixed(0)}</span>;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = "tokens" | "positions" | "history" | "events" | "settings";

// ── Settings Panel ────────────────────────────────────────────────────────────

function SettingsPanel({ config, onClose }: { config: PumpfunConfig; onClose: () => void }) {
  const updateConfig = useUpdatePumpfunConfig();
  const [draft, setDraft] = useState<PumpfunConfig>({ ...config });

  function num(key: keyof PumpfunConfig) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [key]: Number(e.target.value) }));
  }

  function Field({ label, k, step = 0.001 }: { label: string; k: keyof PumpfunConfig; step?: number }) {
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[10px] text-white/40 uppercase tracking-wider">{label}</span>
        <input
          type="number"
          step={step}
          value={String(draft[k])}
          onChange={num(k)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500/50"
        />
      </label>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0f]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
        <h2 className="text-sm font-bold text-white">Pump.fun Trader Settings</h2>
        <button onClick={onClose} className="p-1 text-white/40 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Position size (SOL)" k="positionSizeSol" step={0.001} />
          <Field label="Max open positions" k="maxOpenPositions" step={1} />
          <Field label="Min AI score" k="minAiScore" step={1} />
          <Field label="Virtual balance (SOL)" k="virtualBalanceSol" step={0.1} />
          <Field label="Grad% min" k="graduationMinPct" step={1} />
          <Field label="Grad% max" k="graduationMaxPct" step={0.5} />
        </div>
        <div className="flex items-center gap-3 pt-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
              className="accent-violet-500"
            />
            <span className="text-sm text-white/70">Trading enabled</span>
          </label>
        </div>
      </div>
      <div className="p-4 border-t border-white/8 flex gap-3">
        <button onClick={onClose} className="flex-1 py-2 rounded-xl bg-white/6 text-white/60 text-sm font-bold">Cancel</button>
        <button
          onClick={() => { updateConfig.mutate(draft); onClose(); }}
          disabled={updateConfig.isPending}
          className="flex-1 py-2 rounded-xl bg-violet-600 text-white text-sm font-bold disabled:opacity-50"
        >
          {updateConfig.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ── Token Row ─────────────────────────────────────────────────────────────────

function TokenRow({ token }: { token: PumpfunTrackedToken }) {
  const [expanded, setExpanded] = useState(false);
  const ageMs = Date.now() - token.firstSeen;
  const ageMins = Math.floor(ageMs / 60_000);

  return (
    <div className="border-b border-white/5 last:border-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/3 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-bold text-sm text-white truncate">${token.symbol}</span>
            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${
              token.status === "candidate" ? "bg-blue-500/15 text-blue-400 border-blue-500/25" :
              token.status === "buySignal" ? "bg-amber-500/15 text-amber-400 border-amber-500/25" :
              token.status === "bought"   ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" :
              "bg-white/5 text-white/30 border-white/10"
            }`}>
              {token.status.toUpperCase()}
            </span>
            {token.creatorSold && (
              <span className="text-[9px] text-red-400 font-bold">⚠ CREATOR SOLD</span>
            )}
          </div>
          <GradBar pct={token.graduationPct} />
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-1.5 justify-end mb-1">
            <span className="text-[10px] text-white/40">Score</span>
            <ScoreRing score={token.score} />
          </div>
          <span className="text-[10px] text-white/30">{ageMins < 60 ? `${ageMins}m` : `${Math.floor(ageMins / 60)}h`} · {fmtMcap(token.mcap)}</span>
        </div>
        <ChevronRight className={`w-3.5 h-3.5 text-white/25 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div className="grid grid-cols-3 gap-2 text-[10px]">
            {[
              ["Grad Speed", token.scoreBreakdown.graduationSpeed],
              ["Vol Accel",  token.scoreBreakdown.volumeAcceleration],
              ["Buyer Growth", token.scoreBreakdown.uniqueBuyerGrowth],
              ["TX Velocity", token.scoreBreakdown.txVelocity],
              ["Mcap Accel", token.scoreBreakdown.mcapAcceleration],
              ["Holder Dist", token.scoreBreakdown.holderDistribution],
              ["Whale Accum", token.scoreBreakdown.whaleAccumulation],
              ["Creator Risk", token.scoreBreakdown.creatorRisk],
              ["Momentum",    token.scoreBreakdown.momentumStrength],
            ].map(([label, val]) => (
              <div key={label as string} className="bg-white/4 rounded-lg p-2">
                <div className="text-white/35 mb-0.5">{label}</div>
                <div className={`font-bold ${Number(val) >= 7 ? "text-emerald-400" : Number(val) >= 4 ? "text-amber-400" : "text-white/50"}`}>
                  {Number(val).toFixed(1)}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <a href={pumpfunUrl(token.mint)} target="_blank" rel="noreferrer"
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-amber-500/10 text-amber-400 text-[10px] font-bold border border-amber-500/20">
              <ExternalLink className="w-3 h-3" />Pump.fun
            </a>
            <a href={solscan(token.mint)} target="_blank" rel="noreferrer"
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-white/5 text-white/40 text-[10px] font-bold border border-white/10">
              <ExternalLink className="w-3 h-3" />Solscan
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Position Card ─────────────────────────────────────────────────────────────

function PositionCard({ pos }: { pos: PumpfunPosition }) {
  const pnl = pos.unrealizedPnlSol + pos.realizedPnlSol;
  const isPos = pnl >= 0;
  const pnlPct = pos.sizeSol > 0 ? (pnl / pos.sizeSol) * 100 : 0;

  return (
    <div className="mx-4 mb-3 rounded-xl bg-white/4 border border-white/8 p-3">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-black text-sm text-white">${pos.symbol}</span>
            {pos.tp1Hit && <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded-full font-bold">TP1</span>}
            {pos.tp2Hit && <span className="text-[9px] bg-violet-500/20 text-violet-400 px-1.5 py-0.5 rounded-full font-bold">TP2</span>}
          </div>
          <span className="text-[10px] text-white/30">Entry: {pos.entryGraduationPct.toFixed(1)}% grad · Score {pos.entryScore.toFixed(0)}</span>
        </div>
        <div className="text-right">
          <div className={`text-sm font-black ${isPos ? "text-emerald-400" : "text-red-400"}`}>
            {fmt(pnl)} SOL
          </div>
          <div className={`text-[10px] font-bold ${isPos ? "text-emerald-400/70" : "text-red-400/70"}`}>
            {fmtPct(pnlPct)}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div className="bg-white/3 rounded-lg p-2">
          <div className="text-white/30 mb-0.5">Size</div>
          <div className="text-white font-bold">{pos.sizeSol.toFixed(3)} SOL</div>
        </div>
        <div className="bg-white/3 rounded-lg p-2">
          <div className="text-white/30 mb-0.5">Entry Mcap</div>
          <div className="text-white font-bold">{fmtMcap(pos.entryMcap)}</div>
        </div>
        <div className="bg-white/3 rounded-lg p-2">
          <div className="text-white/30 mb-0.5">SL Price</div>
          <div className="text-red-400/80 font-bold">{pos.effectiveSlPrice > 0 ? pos.effectiveSlPrice.toExponential(3) : "—"}</div>
        </div>
      </div>
    </div>
  );
}

// ── History Row ───────────────────────────────────────────────────────────────

function HistoryRow({ pos }: { pos: PumpfunPosition }) {
  const isWin = pos.realizedPnlSol > 0;
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-[9px] font-black ${isWin ? "text-emerald-400" : "text-red-400"}`}>
            {isWin ? "WIN" : "LOSS"}
          </span>
          <span className="text-xs font-bold text-white">${pos.symbol}</span>
        </div>
        <span className="text-[10px] text-white/30">{pos.closeReason ?? "closed"} · {pos.closedAt ? timeAgo(pos.closedAt) : "—"}</span>
      </div>
      <div className={`text-sm font-black tabular-nums ${isWin ? "text-emerald-400" : "text-red-400"}`}>
        {fmt(pos.realizedPnlSol)} SOL
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function PumpfunTrader() {
  const [tab, setTab] = useState<Tab>("tokens");
  const [showSettings, setShowSettings] = useState(false);

  const { data: status, isLoading: statusLoading } = usePumpfunStatus();
  const { data: tokens = [] } = usePumpfunTokens();
  const { data: positions = [] } = usePumpfunPositions();
  const { data: history = [] } = usePumpfunHistory();
  const { data: events = [] } = usePumpfunEvents();
  const { data: config } = usePumpfunConfig();

  const nearGrad = tokens.filter((t) => t.graduationPct >= 80).sort((a, b) => b.graduationPct - a.graduationPct);
  const totalPnl = (status?.totalCombinedPnlSol ?? 0);
  const winRate  = (status?.tradesTotal ?? 0) > 0
    ? ((status!.wins / status!.tradesTotal) * 100).toFixed(0)
    : "—";

  return (
    <div className="min-h-screen bg-[#0a0a0f] pb-20">
      {showSettings && config && (
        <SettingsPanel config={config} onClose={() => setShowSettings(false)} />
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-[#0d0d15]/95 backdrop-blur-md border-b border-white/8 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <Zap className="w-4.5 h-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-[15px] font-black text-white leading-none tracking-tight">Pre-Migration Sniper</h1>
              <p className="text-[10px] text-white/40 leading-none mt-0.5">Pump.fun bonding curve · pre-graduation entries</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* PumpPortal badge */}
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-black border ${
              status?.ppConnected
                ? "bg-emerald-500/12 text-emerald-400 border-emerald-500/25"
                : "bg-red-500/12 text-red-400 border-red-500/25"
            }`}>
              {status?.ppConnected ? <Wifi className="w-2.5 h-2.5" /> : <WifiOff className="w-2.5 h-2.5" />}
              PP
            </div>
            {/* Helius badge */}
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-black border ${
              statusLoading
                ? "bg-white/6 text-white/30 border-white/10"
                : status?.wsConnected
                ? "bg-emerald-500/12 text-emerald-400 border-emerald-500/25"
                : "bg-white/6 text-white/30 border-white/10"
            }`}>
              {statusLoading ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : <Activity className="w-2.5 h-2.5" />}
              {statusLoading ? "…" : status?.wsConnected ? "HLS" : "NO KEY"}
            </div>
            {config && (
              <button onClick={() => setShowSettings(true)}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors border border-white/6">
                <Settings className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-3 mt-2 text-[10px] flex-wrap">
          <span className="text-white/50">
            <span className="text-white font-bold">{status?.trackedCount ?? 0}</span> tracked
          </span>
          <span className="text-white/15">·</span>
          <span className="text-white/50">
            <span className="text-blue-400 font-bold">{status?.candidateCount ?? 0}</span> candidates
          </span>
          <span className="text-white/15">·</span>
          <span className="text-white/50">
            <span className="text-amber-400 font-bold">{status?.openCount ?? 0}</span> open
          </span>
          <span className="text-white/15">·</span>
          <span className={`font-bold ${totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {fmt(totalPnl, 4)} SOL
          </span>
          <span className="text-white/15">·</span>
          <span className="text-white/40">Win {winRate}%</span>
          <span className="text-white/15">·</span>
          <span className={`font-bold ${status?.enabled ? "text-emerald-400/70" : "text-amber-400/70"}`}>
            {status?.enabled ? "● Trading" : "⏸ Paused"}
          </span>
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex border-b border-white/6 bg-[#0d0d15]/50 sticky top-[73px] z-10">
        {(["tokens", "positions", "history", "events"] as Tab[]).map((t) => {
          const labels: Record<Tab, string> = {
            tokens: `Near-Grad (${nearGrad.length})`,
            positions: `Open (${positions.length})`,
            history: `History (${history.length})`,
            events: `Events (${events.length})`,
            settings: "Settings",
          };
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-[10px] font-bold tracking-wide transition-colors border-b-2 ${
                tab === t
                  ? "text-violet-400 border-violet-500"
                  : "text-white/30 border-transparent hover:text-white/60"
              }`}
            >
              {labels[t]}
            </button>
          );
        })}
      </div>

      {/* ── Tab Content ────────────────────────────────────────────────────── */}

      {tab === "tokens" && (
        <div>
          {nearGrad.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-white/25 gap-3">
              <Activity className="w-8 h-8" />
              <p className="text-sm font-medium">Scanning for near-graduation tokens…</p>
              <p className="text-xs text-white/15">Tokens at 80%+ bonding curve will appear here</p>
            </div>
          ) : (
            <div>
              {nearGrad.map((t) => <TokenRow key={t.mint} token={t} />)}
            </div>
          )}
        </div>
      )}

      {tab === "positions" && (
        <div className="pt-3">
          {positions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-white/25 gap-3">
              <TrendingUp className="w-8 h-8" />
              <p className="text-sm font-medium">No open positions</p>
              <p className="text-xs text-white/15">Pre-migration entries will appear here</p>
            </div>
          ) : (
            positions.map((p) => <PositionCard key={p.id} pos={p} />)
          )}
        </div>
      )}

      {tab === "history" && (
        <div>
          {history.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-white/25 gap-3">
              <TrendingDown className="w-8 h-8" />
              <p className="text-sm font-medium">No trade history yet</p>
            </div>
          ) : (
            <div>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-3 p-4">
                {[
                  ["Total", String(status?.tradesTotal ?? 0), "text-white"],
                  ["Wins", String(status?.wins ?? 0), "text-emerald-400"],
                  ["Losses", String(status?.losses ?? 0), "text-red-400"],
                ].map(([l, v, c]) => (
                  <div key={l} className="bg-white/4 rounded-xl p-3 text-center border border-white/6">
                    <div className={`text-lg font-black ${c}`}>{v}</div>
                    <div className="text-[10px] text-white/30 mt-0.5">{l}</div>
                  </div>
                ))}
              </div>
              <div className="px-4 pb-2">
                <div className={`text-lg font-black ${(status?.totalRealizedPnlSol ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {fmt(status?.totalRealizedPnlSol ?? 0)} SOL
                </div>
                <div className="text-[10px] text-white/30">Total realized P&L</div>
              </div>
              {history.map((p) => <HistoryRow key={p.id} pos={p} />)}
            </div>
          )}
        </div>
      )}

      {tab === "events" && (
        <div>
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-white/25 gap-3">
              <Zap className="w-8 h-8" />
              <p className="text-sm font-medium">No events yet</p>
            </div>
          ) : (
            events.map((ev) => (
              <div key={ev.id} className="flex items-start gap-3 px-4 py-3 border-b border-white/5 last:border-0">
                <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                  ev.action === "entered" ? "bg-emerald-400" :
                  ev.action === "skipped" ? "bg-amber-400/60" :
                  "bg-red-400/60"
                }`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">${ev.symbol}</span>
                    <span className={`text-[9px] font-bold ${
                      ev.action === "entered" ? "text-emerald-400" :
                      ev.action === "skipped" ? "text-amber-400/80" :
                      "text-red-400/70"
                    }`}>{ev.action.toUpperCase()}</span>
                    {ev.score !== undefined && (
                      <span className="text-[9px] text-white/30">score {ev.score.toFixed(0)}</span>
                    )}
                    {ev.graduationPct !== undefined && (
                      <span className="text-[9px] text-white/30">{ev.graduationPct.toFixed(1)}%</span>
                    )}
                  </div>
                  {ev.skipReason && (
                    <p className="text-[10px] text-white/30 mt-0.5 truncate">{ev.skipReason}</p>
                  )}
                </div>
                <span className="text-[9px] text-white/25 shrink-0">{timeAgo(ev.ts)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
