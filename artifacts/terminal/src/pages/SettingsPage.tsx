import { useState } from 'react';
import { Settings } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  settings: Settings;
  onUpdate: (s: Settings) => void;
}

export default function SettingsPage({ settings: init, onUpdate }: Props) {
  const [settings, setSettings] = useState(init);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resetting, setResetting] = useState(false);

  function update(key: keyof Settings, value: unknown) {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.updateSettings(settings);
      onUpdate(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPortfolio() {
    if (!confirm('Are you sure you want to reset your Paper Trading Portfolio back to $100.00 USD? All open/closed paper trades will be cleared.')) return;
    setResetting(true);
    try {
      await api.resetAltcoinPortfolio(settings.startingBalanceUsd || 100);
      window.location.reload();
    } catch {
      // ignore
    } finally {
      setResetting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 600, margin: '0 auto' }}>
      
      {/* Header Banner */}
      <div style={{ background: 'linear-gradient(135deg, rgba(0,212,255,0.08) 0%, rgba(155,89,255,0.08) 100%)', border: '1px solid rgba(0,212,255,0.2)', borderRadius: 14, padding: '16px' }}>
        <div style={{ fontSize: 16, fontWeight: 900, color: '#00d4ff' }}>
          ⚙️ ALTCOIN PAPER ACCOUNT & RISK SETTINGS
        </div>
        <div style={{ fontSize: 11, color: '#7090b0', marginTop: 4 }}>
          Manage your simulated paper balance, quantitative risk parameters, and AI signal gating rules.
        </div>
      </div>

      {/* Account Balance Section */}
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '16px' }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#00ff88', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase' }}>
          💰 PAPER ACCOUNT BALANCE
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700, marginBottom: 4 }}>STARTING BALANCE (USD)</div>
            <input
              type="number"
              value={settings.startingBalanceUsd ?? 100}
              onChange={(e) => update('startingBalanceUsd', parseFloat(e.target.value) || 100)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#0a101d', border: '1px solid rgba(255,255,255,0.1)', color: '#ffffff', fontSize: 13, fontWeight: 700 }}
            />
            <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>Initial paper capital allocated to account (Default: $100.00 USD).</div>
          </div>
        </div>
      </div>

      {/* Risk Management Section */}
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '16px' }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#ffd700', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase' }}>
          🛡️ QUANTITATIVE RISK & POSITION SIZING
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700, marginBottom: 4 }}>MAX RISK PER TRADE (%)</div>
            <input
              type="number"
              step="0.1"
              value={settings.riskPerTradePct ?? 1.0}
              onChange={(e) => update('riskPerTradePct', parseFloat(e.target.value) || 1.0)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#0a101d', border: '1px solid rgba(255,255,255,0.1)', color: '#ffffff', fontSize: 13, fontWeight: 700 }}
            />
            <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>Max capital lost if Stop Loss is hit (Default: 1.0% = $1.00 USD per trade on $100 account).</div>
          </div>

          <div>
            <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700, marginBottom: 4 }}>MAX OPEN POSITIONS</div>
            <input
              type="number"
              value={settings.maxOpenPositions ?? 2}
              onChange={(e) => update('maxOpenPositions', parseInt(e.target.value, 10) || 2)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#0a101d', border: '1px solid rgba(255,255,255,0.1)', color: '#ffffff', fontSize: 13, fontWeight: 700 }}
            />
            <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>Maximum concurrent open positions allowed for quality over quantity (Default: 2).</div>
          </div>
        </div>
      </div>

      {/* AI Gate Thresholds Section */}
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '16px' }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase' }}>
          🤖 AI MODEL ENTRY GATE THRESHOLDS
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700, marginBottom: 4 }}>MINIMUM AI SCORE FOR ENTRY (0 - 100)</div>
            <input
              type="number"
              value={settings.minAiScore ?? 88}
              onChange={(e) => update('minAiScore', parseInt(e.target.value, 10) || 88)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#0a101d', border: '1px solid rgba(255,255,255,0.1)', color: '#ffffff', fontSize: 13, fontWeight: 700 }}
            />
            <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>Minimum combined AI score required to trigger ENTRY_READY (Default: 88/100).</div>
          </div>

          <div>
            <div style={{ fontSize: 11, color: '#7090b0', fontWeight: 700, marginBottom: 4 }}>MINIMUM RISK : REWARD RATIO</div>
            <input
              type="number"
              step="0.1"
              value={settings.minRiskRewardRatio ?? 2.0}
              onChange={(e) => update('minRiskRewardRatio', parseFloat(e.target.value) || 2.0)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#0a101d', border: '1px solid rgba(255,255,255,0.1)', color: '#ffffff', fontSize: 13, fontWeight: 700 }}
            />
            <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>Minimum required reward vs risk ratio (Default: 2.0 : 1).</div>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%', padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, #00d4ff, #9b59ff)',
          border: 'none', color: '#080d1a', fontSize: 13, fontWeight: 900, cursor: 'pointer',
          letterSpacing: '0.04em', opacity: saving ? 0.7 : 1,
        }}
      >
        {saving ? 'SAVING...' : saved ? '✅ SETTINGS SAVED' : 'SAVE SETTINGS'}
      </button>

      {/* Reset Portfolio */}
      <div style={{ background: 'rgba(255,68,102,0.05)', border: '1px solid rgba(255,68,102,0.2)', borderRadius: 12, padding: '16px', marginTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#ff4466', letterSpacing: '0.08em', marginBottom: 4 }}>
          ⚠️ RESET PAPER PORTFOLIO
        </div>
        <div style={{ fontSize: 10, color: '#7090b0', marginBottom: 12 }}>
          Reset your paper trading account back to initial $100.00 USD starting balance.
        </div>
        <button
          onClick={handleResetPortfolio}
          disabled={resetting}
          style={{
            padding: '10px 16px', borderRadius: 8, background: 'rgba(255,68,102,0.18)',
            border: '1px solid rgba(255,68,102,0.4)', color: '#ff4466', fontSize: 11, fontWeight: 800, cursor: 'pointer',
          }}
        >
          {resetting ? 'RESETTING...' : 'RESET PORTFOLIO TO $100.00'}
        </button>
      </div>
    </div>
  );
}
