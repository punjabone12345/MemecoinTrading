import { useState } from 'react';
import { Settings } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props { settings: Settings; onUpdate: (s: Settings) => void }

function NumberInput({ label, value, onChange, min, max, step, suffix, sublabel }: {
  label: string; value: number; onChange: (v: string) => void;
  min?: number; max?: number; step?: number; suffix?: string; sublabel?: string;
}) {
  return (
    <div style={{ padding: '8px 0' }}>
      <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 4, letterSpacing: '0.04em' }}>{label}</div>
      {sublabel && <div style={{ fontSize: 10, color: '#2a3a50', marginBottom: 6, lineHeight: 1.4 }}>{sublabel}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value)}
          className="input-premium" style={{ flex: 1 }} />
        {suffix && <span style={{ fontSize: 12, color: '#3a5070', fontWeight: 600, flexShrink: 0 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Section({ title, color = '#00d4ff', children }: { title: string; color?: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
        <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#d4e0f0' }}>{title}</span>
      </div>
      <div style={{ padding: '4px 16px 14px' }}>{children}</div>
    </div>
  );
}

export default function SettingsPage({ settings: init, onUpdate }: Props) {
  const [settings, setSettings] = useState(init);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetInput, setResetInput] = useState('');

  function update(key: keyof Settings, value: string) {
    const numKeys = ['minMc','maxMc','minVolume24h','minAgeHours','maxAgeHours','scanFrequencyMs','minBuySellRatio','maxTopHolder','maxCreatorPct','minLiquidity','minEntryScore','trendChecksRequired','maxOpenPositions','sizeScore90','sizeScore80','sizeScore70','slPct','tp1Pct','tp1ClosePct','tp2Pct','tp2ClosePct','tp2TrailPct','tp3Pct','tp3ClosePct','trailingSLPct','trailActivatePct','maxDailyLossPct','startingBalanceSol','currentBalanceSol','slippagePct','priorityFeeSol'];
    const updated = { ...settings } as Record<string, unknown>;
    if (numKeys.includes(key)) updated[key] = parseFloat(value) || 0;
    else updated[key] = value;
    setSettings((updated as unknown) as Settings);
  }

  async function save() {
    setSaving(true);
    try {
      const updated = await api.updateSettings(settings);
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  }

  async function handleReset() {
    if (resetInput !== 'RESET') return;
    await api.resetAll();
    setShowReset(false);
    setResetInput('');
    window.location.reload();
  }

  const n = (k: keyof Settings) => settings[k] as number;

  return (
    <div style={{ maxWidth: 520, paddingBottom: 20 }}>

      {/* Whale sniper context banner */}
      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(0,191,255,0.06)', border: '1px solid rgba(0,191,255,0.18)', marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#00bfff', letterSpacing: '0.06em', marginBottom: 4 }}>🐋 WHALE SNIPER MODE</div>
        <div style={{ fontSize: 11, color: '#3a5070', lineHeight: 1.6 }}>
          Entry size is determined by whale buy size ($500 → 0.5%, $1k → 0.75%, $2k → 1%). The position sizing below sets the <b style={{ color: '#c0c8e0' }}>base portfolio balance</b> those percentages apply to.
        </div>
      </div>

      <Section title="Position Sizing" color="#00ff88">
        <NumberInput
          label="Starting Balance (SOL)"
          value={n('startingBalanceSol')}
          onChange={(v) => update('startingBalanceSol', v)}
          min={0.1} step={1} suffix="SOL"
          sublabel="The total portfolio used to calculate % position sizes"
        />
        <NumberInput
          label="Current Balance (SOL)"
          value={n('currentBalanceSol')}
          onChange={(v) => update('currentBalanceSol', v)}
          min={0} step={0.1} suffix="SOL"
          sublabel="Updates automatically when positions open/close in paper mode"
        />
      </Section>

      <Section title="Stop Loss" color="#ff4466">
        <NumberInput
          label="Hard Stop Loss"
          value={n('slPct')}
          onChange={(v) => update('slPct', v)}
          min={5} max={50} step={5} suffix="%"
          sublabel="Whale sniper exits at +100% TP or emergency (liq -40%, liq=$0, 30min timeout). This hard SL applies to any legacy auto-trader positions."
        />
      </Section>

      {/* Save */}
      <button onClick={save} disabled={saving} className="btn-solid-cyan"
        style={{ width: '100%', padding: '16px', fontSize: 15, marginBottom: 16, opacity: saving ? 0.7 : 1 }}>
        {saving ? 'Saving…' : saved ? '✅ Saved!' : 'Save Settings'}
      </button>

      {/* Danger zone */}
      <div style={{ padding: 16, borderRadius: 16, background: 'rgba(255,68,102,0.05)', border: '1px solid rgba(255,68,102,0.18)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#ff4466', letterSpacing: '0.08em', marginBottom: 6 }}>⚠️ DANGER ZONE</div>
        <p style={{ fontSize: 12, color: '#3a5070', marginBottom: 12, lineHeight: 1.5 }}>
          Closes all open positions and resets balance back to starting balance. All trade history is cleared.
        </p>
        {!showReset ? (
          <button onClick={() => setShowReset(true)} className="btn-red" style={{ padding: '10px 20px', fontSize: 13 }}>
            Reset All Data
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#ff4466', fontWeight: 700 }}>Type RESET to confirm:</div>
            <input
              type="text" value={resetInput} onChange={(e) => setResetInput(e.target.value)} placeholder="RESET"
              className="input-premium" style={{ borderColor: 'rgba(255,68,102,0.3)' }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => { setShowReset(false); setResetInput(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}
              >Cancel</button>
              <button
                onClick={handleReset} disabled={resetInput !== 'RESET'} className="btn-solid-red"
                style={{ flex: 1, padding: '10px', fontSize: 13, opacity: resetInput === 'RESET' ? 1 : 0.4 }}
              >Confirm Reset</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
