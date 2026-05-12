import { useState, useEffect } from "react";
import { useAutoTraderStatus, useAutoTraderConfig, useUpdateAutoTraderConfig, usePauseAutoTrader, useResumeAutoTrader } from "@/lib/api";
import { Play, Pause, Settings, Zap, Shield, TrendingUp, Clock } from "lucide-react";

function ConfigRow({ label, field, value, step, onChange, unit }: {
  label: string;
  field: string;
  value: number;
  step?: number;
  onChange: (field: string, val: string) => void;
  unit?: string;
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

export default function AutoTrader() {
  const { data: status } = useAutoTraderStatus();
  const { data: config } = useAutoTraderConfig();
  const updateConfig = useUpdateAutoTraderConfig();
  const pause = usePauseAutoTrader();
  const resume = useResumeAutoTrader();

  const [localConfig, setLocalConfig] = useState<AnyConfig | null>(null);
  const [saved, setSaved] = useState(false);

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

  return (
    <div className="px-4 py-4 space-y-4">
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
              <p>Scanner: <span className="text-white/60">{status.scannerPoolSize} tokens</span></p>
              <p>Total trades opened: <span className="text-white/60">{status.totalTradesOpened}</span></p>
              <p>Tokens evaluated: <span className="text-white/60">{status.lastRunTokensEvaluated}</span></p>
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
        {/* Trade Settings */}
        <Section title="Trade Settings" icon={<Zap className="w-4 h-4 text-amber-400" />}>
          <ConfigRow label="Trade Size" field="solPerTrade" value={localConfig.solPerTrade} step={0.01} onChange={handleChange} unit="SOL per trade" />
          <ConfigRow label="Max Concurrent Trades" field="maxConcurrentTrades" value={localConfig.maxConcurrentTrades} onChange={handleChange} unit="open at once" />
          <ConfigRow label="Min AI Score" field="minAiScore" value={localConfig.minAiScore} onChange={handleChange} unit="0–100" />
          <ConfigRow label="Min Confidence" field="minConfidence" value={localConfig.minConfidence} onChange={handleChange} unit="0–100%" />
        </Section>

        {/* Market Filters */}
        <Section title="Market Filters" icon={<TrendingUp className="w-4 h-4 text-blue-400" />}>
          <ConfigRow label="Min Liquidity" field="minLiquidityUsd" value={localConfig.minLiquidityUsd} step={1000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Vol 24h" field="minVolume24hUsd" value={localConfig.minVolume24hUsd} step={1000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Vol 1h" field="minVolume1hUsd" value={localConfig.minVolume1hUsd} step={500} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Buy Ratio 1h" field="minBuyRatio1h" value={localConfig.minBuyRatio1h} step={0.01} onChange={handleChange} unit="0.0–1.0" />
          <ConfigRow label="Min 1h Change" field="minPriceChange1h" value={localConfig.minPriceChange1h} step={0.5} onChange={handleChange} unit="%" />
          <ConfigRow label="Min Transactions 24h" field="minTransactions24h" value={localConfig.minTransactions24h} onChange={handleChange} unit="txns" />
        </Section>

        {/* Market Cap */}
        <Section title="Market Cap Range" icon={<Settings className="w-4 h-4 text-violet-400" />}>
          <ConfigRow label="Min Market Cap" field="minMcapUsd" value={localConfig.minMcapUsd} step={10000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Max Market Cap" field="maxMcapUsd" value={localConfig.maxMcapUsd} step={100000} onChange={handleChange} unit="USD" />
          <ConfigRow label="Min Liq/MCap Ratio" field="minLiquidityMcapRatio" value={localConfig.minLiquidityMcapRatio} step={0.01} onChange={handleChange} unit="e.g. 0.03 = 3%" />
          <ConfigRow label="Max FDV/MCap Ratio" field="maxFdvMcapRatio" value={localConfig.maxFdvMcapRatio} step={0.5} onChange={handleChange} unit="dilution guard" />
        </Section>

        {/* Age & Dump */}
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
