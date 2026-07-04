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
    const numKeys = ['minMc','maxMc','minVolume24h','minAgeHours','maxAgeHours','scanFrequencyMs','minBuySellRatio','maxTopHolder','maxCreatorPct','minLiquidity','minEntryScore','trendChecksRequired','maxOpenPositions','sizeScore90','sizeScore80','sizeScore70','slPct','tp1Pct','tp1ClosePct','tp2Pct','tp2ClosePct','tp2TrailPct','tp3Pct','tp3ClosePct','trailingSLPct','trailActivatePct','maxDailyLossPct','startingBalanceSol','currentBalanceSol','slippagePct','priorityFeeSol','whaleSlippagePct','whaleStagnationPct','wt1Tp1Pct','wt1Tp1Exit','wt1Tp2Pct','wt1Tp2Exit','wt1Tp2Trail','wt1Tp3Pct','wt1Tp3Exit','wt1Tp3Trail','wt2Tp1Pct','wt2Tp1Exit','wt2Tp2Pct','wt2Tp2Exit','wt2Tp2Trail','wt2Tp3Pct','wt2Tp3Exit','wt2Tp3Trail','wt3Tp1Pct','wt3Tp1Exit','wt3Tp2Pct','wt3Tp2Exit','wt3Tp2Trail','wt3Tp3Pct','wt3Tp3Exit','wt3Tp3Trail'];
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
          Entry size is determined by whale buy size ($500 → 0.5%, $1k → 0.75%, $2k → 1%). Positions are held <b style={{ color: '#c0c8e0' }}>indefinitely</b> — no time limit. Exit only via TP/SL, liquidity emergency, or stagnation (&lt;X% move in 1h).
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

      {/* Whale TP Tiers */}
      <Section title="Whale TP Tiers" color="#ff9900">
        <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 14, lineHeight: 1.6 }}>
          Each TP exits <b style={{ color: '#c0c8e0' }}>30% of the original position</b> → 10% runner held until trailing SL. Tier is set by whale buy size at detection.
        </div>

        {/* Tier header helper */}
        {([
          { label: 'Tier 1 — $500–$999 buys',   k: 'wt1' as const, color: '#00d4ff' },
          { label: 'Tier 2 — $1000–$1999 buys', k: 'wt2' as const, color: '#9b59ff' },
          { label: 'Tier 3 — $2000+ buys',       k: 'wt3' as const, color: '#ff9900' },
        ] as const).map(({ label, k, color }) => (
          <div key={k} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ width: 3, height: 12, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: '0.06em' }}>{label}</span>
            </div>

            {/* Column headers */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 4 }}>
              {['Level', 'Gain %', 'Exit %', 'SL Trail %'].map(h => (
                <div key={h} style={{ fontSize: 10, color: '#2a3a50', fontWeight: 700, letterSpacing: '0.05em' }}>{h}</div>
              ))}
            </div>

            {/* TP1 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP1</div>
              <input type="number" value={n(`${k}Tp1Pct` as keyof Settings)} min={10} max={500} step={5}
                onChange={e => update(`${k}Tp1Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp1Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp1Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <div style={{ fontSize: 10, color: '#3a5070', fontStyle: 'italic' }}>→ Breakeven</div>
            </div>

            {/* TP2 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP2</div>
              <input type="number" value={n(`${k}Tp2Pct` as keyof Settings)} min={10} max={1000} step={5}
                onChange={e => update(`${k}Tp2Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp2Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp2Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp2Trail` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp2Trail` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
            </div>

            {/* TP3 row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 6, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700 }}>TP3 + Runner</div>
              <input type="number" value={n(`${k}Tp3Pct` as keyof Settings)} min={10} max={2000} step={10}
                onChange={e => update(`${k}Tp3Pct` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp3Exit` as keyof Settings)} min={5} max={50} step={5}
                onChange={e => update(`${k}Tp3Exit` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
              <input type="number" value={n(`${k}Tp3Trail` as keyof Settings)} min={3} max={50} step={1}
                onChange={e => update(`${k}Tp3Trail` as keyof Settings, e.target.value)}
                className="input-premium" style={{ padding: '6px 8px', fontSize: 12 }} />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Stop Loss" color="#ff4466">
        <NumberInput
          label="Hard Stop Loss"
          value={n('slPct')}
          onChange={(v) => update('slPct', v)}
          min={5} max={50} step={5} suffix="%"
          sublabel="Applies to any legacy auto-trader positions only. Whale sniper uses its own per-tier SL/trailing rules."
        />
      </Section>

      <Section title="Stagnation Exit" color="#ff6600">
        <NumberInput
          label="Max Flat Move in 1h"
          value={n('whaleStagnationPct')}
          onChange={(v) => update('whaleStagnationPct', v)}
          min={1} max={30} step={1} suffix="%"
          sublabel="Close a whale position if the absolute 1h price change is below this % and the position has been open for at least 1 hour. Keeps capital moving; no time-based exit otherwise."
        />
      </Section>

      <Section title="Whale Entry Slippage" color="#ffaa00">
        <NumberInput
          label="Max Slippage vs Whale Price"
          value={n('whaleSlippagePct')}
          onChange={(v) => update('whaleSlippagePct', v)}
          min={1} max={100} step={1} suffix="%"
          sublabel="Skip a trade if the current price has pumped more than this % above the detected whale buy price. Default: 20%. Telegram alert is sent on every skip."
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
