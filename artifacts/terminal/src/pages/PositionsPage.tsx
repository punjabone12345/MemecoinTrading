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

// Mirrors backend trailGivebackPct logic
function givebackPct(peakGain: number): number | null {
  if (peakGain >= 400) return 10;
  if (peakGain >= 300) return 15;
  if (peakGain >= 200) return 20;
  if (peakGain >= 100) return 30;
  if (peakGain >= 50)  return 40;
  return null;
}

function RunnerBar({ pos, settings }: { pos: Position; settings: Settings | null }) {
  const slPct = settings?.slPct ?? 20;
  const current = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = pos.pnlPct ?? ((current - pos.entryPrice) / pos.entryPrice * 100);
  const peakGain = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // Use actual slCurrent from DB (backend computed) → convert to % from entry
  const slPriceFromEntry = pos.slCurrent;
  const slFromEntry = ((slPriceFromEntry - pos.entryPrice) / pos.entryPrice) * 100;

  // Distance from current price to SL trigger (negative = SL is below current)
  const distToSL = ((current - slPriceFromEntry) / current) * 100;

  const giveback = givebackPct(peakGain);
  const isTrailing = giveback !== null;

  const windowPct = Math.max(100, peakGain * 1.2);
  const progress = Math.min(100, Math.max(0, ((pnlPct + windowPct * 0.2) / (windowPct * 1.2)) * 100));
  const slProgress = Math.min(100, Math.max(0, ((slFromEntry + windowPct * 0.2) / (windowPct * 1.2)) * 100));
  const color = pnlPct > 0 ? '#00ff88' : '#ff4466';

  const tierLabel = isTrailing
    ? <span style={{ color: '#00ff88', fontWeight: 800 }}>Trailing SL · {giveback}% giveback</span>
    : <span style={{ color: '#ffd700', fontWeight: 800 }}>Hard SL · trailing kicks in at +50%</span>;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
        <span style={{ color: '#3a5070' }}>{tierLabel}</span>
        <span style={{ color, fontWeight: 800 }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</span>
      </div>

      {/* Progress bar with SL marker */}
      <div style={{ position: 'relative', height: 8, borderRadius: 6, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ height: '100%', borderRadius: 6, width: `${progress}%`, background: color, boxShadow: `0 0 8px ${color}55`, transition: 'width 0.3s ease' }} />
        {/* SL marker line */}
        <div style={{
          position: 'absolute', top: -2, bottom: -2, left: `${slProgress}%`,
          width: 2, borderRadius: 1, background: '#ff4466',
          boxShadow: '0 0 6px #ff4466',
          transform: 'translateX(-50%)',
        }} />
      </div>

      {/* SL info row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 5, color: '#3a5070', fontWeight: 700 }}>
        <span style={{ color: '#ff4466' }}>
          SL {slFromEntry >= 0 ? '+' : ''}{slFromEntry.toFixed(1)}% · <span style={{ color: '#ff446699' }}>${formatPrice(slPriceFromEntry)}</span>
        </span>
        <span style={{ color: '#7090b0' }}>Peak +{peakGain.toFixed(1)}%</span>
      </div>

      {/* Distance to SL */}
      <div style={{ marginTop: 5, padding: '5px 10px', borderRadius: 7, background: isTrailing ? 'rgba(0,255,136,0.05)' : 'rgba(255,180,0,0.05)', border: `1px solid ${isTrailing ? 'rgba(0,255,136,0.12)' : 'rgba(255,180,0,0.12)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#3a5070' }}>
          SL trigger at <b style={{ color: '#ff4466' }}>${formatPrice(slPriceFromEntry)}</b>
        </span>
        <span style={{ fontSize: 10, fontWeight: 800, color: distToSL > 15 ? '#00ff88' : distToSL > 5 ? '#ffd700' : '#ff4466' }}>
          {distToSL.toFixed(1)}% away
        </span>
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

const CLOSE_REASONS = ['Manual close', 'Filter change', 'Strategy change', 'Risk management', 'Taking profit'];

function CloseModal({ pos, onClose, onConfirm }: { pos: Position; onClose: () => void; onConfirm: () => void }) {
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState('Manual close');
  const price = pos.currentPrice ?? pos.entryPrice;
  const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlSol = pos.sizeSol * (pnlPct / 100);
  async function close() {
    setLoading(true);
    try { await api.closePosition(pos.id, price, reason); onConfirm(); onClose(); }
    finally { setLoading(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3 style={{ fontWeight: 900, fontSize: 16, color: '#ff4466', marginBottom: 20 }}>Close — {pos.symbol}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {[['Close Price', `$${formatPrice(price)}`, '#d4e0f0'], ['P&L', `${formatSOL(pnlSol)} (${formatPct(pnlPct)})`, pnlSol >= 0 ? '#00ff88' : '#ff4466']].map(([l, v, c]) => (
          <div key={String(l)} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span style={{ color: '#3a5070' }}>{l}</span>
            <span style={{ color: c as string, fontWeight: 800 }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#3a5070', marginBottom: 6, fontWeight: 700 }}>CLOSE REASON</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CLOSE_REASONS.map((r) => (
            <button key={r} onClick={() => setReason(r)} style={{
              padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: reason === r ? 'rgba(255,68,102,0.18)' : 'rgba(255,255,255,0.04)',
              border: reason === r ? '1px solid #ff4466' : '1px solid rgba(255,255,255,0.08)',
              color: reason === r ? '#ff4466' : '#7090b0',
            }}>{r}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={onClose} style={{ flex: 1, padding: 12, borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontWeight: 700 }}>Cancel</button>
        <button onClick={close} disabled={loading} className="btn-solid-red" style={{ flex: 1, padding: 12, fontSize: 14 }}>{loading ? 'Closing…' : 'Close Position'}</button>
      </div>
    </Modal>
  );
}

// Flashes briefly when the price updates (driven by 500ms monitor)
function LivePriceTicker({ price, entryPrice }: { price: number; entryPrice: number }) {
  const prev = useRef(price);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (price !== prev.current) {
      setFlash(price > prev.current ? 'up' : 'down');
      const t = setTimeout(() => setFlash(null), 400);
      prev.current = price;
      return () => clearTimeout(t);
    }
  }, [price]);
  const isPos = price >= entryPrice;
  const flashColor = flash === 'up' ? '#00ff8866' : flash === 'down' ? '#ff446644' : 'transparent';
  return (
    <span style={{
      fontWeight: 800, fontSize: 13,
      color: isPos ? '#00ff88' : '#ff4466',
      background: flashColor,
      borderRadius: 4, padding: '1px 4px',
      transition: 'background 0.3s ease',
    }}>
      ${formatPrice(price)}
    </span>
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
  const peakGain = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const giveback = givebackPct(peakGain);

  async function del() {
    if (!confirm(`Delete ${pos.symbol}?`)) return;
    setDeleting(true);
    try { await api.deletePosition(pos.id); await onRefresh(); } finally { setDeleting(false); }
  }

  return (
    <>
      <div className={`card ${isPos ? 'card-glow-green' : 'card-glow-red'}`}
        style={{ padding: '16px', borderColor: isPos ? 'rgba(0,255,136,0.18)' : 'rgba(255,68,102,0.18)' }}>

        {/* Header: symbol + P&L */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 900, fontSize: 15, color: '#d4e0f0', flexShrink: 0 }}>{pos.symbol}</span>
              <span style={{ fontSize: 11, color: '#3a5070', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 80 }}>{pos.name}</span>
              <span style={{ padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 700, background: 'rgba(0,212,255,0.1)', color: '#00d4ff', border: '1px solid rgba(0,212,255,0.2)', flexShrink: 0 }}>Score: {pos.scoreAtEntry}</span>
              {/* Live 500ms indicator */}
              <span title="Price updating every 500ms" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#00ff88', fontWeight: 800, flexShrink: 0 }}>
                <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 5px #00ff88', animation: 'pulse-dot 0.8s ease-in-out infinite' }} />
                LIVE
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#3a5070' }}>{toIST(pos.entryTime)}</div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <PnlDisplay pnl={pnlSol} pct={pnlPct} />
          </div>
        </div>

        {/* Key metrics grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', marginBottom: 10 }}>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Entry </span>
            <b style={{ color: '#d4e0f0' }}>${formatPrice(pos.entryPrice)}</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Current </span>
            <LivePriceTicker price={current} entryPrice={pos.entryPrice} />
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Size </span>
            <b style={{ color: '#d4e0f0' }}>{pos.sizeSol.toFixed(3)} SOL</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Peak </span>
            <b style={{ color: '#ffd700' }}>+{peakGain.toFixed(1)}%</b>
            {giveback !== null && <span style={{ color: '#3a5070', fontSize: 10 }}> · {giveback}% give</span>}
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>B/S Ratio </span>
            <b style={{ color: (pos.buySellRatio ?? 1) >= 1.5 ? '#00ff88' : '#d4e0f0' }}>{(pos.buySellRatio ?? 1).toFixed(2)}x</b>
          </div>
          <div style={{ fontSize: 11 }}>
            <span style={{ color: '#3a5070' }}>Mode </span>
            <b style={{ color: pos.mode === 'live' ? '#00ff88' : '#ffd700' }}>{pos.mode?.toUpperCase() ?? 'PAPER'}</b>
          </div>
        </div>

        <RunnerBar pos={pos} settings={settings} />

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
  const unrealized = openPositions.reduce((s, p) => {
    const current = p.currentPrice ?? p.entryPrice;
    const pct = (current - p.entryPrice) / p.entryPrice;
    return s + p.sizeSol * pct;
  }, 0);

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

      {/* Live feed badge */}
      {openPositions.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 8, background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.1)', fontSize: 10 }}>
          <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 6px #00ff88', animation: 'pulse-dot 0.8s ease-in-out infinite' }} />
          <span style={{ color: '#00ff88', fontWeight: 800 }}>LIVE</span>
          <span style={{ color: '#3a5070' }}>Prices updating every <b style={{ color: '#7090b0' }}>500ms</b> · SL checks via pair-address feed</span>
        </div>
      )}

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

      {closedPositions.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 8 }}>Closed Positions ({closedPositions.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {closedPositions.slice(0, 20).map((p) => {
              const pnlPos = (p.pnlSol ?? 0) >= 0;
              return (
                <div key={p.id} className="card" style={{ padding: '14px 16px', borderColor: pnlPos ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.1)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: '#d4e0f0' }}>{p.symbol}</span>
                        <span style={{ fontSize: 10, color: '#3a5070' }}>{p.name}</span>
                      </div>
                      <div style={{ fontSize: 10, color: '#3a5070', marginBottom: 3 }}>{toIST(p.entryTime)} → {p.exitTime ? toIST(p.exitTime) : '—'}</div>
                      {p.closeReason && <div style={{ fontSize: 10, color: '#7090b0', fontStyle: 'italic' }}>{p.closeReason}</div>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 900, fontSize: 14, color: pnlPos ? '#00ff88' : '#ff4466' }}>{formatSOL(p.pnlSol ?? 0)}</div>
                      <div style={{ fontSize: 11, color: pnlPos ? '#00ff8899' : '#ff446699' }}>{formatPct(p.pnlPct ?? 0)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11 }}>
                    <span style={{ color: '#3a5070' }}>Entry <b style={{ color: '#7090b0' }}>${formatPrice(p.entryPrice)}</b></span>
                    <span style={{ color: '#3a5070' }}>Exit <b style={{ color: '#7090b0' }}>${formatPrice(p.exitPrice ?? 0)}</b></span>
                    <span style={{ color: '#3a5070' }}>Size <b style={{ color: '#7090b0' }}>{p.sizeSol.toFixed(3)} SOL</b></span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
