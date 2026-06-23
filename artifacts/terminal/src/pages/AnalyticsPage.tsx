import { useState, useMemo } from 'react';
import { Position, Analytics } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatSOL, formatPct, formatMC, formatPrice, toIST, holdTime } from '../lib/utils.js';

interface Props {
  analytics: Analytics | null;
  closedPositions: Position[];
  balance: number;
  onRefresh: () => Promise<void>;
}

type SortKey = 'exitTime' | 'pnlSol' | 'pnlPct' | 'entryTime' | 'scoreAtEntry';
type SortDir = 'asc' | 'desc';

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="rounded-xl p-4 border" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}>
      <div className="text-lg font-bold" style={{ color: color ?? 'var(--text)' }}>{value}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{label}</div>
      {sub && <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{sub}</div>}
    </div>
  );
}

function MiniChart({ positions }: { positions: Position[] }) {
  if (positions.length < 2) return null;

  const sorted = [...positions].sort((a, b) => new Date(a.exitTime!).getTime() - new Date(b.exitTime!).getTime());
  let running = 0;
  const points = sorted.map((p, i) => {
    running += p.pnlSol ?? 0;
    return { x: i, y: running, pnl: p.pnlSol ?? 0 };
  });

  const maxY = Math.max(...points.map((p) => p.y));
  const minY = Math.min(...points.map((p) => p.y));
  const range = maxY - minY || 1;
  const W = 600; const H = 120;
  const pad = 10;

  const mapX = (i: number) => pad + (i / Math.max(points.length - 1, 1)) * (W - pad * 2);
  const mapY = (y: number) => H - pad - ((y - minY) / range) * (H - pad * 2);

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${mapX(i)} ${mapY(p.y)}`).join(' ');
  const areaD = `${pathD} L ${mapX(points.length - 1)} ${H} L ${mapX(0)} ${H} Z`;

  const lastY = points[points.length - 1].y;
  const color = lastY >= 0 ? '#00ff88' : '#ff4466';

  return (
    <div className="rounded-xl border p-4 mb-4" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}>
      <div className="text-sm font-semibold mb-3" style={{ color: 'var(--text-dim)' }}>Cumulative PNL</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: '100px' }}>
        <defs>
          <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#pnlGrad)" />
        <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <line x1={pad} y1={mapY(0)} x2={W - pad} y2={mapY(0)} stroke="var(--navy-border)" strokeWidth="1" strokeDasharray="4,4" />
      </svg>
    </div>
  );
}

export default function AnalyticsPage({ analytics, closedPositions, balance, onRefresh }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('exitTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [deleting, setDeleting] = useState<string | null>(null);

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

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function exportCSV() {
    const headers = ['Symbol', 'Name', 'Entry Time (IST)', 'Exit Time (IST)', 'Hold Time', 'Entry Price', 'Exit Price', 'Entry MC', 'Exit MC', 'Size SOL', 'PNL SOL', 'PNL %', 'Peak Gain %', 'Score', 'Close Reason', 'TP1', 'TP2', 'TP3', 'Mode'];
    const rows = closedPositions.map((p) => [
      p.symbol, p.name, toIST(p.entryTime), toIST(p.exitTime ?? ''), holdTime(p.entryTime, p.exitTime),
      p.entryPrice, p.exitPrice ?? '', p.entryMc, p.exitMc ?? '',
      p.sizeSol, p.pnlSol ?? '', p.pnlPct ?? '',
      p.peakPrice ? (((p.peakPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(2) : '',
      p.scoreAtEntry, p.closeReason ?? '', p.tp1Hit, p.tp2Hit, p.tp3Hit, p.mode,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `apex-trades-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this trade record?')) return;
    setDeleting(id);
    try { await api.deletePosition(id); await onRefresh(); } finally { setDeleting(null); }
  }

  const a = analytics;

  return (
    <div>
      {/* Performance Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total Trades" value={String(a?.totalTrades ?? 0)} color="var(--cyan)" />
        <StatCard label="Win Rate" value={`${(a?.winRate ?? 0).toFixed(1)}%`} color={(a?.winRate ?? 0) >= 55 ? 'var(--green)' : 'var(--gold)'} />
        <StatCard label="Total PNL" value={`${(a?.totalPnlSol ?? 0) >= 0 ? '+' : ''}${(a?.totalPnlSol ?? 0).toFixed(4)} SOL`} color={(a?.totalPnlSol ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'} />
        <StatCard label="Profit Factor" value={(a?.profitFactor ?? 0).toFixed(2)} color={(a?.profitFactor ?? 0) >= 1.5 ? 'var(--green)' : 'var(--text)'} />
        <StatCard label="Best Trade" value={`+${(a?.bestTrade ?? 0).toFixed(1)}%`} color="var(--green)" />
        <StatCard label="Worst Trade" value={`${(a?.worstTrade ?? 0).toFixed(1)}%`} color="var(--red)" />
        <StatCard label="Current Streak" value={`${(a?.currentStreak ?? 0) >= 0 ? '+' : ''}${a?.currentStreak ?? 0}`} color={(a?.currentStreak ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'} sub={`Max W: ${a?.maxWinStreak ?? 0} / L: ${a?.maxLossStreak ?? 0}`} />
        <StatCard label="Max Drawdown" value={`-${(a?.maxDrawdown ?? 0).toFixed(1)}%`} color="var(--red)" />
        <StatCard label="Avg Hold Time" value={`${(a?.avgHoldTimeMinutes ?? 0).toFixed(0)}m`} color="var(--text)" />
        <StatCard label="Daily PNL" value={`${(a?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(a?.dailyPnl ?? 0).toFixed(4)} SOL`} color={(a?.dailyPnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'} />
        <StatCard label="Balance" value={`${balance.toFixed(3)} SOL`} color="var(--cyan)" />
        <StatCard label="Open Positions" value={String(a?.openPositionsCount ?? 0)} color="var(--cyan)" />
      </div>

      {/* Chart */}
      <MiniChart positions={closedPositions.filter((p) => p.exitTime)} />

      {/* Trade Table */}
      <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}>
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--navy-border)' }}>
          <h2 className="font-semibold text-sm" style={{ color: 'var(--text)' }}>Closed Trades ({closedPositions.length})</h2>
          <button onClick={exportCSV} className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ background: 'rgba(0,212,255,0.15)', color: 'var(--cyan)', border: '1px solid rgba(0,212,255,0.3)' }}>
            📥 Export CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: '#0d1526' }}>
                {[
                  { label: 'Token', key: null },
                  { label: 'Entry (IST)', key: 'entryTime' },
                  { label: 'Exit (IST)', key: 'exitTime' },
                  { label: 'Hold', key: null },
                  { label: 'Entry $', key: null },
                  { label: 'Exit $', key: null },
                  { label: 'PNL SOL', key: 'pnlSol' },
                  { label: 'PNL %', key: 'pnlPct' },
                  { label: 'Peak %', key: null },
                  { label: 'Score', key: 'scoreAtEntry' },
                  { label: 'Reason', key: null },
                  { label: 'Actions', key: null },
                ].map(({ label, key }) => (
                  <th
                    key={label}
                    className={`px-3 py-2.5 text-left font-semibold ${key ? 'cursor-pointer hover:opacity-80' : ''}`}
                    style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}
                    onClick={() => key && toggleSort(key as SortKey)}
                  >
                    {label}{key && sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr><td colSpan={12} className="text-center py-10" style={{ color: 'var(--text-dim)' }}>No closed trades yet</td></tr>
              ) : (
                sorted.map((p) => {
                  const pnlPos = (p.pnlSol ?? 0) >= 0;
                  const peakPct = p.peakPrice ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
                  return (
                    <tr key={p.id} className="border-t" style={{ borderColor: 'var(--navy-border)' }}>
                      <td className="px-3 py-2.5" style={{ whiteSpace: 'nowrap' }}>
                        <div className="font-bold" style={{ color: 'var(--text)' }}>{p.symbol}</div>
                        <div style={{ color: 'var(--text-dim)' }}>{p.name.slice(0, 12)}</div>
                      </td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{toIST(p.entryTime)}</td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{p.exitTime ? toIST(p.exitTime) : '—'}</td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text-dim)' }}>{holdTime(p.entryTime, p.exitTime)}</td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text)' }}>${formatPrice(p.entryPrice)}</td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text)' }}>{p.exitPrice ? `$${formatPrice(p.exitPrice)}` : '—'}</td>
                      <td className="px-3 py-2.5 font-bold" style={{ color: pnlPos ? 'var(--green)' : 'var(--red)' }}>
                        {p.pnlSol !== undefined ? formatSOL(p.pnlSol) : '—'}
                      </td>
                      <td className="px-3 py-2.5 font-bold" style={{ color: pnlPos ? 'var(--green)' : 'var(--red)' }}>
                        {p.pnlPct !== undefined ? formatPct(p.pnlPct) : '—'}
                      </td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--gold)' }}>
                        {peakPct > 0 ? `+${peakPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--cyan)' }}>{p.scoreAtEntry}</td>
                      <td className="px-3 py-2.5" style={{ color: 'var(--text-dim)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.closeReason ?? '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          {p.dexUrl && (
                            <a href={p.dexUrl} target="_blank" rel="noopener noreferrer"
                              className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--cyan)' }}>
                              DEX
                            </a>
                          )}
                          <button onClick={() => handleDelete(p.id)} disabled={deleting === p.id}
                            className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(255,68,102,0.1)', color: 'var(--red)' }}>
                            {deleting === p.id ? '...' : 'Del'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
