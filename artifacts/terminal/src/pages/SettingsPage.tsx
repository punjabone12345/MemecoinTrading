import { useState, useEffect } from "react";
import { useEDConfig, useUpdateEDConfig, useResetPaperBalance } from "@/lib/api";
import type { EDConfig } from "@/lib/types";
import {
  Settings2, RotateCcw, Save, CheckCircle, ChevronDown, ChevronUp,
  Shield, Target, TrendingUp, Sliders, AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

/* ── Field input ──────────────────────────────────────────────────────────── */
function Field({
  label, value, onChange, min, max, step = 0.01, unit, hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div className="flex items-center justify-between mb-1">
        <div>
          <p className="text-xs font-semibold text-slate-300">{label}</p>
          {hint && <p className="text-[9px] text-slate-600 mt-0.5">{hint}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) onChange(v);
            }}
            className="w-20 text-right text-sm font-bold rounded-lg px-2 py-1.5 outline-none focus:ring-1 transition-all"
            style={{
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#f1f5f9",
            }}
          />
          {unit && <span className="text-[10px] text-slate-500 w-6">{unit}</span>}
        </div>
      </div>
      <input
        type="range"
        min={min ?? 0}
        max={max ?? 100}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 mt-1 appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, #818cf8 0%, #818cf8 ${((value - (min ?? 0)) / ((max ?? 100) - (min ?? 0))) * 100}%, rgba(255,255,255,0.1) ${((value - (min ?? 0)) / ((max ?? 100) - (min ?? 0))) * 100}%, rgba(255,255,255,0.1) 100%)`,
          accentColor: "#818cf8",
        }}
      />
    </div>
  );
}

/* ── Toggle field ─────────────────────────────────────────────────────────── */
function ToggleField({ label, value, onChange, hint }: {
  label: string; value: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <div className="flex items-center justify-between py-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div>
        <p className="text-xs font-semibold text-slate-300">{label}</p>
        {hint && <p className="text-[9px] text-slate-600 mt-0.5">{hint}</p>}
      </div>
      <button
        onClick={() => onChange(!value)}
        className="relative w-11 h-6 rounded-full transition-all duration-300 shrink-0"
        style={{ background: value ? "#818cf8" : "rgba(255,255,255,0.1)" }}
      >
        <div
          className="absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-300"
          style={{ left: value ? "calc(100% - 20px)" : "4px" }}
        />
      </button>
    </div>
  );
}

/* ── Section card ─────────────────────────────────────────────────────────── */
function Section({
  title, icon, children, defaultOpen = false,
}: {
  title: string; icon: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl overflow-hidden mb-3" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 transition-colors"
        style={{ borderBottom: open ? "1px solid rgba(255,255,255,0.06)" : "none" }}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-2">
          <div className="text-indigo-400">{icon}</div>
          <span className="text-sm font-bold text-white">{title}</span>
        </div>
        {open ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
      </button>
      {open && <div className="px-4 pb-2">{children}</div>}
    </div>
  );
}

/* ── Main ─────────────────────────────────────────────────────────────────── */
export default function SettingsPage() {
  const { data: config, isLoading } = useEDConfig();
  const updateConfig = useUpdateEDConfig();
  const resetBalance = useResetPaperBalance();
  const { toast } = useToast();

  const [draft, setDraft] = useState<EDConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (config && !draft) setDraft({ ...config });
  }, [config, draft]);

  function set<K extends keyof EDConfig>(key: K, val: EDConfig[K]) {
    if (!draft) return;
    setDraft((d) => ({ ...d!, [key]: val }));
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    if (!draft) return;
    try {
      await updateConfig.mutateAsync(draft);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      toast({ title: "Settings saved", description: "Configuration updated successfully." });
    } catch {
      toast({ title: "Save failed", description: "Could not update config.", variant: "destructive" });
    }
  }

  async function doReset() {
    await resetBalance.mutateAsync();
    toast({ title: "Balance reset", description: "Virtual balance restored to 1.0 SOL." });
  }

  if (isLoading || !draft) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-3">
        <Settings2 size={28} className="text-slate-700 animate-spin" style={{ animationDuration: "3s" }} />
        <p className="text-slate-500 text-sm">Loading settings…</p>
      </div>
    );
  }

  return (
    <div className="px-4 pt-6 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-black text-white">Settings</h1>
          <p className="text-xs text-slate-500 mt-0.5">Early Demand Discovery · Paper Mode</p>
        </div>
        <button
          onClick={save}
          disabled={!dirty || updateConfig.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all"
          style={{
            background: dirty ? "rgba(129,140,248,0.2)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${dirty ? "rgba(129,140,248,0.4)" : "rgba(255,255,255,0.08)"}`,
            color: dirty ? "#818cf8" : "#64748b",
          }}
        >
          {saved
            ? <><CheckCircle size={12} className="text-emerald-400" /> Saved</>
            : <><Save size={12} /> {updateConfig.isPending ? "Saving…" : "Save"}</>}
        </button>
      </div>

      {dirty && (
        <div className="mb-4 rounded-xl px-4 py-2.5 flex items-center gap-2"
          style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)" }}>
          <AlertTriangle size={12} className="text-amber-400 shrink-0" />
          <p className="text-[10px] text-amber-400">Unsaved changes — tap Save to apply</p>
        </div>
      )}

      {/* ── General ── */}
      <Section title="General" icon={<Settings2 size={14} />} defaultOpen>
        <ToggleField
          label="Bot Enabled"
          value={draft.enabled}
          onChange={(v) => set("enabled", v)}
          hint="Master switch — pauses all new entries when off"
        />
        <Field
          label="Max Open Positions"
          value={draft.maxOpenPositions}
          onChange={(v) => set("maxOpenPositions", Math.round(v))}
          min={1} max={20} step={1}
          hint="Maximum simultaneous paper trades"
        />
      </Section>

      {/* ── Entry Filters ── */}
      <Section title="Entry Filters" icon={<Shield size={14} />} defaultOpen>
        <Field
          label="Min Demand Score"
          value={draft.minScore}
          onChange={(v) => set("minScore", v)}
          min={60} max={120} step={1}
          hint="Minimum score/120 required to enter"
        />
        <Field
          label="Min Bonding Curve %"
          value={draft.minBondingCurvePct}
          onChange={(v) => set("minBondingCurvePct", v)}
          min={50} max={99} step={1} unit="%"
          hint="Token must be this close to graduation"
        />
        <Field
          label="Min Unique Buyers"
          value={draft.minUniqueBuyers}
          onChange={(v) => set("minUniqueBuyers", Math.round(v))}
          min={5} max={200} step={1}
          hint="Minimum number of distinct buyer wallets"
        />
        <Field
          label="Min Buy/Sell Ratio"
          value={draft.minBuyPressureRatio}
          onChange={(v) => set("minBuyPressureRatio", v)}
          min={1} max={10} step={0.1} unit="×"
          hint="Buy volume must exceed sell by this multiple"
        />
      </Section>

      {/* ── Position Sizing ── */}
      <Section title="Position Sizing" icon={<Sliders size={14} />}>
        <Field
          label="Base Position Size"
          value={draft.positionSizeSol}
          onChange={(v) => set("positionSizeSol", v)}
          min={0.01} max={10} step={0.01} unit="SOL"
          hint="Full size for score 110-120. 75% for 100-109, 50% for 95-99"
        />
        <div className="mt-2 rounded-lg p-3 space-y-1" style={{ background: "rgba(129,140,248,0.06)", border: "1px solid rgba(129,140,248,0.15)" }}>
          {[
            { label: "Score 110-120", mult: 1.0 },
            { label: "Score 100-109", mult: 0.75 },
            { label: "Score 95-99",   mult: 0.50 },
          ].map(({ label, mult }) => (
            <div key={label} className="flex justify-between text-[10px]">
              <span className="text-slate-500">{label}</span>
              <span className="text-indigo-400 font-bold">{(draft.positionSizeSol * mult).toFixed(3)} SOL</span>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Exit Model ── */}
      <Section title="Exit Model" icon={<Target size={14} />}>
        <Field
          label="Stop Loss"
          value={draft.slPct}
          onChange={(v) => set("slPct", v)}
          min={5} max={50} step={0.5} unit="%"
          hint="Exit all remaining if price drops this % from entry"
        />
        <Field
          label="TP1 Target"
          value={draft.tp1Pct}
          onChange={(v) => set("tp1Pct", v)}
          min={20} max={300} step={5} unit="%"
          hint="First take-profit level"
        />
        <Field
          label="TP1 Close %"
          value={draft.tp1ClosePct}
          onChange={(v) => set("tp1ClosePct", v)}
          min={10} max={80} step={5} unit="%"
          hint="Fraction of position to sell at TP1"
        />
        <Field
          label="TP2 Target"
          value={draft.tp2Pct}
          onChange={(v) => set("tp2Pct", v)}
          min={50} max={1000} step={10} unit="%"
          hint="Second take-profit level — SL moves to breakeven after TP1"
        />
        <Field
          label="TP2 Close %"
          value={draft.tp2ClosePct}
          onChange={(v) => set("tp2ClosePct", v)}
          min={10} max={80} step={5} unit="%"
          hint="Fraction of remaining to sell at TP2"
        />
        <Field
          label="Runner Trailing Stop"
          value={draft.runnerTrailingPct}
          onChange={(v) => set("runnerTrailingPct", v)}
          min={5} max={50} step={1} unit="%"
          hint="After TP2, trail remaining position this % below peak"
        />
      </Section>

      {/* ── Summary ── */}
      <div className="rounded-xl p-4 mb-5" style={{ background: "rgba(13,13,30,0.8)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-3 flex items-center gap-1.5">
          <TrendingUp size={10} /> Exit Scenario Preview
        </p>
        <div className="space-y-1.5 text-[11px]">
          {[
            { label: "SL",     pct: -draft.slPct,  frac: 100 },
            { label: "TP1",    pct: draft.tp1Pct,   frac: draft.tp1ClosePct },
            { label: "TP2",    pct: draft.tp2Pct,   frac: draft.tp2ClosePct },
            { label: "Runner", pct: "trailing",      frac: 100 - draft.tp1ClosePct - draft.tp2ClosePct },
          ].map(({ label, pct, frac }) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-slate-500 w-16">{label}</span>
              <span className="font-bold text-white">
                {typeof pct === "number"
                  ? `${pct >= 0 ? "+" : ""}${pct}%`
                  : `−${draft.runnerTrailingPct}% from peak`}
              </span>
              <span className="text-slate-500">sell {Math.max(0, frac)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Danger zone ── */}
      <div className="rounded-xl p-4" style={{ background: "rgba(248,113,113,0.04)", border: "1px solid rgba(248,113,113,0.15)" }}>
        <p className="text-[10px] text-red-400 uppercase tracking-widest mb-3">Danger Zone</p>
        <button
          onClick={doReset}
          disabled={resetBalance.isPending}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-xs font-bold transition-all"
          style={{ background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", color: "#f87171" }}
        >
          <RotateCcw size={12} />
          {resetBalance.isPending ? "Resetting…" : "Reset Paper Balance to 1.0 SOL"}
        </button>
        <p className="text-[9px] text-slate-600 text-center mt-2">
          This clears all open positions and resets virtual balance
        </p>
      </div>
    </div>
  );
}
