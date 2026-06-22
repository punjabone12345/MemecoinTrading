import { useState, useEffect } from "react";
import { useEDConfig, useUpdateEDConfig, useResetPaperBalance, useWebSocket } from "@/lib/api";
import type { EDConfig } from "@/lib/types";
import { Settings, RotateCcw, Save, AlertTriangle, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type NumberField = Exclude<keyof EDConfig, "enabled">;

const FIELDS: { key: NumberField; label: string; description: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: "positionSizeSol",   label: "Position Size",      description: "Base SOL per trade",            min: 0.01, max: 10,   step: 0.01, unit: "SOL" },
  { key: "maxOpenPositions",  label: "Max Open Trades",    description: "Max concurrent paper positions", min: 1,    max: 20,   step: 1 },
  { key: "minScore",          label: "Min Entry Score",    description: "Score threshold to enter (95–120)", min: 50, max: 120, step: 1 },
  { key: "minBondingCurvePct",label: "Min Bonding Curve",  description: "Minimum bonding curve %",       min: 0,    max: 100,  step: 1, unit: "%" },
  { key: "minUniqueBuyers",   label: "Min Unique Buyers",  description: "Minimum unique buyers required", min: 5,   max: 500,  step: 1 },
  { key: "minBuyPressureRatio",label: "Min Buy Pressure",  description: "Min buy/sell volume ratio",     min: 1,    max: 20,   step: 0.1, unit: "x" },
  { key: "slPct",             label: "Stop Loss",          description: "Stop loss percentage",          min: 5,    max: 50,   step: 1, unit: "%" },
  { key: "tp1Pct",            label: "TP1 Target",         description: "Take profit 1 percentage",      min: 20,   max: 500,  step: 5, unit: "%" },
  { key: "tp1ClosePct",       label: "TP1 Close %",        description: "Fraction to close at TP1",      min: 10,   max: 75,   step: 5, unit: "%" },
  { key: "tp2Pct",            label: "TP2 Target",         description: "Take profit 2 percentage",      min: 50,   max: 1000, step: 10, unit: "%" },
  { key: "tp2ClosePct",       label: "TP2 Close %",        description: "Fraction to close at TP2",      min: 10,   max: 75,   step: 5, unit: "%" },
  { key: "runnerTrailingPct", label: "Runner Trailing Stop", description: "Trailing stop % from high",  min: 10,   max: 50,   step: 5, unit: "%" },
];

function NumberInput({ field, value, onChange }: {
  field: typeof FIELDS[number]; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="bg-white/3 rounded-xl border border-white/8 p-4">
      <div className="flex items-center justify-between mb-1">
        <div>
          <div className="font-bold text-sm text-white">{field.label}</div>
          <div className="text-xs text-white/40 mt-0.5">{field.description}</div>
        </div>
        <div className="text-right ml-3 shrink-0">
          <div className="font-mono font-black text-lg text-violet-400">
            {field.step < 1 ? value.toFixed(2) : value}{field.unit ?? ""}
          </div>
        </div>
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-2 accent-violet-500"
      />
      <div className="flex justify-between text-[10px] text-white/25 mt-0.5">
        <span>{field.min}{field.unit ?? ""}</span>
        <span>{field.max}{field.unit ?? ""}</span>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  useWebSocket();
  const configQ  = useEDConfig();
  const updateFn = useUpdateEDConfig();
  const resetFn  = useResetPaperBalance();
  const { toast } = useToast();

  const [draft, setDraft] = useState<EDConfig | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (configQ.data && !draft) {
      setDraft({ ...configQ.data });
    }
  }, [configQ.data, draft]);

  function patch<K extends keyof EDConfig>(key: K, value: EDConfig[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setDirty(true);
  }

  async function save() {
    if (!draft) return;
    try {
      await updateFn.mutateAsync(draft);
      setDirty(false);
      toast({ title: "Settings saved", description: "Configuration updated successfully." });
    } catch {
      toast({ title: "Save failed", variant: "destructive" });
    }
  }

  async function resetBalance() {
    try {
      await resetFn.mutateAsync();
      toast({ title: "Balance reset", description: "Paper trading balance reset to 1.000 SOL." });
    } catch {
      toast({ title: "Reset failed", variant: "destructive" });
    }
  }

  const config = draft ?? configQ.data;

  return (
    <div className="flex flex-col h-screen bg-[#09090f] text-white pb-16 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-white/8 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-amber-600 flex items-center justify-center">
              <Settings size={12} className="text-white" />
            </div>
            <span className="font-black text-sm tracking-wider text-white">SETTINGS</span>
          </div>
          {dirty && (
            <div className="flex items-center gap-1 text-xs text-amber-400">
              <AlertTriangle size={12} /> Unsaved changes
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="p-4 space-y-4">
          {/* Enable toggle */}
          {config && (
            <div className="bg-white/3 rounded-xl border border-white/8 p-4 flex items-center justify-between">
              <div>
                <div className="font-bold text-sm text-white">Discovery Engine</div>
                <div className="text-xs text-white/40 mt-0.5">Enable/disable token scanning and paper trading</div>
              </div>
              <button
                onClick={() => patch("enabled", !config.enabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${config.enabled ? "bg-violet-500" : "bg-white/15"}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${config.enabled ? "translate-x-6" : "translate-x-0"}`} />
              </button>
            </div>
          )}

          {/* Parameter sliders */}
          {config && FIELDS.map((field) => (
            <NumberInput
              key={field.key}
              field={field}
              value={config[field.key] as number}
              onChange={(v) => patch(field.key, v as EDConfig[typeof field.key])}
            />
          ))}

          {/* Strategy info */}
          {config && (
            <div className="bg-violet-500/5 rounded-xl border border-violet-500/20 p-4">
              <div className="text-xs font-bold text-violet-400 uppercase tracking-widest mb-2">Strategy Summary</div>
              <div className="space-y-1 text-xs text-white/60">
                <div>Entry: Score ≥ {config.minScore}/120, confirmed for 2 min</div>
                <div>SL: -{config.slPct}% | TP1: +{config.tp1Pct}% → sell {config.tp1ClosePct}% → move SL to BE</div>
                <div>TP2: +{config.tp2Pct}% → sell {config.tp2ClosePct}% | Runner: -{config.runnerTrailingPct}% trail</div>
                <div>Position: {config.positionSizeSol} SOL base (×1.0 at 95, ×0.75 at 100, ×1.0 at 110+)</div>
              </div>
            </div>
          )}

          {/* Danger zone */}
          <div className="bg-red-500/5 rounded-xl border border-red-500/20 p-4">
            <div className="text-xs font-bold text-red-400 uppercase tracking-widest mb-3">Danger Zone</div>
            <button
              onClick={() => {
                if (window.confirm("Reset paper balance to 1.000 SOL? This closes all open positions.")) {
                  void resetBalance();
                }
              }}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/15 hover:bg-red-500/25 text-red-400 rounded-lg text-sm font-bold transition-colors border border-red-500/30"
            >
              <RotateCcw size={14} />
              Reset Paper Balance
            </button>
            <div className="text-xs text-white/30 mt-2">Resets virtual balance to 1.000 SOL. Cannot be undone.</div>
          </div>
        </div>
      </div>

      {/* Save button */}
      {dirty && (
        <div className="flex-shrink-0 border-t border-white/8 px-4 py-3">
          <button
            onClick={() => void save()}
            disabled={updateFn.isPending}
            className="w-full flex items-center justify-center gap-2 py-3 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-xl font-bold text-sm transition-colors"
          >
            {updateFn.isPending
              ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Saving…</>
              : <><Save size={14} /> Save Settings</>
            }
          </button>
        </div>
      )}
    </div>
  );
}
