import { useState } from 'react';
import { Position, Analytics, WhaleStatus, ClosedWhalePosition } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatPrice } from '../lib/utils.js';

interface Props { analytics: Analytics | null; closedPositions: Position[]; balance: number; onRefresh: () => Promise<void>; whaleStatus?: WhaleStatus | null }

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 18, fontWeight: 900, color: color ?? '#d4e0f0', letterSpacing: '-0.01em', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10, color: '#3a5070', marginTop: 5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: '#3a5070', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function WhalePnlChart({ positions }: { positions: ClosedWhalePosition[] }) {
  if (positions.length < 2) return null;
  const sorted = [...positions].sort((a, b) => (a.closeTime ?? a.entryTime) - (b.closeTime ?? b.entryTime));
  let running = 0;
  const pts = sorted.map((p, i) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    running += initSize * (p.closePnlPct / 100);
    return { x: i, y: running };
  });
  const maxY = Math.max(...pts.map((p) => p.y), 0);
  const minY = Math.min(...pts.map((p) => p.y), 0);
  const range = maxY - minY || 1;
  const W = 600, H = 90, pad = 8;
  const mx = (i: number) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2);
  const my = (y: number) => H - pad - ((y - minY) / range) * (H - pad * 2);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${mx(i)} ${my(p.y)}`).join(' ');
  const area = `${path} L${mx(pts.length - 1)} ${H} L${mx(0)} ${H} Z`;
  const last = pts[pts.length - 1].y;
  const col = last >= 0 ? '#9b59ff' : '#ff4466';
  return (
    <div className="card" style={{ padding: '16px', marginBottom: 4 }}>
      <div className="section-label" style={{ marginBottom: 12 }}>🐋 Cumulative PNL</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 72, display: 'block' }}>
        <defs>
          <linearGradient id="whalepnlg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.25" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#whalepnlg)" />
        <path d={path} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${col}88)` }} />
        <line x1={pad} y1={my(0)} x2={W - pad} y2={my(0)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4,4" />
      </svg>
    </div>
  );
}

export default function AnalyticsPage({ analytics: _a, balance, onRefresh, whaleStatus }: Props) {
  // All stats derived from whale sniper data
  const whaleClosed = whaleStatus?.closedPositions ?? [];
  const whaleOpen   = whaleStatus?.openPositions   ?? [];
  void _a;

  const whaleTotalPnlSol = whaleClosed.reduce((sum, p) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return sum + initSize * (p.closePnlPct / 100);
  }, 0);
  const whaleWins    = whaleClosed.filter(p => p.closePnlPct > 0).length;
  const whaleLosses  = whaleClosed.filter(p => p.closePnlPct <= 0).length;
  const whaleWinRate = whaleClosed.length > 0 ? (whaleWins / whaleClosed.length) * 100 : 0;
  const whalePnls    = whaleClosed.map(p => p.closePnlPct);
  const whaleBest    = whalePnls.length > 0 ? Math.max(...whalePnls) : 0;
  const whaleWorst   = whalePnls.length > 0 ? Math.min(...whalePnls) : 0;

  const whaleGross = whaleClosed.reduce((s, p) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    const pnl = initSize * (p.closePnlPct / 100);
    return s + (pnl > 0 ? pnl : 0);
  }, 0);
  const whaleLossAmt = whaleClosed.reduce((s, p) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    const pnl = initSize * (p.closePnlPct / 100);
    return s + (pnl < 0 ? Math.abs(pnl) : 0);
  }, 0);
  const whalePF = whaleLossAmt > 0 ? whaleGross / whaleLossAmt : whaleGross > 0 ? 99 : 0;

  // Current streak (from most-recent trade)
  let whaleStreak = 0;
  for (let i = 0; i < whaleClosed.length; i++) {
    const win = whaleClosed[i].closePnlPct > 0;
    if (i === 0) { whaleStreak = win ? 1 : -1; }
    else if (win && whaleStreak > 0) whaleStreak++;
    else if (!win && whaleStreak < 0) whaleStreak--;
    else break;
  }

  const todayStr = new Date().toDateString();
  const whaleDailyPnl = whaleClosed.reduce((sum, p) => {
    if (new Date(p.closeTime).toDateString() !== todayStr) return sum;
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return sum + initSize * (p.closePnlPct / 100);
  }, 0);

  const whaleAvgHoldMin = whaleClosed.length > 0
    ? whaleClosed.reduce((s, p) => s + (p.closeTime - p.entryTime), 0) / whaleClosed.length / 60000
    : 0;

  // Max drawdown
  let peak = 0, maxDD = 0, running = 0;
  for (const p of [...whaleClosed].reverse()) {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    running += initSize * (p.closePnlPct / 100);
    if (running > peak) peak = running;
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  function exportWhaleCSV() {
    const headers = ['Symbol', 'Entry (IST)', 'Close (IST)', 'Tier', 'Init SOL', 'Banked SOL', 'PNL %', 'Close Reason'];
    const rows = whaleClosed.map((p) => {
      const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
      return [p.symbol,
        new Date(p.entryTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        p.closeTime ? new Date(p.closeTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
        `T${p.tpTier}`, initSize.toFixed(4), p.bankedSol.toFixed(4),
        p.closePnlPct.toFixed(2), p.closeReason ?? ''];
    });
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `whale-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const totalPnl = whaleTotalPnlSol;
  const pf       = whalePF;
  const winRate  = whaleWinRate;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <StatCard label="Total Trades"    value={String(whaleClosed.length)}                color="#00d4ff" />
        <StatCard label="Win Rate"        value={`${winRate.toFixed(1)}%`}                  color={winRate >= 55 ? '#00ff88' : '#ffd700'} />
        <StatCard label="Total PNL"       value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`}  color={totalPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Profit Factor"   value={pf >= 99 ? '∞' : pf.toFixed(2)}            color={pf >= 1.5 ? '#00ff88' : '#d4e0f0'} />
        <StatCard label="Best Trade"      value={`+${whaleBest.toFixed(1)}%`}               color="#00ff88" />
        <StatCard label="Worst Trade"     value={`${whaleWorst.toFixed(1)}%`}               color="#ff4466" />
        <StatCard label="Streak"          value={`${whaleStreak >= 0 ? '+' : ''}${whaleStreak}`}
          color={whaleStreak >= 0 ? '#00ff88' : '#ff4466'}
          sub={`W: ${whaleWins}  L: ${whaleLosses}`} />
        <StatCard label="Max Drawdown"    value={`-${maxDD.toFixed(1)}%`}                   color="#ff4466" />
        <StatCard label="Avg Hold"        value={`${whaleAvgHoldMin.toFixed(0)}m`}          color="#d4e0f0" />
        <StatCard label="Daily PNL"       value={`${whaleDailyPnl >= 0 ? '+' : ''}${whaleDailyPnl.toFixed(4)} SOL`}
          color={whaleDailyPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Balance"         value={`${balance.toFixed(3)} SOL`}               color="#00d4ff" />
        <StatCard label="Open Positions"  value={String(whaleOpen.length)}                  color="#9b59ff" />
      </div>

      <WhalePnlChart positions={whaleClosed} />

      {/* Whale closed trades table */}
      <WhaleClosedTable positions={whaleClosed} onRefresh={onRefresh} onExport={exportWhaleCSV} />
    </div>
  );
}

// ── Whale closed positions table ──────────────────────────────────────────────

function WhaleClosedTable({ positions, onRefresh, onExport }: {
  positions: ClosedWhalePosition[];
  onRefresh: () => Promise<void>;
  onExport: () => void;
}) {
  const [deleting, setDeleting]   = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft]         = useState({ closeReason: '', closePnlPct: '' });
  const [saving, setSaving]       = useState(false);

  const sorted = [...positions].sort((a, b) =>
    (b.closeTime ?? b.entryTime) - (a.closeTime ?? a.entryTime),
  );

  async function handleDelete(id: string, symbol: string) {
    if (!confirm(`Delete ${symbol} closed whale trade?`)) return;
    setDeleting(id);
    try { await api.deleteClosedWhalePosition(id); await onRefresh(); } finally { setDeleting(null); }
  }

  function openEdit(pos: ClosedWhalePosition) {
    setEditingId(pos.id);
    setDraft({ closeReason: pos.closeReason ?? '', closePnlPct: String(pos.closePnlPct) });
  }

  async function handleSave() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api.editClosedWhalePosition(editingId, {
        closeReason: draft.closeReason || undefined,
        closePnlPct: parseFloat(draft.closePnlPct) || undefined,
      });
      await onRefresh();
      setEditingId(null);
    } finally { setSaving(false); }
  }

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* Edit modal */}
      {editingId && (() => {
        const pos = positions.find(p => p.id === editingId);
        if (!pos) return null;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div className="card" style={{ width: 340, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 900, color: '#d4e0f0', fontSize: 15 }}>Edit 🐋 Whale — <span style={{ color: '#9b59ff' }}>{pos.symbol}</span></div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Close Reason</span>
                <input type="text" value={draft.closeReason} onChange={(e) => setDraft({ ...draft, closeReason: e.target.value })}
                  style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Close P&L %</span>
                <input type="number" step="0.1" value={draft.closePnlPct} onChange={(e) => setDraft({ ...draft, closePnlPct: e.target.value })}
                  style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleSave} disabled={saving} className="btn-primary" style={{ flex: 1, padding: '9px 0', fontSize: 12, fontWeight: 800 }}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditingId(null)} className="btn-red" style={{ padding: '9px 14px', fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontWeight: 800, color: '#9b59ff', fontSize: 13 }}>🐋 Whale Closed Trades ({positions.length})</span>
        {positions.length > 0 && (
          <button onClick={onExport} className="btn-primary" style={{ padding: '6px 12px', fontSize: 11 }}>📥 Export CSV</button>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
              {['Token', 'Entry (IST)', 'Close (IST)', 'Tier', 'Entry $', 'Exit $', 'Init SOL', 'Banked', 'PNL %', 'Close Reason', ''].map((l) => (
                <th key={l} style={{ padding: '10px 12px', textAlign: 'left', color: '#3a5070', whiteSpace: 'nowrap', fontWeight: 700, letterSpacing: '0.05em', fontSize: 10 }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={11} style={{ textAlign: 'center', padding: '32px', color: '#3a5070' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🐋</div>
                No closed whale trades yet
              </td></tr>
            ) : sorted.map((p) => {
              const pnlPos = p.closePnlPct >= 0;
              const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
              const dexUrl = `https://dexscreener.com/solana/${p.mint}`;
              return (
                <tr key={p.id} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 800, color: '#d4e0f0' }}>{p.symbol}</div>
                    <div style={{ color: '#3a5070', fontSize: 10 }}>{p.name?.slice(0, 10)}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#3a5070', whiteSpace: 'nowrap', fontSize: 10 }}>
                    {new Date(p.entryTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#3a5070', whiteSpace: 'nowrap', fontSize: 10 }}>
                    {p.closeTime ? new Date(p.closeTime).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 6px', borderRadius: 5, fontSize: 9, fontWeight: 800, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.28)' }}>T{p.tpTier}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#d4e0f0' }}>${formatPrice(p.entryPrice)}</td>
                  <td style={{ padding: '10px 12px', color: '#d4e0f0' }}>${formatPrice(p.lastPrice)}</td>
                  <td style={{ padding: '10px 12px', color: '#7090b0' }}>{initSize.toFixed(3)}</td>
                  <td style={{ padding: '10px 12px', color: '#9b59ff', fontWeight: 700 }}>{p.bankedSol.toFixed(3)}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 800, color: pnlPos ? '#00ff88' : '#ff4466' }}>
                    {pnlPos ? '+' : ''}{p.closePnlPct.toFixed(1)}%
                  </td>
                  <td style={{ padding: '10px 12px', maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <span style={{ fontSize: 10, color: '#7090b0' }} title={p.closeReason ?? ''}>{p.closeReason ?? '—'}</span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <a href={dexUrl} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ padding: '4px 8px', fontSize: 10, textDecoration: 'none' }}>DEX</a>
                      <button onClick={() => openEdit(p)} className="btn-primary" style={{ padding: '4px 8px', fontSize: 10, background: 'rgba(155,89,255,0.15)', borderColor: 'rgba(155,89,255,0.35)' }}>Edit</button>
                      <button onClick={() => handleDelete(p.id, p.symbol)} disabled={deleting === p.id} className="btn-red" style={{ padding: '4px 8px', fontSize: 10 }}>
                        {deleting === p.id ? '…' : 'Del'}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
