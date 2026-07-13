import { useState } from 'react';
import { WhaleStatus, ClosedWhalePosition } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatPrice } from '../lib/utils.js';

interface Props {
  balance: number;      // portfolio value (free cash + open position market value)
  freeBalance: number;  // free cash only
  onRefresh: () => Promise<void>;
  whaleStatus?: WhaleStatus | null;
}

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
  if (positions.length < 1) return null;
  const sorted = [...positions].sort((a, b) => (a.closeTime ?? a.entryTime) - (b.closeTime ?? b.entryTime));
  let running = 0;
  const pts = sorted.map((p, i) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    running += initSize * (p.closePnlPct / 100);
    return { x: i, y: running };
  });
  // With 1 point, manufacture a start point at 0
  const allPts = pts.length === 1 ? [{ x: -1, y: 0 }, ...pts] : pts;
  const maxY = Math.max(...allPts.map((p) => p.y), 0);
  const minY = Math.min(...allPts.map((p) => p.y), 0);
  const range = maxY - minY || 1;
  const W = 600, H = 90, pad = 8;
  const mx = (i: number) => pad + ((i + (pts.length === 1 ? 1 : 0)) / Math.max(allPts.length - 1, 1)) * (W - pad * 2);
  const mxAll = (_: number, idx: number) => pad + (idx / Math.max(allPts.length - 1, 1)) * (W - pad * 2);
  const my = (y: number) => H - pad - ((y - minY) / range) * (H - pad * 2);
  const path = allPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${mxAll(p.x, i)} ${my(p.y)}`).join(' ');
  const area = `${path} L${mxAll(allPts[allPts.length - 1].x, allPts.length - 1)} ${H} L${mxAll(allPts[0].x, 0)} ${H} Z`;
  const last = allPts[allPts.length - 1].y;
  const col = last >= 0 ? '#9b59ff' : '#ff4466';
  return (
    <div className="card" style={{ padding: '16px', marginBottom: 4 }}>
      <div className="section-label" style={{ marginBottom: 12 }}>🐋 Cumulative Realised PNL (SOL)</div>
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

/** Wrap a CSV field value in quotes and escape any internal quotes */
function csvField(v: string | number): string {
  const s = String(v);
  // Always quote — eliminates all comma-in-value bugs (IST date strings contain commas)
  return `"${s.replace(/"/g, '""')}"`;
}

export default function AnalyticsPage({ balance, freeBalance, onRefresh, whaleStatus }: Props) {
  const whaleClosed = whaleStatus?.closedPositions ?? [];
  const whaleOpen   = whaleStatus?.openPositions   ?? [];

  // ── Realised stats (closed positions only) ────────────────────────────────
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

  // Current streak (from most-recent trade — closedPositions is newest-first)
  let whaleStreak = 0;
  for (let i = 0; i < whaleClosed.length; i++) {
    const win = whaleClosed[i].closePnlPct > 0;
    if (i === 0) { whaleStreak = win ? 1 : -1; }
    else if (win && whaleStreak > 0) whaleStreak++;
    else if (!win && whaleStreak < 0) whaleStreak--;
    else break;
  }

  // Daily PNL — uses browser local timezone (which is IST for this app's users)
  const todayStr = new Date().toDateString();
  const whaleDailyPnl = whaleClosed.reduce((sum, p) => {
    if (new Date(p.closeTime).toDateString() !== todayStr) return sum;
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return sum + initSize * (p.closePnlPct / 100);
  }, 0);

  const whaleAvgHoldMin = whaleClosed.length > 0
    ? whaleClosed.reduce((s, p) => s + (p.closeTime - p.entryTime), 0) / whaleClosed.length / 60000
    : 0;

  // Max drawdown over realised equity curve
  let peak = 0, maxDD = 0, running = 0;
  for (const p of [...whaleClosed].reverse()) {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    running += initSize * (p.closePnlPct / 100);
    if (running > peak) peak = running;
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // ── Unrealised stats (open positions) ────────────────────────────────────
  const unrealisedPnlSol = whaleOpen.reduce((sum, p) => {
    const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
    return sum + initSize * (p.pnlPct / 100);
  }, 0);

  // ── CSV export ───────────────────────────────────────────────────────────
  function exportWhaleCSV() {
    const headers = [
      'Symbol', 'Name', 'Mint',
      'Entry Time (IST)', 'Close Time (IST)', 'Hold (min)',
      'Tier', 'Vol Trigger ($)',
      'Entry Price', 'Exit Price',
      'Init SOL', 'Banked SOL', 'Total Return SOL', 'PNL SOL', 'PNL %',
      'Close Reason',
    ];

    const rows = whaleClosed.map((p) => {
      const initSize    = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
      const pnlSol      = initSize * (p.closePnlPct / 100);
      const totalReturn = p.bankedSol + (p.remainingSizeSol * (p.lastPrice / (p.entryPrice || 1)));
      const holdMin     = p.closeTime && p.entryTime ? ((p.closeTime - p.entryTime) / 60000).toFixed(1) : '';
      const entryIST    = new Date(p.entryTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
      const closeIST    = p.closeTime
        ? new Date(p.closeTime).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
        : '';

      return [
        p.symbol,
        p.name,
        p.mint,
        entryIST,
        closeIST,
        holdMin,
        `T${p.tpTier}`,
        p.triggerAmountUsd?.toFixed(2) ?? '',
        p.entryPrice.toFixed(8),
        p.lastPrice > 0 ? p.lastPrice.toFixed(8) : '',
        initSize.toFixed(6),
        p.bankedSol.toFixed(6),
        totalReturn.toFixed(6),
        pnlSol.toFixed(6),
        p.closePnlPct.toFixed(2),
        p.closeReason ?? '',
      ].map(csvField);
    });

    const csv = [headers.map(csvField), ...rows].map(r => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <StatCard label="Total Trades"    value={String(whaleClosed.length)}                 color="#00d4ff" />
        <StatCard label="Win Rate"        value={`${whaleWinRate.toFixed(1)}%`}              color={whaleWinRate >= 55 ? '#00ff88' : '#ffd700'}
          sub={`W: ${whaleWins}  L: ${whaleLosses}`} />
        <StatCard label="Realised PNL"    value={`${whaleTotalPnlSol >= 0 ? '+' : ''}${whaleTotalPnlSol.toFixed(4)} SOL`}
          color={whaleTotalPnlSol >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Unrealised PNL"  value={`${unrealisedPnlSol >= 0 ? '+' : ''}${unrealisedPnlSol.toFixed(4)} SOL`}
          color={unrealisedPnlSol >= 0 ? '#9b59ff' : '#ff8844'}
          sub={`${whaleOpen.length} open position${whaleOpen.length !== 1 ? 's' : ''}`} />
        <StatCard label="Portfolio Value" value={`${balance.toFixed(3)} SOL`}               color="#00d4ff" />
        <StatCard label="Free Cash"       value={`${freeBalance.toFixed(3)} SOL`}           color="#7090b0" />
        <StatCard label="Profit Factor"   value={whalePF >= 99 ? '∞' : whalePF.toFixed(2)} color={whalePF >= 1.5 ? '#00ff88' : '#d4e0f0'} />
        <StatCard label="Daily PNL"       value={`${whaleDailyPnl >= 0 ? '+' : ''}${whaleDailyPnl.toFixed(4)} SOL`}
          color={whaleDailyPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Best Trade"      value={`+${whaleBest.toFixed(1)}%`}               color="#00ff88" />
        <StatCard label="Worst Trade"     value={`${whaleWorst.toFixed(1)}%`}               color="#ff4466" />
        <StatCard label="Avg Hold"        value={`${whaleAvgHoldMin.toFixed(0)}m`}          color="#d4e0f0" />
        <StatCard label="Max Drawdown"    value={`-${maxDD.toFixed(1)}%`}                   color="#ff4466" />
        <StatCard label="Streak"          value={`${whaleStreak >= 0 ? '+' : ''}${whaleStreak}`}
          color={whaleStreak >= 0 ? '#00ff88' : '#ff4466'} />
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
    setDraft({
      closeReason: pos.closeReason ?? '',
      // Show 2 decimal places — avoids the raw float (e.g. 18.384615…)
      closePnlPct: pos.closePnlPct.toFixed(2),
    });
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
        const initSize = pos.initialSizeSol > 0 ? pos.initialSizeSol : pos.sizeSol;
        const pnlSol   = initSize * (pos.closePnlPct / 100);
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div className="card" style={{ width: 340, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ fontWeight: 900, color: '#d4e0f0', fontSize: 15 }}>Edit 🐋 Whale — <span style={{ color: '#9b59ff' }}>{pos.symbol}</span></div>

              {/* Read-only summary */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div>
                  <div style={{ fontSize: 9, color: '#3a5070', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Init SOL</div>
                  <div style={{ fontSize: 12, color: '#d4e0f0', fontWeight: 700, marginTop: 2 }}>{initSize.toFixed(4)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: '#3a5070', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>PNL SOL</div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginTop: 2, color: pnlSol >= 0 ? '#00ff88' : '#ff4466' }}>
                    {pnlSol >= 0 ? '+' : ''}{pnlSol.toFixed(4)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: '#3a5070', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Banked SOL</div>
                  <div style={{ fontSize: 12, color: '#9b59ff', fontWeight: 700, marginTop: 2 }}>{pos.bankedSol.toFixed(4)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: '#3a5070', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Tier</div>
                  <div style={{ fontSize: 12, color: '#00d4ff', fontWeight: 700, marginTop: 2 }}>T{pos.tpTier}</div>
                </div>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Close Reason</span>
                <input
                  type="text"
                  value={draft.closeReason}
                  onChange={(e) => setDraft({ ...draft, closeReason: e.target.value })}
                  style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Close P&L % <span style={{ color: '#2a3a50', fontWeight: 400, textTransform: 'none' }}>(override calculated value)</span></span>
                <input
                  type="number"
                  step="0.01"
                  value={draft.closePnlPct}
                  onChange={(e) => setDraft({ ...draft, closePnlPct: e.target.value })}
                  style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }}
                />
                <span style={{ fontSize: 10, color: '#2a3a50' }}>e.g. +18.50 for +18.50% return on invested SOL</span>
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
              {['Token', 'Entry (IST)', 'Close (IST)', 'Hold', 'Tier', 'Entry $', 'Exit $', 'Init SOL', 'PNL SOL', 'PNL %', 'Close Reason', ''].map((l) => (
                <th key={l} style={{ padding: '10px 12px', textAlign: 'left', color: '#3a5070', whiteSpace: 'nowrap', fontWeight: 700, letterSpacing: '0.05em', fontSize: 10 }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={12} style={{ textAlign: 'center', padding: '32px', color: '#3a5070' }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🐋</div>
                No closed whale trades yet
              </td></tr>
            ) : sorted.map((p) => {
              const pnlPos  = p.closePnlPct >= 0;
              const initSize = p.initialSizeSol > 0 ? p.initialSizeSol : p.sizeSol;
              const pnlSol   = initSize * (p.closePnlPct / 100);
              const holdMin  = p.closeTime && p.entryTime
                ? Math.round((p.closeTime - p.entryTime) / 60000)
                : null;
              const dexUrl  = `https://dexscreener.com/solana/${p.mint}`;
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
                  <td style={{ padding: '10px 12px', color: '#3a5070', fontSize: 10, whiteSpace: 'nowrap' }}>
                    {holdMin !== null ? `${holdMin}m` : '—'}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 6px', borderRadius: 5, fontSize: 9, fontWeight: 800, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.28)' }}>T{p.tpTier}</span>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#d4e0f0', whiteSpace: 'nowrap' }}>${formatPrice(p.entryPrice)}</td>
                  <td style={{ padding: '10px 12px', color: '#d4e0f0', whiteSpace: 'nowrap' }}>{p.lastPrice > 0 ? `$${formatPrice(p.lastPrice)}` : '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#7090b0' }}>{initSize.toFixed(3)}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: pnlPos ? '#00ff88' : '#ff4466', whiteSpace: 'nowrap' }}>
                    {pnlPos ? '+' : ''}{pnlSol.toFixed(4)}
                  </td>
                  <td style={{ padding: '10px 12px', fontWeight: 800, color: pnlPos ? '#00ff88' : '#ff4466', whiteSpace: 'nowrap' }}>
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
