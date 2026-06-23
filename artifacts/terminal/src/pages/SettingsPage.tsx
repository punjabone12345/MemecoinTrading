import { useState } from 'react';
import { Settings } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  settings: Settings;
  onUpdate: (s: Settings) => void;
}

function SettingInput({
  label, value, onChange, type = 'number', min, max, step, suffix,
}: {
  label: string; value: number | string | boolean; onChange: (v: string) => void;
  type?: 'number' | 'text' | 'toggle'; min?: number; max?: number; step?: number; suffix?: string;
}) {
  if (type === 'toggle') {
    return (
      <div className="flex items-center justify-between py-2">
        <span className="text-sm" style={{ color: 'var(--text)' }}>{label}</span>
        <button
          onClick={() => onChange(value ? 'false' : 'true')}
          className="relative w-12 h-6 rounded-full transition-all"
          style={{ background: value ? 'var(--cyan)' : 'var(--navy-border)' }}
        >
          <div className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: value ? '26px' : '2px' }} />
        </button>
      </div>
    );
  }
  return (
    <div className="py-2">
      <label className="text-xs block mb-1" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type={type}
          value={String(value)}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded-lg text-sm"
          style={{
            background: 'var(--navy)',
            border: '1px solid var(--navy-border)',
            color: 'var(--text)',
            outline: 'none',
          }}
        />
        {suffix && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{suffix}</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border p-4 mb-4" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}>
      <h3 className="text-xs font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--cyan)' }}>{title}</h3>
      {children}
    </div>
  );
}

export default function SettingsPage({ settings: initial, onUpdate }: Props) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [showReset, setShowReset] = useState(false);

  function update(key: keyof Settings, value: string) {
    const numKeys = [
      'minMc', 'minVolume24h', 'minAgeHours', 'maxAgeHours', 'scanFrequencyMs',
      'minBuySellRatio', 'maxTopHolder', 'maxCreatorPct', 'minLiquidity',
      'minEntryScore', 'trendChecksRequired', 'maxOpenPositions',
      'sizeScore90', 'sizeScore80', 'sizeScore70',
      'slPct', 'tp1Pct', 'tp1ClosePct', 'tp2Pct', 'tp2ClosePct', 'tp3Pct', 'tp3ClosePct',
      'trailingSLPct', 'maxDailyLossPct', 'startingBalanceSol', 'currentBalanceSol',
      'slippagePct', 'priorityFeeSol',
    ];
    const boolKeys = ['rugcheckEnabled'];
    const updated = { ...settings };
    if (numKeys.includes(key)) (updated as Record<string, unknown>)[key] = parseFloat(value) || 0;
    else if (boolKeys.includes(key)) (updated as Record<string, unknown>)[key] = value === 'true';
    else (updated as Record<string, unknown>)[key] = value;
    setSettings(updated);
  }

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(settings)) payload[k] = String(v);
      const updated = await api.updateSettings(settings);
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (resetInput !== 'RESET') return;
    await api.resetAll();
    setShowReset(false);
    setResetInput('');
    window.location.reload();
  }

  return (
    <div className="max-w-2xl">
      <Section title="Scanning">
        <SettingInput label="Min Market Cap ($)" value={settings.minMc} onChange={(v) => update('minMc', v)} min={0} step={10000} />
        <SettingInput label="Min 24h Volume ($)" value={settings.minVolume24h} onChange={(v) => update('minVolume24h', v)} min={0} step={10000} />
        <SettingInput label="Min Age (hours)" value={settings.minAgeHours} onChange={(v) => update('minAgeHours', v)} min={0} step={0.5} />
        <SettingInput label="Max Age (hours)" value={settings.maxAgeHours} onChange={(v) => update('maxAgeHours', v)} min={1} step={24} />
        <SettingInput label="Scan Frequency (ms)" value={settings.scanFrequencyMs} onChange={(v) => update('scanFrequencyMs', v)} min={10000} step={5000} />
      </Section>

      <Section title="Quality Filters">
        <SettingInput label="Min Buy/Sell Ratio" value={settings.minBuySellRatio} onChange={(v) => update('minBuySellRatio', v)} min={1} max={5} step={0.1} />
        <SettingInput label="Max Top Holder %" value={settings.maxTopHolder} onChange={(v) => update('maxTopHolder', v)} min={1} max={100} step={1} suffix="%" />
        <SettingInput label="Max Creator %" value={settings.maxCreatorPct} onChange={(v) => update('maxCreatorPct', v)} min={1} max={100} step={1} suffix="%" />
        <SettingInput label="Min Liquidity ($)" value={settings.minLiquidity} onChange={(v) => update('minLiquidity', v)} min={0} step={5000} />
        <SettingInput label="Rugcheck Enabled" value={settings.rugcheckEnabled} onChange={(v) => update('rugcheckEnabled', v)} type="toggle" />
      </Section>

      <Section title="Scoring & Entry">
        <SettingInput label="Min Entry Score (0-100)" value={settings.minEntryScore} onChange={(v) => update('minEntryScore', v)} min={50} max={100} step={5} />
        <SettingInput label="Trend Checks Required" value={settings.trendChecksRequired} onChange={(v) => update('trendChecksRequired', v)} min={1} max={10} step={1} />
      </Section>

      <Section title="Position Sizing">
        <SettingInput label="Max Open Positions" value={settings.maxOpenPositions} onChange={(v) => update('maxOpenPositions', v)} min={1} max={20} step={1} />
        <SettingInput label="Size at Score 90+ (% of portfolio)" value={settings.sizeScore90} onChange={(v) => update('sizeScore90', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <SettingInput label="Size at Score 80-89 (% of portfolio)" value={settings.sizeScore80} onChange={(v) => update('sizeScore80', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <SettingInput label="Size at Score 70-79 (% of portfolio)" value={settings.sizeScore70} onChange={(v) => update('sizeScore70', v)} min={0.1} max={10} step={0.1} suffix="%" />
      </Section>

      <Section title="Take Profit / Stop Loss">
        <SettingInput label="Stop Loss %" value={settings.slPct} onChange={(v) => update('slPct', v)} min={5} max={50} step={5} suffix="%" />
        <SettingInput label="TP1 Gain %" value={settings.tp1Pct} onChange={(v) => update('tp1Pct', v)} min={20} max={500} step={10} suffix="%" />
        <SettingInput label="TP1 Close %" value={settings.tp1ClosePct} onChange={(v) => update('tp1ClosePct', v)} min={10} max={100} step={5} suffix="%" />
        <SettingInput label="TP2 Gain %" value={settings.tp2Pct} onChange={(v) => update('tp2Pct', v)} min={50} max={1000} step={25} suffix="%" />
        <SettingInput label="TP2 Close %" value={settings.tp2ClosePct} onChange={(v) => update('tp2ClosePct', v)} min={10} max={100} step={5} suffix="%" />
        <SettingInput label="TP3 Gain %" value={settings.tp3Pct} onChange={(v) => update('tp3Pct', v)} min={100} max={2000} step={50} suffix="%" />
        <SettingInput label="TP3 Close %" value={settings.tp3ClosePct} onChange={(v) => update('tp3ClosePct', v)} min={10} max={100} step={5} suffix="%" />
        <SettingInput label="Trailing SL %" value={settings.trailingSLPct} onChange={(v) => update('trailingSLPct', v)} min={5} max={50} step={5} suffix="%" />
      </Section>

      <Section title="Risk Management">
        <SettingInput label="Max Daily Loss %" value={settings.maxDailyLossPct} onChange={(v) => update('maxDailyLossPct', v)} min={1} max={20} step={0.5} suffix="%" />
      </Section>

      <Section title="Paper Trading">
        <SettingInput label="Starting Balance (SOL)" value={settings.startingBalanceSol} onChange={(v) => update('startingBalanceSol', v)} min={0.1} step={1} suffix="SOL" />
        <SettingInput label="Current Balance (SOL)" value={settings.currentBalanceSol} onChange={(v) => update('currentBalanceSol', v)} min={0} step={0.1} suffix="SOL" />
      </Section>

      <Section title="Live Trading (Future)">
        <SettingInput label="RPC Endpoint" value={settings.rpcEndpoint} onChange={(v) => update('rpcEndpoint', v)} type="text" />
        <SettingInput label="Slippage %" value={settings.slippagePct} onChange={(v) => update('slippagePct', v)} min={0.1} max={10} step={0.1} suffix="%" />
        <SettingInput label="Priority Fee (SOL)" value={settings.priorityFeeSol} onChange={(v) => update('priorityFeeSol', v)} min={0} max={0.01} step={0.0001} suffix="SOL" />
        <div className="py-2 text-xs" style={{ color: 'var(--text-dim)' }}>
          Wallet: {settings.walletPublicKey || 'Not configured (set WALLET_PRIVATE_KEY env var for live mode)'}
        </div>
      </Section>

      {/* Save Button */}
      <button
        onClick={save}
        disabled={saving}
        className="w-full py-3 rounded-xl font-bold text-sm transition-all mb-4"
        style={{
          background: saved ? 'var(--green)' : 'var(--cyan)',
          color: 'var(--navy)',
          opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? 'Saving...' : saved ? '✅ Saved!' : 'Save Settings'}
      </button>

      {/* Reset Button */}
      <div className="rounded-xl border p-4" style={{ background: 'rgba(255,68,102,0.05)', borderColor: 'rgba(255,68,102,0.2)' }}>
        <h3 className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--red)' }}>⚠️ Danger Zone</h3>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
          Reset All Data will delete all positions (open & closed) and restore balance to the starting balance setting.
        </p>
        {!showReset ? (
          <button onClick={() => setShowReset(true)}
            className="px-4 py-2 rounded-lg text-sm font-semibold"
            style={{ background: 'rgba(255,68,102,0.15)', color: 'var(--red)', border: '1px solid rgba(255,68,102,0.3)' }}>
            Reset All Data
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs font-semibold" style={{ color: 'var(--red)' }}>Type RESET to confirm:</p>
            <input
              type="text"
              value={resetInput}
              onChange={(e) => setResetInput(e.target.value)}
              placeholder="RESET"
              className="w-full px-3 py-2 rounded-lg text-sm"
              style={{ background: 'var(--navy)', border: '1px solid rgba(255,68,102,0.4)', color: 'var(--text)', outline: 'none' }}
            />
            <div className="flex gap-2">
              <button onClick={() => { setShowReset(false); setResetInput(''); }}
                className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'var(--navy-border)', color: 'var(--text)' }}>
                Cancel
              </button>
              <button onClick={handleReset} disabled={resetInput !== 'RESET'}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-opacity"
                style={{ background: resetInput === 'RESET' ? 'var(--red)' : 'rgba(255,68,102,0.3)', color: 'white', opacity: resetInput === 'RESET' ? 1 : 0.5 }}>
                Confirm Reset
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
