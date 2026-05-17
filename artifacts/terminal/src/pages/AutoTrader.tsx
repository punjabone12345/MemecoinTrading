import { useState, useEffect } from "react";
import { useAutoTraderStatus, useAutoTraderConfig, useUpdateAutoTraderConfig, usePauseAutoTrader, useResumeAutoTrader, useAutoTraderHistory } from "@/lib/api";
import { Play, Pause, Settings, Zap, Shield, TrendingUp, Clock, ChevronDown, ChevronUp, CheckCircle2, XCircle, SkipForward, FlaskConical, Loader2 } from "lucide-react";
import type { CycleDecision } from "@/lib/types";

function ConfigRow({ label, field, value, step, onChange, unit }: {
  label: string; field: string; value: number; step?: number;
  onChange: (field: string, val: string) => void; unit?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-white/5 last:border-0">
      <div className="flex-1 min-w-0 pr-3">
        <p className="text-white/80 text-sm font-medium">{label}</p>
        {unit && <p className="text-white/30 text-[10px]">{unit}</p>}
      </div>
      <input
        type="number"
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(field, e.target.value)}
        className="w-24 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-right text-sm text-white font-mono focus:outline-none focus:border-violet-500/50"
      />
    </div>
  );
}

type AnyConfig = Record<string, number>;

function formatK(n: number) {
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function holdLabel(mins: number) {
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function LlmBadge({ verdict, provider, confidence }: { verdict?: string; provider?: string; confidence?: number }) {
  if (!verdict || verdict === "none" || !provider || provider === "none") return null;
  const colors: Record<string, string> = {
    TRADE: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    RISKY: "bg-amber-500/20 text-amber-300 border-amber-500/30",
    SKIP:  "bg-red-500/20 text-red-300 border-red-500/30",
  };
  const cls = colors[verdict] ?? "bg-white/10 text-white/50 border-white/10";
  const providerLabel = provider === "gemini" ? "Gemini" : provider === "groq" ? "Groq" : provider;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${cls}`}>
      <span>{verdict}</span>
      <span className="opacity-60">·</span>
      <span className="opacity-70">{providerLabel}</span>
      {confidence !== undefined && confidence > 0 && (
        <><span className="opacity-60">·</span><span className="opacity-70">{confidence}%</span></>
      )}
    </span>
  );
}

function AiAnalysisCard({ d }: { d: CycleDecision }) {
  const hasLlm = d.llmProvider && d.llmProvider !== "none";
  if (!hasLlm) return null;

  const verdict = d.llmVerdict ?? "TRADE";
  const providerLabel = d.llmProvider === "gemini" ? "Gemini Flash" : d.llmProvider === "groq" ? "Groq Llama" : d.llmProvider ?? "";

  const verdictStyles: Record<string, { border: string; bg: string; text: string; dot: string }> = {
    TRADE: { border: "border-emerald-500/30", bg: "bg-emerald-900/20", text: "text-emerald-300", dot: "bg-emerald-400" },
    RISKY: { border: "border-amber-500/30",   bg: "bg-amber-900/20",   text: "text-amber-300",  dot: "bg-amber-400"  },
    SKIP:  { border: "border-red-500/30",      bg: "bg-red-900/20",     text: "text-red-300",    dot: "bg-red-400"    },
  };
  const s = verdictStyles[verdict] ?? verdictStyles["TRADE"];

  return (
    <div className={`mx-0 mb-2.5 rounded-xl border ${s.border} ${s.bg} overflow-hidden`}>
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${s.border}`}>
        <div className={`w-1.5 h-1.5 rounded-full ${s.dot} shrink-0`} />
        <span className={`text-[10px] font-black tracking-widest uppercase ${s.text}`}>{verdict}</span>
        <span className="text-white/20 text-[9px]">·</span>
        <span className="text-white/40 text-[9px]">{providerLabel}</span>
        {d.llmConfidence !== undefined && d.llmConfidence > 0 && (
          <>
            <span className="text-white/20 text-[9px]">·</span>
            <span className="text-white/40 text-[9px]">{d.llmConfidence}% confidence</span>
          </>
        )}
        {d.llmDurationMs !== undefined && (
          <>
            <span className="text-white/20 text-[9px]">·</span>
            <span className="text-white/25 text-[9px]">{d.llmDurationMs}ms</span>
          </>
        )}
      </div>
      {/* Reasoning */}
      {d.llmReasoning && (
        <p className="px-3 pt-2 pb-1.5 text-[11px] text-white/70 leading-snug">{d.llmReasoning}</p>
      )}
      {/* Strengths + Risks grid */}
      {((d.llmStrengths && d.llmStrengths.length > 0) || (d.llmRisks && d.llmRisks.length > 0)) && (
        <div className="grid grid-cols-2 gap-0 border-t border-white/5">
          {d.llmStrengths && d.llmStrengths.length > 0 && (
            <div className="px-3 py-2 border-r border-white/5">
              <p className="text-[9px] font-bold text-emerald-400/60 uppercase tracking-wider mb-1.5">Strengths</p>
              {d.llmStrengths.map((s, i) => (
                <p key={i} className="text-[10px] text-emerald-300/60 leading-snug mb-0.5">↑ {s}</p>
              ))}
            </div>
          )}
          {d.llmRisks && d.llmRisks.length > 0 && (
            <div className="px-3 py-2">
              <p className="text-[9px] font-bold text-red-400/60 uppercase tracking-wider mb-1.5">Risks</p>
              {d.llmRisks.map((r, i) => (
                <p key={i} className="text-[10px] text-red-300/60 leading-snug mb-0.5">↓ {r}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionRow({ d }: { d: CycleDecision }) {
  const isTraded = d.action === "traded";
  const isFiltered = d.action === "filtered";
  const hasLlm = !!(d.llmProvider && d.llmProvider !== "none");
  // Auto-expand AI card for traded tokens; collapsed by default for others
  const [showAi, setShowAi] = useState(isTraded && hasLlm);

  const Icon = isTraded ? CheckCircle2 : isFiltered ? XCircle : SkipForward;
  const iconColor = isTraded ? "text-emerald-400" : isFiltered ? "text-red-400" : "text-white/30";

  return (
    <div className="border-b border-white/5 last:border-0">
      <div className="flex items-start gap-2.5 py-2.5">
        <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white text-xs">${d.symbol}</span>
            <span className="text-white/30 text-[10px]">Score {d.aiScore}</span>
            <span className="text-white/30 text-[10px]">Liq {formatK(d.liquidityUsd)}</span>
            <span className="text-white/30 text-[10px]">MCap {formatK(d.marketCapUsd)}</span>
            <span className="text-white/30 text-[10px]">Vol24h {formatK(d.volume24hUsd)}</span>
            {d.pairAgeMinutes > 0 && (
              <span className="text-white/30 text-[10px]">{holdLabel(d.pairAgeMinutes)} old</span>
            )}
            {hasLlm && (
              <button
                onClick={() => setShowAi(v => !v)}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold transition-opacity ${
                  d.llmVerdict === "TRADE" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" :
                  d.llmVerdict === "RISKY" ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :
                  "bg-red-500/20 text-red-300 border-red-500/30"
                }`}
              >
                <span>{d.llmVerdict}</span>
                <span className="opacity-50">·</span>
                <span className="opacity-60">{d.llmProvider === "gemini" ? "Gemini" : "Groq"}</span>
                <span className="opacity-40 ml-0.5">{showAi ? "▲" : "▼"}</span>
              </button>
            )}
          </div>
          <p className={`text-[10px] mt-0.5 ${isTraded ? "text-emerald-400/80" : isFiltered ? "text-red-400/70" : "text-white/30"}`}>
            {d.reason}
          </p>
        </div>
      </div>
      {showAi && hasLlm && <AiAnalysisCard d={d} />}
    </div>
  );
}

type AiTestResult = {
  provider: string;
  verdict: string;
  confidence: number;
  durationMs: number;
  reasoning: string;
  risks: string[];
  strengths: string[];
  secondaryVerdict?: string;
  secondaryProvider?: string;
  stage?: string;
  potential?: string;
  concern?: string;
  llmScore?: number;
};

type AiTestState =
  | { status: "idle" }
  | { status: "loading" }
  | ({ status: "ok" } & AiTestResult)
  | { status: "error"; error: string };

function AiDebugPanel() {
  const [result, setResult] = useState<AiTestState>({ status: "idle" });

  const runTest = async () => {
    setResult({ status: "loading" });
    try {
      const res = await fetch("/api/debug/ai-test", { signal: AbortSignal.timeout(35_000) });
      const data = await res.json() as { ok: boolean; result?: AiTestResult; error?: string };
      if (data.ok && data.result) {
        setResult({ status: "ok", ...data.result });
      } else {
        setResult({ status: "error", error: data.error ?? "Unknown error" });
      }
    } catch (e) {
      setResult({ status: "error", error: (e as Error).message });
    }
  };

  const isHeuristic = result.status === "ok" && result.provider === "heuristic";
  const isGroq      = result.status === "ok" && result.provider === "groq";

  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-violet-400" />
          <p className="text-sm font-bold text-white/70">Live AI Test</p>
          <span className="text-[9px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">Groq Dual Model</span>
        </div>
        <button
          onClick={runTest}
          disabled={result.status === "loading"}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-600/80 text-white text-[11px] font-bold active:scale-95 transition-all disabled:opacity-50"
        >
          {result.status === "loading"
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Testing...</>
            : <><FlaskConical className="w-3 h-3" /> Test AI</>}
        </button>
      </div>

      <div className="px-4 py-3">
        {result.status === "idle" && (
          <p className="text-white/30 text-xs text-center py-2">Press "Test AI" to run a live dual-model analysis.</p>
        )}

        {result.status === "loading" && (
          <div className="flex items-center gap-2 py-3 justify-center">
            <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
            <p className="text-violet-300 text-xs">Running Llama + Mixtral in parallel…</p>
          </div>
        )}

        {result.status === "ok" && (
          <div className="space-y-2.5">
            {/* Verdict + provider row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-black ${
                result.verdict === "TRADE" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                : result.verdict === "RISKY" ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "bg-red-500/20 text-red-300 border border-red-500/30"
              }`}>
                {result.verdict}
              </span>
              <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                isGroq      ? "bg-violet-500/15 text-violet-300 border-violet-500/25"
                : isHeuristic ? "bg-red-500/15 text-red-300 border-red-500/25"
                : "bg-white/10 text-white/50 border-white/10"
              }`}>
                {isGroq ? "✓ Llama + Mixtral" : isHeuristic ? "✗ Heuristic fallback" : result.provider}
              </span>
              <span className="text-white/35 text-[10px]">{result.confidence}% confidence</span>
              <span className="text-white/25 text-[10px]">{result.durationMs.toLocaleString()}ms</span>
            </div>

            {/* Model agreement row */}
            {result.secondaryVerdict && result.secondaryVerdict !== "N/A" && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-white/30">Llama:</span>
                <span className={result.verdict === "SKIP" ? "text-red-400" : "text-emerald-400"}>
                  {result.verdict === "TRADE" || result.verdict === "RISKY" ? "PASS" : "FAIL"}
                </span>
                <span className="text-white/20">·</span>
                <span className="text-white/30">Mixtral:</span>
                <span className={result.secondaryVerdict === "PASS" ? "text-emerald-400" : "text-red-400"}>
                  {result.secondaryVerdict}
                </span>
                {result.secondaryVerdict !== (result.verdict === "SKIP" ? "FAIL" : "PASS") && (
                  <span className="text-amber-400/70 text-[9px]">split decision</span>
                )}
              </div>
            )}

            {/* Stage / Potential chips */}
            {(result.stage || result.potential) && (
              <div className="flex items-center gap-2 flex-wrap">
                {result.stage && result.stage !== "Unknown" && (
                  <span className="text-[9px] px-2 py-0.5 rounded bg-white/5 text-white/40">
                    Stage: <span className="text-white/60 font-semibold">{result.stage}</span>
                  </span>
                )}
                {result.potential && result.potential !== "Unknown" && (
                  <span className={`text-[9px] px-2 py-0.5 rounded font-semibold ${
                    result.potential.toLowerCase().includes("dump")
                      ? "bg-red-500/10 text-red-400"
                      : "bg-emerald-500/10 text-emerald-400"
                  }`}>
                    {result.potential}
                  </span>
                )}
              </div>
            )}

            {/* Trader verdict line */}
            {result.reasoning && (
              <p className="text-white/60 text-[11px] leading-snug border-l-2 border-violet-500/30 pl-2 italic">
                "{result.reasoning}"
              </p>
            )}

            {/* Concern */}
            {result.concern && result.concern !== "None" && (
              <div className="flex items-start gap-1.5 bg-amber-500/8 border border-amber-500/15 rounded-lg px-2.5 py-1.5">
                <span className="text-amber-400 text-[10px] mt-px">⚠</span>
                <p className="text-amber-300/70 text-[10px] leading-snug">{result.concern}</p>
              </div>
            )}

            {/* Risks */}
            {result.risks?.length > 0 && (
              <div className="space-y-0.5">
                {result.risks.map((r, i) => (
                  <p key={i} className="text-[10px] text-red-300/60 leading-snug">↓ {r}</p>
                ))}
              </div>
            )}

            {isHeuristic && (
              <p className="text-red-400/80 text-[10px] bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                Both AI models failed — running heuristic fallback. Check GROQ_API_KEY in server config.
              </p>
            )}
          </div>
        )}

        {result.status === "error" && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <p className="text-red-400 text-xs font-bold mb-1">Test Failed</p>
            <p className="text-red-300/70 text-[10px]">{result.error}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AutoTrader() {
  const { data: status } = useAutoTraderStatus();
  const { data: config } = useAutoTraderConfig();
  const { data: history = [] } = useAutoTraderHistory();
  const updateConfig = useUpdateAutoTraderConfig();
  const pause = usePauseAutoTrader();
  const resume = useResumeAutoTrader();

  const [localConfig, setLocalConfig] = useState<AnyConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [cycleOpen, setCycleOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (config && !localConfig) setLocalConfig(config as unknown as AnyConfig);
  }, [config, localConfig]);

  if (!status || !localConfig) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const handleChange = (key: string, value: string) => {
    setLocalConfig({ ...localConfig, [key]: Number(value) });
  };

  const handleSave = () => {
    updateConfig.mutate(localConfig as any, {
      onSuccess: () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      },
    });
  };

  const isRunning = !status.paused;

  // Latest cycle
  const latestCycle = history[0];
  const decisions = latestCycle?.decisions ?? [];
  const traded = decisions.filter((d) => d.action === "traded");
  const filtered = decisions.filter((d) => d.action === "filtered");
  const skipped = decisions.filter((d) => d.action !== "traded" && d.action !== "filtered");

  // Group filter reasons
  const reasonCounts: Record<string, number> = {};
  for (const d of filtered) {
    const key = d.reason.split(" ")[0] + " " + (d.reason.split(" ")[1] ?? "");
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
  }
  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Decisions to show: traded first, then top filtered, then skipped
  const displayDecisions = showAll
    ? [...traded, ...filtered, ...skipped]
    : [...traded, ...filtered.slice(0, 8), ...skipped.slice(0, 3)];

  return (
    <div className="px-4 py-4 space-y-4">
      {/* AI Debug Panel */}
      <AiDebugPanel />

      {/* Status Card */}
      <div className={`relative rounded-2xl overflow-hidden border p-5 ${isRunning ? "bg-emerald-900/20 border-emerald-500/25" : "bg-red-900/20 border-red-500/25"}`}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white/50 text-xs uppercase tracking-widest font-semibold">Auto-Trader</p>
            <div className="flex items-center gap-2 mt-1">
              <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
              <p className={`text-2xl font-black ${isRunning ? "text-emerald-400" : "text-red-400"}`}>
                {isRunning ? "ACTIVE" : "PAUSED"}
              </p>
            </div>
            <div className="mt-2 space-y-0.5 text-xs text-white/40">
              <p>Scanner pool: <span className="text-white/60">{status.scannerPoolSize} tokens</span></p>
              <p>All-time trades: <span className="text-white/60">{status.totalTradesOpened}</span></p>
              <p>Last cycle evaluated: <span className="text-white/60">{status.lastRunTokensEvaluated} tokens</span></p>
            </div>
          </div>
          <button
            onClick={() => isRunning ? pause.mutate() : resume.mutate()}
            disabled={pause.isPending || resume.isPending}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm active:scale-95 transition-all ${
              isRunning
                ? "bg-red-500/15 border border-red-500/30 text-red-400"
                : "bg-emerald-500/15 border border-emerald-500/30 text-emerald-400"
            }`}
          >
            {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isRunning ? "Pause" : "Resume"}
          </button>
        </div>
      </div>

      {/* Last Cycle Panel */}
      {latestCycle && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 border-b border-white/5"
            onClick={() => setCycleOpen((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <p className="text-sm font-bold text-white/70">Last Cycle #{latestCycle.cycleId}</p>
              <span className="text-[10px] text-white/30">
                {new Date(latestCycle.startedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-bold text-emerald-400">{traded.length} traded</span>
              <span className="text-[10px] text-red-400">{filtered.length} filtered</span>
              <span className="text-[10px] text-white/30">{skipped.length} skipped</span>
              {cycleOpen ? <ChevronUp className="w-4 h-4 text-white/30" /> : <ChevronDown className="w-4 h-4 text-white/30" />}
            </div>
          </button>

          {cycleOpen && (
            <div className="px-4">
              {/* Top rejection reasons */}
              {topReasons.length > 0 && filtered.length > 0 && (
                <div className="py-3 border-b border-white/5">
                  <p className="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-2">Top Filter Reasons</p>
                  <div className="flex flex-wrap gap-1.5">
                    {topReasons.map(([reason, count]) => (
                      <span key={reason} className="text-[10px] bg-red-500/10 border border-red-500/20 text-red-400/80 rounded-full px-2 py-0.5">
                        {reason} ×{count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Decision list */}
              <div>
                {displayDecisions.length === 0 && (
                  <p className="text-white/30 text-xs py-4 text-center">No decisions recorded yet</p>
                )}
                {displayDecisions.map((d, i) => (
                  <DecisionRow key={`${d.pairAddress}-${i}`} d={d} />
                ))}
                {!showAll && decisions.length > displayDecisions.length && (
                  <button
                    className="w-full py-2.5 text-[11px] text-violet-400 text-center"
                    onClick={() => setShowAll(true)}
                  >
                    Show all {decisions.length} decisions ↓
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {!latestCycle && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-6 text-center">
          <Zap className="w-7 h-7 text-white/20 mx-auto mb-2" />
          <p className="text-white/30 text-sm">Waiting for first cycle...</p>
          <p className="text-white/20 text-[11px] mt-1">The bot runs every 60 seconds</p>
        </div>
      )}

      {/* SL/TP Info Banner */}
      <div className="bg-violet-500/8 border border-violet-500/20 rounded-xl p-3">
        <p className="text-violet-400 text-xs font-bold mb-1">Dynamic SL/TP (AI Score Based)</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-white/50">
          <span>Score 95+: SL -20% / TP +500%</span>
          <span>Score 90-94: SL -18% / TP +200%</span>
          <span>Score 80-89: SL -15% / TP +80%</span>
          <span>Score 70-79: SL -12% / TP +50%</span>
        </div>
      </div>

      {/* Settings Sections */}
      <div className="space-y-3">
        <Section title="Trade Settings" icon={<Zap className="w-4 h-4 text-amber-400" />}>
          <ConfigRow label="Trade Size" field="solPerTrade" value={localConfig.solPerTrade} step={0.01} onChange={handleChange} unit="SOL per trade" />
          <ConfigRow label="Max Concurrent Trades" field="maxConcurrentTrades" value={localConfig.maxConcurrentTrades} onChange={handleChange} unit="open at once" />
          <ConfigRow label="Min AI Score" field="minAiScore" value={localConfig.minAiScore} onChange={handleChange} unit="0–100" />
          <ConfigRow label="Min Confidence" field="minConfidence" value={localConfig.minConfidence} onChange={handleChange} unit="0–100%" />
        </Section>

        <Section title="Market Filters" icon={<TrendingUp className="w-4 h-4 text-blue-400" />}>
          <ConfigRow label="Min Liquidity" field="minLiquidityUsd" value={localConfig.minLiquidityUsd} step={1000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Vol 24h" field="minVolume24hUsd" value={localConfig.minVolume24hUsd} step={1000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Vol 1h" field="minVolume1hUsd" value={localConfig.minVolume1hUsd} step={500} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Buy Ratio 1h" field="minBuyRatio1h" value={localConfig.minBuyRatio1h} step={0.01} onChange={handleChange} unit="0.0–1.0" />
          <ConfigRow label="Min 1h Change" field="minPriceChange1h" value={localConfig.minPriceChange1h} step={0.5} onChange={handleChange} unit="%" />
          <ConfigRow label="Min Transactions 24h" field="minTransactions24h" value={localConfig.minTransactions24h} onChange={handleChange} unit="txns" />
        </Section>

        <Section title="Market Cap Range" icon={<Settings className="w-4 h-4 text-violet-400" />}>
          <ConfigRow label="Min Market Cap" field="minMcapUsd" value={localConfig.minMcapUsd} step={1000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Max Market Cap" field="maxMcapUsd" value={localConfig.maxMcapUsd} step={100000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Liq/MCap Ratio" field="minLiquidityMcapRatio" value={localConfig.minLiquidityMcapRatio} step={0.01} onChange={handleChange} unit="e.g. 0.03 = 3%" />
          <ConfigRow label="Max FDV/MCap Ratio" field="maxFdvMcapRatio" value={localConfig.maxFdvMcapRatio} step={0.5} onChange={handleChange} unit="dilution guard" />
        </Section>

        <Section title="Age & Safety" icon={<Clock className="w-4 h-4 text-white/40" />}>
          <ConfigRow label="Min Pair Age" field="minPairAgeMinutes" value={localConfig.minPairAgeMinutes} onChange={handleChange} unit="minutes" />
          <ConfigRow label="Max Pair Age" field="maxPairAgeHours" value={localConfig.maxPairAgeHours} onChange={handleChange} unit="hours" />
          <ConfigRow label="Max 6h Drop" field="maxPriceDropH6Pct" value={localConfig.maxPriceDropH6Pct} step={5} onChange={handleChange} unit="e.g. -40 = 40% max drop" />
          <ConfigRow label="Max 24h Drop" field="maxPriceDropH24Pct" value={localConfig.maxPriceDropH24Pct} step={5} onChange={handleChange} unit="e.g. -65 = 65% max drop" />
        </Section>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={updateConfig.isPending}
        className={`w-full py-4 rounded-xl font-bold text-base active:scale-95 transition-all ${
          saved
            ? "bg-emerald-500/20 border border-emerald-500/30 text-emerald-400"
            : "bg-violet-600 text-white shadow-lg shadow-violet-500/20"
        }`}
      >
        {saved ? "✓ Saved!" : updateConfig.isPending ? "Saving..." : "Save Configuration"}
      </button>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        {icon}
        <p className="text-sm font-bold text-white/70">{title}</p>
      </div>
      <div className="px-4">
        {children}
      </div>
    </div>
  );
}
