import { useState, useMemo } from 'react';
import { Position, Analytics, WhaleStatus, ClosedWhalePosition } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatSOL, formatPct, formatPrice, toIST, holdTime } from '../lib/utils.js';

interface Props { analytics: Analytics | null; closedPositions: Position[]; balance: number; onRefresh: () => Promise<void>; whaleStatus?: WhaleStatus | null }
type Sort = 'exitTime' | 'pnlSol' | 'pnlPct' | 'entryTime' | 'scoreAtEntry';
type Dir = 'asc' | 'desc';

interface EditDraft {
  exitPrice: string;
  exitTime: string;
  closeReason: string;
  notes: string;
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

function PnlChart({ positions }: { positions: Position[] }) {
  if (positions.length < 2) return null;
  const sorted = [...positions].sort((a, b) => new Date(a.exitTime!).getTime() - new Date(b.exitTime!).getTime());
  let running = 0;
  const pts = sorted.map((p, i) => { running += p.pnlSol ?? 0; return { x: i, y: running }; });
  const maxY = Math.max(...pts.map((p) => p.y), 0);
  const minY = Math.min(...pts.map((p) => p.y), 0);
  const range = maxY - minY || 1;
  const W = 600, H = 90, pad = 8;
  const mx = (i: number) => pad + (i / Math.max(pts.length - 1, 1)) * (W - pad * 2);
  const my = (y: number) => H - pad - ((y - minY) / range) * (H - pad * 2);
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${mx(i)} ${my(p.y)}`).join(' ');
  const area = `${path} L${mx(pts.length - 1)} ${H} L${mx(0)} ${H} Z`;
  const last = pts[pts.length - 1].y;
  const col = last >= 0 ? '#00ff88' : '#ff4466';
  return (
    <div className="card" style={{ padding: '16px', marginBottom: 4 }}>
      <div className="section-label" style={{ marginBottom: 12 }}>Cumulative PNL</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 72, display: 'block' }}>
        <defs>
          <linearGradient id="pnlg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.25" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#pnlg)" />
        <path d={path} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${col}88)` }} />
        <line x1={pad} y1={my(0)} x2={W - pad} y2={my(0)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4,4" />
      </svg>
    </div>
  );
}

function isoToLocalInput(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

export default function AnalyticsPage({ analytics: a, closedPositions, balance, onRefresh, whaleStatus }: Props) {
  const [sortKey, setSortKey] = useState<Sort>('exitTime');
  const [sortDir, setSortDir] = useState<Dir>('desc');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingPos, setEditingPos] = useState<Position | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ exitPrice: '', exitTime: '', closeReason: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const sorted = useMemo(() => {
    const arr = [...closedPositions];
    arr.sort((a, b) => {
      let va: number, vb: number;
      if (sortKey === 'exitTime') { va = new Date(a.exitTime ?? 0).getTime(); vb = new Date(b.exitTime ?? 0).getTime(); }
      else if (sortKey === 'entryTime') { va = new Date(a.entryTime).getTime(); vb = new Date(b.entryTime).getTime(); }
      else if (sortKey === 'pnlSol') { va = a.pnlSol ?? 0; vb = b.pnlSol ?? 0; }
      else if (sortKey === 'pnlPct') { va = a.pnlPct ?? 0; vb = b.pnlPct ?? 0; }
      else { va = a.scoreAtEntry; vb = b.scoreAtEntry; }
      return sortDir === 'desc' ? vb - va : va - vb;
    });
    return arr;
  }, [closedPositions, sortKey, sortDir]);

  function toggleSort(k: Sort) {
    if (sortKey === k) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
  }

  function exportCSV() {
    const headers = ['Symbol', 'Entry (IST)', 'Exit (IST)', 'Hold', 'Entry $', 'Exit $', 'PNL SOL', 'PNL %', 'Score', 'Reason'];
    const rows = closedPositions.map((p) => [p.symbol, toIST(p.entryTime), toIST(p.exitTime ?? ''), holdTime(p.entryTime, p.exitTime), p.entryPrice, p.exitPrice ?? '', p.pnlSol ?? '', p.pnlPct ?? '', p.scoreAtEntry, p.closeReason ?? '']);
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `apex-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this trade?')) return;
    setDeleting(id);
    try { await api.deletePosition(id); await onRefresh(); } finally { setDeleting(null); }
  }

  function openEdit(p: Position) {
    setEditingPos(p);
    setDraft({
      exitPrice: p.exitPrice != null ? String(p.exitPrice) : '',
      exitTime: p.exitTime ? isoToLocalInput(p.exitTime) : '',
      closeReason: p.closeReason ?? '',
      notes: p.notes ?? '',
    });
  }

  async function handleSave() {
    if (!editingPos) return;
    setSaving(true);
    try {
      const exitPrice = parseFloat(draft.exitPrice);
      const entryPrice = editingPos.entryPrice;
      const sizeSol = editingPos.sizeSol;

      const updates: Record<string, unknown> = {};
      if (!isNaN(exitPrice) && exitPrice > 0) {
        updates.exitPrice = exitPrice;
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        const pnlSol = sizeSol * (pnlPct / 100);
        updates.pnlPct = pnlPct;
        updates.pnlSol = pnlSol;
      }
      if (draft.exitTime) {
        updates.exitTime = new Date(draft.exitTime).toISOString();
      }
      if (draft.closeReason !== editingPos.closeReason) {
        updates.closeReason = draft.closeReason;
      }
      if (draft.notes !== (editingPos.notes ?? '')) {
        updates.notes = draft.notes;
      }

      await api.editPosition(editingPos.id, updates as Partial<Position>);
      await onRefresh();
      setEditingPos(null);
    } finally {
      setSaving(false);
    }
  }

  const winRate = a?.winRate ?? 0;
  const totalPnl = a?.totalPnlSol ?? 0;
  const pf = a?.profitFactor ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Edit modal */}
      {editingPos && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: 340, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontWeight: 900, color: '#d4e0f0', fontSize: 15 }}>
              Edit Trade — <span style={{ color: '#00d4ff' }}>{editingPos.symbol}</span>
            </div>

            <div style={{ fontSize: 11, color: '#3a5070', background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '8px 10px', lineHeight: 1.7 }}>
              Entry: <strong style={{ color: '#d4e0f0' }}>${formatPrice(editingPos.entryPrice)}</strong>
              {' · '}Size: <strong style={{ color: '#d4e0f0' }}>{editingPos.sizeSol} SOL</strong>
              <br />
              Entry time: <strong style={{ color: '#d4e0f0' }}>{toIST(editingPos.entryTime)}</strong>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Exit Price (USD) <span style={{ color: '#00ff88' }}>← PNL recalculated automatically</span>
              </span>
              <input
                type="number"
                step="any"
                value={draft.exitPrice}
                onChange={(e) => setDraft({ ...draft, exitPrice: e.target.value })}
                placeholder={String(editingPos.exitPrice ?? '')}
                style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }}
              />
              {draft.exitPrice && !isNaN(parseFloat(draft.exitPrice)) && (() => {
                const ep = parseFloat(draft.exitPrice);
                const pct = ((ep - editingPos.entryPrice) / editingPos.entryPrice) * 100;
                const sol = editingPos.sizeSol * (pct / 100);
                const pos = pct >= 0;
                return (
                  <div style={{ fontSize: 11, color: pos ? '#00ff88' : '#ff4466', fontWeight: 700 }}>
                    {pos ? '+' : ''}{pct.toFixed(2)}% · {pos ? '+' : ''}{sol.toFixed(5)} SOL
                  </div>
                );
              })()}
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Exit Time (local time)</span>
              <input
                type="datetime-local"
                value={draft.exitTime}
                onChange={(e) => setDraft({ ...draft, exitTime: e.target.value })}
                style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box', colorScheme: 'dark' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Close Reason</span>
              <input
                type="text"
                value={draft.closeReason}
                onChange={(e) => setDraft({ ...draft, closeReason: e.target.value })}
                placeholder="e.g. Manual close — corrected false SL"
                style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 10, color: '#3a5070', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</span>
              <input
                type="text"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Optional notes"
                style={{ background: '#0d1f35', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#d4e0f0', padding: '8px 10px', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' }}
              />
            </label>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary"
                style={{ flex: 1, padding: '9px 0', fontSize: 12, fontWeight: 800 }}
              >
                {saving ? 'Saving…' : 'Save Correction'}
              </button>
              <button
                onClick={() => setEditingPos(null)}
                className="btn-red"
                style={{ padding: '9px 14px', fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <StatCard label="Total Trades" value={String(a?.totalTrades ?? 0)} color="#00d4ff" />
        <StatCard label="Win Rate" value={`${winRate.toFixed(1)}%`} color={winRate >= 55 ? '#00ff88' : '#ffd700'} />
        <StatCard label="Total PNL" value={`${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`} color={totalPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Profit Factor" value={pf.toFixed(2)} color={pf >= 1.5 ? '#00ff88' : '#d4e0f0'} />
        <StatCard label="Best Trade" value={`+${(a?.bestTrade ?? 0).toFixed(1)}%`} color="#00ff88" />
        <StatCard label="Worst Trade" value={`${(a?.worstTrade ?? 0).toFixed(1)}%`} color="#ff4466" />
        <StatCard label="Streak" value={`${(a?.currentStreak ?? 0) >= 0 ? '+' : ''}${a?.currentStreak ?? 0}`}
          color={(a?.currentStreak ?? 0) >= 0 ? '#00ff88' : '#ff4466'}
          sub={`Max W: ${a?.maxWinStreak ?? 0}  L: ${a?.maxLossStreak ?? 0}`} />
        <StatCard label="Max Drawdown" value={`-${(a?.maxDrawdown ?? 0).toFixed(1)}%`} color="#ff4466" />
        <StatCard label="Avg Hold" value={`${(a?.avgHoldTimeMinutes ?? 0).toFixed(0)}m`} color="#d4e0f0" />
        <StatCard label="Daily PNL" value={`${(a?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(a?.dailyPnl ?? 0).toFixed(4)} SOL`}
          color={(a?.dailyPnl ?? 0) >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Balance" value={`${balance.toFixed(3)} SOL`} color="#00d4ff" />
        <StatCard label="Open Positions" value={String(a?.openPositionsCount ?? 0)} color="#00d4ff" />
      </div>

      <PnlChart positions={closedPositions.filter((p) => p.exitTime)} />

      {/* Trade history */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <span style={{ fontWeight: 800, color: '#d4e0f0', fontSize: 13 }}>Closed Trades ({closedPositions.length})</span>
          <button onClick={exportCSV} className="btn-primary" style={{ padding: '6px 12px', fontSize: 11 }}>📥 Export CSV</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                {[['Token', null], ['Entry (IST)', 'entryTime'], ['Exit (IST)', 'exitTime'], ['Hold', null], ['Entry $', null], ['Exit $', null], ['PNL SOL', 'pnlSol'], ['PNL %', 'pnlPct'], ['Score', 'scoreAtEntry'], ['Close Reason', null], ['', null]].map(([l, k]) => (
                  <th key={String(l)} onClick={() => k && toggleSort(k as Sort)}
                    style={{ padding: '10px 12px', textAlign: 'left', color: '#3a5070', whiteSpace: 'nowrap', fontWeight: 700, cursor: k ? 'pointer' : 'default', letterSpacing: '0.05em', fontSize: 10 }}>
                    {l}{k && sortKey === k ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={11} style={{ textAlign: 'center', padding: '32px', color: '#3a5070' }}>No closed trades yet</td></tr>
              ) : sorted.map((p) => {
                const pos = (p.pnlSol ?? 0) >= 0;
                const isEmergency = p.closeReason?.startsWith('EMERGENCY');
                const isHardSL = p.closeReason?.startsWith('Hard SL');
                const isTrailSL = p.closeReason?.startsWith('Trailing SL');
                const isFilterChange = p.closeReason === 'Filter change';
                const isTakingProfit = p.closeReason === 'Taking profit';
                const reasonColor = isEmergency ? '#ff4466' : isHardSL ? '#ff6b35' : isTrailSL ? '#ffd700' : isFilterChange ? '#9b59ff' : isTakingProfit ? '#00ff88' : '#3a5070';
                return (
                  <tr key={p.id} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 800, color: '#d4e0f0' }}>{p.symbol}</div>
                      <div style={{ color: '#3a5070', fontSize: 10 }}>{p.name.slice(0, 10)}</div>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#3a5070', whiteSpace: 'nowrap' }}>{toIST(p.entryTime)}</td>
                    <td style={{ padding: '10px 12px', color: '#3a5070', whiteSpace: 'nowrap' }}>{p.exitTime ? toIST(p.exitTime) : '—'}</td>
                    <td style={{ padding: '10px 12px', color: '#3a5070' }}>{holdTime(p.entryTime, p.exitTime)}</td>
                    <td style={{ padding: '10px 12px', color: '#d4e0f0' }}>${formatPrice(p.entryPrice)}</td>
                    <td style={{ padding: '10px 12px', color: '#d4e0f0' }}>{p.exitPrice ? `$${formatPrice(p.exitPrice)}` : '—'}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 800, color: pos ? '#00ff88' : '#ff4466' }}>{p.pnlSol !== undefined ? formatSOL(p.pnlSol) : '—'}</td>
                    <td style={{ padding: '10px 12px', fontWeight: 800, color: pos ? '#00ff88' : '#ff4466' }}>{p.pnlPct !== undefined ? formatPct(p.pnlPct) : '—'}</td>
                    <td style={{ padding: '10px 12px', color: '#00d4ff' }}>{p.scoreAtEntry}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={{ fontSize: 10, color: reasonColor, fontWeight: 600 }} title={p.closeReason ?? ''}>{p.closeReason ?? '—'}</span>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {p.dexUrl && <a href={p.dexUrl} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ padding: '4px 8px', fontSize: 10, textDecoration: 'none' }}>DEX</a>}
                        <button
                          onClick={() => openEdit(p)}
                          className="btn-primary"
                          style={{ padding: '4px 8px', fontSize: 10, background: 'rgba(0,212,255,0.15)', borderColor: 'rgba(0,212,255,0.3)' }}
                        >
                          Edit
                        </button>
                        <button onClick={() => handleDelete(p.id)} disabled={deleting === p.id} className="btn-red" style={{ padding: '4px 8px', fontSize: 10 }}>
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

      {/* ── Whale Closed Trades ─────────────────────────────────────────────── */}
      {(whaleStatus?.closedPositions?.length ?? 0) > 0 && (
        <WhaleClosedTable positions={whaleStatus!.closedPositions} onRefresh={onRefresh} />
      )}
    </div>
  );
}

// ── Whale closed positions table ──────────────────────────────────────────────

function WhaleClosedTable({ positions, onRefresh }: { positions: ClosedWhalePosition[]; onRefresh: () => Promise<void> }) {
  const [deleting, setDeleting]     = useState<string | null>(null);
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [draft, setDraft]           = useState({ closeReason: '', closePnlPct: '' });
  const [saving, setSaving]         = useState(false);

  const sorted = [...positions].sort((a, b) =>
    new Date(b.closeTime ?? b.entryTime).getTime() - new Date(a.closeTime ?? a.entryTime).getTime(),
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
              <div style={{ fontWeight: 900, color: '#d4e0f0', fontSize: 15 }}>Edit 🐋 Whale — <span style={{ color: '#9b59ff' }}>{pos?.symbol}</span></div>
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
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
              {['Token', 'Entry (IST)', 'Close (IST)', 'Tier', 'Entry Price', 'Exit Price', 'Init SOL', 'Banked', 'PNL %', 'Close Reason', ''].map((l) => (
                <th key={l} style={{ padding: '10px 12px', textAlign: 'left', color: '#3a5070', whiteSpace: 'nowrap', fontWeight: 700, letterSpacing: '0.05em', fontSize: 10 }}>{l}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
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
