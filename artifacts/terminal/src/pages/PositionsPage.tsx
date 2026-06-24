import { useState, useRef, useEffect } from 'react';
import { Position, Analytics, Settings } from '../lib/types.js';
import { api } from '../lib/api.js';
import { formatSOL, formatPct, formatPrice, toIST } from '../lib/utils.js';

interface Props {
  openPositions: Position[];
  closedPositions: Position[];
  balance: number;
  analytics: Analytics | null;
  settings: Settings | null;
  onRefresh: () => Promise<void>;
}

function PnlDisplay({ pnl, pct }: { pnl?: number; pct?: number }) {
  const prevPnl = useRef<number | undefined>(pnl);
  const [anim, setAnim] = useState('');
  useEffect(() => {
    if (pnl !== undefined && prevPnl.current !== undefined) {
      const prev = prevPnl.current;
      // Only animate on meaningful changes (≥0.5% of position or ≥0.0001 SOL)
      const change = Math.abs(pnl - prev);
      const threshold = Math.max(0.0001, Math.abs(prev) * 0.005);
      if (change >= threshold) {
        setAnim(pnl > prev ? 'animate-up' : 'animate-down');
        const t = setTimeout(() => setAnim(''), 600);
        prevPnl.current = pnl;
        return () => clearTimeout(t);
      }
    }
    prevPnl.current = pnl;
    return undefined;
  }, [pnl]);
  const pos = (pnl ?? 0) >= 0;
  return (
    <div className={`${anim}`} style={{ textAlign: 'right' }}>
      <div style={{ fontWeight: 900, fontSize: 15, color: pos ? '#00ff88' : '#ff4466' }}>{pnl !== undefined ? formatSOL(pnl) : '—'}</div>
      <div style={{ fontSize: 11, color: pos ? '#00ff8899' : '#ff446699' }}>{pct !== undefined ? formatPct(pct) : ''}</div>
    </div>
  );
}

function TPBar({ pos, settings }: { pos: Position; settings: Settings | null }) {
  const tp1 = settings?.tp1Pct ?? 70;
  const tp2 = settings?.tp2Pct ?? 150;
  const tp3 = settings?.tp3Pct ?? 300;
  const tps = [tp1, tp2, tp3];
  const maxPct = tp3 * 1.15;
  const pnlPct = pos.pnlPct ?? (((pos.currentPrice ?? pos.entryPrice) - pos.entryPrice) / pos.entryPrice * 100);
  const progress = Math.min(100, Math.max(0, (pnlPct / maxPct) * 100));
  const trackColor = pnlPct >= tp3 ? '#ffd700' : pnlPct >= tp2 ? '#00d4ff' : pnlPct >= tp1 ? '#00ff88' : pnlPct < 0 ? '#ff4466' : '#3a5070';
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6, color: '#3a5070' }}>
        <span>TP Progress</span>
        <span style={{ color: trackColor, fontWeight: 800 }}>{pnlPct.toFixed(1)}%</span>
      </div>
      <div style={{ position: 'relative', height: 6, borderRadius: 6, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ height: '100%', borderRadius: 6, width: `${progress}%`, background: trackColor, boxShadow: `0 0 8px ${trackColor}55`, transition: 'width 0.5s ease' }} />
        {tps.map((tp, i) => {
          const hit = [pos.tp1Hit, pos.tp2Hit, pos.tp3Hit][i];
          return (
            <div key={tp} style={{
              position: 'absolute', top: '50%', transform: 'translate(-50%, -50%)',
              left: `${Math.min(100, (tp / maxPct) * 100)}%`,
              width: 10, height: 10, borderRadius: '50%',
              background: hit ? '#ffd700' : '#080d1a',
              border: `2px solid ${hit ? '#ffd700' : 'rgba(255,255,255,0.15)'}`,
              boxShadow: hit ? '0 0 6px #ffd700' : 'none',
            }} />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginTop: 4, color: '#3a5070', fontWeight: 700 }}>
        <span>+{tp1}%</span><span>+{tp2}%</span><span>+{tp3}%</span>
      </div>
    </div>
  );
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#0c1220', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, padding: 24, width: '100%', maxWidth: 420, boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}>
        {children}
      </div>
    </div>
  );
}

function EditModal({ pos, onClose, onSave }: { pos: Position; onClose: () => void; onSave: () => void }) {
  const [form, setForm] = useState({ entryPrice: String(pos.entryPrice), sizeSol: String(pos.sizeSol), slCurrent: String(pos.slCurrent), notes: pos.notes ?? '' });
  const [loading, setLoading] = useState(false);
  async function save() {
    setLoading(true);
    try { await api.editPosition(pos.id, { entryPrice: parseFloat(form.entryPrice), sizeSol: parseFloat(form.sizeSol), slCurrent: parseFloat(form.slCurrent), notes: form.notes }); onSave(); onClose(); }
    finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#00d4ff', marginBottom: 20 }}>Edit — {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {[['Entry Price', 'entryPrice'], ['Size (SOL)', 'sizeSol'], ['Stop Loss Price', 'slCurrent']].map(([label, key]) => (
          <div key={key}>
            <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 5, fontWeight: 700 }}>{label}</div>
            <input type="number" value={form[key as keyof typeof form]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className="input-premium" />
          </div>
        ))}
        <div>
          <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 5, fontWeight: 700 }}>Notes</div>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-premium" style={{ resize: 'none' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={save} disabled={loading} className="btn-solid-cyan" style={{ flex: 1, padding: 12, fontSize: 14 }}>{loading ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function CloseModal({ pos, onClose, onConfirm }: { pos: Position; onClose: () => void; onConfirm: () => void }) {
  const [loading, setLoading] = useState(false);
  const price = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlSol = pos.sizeSol * (pnlPct / 100);
  async function close() {
    setLoading(true);
    try { await api.closePosition(pos.id, price); onConfirm(); onClose(); }
    finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#ff4466', marginBottom: 20 }}>Close — {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {[['Close Price', `$${formatPrice(price)}`, '#d4e0f0'], ['P&L', `${formatSOL(pnlSol)} (${formatPct(pnlPct)})`, pnlSol >= 0 ? '#00ff88' : '#ff4466']].map(([l, v, c]) => (
          <div key={String(l)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: '#3a5070' }}>{l}</span>
            <span style={{ color: c as string, fontWeight: 800 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={close} disabled={loading} className="btn-solid-red" style={{ flex: 1, padding: 12, fontSize: 14 }}>{loading ? 'Closing…' : 'Close Position'}</button>
      </div>
    </Modal>
  );
}

function PositionCard({ pos, settings, onRefresh }: { pos: Position; settings: Settings | null; onRefresh: () => Promise<void> }) {
  const [showEdit, setShowEdit] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const current = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = pos.pnlPct ?? ((current - pos.entryPrice) / pos.entryPrice * 100);
  const pnlSol = pos.pnlSol ?? (pos.sizeSol * pnlPct / 100);
  const isPos = pnlPct >= 0;

  async function del() {
    if (!confirm(`Delete ${pos.symbol}?`)) return;
    setDeleting(true);
    try { await api.deletePosition(pos.id); await onRefresh(); } finally { setDeleting(false); }
  }

  return (
    <>
      <div className={`card ${isPos ? 'card-glow-green' : 'card-glow-red'}`}
        style={{ padding: '16px', borderColor: isPos ? 'rgba(0,255,136,0.18)' : 'rgba(255,68,102,0.18)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 900, fontSize: 15, color: '#d4e0f0' }}>{pos.symbol}</span>
              <span style={{ fontSize: 11, color: '#3a5070' }}>{pos.name}</span>
              <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,212,255,0.1)', color: '#00d4ff', border: '1px solid rgba(0,212,255,0.2)' }}>Score: {pos.scoreAtEntry}</span>
            </div>
            <div style={{ fontSize: 11, color: '#3a5070' }}>{toIST(pos.entryTime)}</div>
          </div>
          <PnlDisplay pnl={pnlSol} pct={pnlPct} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', marginBottom: 10 }}>
          {[
            ['Entry', `$${formatPrice(pos.entryPrice)}`, '#d4e0f0'],
            ['Current', `$${formatPrice(current)}`, isPos ? '#00ff88' : '#ff4466'],
            ['Size', `${pos.sizeSol.toFixed(3)} SOL`, '#d4e0f0'],
            ['Stop Loss', `$${formatPrice(pos.slCurrent)}`, '#ff4466'],
            ['Entry MC', undefined, undefined],
            ['B/S Ratio', `${(pos.buySellRatio ?? 1).toFixed(2)}x`, (pos.buySellRatio ?? 1) >= 1.5 ? '#00ff88' : '#d4e0f0'],
          ].map(([label, val, col], idx) => val !== undefined ? (
            <div key={idx} style={{ fontSize: 11 }}>
              <span style={{ color: '#3a5070' }}>{label} </span>
              <b style={{ color: col as string }}>{val}</b>
            </div>
          ) : null)}
        </div>

        <TPBar pos={pos} settings={settings} />

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {pos.dexUrl && (
            <a href={pos.dexUrl} target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ padding: '7px 12px', fontSize: 11, textDecoration: 'none' }}>DEX ↗</a>
          )}
          <button onClick={() => setShowEdit(true)} className="btn-primary" style={{ padding: '7px 12px', fontSize: 11 }}>Edit</button>
          <button onClick={() => setShowClose(true)} className="btn-red" style={{ padding: '7px 12px', fontSize: 11 }}>Close</button>
          <button onClick={del} disabled={deleting} style={{ padding: '7px 12px', fontSize: 11, borderRadius: 12, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#3a5070', cursor: 'pointer' }}>
            {deleting ? '…' : 'Delete'}
          </button>
        </div>

        {pos.notes && <div style={{ marginTop: 8, fontSize: 11, color: '#3a5070', fontStyle: 'italic' }}>📝 {pos.notes}</div>}
      </div>

      {showEdit && <EditModal pos={pos} onClose={() => setShowEdit(false)} onSave={onRefresh} />}
      {showClose && <CloseModal pos={pos} onClose={() => setShowClose(false)} onConfirm={onRefresh} />}
    </>
  );
}

export default function PositionsPage({ openPositions, closedPositions, balance, analytics, settings, onRefresh }: Props) {
  const unrealized = openPositions.reduce((s, p) => s + (p.pnlSol ?? 0), 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { label: 'Open Positions', value: String(openPositions.length), color: '#00d4ff' },
          { label: 'Unrealized PNL', value: `${unrealized >= 0 ? '+' : ''}${unrealized.toFixed(4)} SOL`, color: unrealized >= 0 ? '#00ff88' : '#ff4466' },
          { label: "Today's PNL", value: `${(analytics?.dailyPnl ?? 0) >= 0 ? '+' : ''}${(analytics?.dailyPnl ?? 0).toFixed(4)} SOL`, color: (analytics?.dailyPnl ?? 0) >= 0 ? '#00ff88' : '#ff4466' },
          { label: 'Win Rate', value: `${(analytics?.winRate ?? 0).toFixed(1)}%`, color: '#ffd700' },
        ].map((s) => (
          <div key={s.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 17, fontWeight: 900, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
            <div style={{ fontSize: 10, color: '#3a5070', marginTop: 5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 4 }}>Open Positions ({openPositions.length})</div>

      {openPositions.length === 0 ? (
        <div className="card" style={{ padding: '40px 20px', textAlign: 'center', color: '#3a5070' }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>📊</div>
          <div style={{ fontWeight: 700, color: '#7090b0', marginBottom: 4 }}>No open positions</div>
          <div style={{ fontSize: 12 }}>Scanner is looking for entries...</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {openPositions.map((p) => <PositionCard key={p.id} pos={p} settings={settings} onRefresh={onRefresh} />)}
        </div>
      )}
    </div>
  );
}
