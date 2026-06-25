import { useState } from 'react';
import { Settings } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props { settings: Settings; onUpdate: (s: Settings) => void }

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
      <span style={{ fontSize: 13, color: '#d4e0f0', fontWeight: 600 }}>{label}</span>
      <button onClick={() => onChange(value ? 'false' : 'true')}
        style={{
          position: 'relative', width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer',
          background: value ? 'linear-gradient(135deg, #00d4ff, #0090cc)' : 'rgba(255,255,255,0.08)',
          boxShadow: value ? '0 0 12px rgba(0,212,255,0.35)' : 'none',
          transition: 'all 0.25s ease',
        }}>
        <div style={{
          position: 'absolute', top: 3, width: 20, height: 20, borderRadius: '50%',
          background: 'white', transition: 'left 0.25s ease',
          left: value ? 25 : 3,
          boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        }} />
      </button>
    </div>
  );
}

function NumberInput({ label, value, onChange, min, max, step, suffix }: {
  label: string; value: number; onChange: (v: string) => void;
  min?: number; max?: number; step?: number; suffix?: string;
}) {
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 6, letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.target.value)}
          className="input-premium" style={{ flex: 1 }} />
        {suffix && <span style={{ fontSize: 12, color: '#3a5070', fontWeight: 600, flexShrink: 0 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function TextInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ padding: '6px 0' }}>
      <div style={{ fontSize: 11, color: '#3a5070', fontWeight: 700, marginBottom: 6, letterSpacing: '0.04em' }}>{label}</div>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="input-premium" />
    </div>
  );
}

function Section({ title, color = '#00d4ff', children }: { title: string; color?: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 8 }}>
      <button onClick={() => setCollapsed(!collapsed)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 3, height: 14, borderRadius: 2, background: color }} />
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#d4e0f0' }}>{title}</span>
        </div>
        <span style={{ color: '#3a5070', fontSize: 12 }}>{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div style={{ padding: '0 16px 14px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {children}
        </div>
      )}
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
    const numKeys = ['minMc','maxMc','minVolume24h','minAgeHours','maxAgeHours','scanFrequencyMs','minBuySellRatio','maxTopHolder','maxCreatorPct','minLiquidity','minEntryScore','trendChecksRequired','maxOpenPositions','sizeScore90','sizeScore80','sizeScore70','slPct','tp1Pct','tp1ClosePct','tp2Pct','tp2ClosePct','tp2TrailPct','tp3Pct','tp3ClosePct','trailingSLPct','maxDailyLossPct','startingBalanceSol','currentBalanceSol','slippagePct','priorityFeeSol'];
    const boolKeys = ['rugcheckEnabled'];
    const updated = { ...settings } as Record<string, unknown>;
    if (numKeys.includes(key)) updated[key] = parseFloat(value) || 0;
    else if (boolKeys.includes(key)) updated[key] = value === 'true';
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
  const b = (k: keyof Settings) => settings[k] as boolean;
  const s = (k: keyof Settings) => settings[k] as string;

  return (
    <div style={{ maxWidth: 520, paddingBottom: 20 }}>
      <Section title="Scanning" color="#00d4ff">
        <NumberInput label="Min Market Cap ($)" value={n('minMc')} onChange={(v) => update('minMc', v)} min={0} step={10000} />
        <NumberInput label="Max Market Cap ($)" value={n('maxMc')} onChange={(v) => update('maxMc', v)} min={100000} step={500000} />
        <NumberInput label="Min 24h Volume ($)" value={n('minVolume24h')} onChange={(v) => update('minVolume24h', v)} min={0} step={10000} />
        <NumberInput label="Min Age (hours)" value={n('minAgeHours')} onChange={(v) => update('minAgeHours', v)} min={0} step={0.5} />
        <NumberInput label="Max Age (hours)" value={n('maxAgeHours')} onChange={(v) => update('maxAgeHours', v)} min={1} step={24} />
        <NumberInput label="Scan Frequency (ms)" value={n('scanFrequencyMs')} onChange={(v) => update('scanFrequencyMs', v)} min={10000} step={5000} />
      </Section>

      <Section title="Quality Filters" color="#9b59ff">
        <NumberInput label="Min Buy/Sell Ratio" value={n('minBuySellRatio')} onChange={(v) => update('minBuySellRatio', v)} min={1} max={5} step={0.1} />
        <NumberInput label="Min Liquidity ($)" value={n('minLiquidity')} onChange={(v) => update('minLiquidity', v)} min={0} step={5000} />
        <NumberInput label="Max Top Holder %" value={n('maxTopHolder')} onChange={(v) => update('maxTopHolder', v)} min={1} max={100} step={1} suffix="%" />
        <NumberInput label="Max Creator %" value={n('maxCreatorPct')} onChange={(v) => update('maxCreatorPct', v)} min={1} max={100} step={1} suffix="%" />
        <Toggle label="Rugcheck Enabled" value={b('rugcheckEnabled')} onChange={(v) => update('rugcheckEnabled', v)} />
      </Section>

      <Section title="Scoring & Entry" color="#ffd700">
        <NumberInput label="Min Entry Score (0–100)" value={n('minEntryScore')} onChange={(v) => update('minEntryScore', v)} min={0} max={100} step={5} />
        <NumberInput label="Trend Checks Required" value={n('trendChecksRequired')} onChange={(v) => update('trendChecksRequired', v)} min={1} max={10} step={1} />
      </Section>

      <Section title="Position Sizing" color="#00ff88">
        <NumberInput label="Max Open Positions" value={n('maxOpenPositions')} onChange={(v) => update('maxOpenPositions', v)} min={1} max={20} step={1} />
        <NumberInput label="Size @ Score 90+ (% portfolio)" value={n('sizeScore90')} onChange={(v) => update('sizeScore90', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <NumberInput label="Size @ Score 80–89" value={n('sizeScore80')} onChange={(v) => update('sizeScore80', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <NumberInput label="Size @ Score 70–79" value={n('sizeScore70')} onChange={(v) => update('sizeScore70', v)} min={0.1} max={10} step={0.1} suffix="%" />
      </Section>

      <Section title="Stop Loss / Runner" color="#ff4466">
        <NumberInput label="Hard Stop Loss %" value={n('slPct')} onChange={(v) => update('slPct', v)} min={5} max={50} step={5} suffix="%" />
        <NumberInput label="Trailing SL % (below peak)" value={n('trailingSLPct')} onChange={(v) => update('trailingSLPct', v)} min={5} max={50} step={5} suffix="%" />
      </Section>

      <Section title="Risk Management" color="#ffd700">
        <NumberInput label="Max Daily Loss %" value={n('maxDailyLossPct')} onChange={(v) => update('maxDailyLossPct', v)} min={1} max={20} step={0.5} suffix="%" />
      </Section>

      <Section title="Paper Trading Balance" color="#00d4ff">
        <NumberInput label="Starting Balance (SOL)" value={n('startingBalanceSol')} onChange={(v) => update('startingBalanceSol', v)} min={0.1} step={1} suffix="SOL" />
        <NumberInput label="Current Balance (SOL)" value={n('currentBalanceSol')} onChange={(v) => update('currentBalanceSol', v)} min={0} step={0.1} suffix="SOL" />
      </Section>

      <Section title="Live Trading (Render)" color="#9b59ff">
        <TextInput label="RPC Endpoint" value={s('rpcEndpoint')} onChange={(v) => update('rpcEndpoint', v)} />
        <NumberInput label="Slippage %" value={n('slippagePct')} onChange={(v) => update('slippagePct', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <NumberInput label="Priority Fee (SOL)" value={n('priorityFeeSol')} onChange={(v) => update('priorityFeeSol', v)} min={0} max={0.01} step={0.0001} suffix="SOL" />
        <div style={{ padding: '8px 0', fontSize: 11, color: '#3a5070' }}>
          Wallet: <span style={{ color: '#7090b0' }}>{s('walletPublicKey') || 'Not configured (set SOLANA_PRIVATE_KEY on Render)'}</span>
        </div>
      </Section>

      {/* Save */}
      <button onClick={save} disabled={saving} className="btn-solid-cyan"
        style={{ width: '100%', padding: '16px', fontSize: 15, marginBottom: 12, opacity: saving ? 0.7 : 1 }}>
        {saving ? 'Saving…' : saved ? '✅ Saved!' : 'Save Settings'}
      </button>

      {/* Danger zone */}
      <div style={{ padding: 16, borderRadius: 16, background: 'rgba(255,68,102,0.05)', border: '1px solid rgba(255,68,102,0.18)' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#ff4466', letterSpacing: '0.08em', marginBottom: 8 }}>⚠️ DANGER ZONE</div>
        <p style={{ fontSize: 12, color: '#3a5070', marginBottom: 12, lineHeight: 1.5 }}>
          Resets all positions and restores balance to starting balance.
        </p>
        {!showReset ? (
          <button onClick={() => setShowReset(true)} className="btn-red" style={{ padding: '10px 20px', fontSize: 13 }}>Reset All Data</button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12, color: '#ff4466', fontWeight: 700 }}>Type RESET to confirm:</div>
            <input type="text" value={resetInput} onChange={(e) => setResetInput(e.target.value)} placeholder="RESET"
              className="input-premium" style={{ borderColor: 'rgba(255,68,102,0.3)' }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => { setShowReset(false); setResetInput(''); }}
                style={{ flex: 1, padding: '10px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
              <button onClick={handleReset} disabled={resetInput !== 'RESET'} className="btn-solid-red"
                style={{ flex: 1, padding: '10px', fontSize: 13, opacity: resetInput === 'RESET' ? 1 : 0.4 }}>Confirm Reset</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
