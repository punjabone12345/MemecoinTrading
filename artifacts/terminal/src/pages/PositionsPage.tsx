import { useState, useRef, useEffect } from 'react';
import { Position, Analytics } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatSOL, formatPct, formatMC, formatPrice, toIST } from '../lib/utils.js';

interface Props {
  openPositions: Position[];
  closedPositions: Position[];
  balance: number;
  analytics: Analytics | null;
  onRefresh: () => Promise<void>;
}

function PnlDisplay({ pnl, pct }: { pnl?: number; pct?: number }) {
  const prevPnl = useRef<number | undefined>(pnl);
  const [animClass, setAnimClass] = useState('');

  useEffect(() => {
    if (pnl !== undefined && prevPnl.current !== undefined) {
      setAnimClass(pnl > prevPnl.current ? 'animate-up' : pnl < prevPnl.current ? 'animate-down' : '');
      const t = setTimeout(() => setAnimClass(''), 300);
      prevPnl.current = pnl;
      return () => clearTimeout(t);
    }
    prevPnl.current = pnl;
  }, [pnl]);

  const isPos = (pnl ?? 0) >= 0;
  return (
    <div className={`text-right ${animClass}`}>
      <div className="font-bold text-sm" style={{ color: isPos ? 'var(--green)' : 'var(--red)' }}>
        {pnl !== undefined ? formatSOL(pnl) : '—'}
      </div>
      <div className="text-xs" style={{ color: isPos ? 'var(--green)' : 'var(--red)' }}>
        {pct !== undefined ? formatPct(pct) : ''}
      </div>
    </div>
  );
}

function TPBar({ pos, settings }: { pos: Position; settings?: { tp1Pct?: number; tp2Pct?: number; tp3Pct?: number } }) {
  const pnlPct = pos.pnlPct ?? ((((pos.currentPrice ?? pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100);
  const tp1 = 70; const tp2 = 150; const tp3 = 300;
  const maxPct = 350;
  const progress = Math.min(100, Math.max(0, (pnlPct / maxPct) * 100));

  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--text-dim)' }}>
        <span>TP Progress</span>
        <span style={{ color: 'var(--cyan)' }}>{pnlPct.toFixed(1)}%</span>
      </div>
      <div className="relative h-2 rounded-full" style={{ background: 'var(--navy-border)' }}>
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${progress}%`,
            background: pnlPct >= tp3 ? 'var(--gold)' : pnlPct >= tp2 ? 'var(--cyan)' : pnlPct >= tp1 ? 'var(--green)' : pnlPct < 0 ? 'var(--red)' : '#64748b',
          }}
        />
        {[tp1, tp2, tp3].map((tp, i) => {
          const pct = Math.min(100, (tp / maxPct) * 100);
          const hit = [pos.tp1Hit, pos.tp2Hit, pos.tp3Hit][i];
          return (
            <div key={tp} className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full border"
              style={{
                left: `${pct}%`,
                background: hit ? 'var(--gold)' : 'var(--navy)',
                borderColor: hit ? 'var(--gold)' : 'var(--text-dim)',
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
        <span>TP1 +{tp1}%</span><span>TP2 +{tp2}%</span><span>TP3 +{tp3}%</span>
      </div>
    </div>
  );
}

function EditModal({ pos, onClose, onSave }: { pos: Position; onClose: () => void; onSave: () => void }) {
  const [form, setForm] = useState({
    entryPrice: String(pos.entryPrice),
    sizeSol: String(pos.sizeSol),
    slCurrent: String(pos.slCurrent),
    notes: pos.notes ?? '',
  });
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    setLoading(true);
    try {
      await api.editPosition(pos.id, {
        entryPrice: parseFloat(form.entryPrice),
        sizeSol: parseFloat(form.sizeSol),
        slCurrent: parseFloat(form.slCurrent),
        notes: form.notes,
      });
      onSave();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="rounded-2xl p-6 w-full max-w-md" style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)' }}>
        <h3 className="font-bold text-lg mb-4" style={{ color: 'var(--cyan)' }}>Edit Position — {pos.symbol}</h3>
        <div className="space-y-3">
          {[
            { label: 'Entry Price', key: 'entryPrice' },
            { label: 'Size (SOL)', key: 'sizeSol' },
            { label: 'Stop Loss Price', key: 'slCurrent' },
          ].map(({ label, key }) => (
            <div key={key}>
              <label className="text-xs mb-1 block" style={{ color: 'var(--text-dim)' }}>{label}</label>
              <input
                type="number"
                value={form[key as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className="w-full px-3 py-2 rounded-lg text-sm"
                style={{ background: 'var(--navy)', border: '1px solid var(--navy-border)', color: 'var(--text)' }}
              />
            </div>
          ))}
          <div>
            <label className="text-xs mb-1 block" style={{ color: 'var(--text-dim)' }}>Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 rounded-lg text-sm resize-none"
              style={{ background: 'var(--navy)', border: '1px solid var(--navy-border)', color: 'var(--text)' }}
            />
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'var(--navy-border)', color: 'var(--text)' }}>Cancel</button>
          <button onClick={handleSave} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--cyan)', color: 'var(--navy)' }}>
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseModal({ pos, onClose, onConfirm }: { pos: Position; onClose: () => void; onConfirm: () => void }) {
  const [loading, setLoading] = useState(false);
  const price = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlSol = pos.sizeSol * (pnlPct / 100);

  async function handleClose() {
    setLoading(true);
    try {
      await api.closePosition(pos.id, price);
      onConfirm();
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="rounded-2xl p-6 w-full max-w-sm" style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)' }}>
        <h3 className="font-bold text-lg mb-4" style={{ color: 'var(--red)' }}>Close Position — {pos.symbol}</h3>
        <div className="space-y-2 text-sm mb-4">
          <div className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>Close Price</span><span>${formatPrice(price)}</span></div>
          <div className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>P&L</span>
            <span style={{ color: pnlSol >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatSOL(pnlSol)} ({formatPct(pnlPct)})</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm" style={{ background: 'var(--navy-border)', color: 'var(--text)' }}>Cancel</button>
          <button onClick={handleClose} disabled={loading} className="flex-1 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--red)', color: 'white' }}>
            {loading ? 'Closing...' : 'Close Position'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PositionCard({ pos, onRefresh }: { pos: Position; onRefresh: () => Promise<void> }) {
  const [showEdit, setShowEdit] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const currentPrice = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = pos.pnlPct ?? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);
  const pnlSol = pos.pnlSol ?? (pos.sizeSol * pnlPct / 100);

  async function handleDelete() {
    if (!confirm(`Delete ${pos.symbol} position? This will restore the SOL to your balance.`)) return;
    setDeleting(true);
    try {
      await api.deletePosition(pos.id);
      await onRefresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="rounded-xl border p-4 transition-all" style={{
        background: 'var(--navy-card)',
        borderColor: pnlPct >= 0 ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,102,0.2)',
      }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold" style={{ color: 'var(--text)' }}>{pos.symbol}</span>
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{pos.name}</span>
              <span className="px-1.5 py-0.5 rounded text-xs" style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--cyan)' }}>
                Score: {pos.scoreAtEntry}
              </span>
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{toIST(pos.entryTime)}</div>
          </div>
          <PnlDisplay pnl={pnlSol} pct={pnlPct} />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-xs">
          <div><span style={{ color: 'var(--text-dim)' }}>Entry: </span><span>${formatPrice(pos.entryPrice)}</span></div>
          <div><span style={{ color: 'var(--text-dim)' }}>Current: </span>
            <span style={{ color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>${formatPrice(currentPrice)}</span>
          </div>
          <div><span style={{ color: 'var(--text-dim)' }}>Size: </span><span>{pos.sizeSol.toFixed(3)} SOL</span></div>
          <div><span style={{ color: 'var(--text-dim)' }}>SL: </span><span style={{ color: 'var(--red)' }}>${formatPrice(pos.slCurrent)}</span></div>
          <div><span style={{ color: 'var(--text-dim)' }}>Entry MC: </span><span>{formatMC(pos.entryMc)}</span></div>
          <div><span style={{ color: 'var(--text-dim)' }}>Curr MC: </span><span>{formatMC(pos.currentMc ?? pos.entryMc)}</span></div>
          <div><span style={{ color: 'var(--text-dim)' }}>B/S: </span>
            <span style={{ color: (pos.buySellRatio ?? 1) >= 1.5 ? 'var(--green)' : 'var(--text)' }}>
              {(pos.buySellRatio ?? 1).toFixed(2)}x
            </span>
          </div>
          <div><span style={{ color: 'var(--text-dim)' }}>TP: </span>
            <span style={{ color: 'var(--gold)' }}>
              {[pos.tp1Hit && 'TP1', pos.tp2Hit && 'TP2', pos.tp3Hit && 'TP3'].filter(Boolean).join(' ') || 'None'}
            </span>
          </div>
        </div>

        <TPBar pos={pos} />

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {pos.dexUrl && (
            <a href={pos.dexUrl} target="_blank" rel="noopener noreferrer"
              className="px-2.5 py-1 rounded text-xs transition-opacity hover:opacity-80"
              style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--cyan)', border: '1px solid rgba(0,212,255,0.2)' }}>
              DEX ↗
            </a>
          )}
          <button onClick={() => setShowEdit(true)}
            className="px-2.5 py-1 rounded text-xs font-medium transition-opacity hover:opacity-80"
            style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--cyan)', border: '1px solid rgba(0,212,255,0.2)' }}>
            EDIT
          </button>
          <button onClick={() => setShowClose(true)}
            className="px-2.5 py-1 rounded text-xs font-medium transition-opacity hover:opacity-80"
            style={{ background: 'rgba(255,68,102,0.1)', color: 'var(--red)', border: '1px solid rgba(255,68,102,0.2)' }}>
            CLOSE
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="px-2.5 py-1 rounded text-xs font-medium transition-opacity hover:opacity-80"
            style={{ background: 'rgba(100,116,139,0.1)', color: 'var(--text-dim)', border: '1px solid var(--navy-border)' }}>
            {deleting ? '...' : 'DELETE'}
          </button>
        </div>

        {pos.notes && (
          <div className="mt-2 text-xs italic" style={{ color: 'var(--text-dim)' }}>📝 {pos.notes}</div>
        )}
      </div>

      {showEdit && <EditModal pos={pos} onClose={() => setShowEdit(false)} onSave={onRefresh} />}
      {showClose && <CloseModal pos={pos} onClose={() => setShowClose(false)} onConfirm={onRefresh} />}
    </>
  );
}

export default function PositionsPage({ openPositions, closedPositions, balance, analytics, onRefresh }: Props) {
  const unrealizedPnl = openPositions.reduce((s, p) => s + (p.pnlSol ?? 0), 0);

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Open Positions', value: openPositions.length, color: 'var(--cyan)', format: String },
          { label: 'Unrealized PNL', value: unrealizedPnl, color: unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)', format: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL` },
          { label: "Today's PNL", value: analytics?.dailyPnl ?? 0, color: (analytics?.dailyPnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)', format: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL` },
          { label: 'Win Rate', value: analytics?.winRate ?? 0, color: 'var(--gold)', format: (v: number) => `${v.toFixed(1)}%` },
        ].map((s) => (
          <div key={s.label} className="rounded-xl p-3 border" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}>
            <div className="text-lg font-bold" style={{ color: s.color }}>{(s.format as (v: number) => string)(s.value as number)}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Open Positions */}
      <div className="mb-6">
        <h2 className="text-sm font-semibold mb-3 uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
          Open Positions ({openPositions.length})
        </h2>
        {openPositions.length === 0 ? (
          <div className="text-center py-12 rounded-xl border" style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)', color: 'var(--text-dim)' }}>
            <div className="text-3xl mb-2">📊</div>
            <div>No open positions. The scanner is looking for entries...</div>
          </div>
        ) : (
          <div className="space-y-3">
            {openPositions.map((p) => <PositionCard key={p.id} pos={p} onRefresh={onRefresh} />)}
          </div>
        )}
      </div>
    </div>
  );
}
