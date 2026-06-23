import { useMemo, useState } from 'react';
import { Token } from '../lib/types.js';
import { formatMC, formatAge, formatPrice } from '../lib/utils.js';

interface Props { tokens: Token[] }

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.06)' }}>
      <div style={{ height: '100%', width: `${Math.min(100, (value / max) * 100)}%`, borderRadius: 4, background: color, boxShadow: `0 0 6px ${color}44`, transition: 'width 0.4s ease' }} />
    </div>
  );
}

function TokenRow({ token }: { token: Token }) {
  const [open, setOpen] = useState(false);
  const color = token.score >= 70 ? '#00ff88' : token.score >= 50 ? '#ffd700' : '#7090b0';
  const ch = token.priceChange5m;
  const chColor = ch >= 0 ? '#00ff88' : '#ff4466';
  const isEligible = token.status === 'ELIGIBLE';

  return (
    <div className={`card ${isEligible ? 'card-glow-green' : ''}`}
      style={{ borderColor: isEligible ? 'rgba(0,255,136,0.2)' : undefined, overflow: 'hidden' }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', display: 'block', background: 'transparent', border: 'none', cursor: 'pointer', padding: '14px 16px', textAlign: 'left' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Score bubble */}
          <div style={{
            width: 44, height: 44, borderRadius: 14, flexShrink: 0,
            background: `${color}18`, border: `2px solid ${color}55`,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 0 14px ${color}22`,
          }}>
            <span style={{ fontSize: 14, fontWeight: 900, color, lineHeight: 1 }}>{token.score}</span>
            <span style={{ fontSize: 8, color: color + '99', fontWeight: 700, letterSpacing: '0.04em' }}>SCORE</span>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 14, color: '#d4e0f0' }}>{token.symbol}</span>
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 6, background: 'rgba(0,212,255,0.08)', color: '#00d4ff', border: '1px solid rgba(0,212,255,0.18)', fontWeight: 700 }}>{token.dexId}</span>
              {isEligible && <span className="badge badge-eligible">ELIGIBLE</span>}
            </div>
            <div style={{ fontSize: 11, color: '#3a5070' }}>
              MC <b style={{ color: '#7090b0' }}>{formatMC(token.marketCap)}</b>
              {' · '}Vol <b style={{ color: '#7090b0' }}>{formatMC(token.volume24h)}</b>
              {' · '}<b style={{ color: '#7090b0' }}>{formatAge(token.age)}</b>
            </div>
          </div>

          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 14, color: chColor }}>
              {ch >= 0 ? '+' : ''}{ch.toFixed(2)}%
            </div>
            <div style={{ fontSize: 10, color: '#3a5070' }}>5m</div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <Bar value={token.score} max={100} color={color} />
        </div>
      </button>

      {open && (
        <div style={{ padding: '14px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: 12, marginBottom: 12 }}>
            {[
              ['Price', `$${formatPrice(token.price)}`, '#d4e0f0'],
              ['B/S Ratio', `${token.buySellRatio.toFixed(2)}x`, token.buySellRatio >= 1.5 ? '#00ff88' : '#d4e0f0'],
              ['Liquidity', formatMC(token.liquidity), '#d4e0f0'],
              ['1h Change', `${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(2)}%`, token.priceChange1h >= 0 ? '#00ff88' : '#ff4466'],
            ].map(([l, v, c]) => (
              <div key={String(l)}>
                <span style={{ color: '#3a5070' }}>{l} </span>
                <b style={{ color: c as string }}>{v}</b>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {[
              { label: 'Price Momentum', v: token.scoreBreakdown?.priceMomentum ?? 0, color: '#00d4ff' },
              { label: 'Volume Momentum', v: token.scoreBreakdown?.volumeMomentum ?? 0, color: '#9b59ff' },
              { label: 'Buy Pressure', v: token.scoreBreakdown?.buyPressure ?? 0, color: '#00ff88' },
            ].map((item) => (
              <div key={item.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4, color: '#3a5070' }}>
                  <span>{item.label}</span>
                  <b style={{ color: item.color }}>{item.v}/25</b>
                </div>
                <Bar value={item.v} max={25} color={item.color} />
              </div>
            ))}
          </div>

          <a href={`https://dexscreener.com/solana/${token.mint}`} target="_blank" rel="noopener noreferrer"
            className="btn-primary" onClick={(e) => e.stopPropagation()}
            style={{ display: 'block', marginTop: 12, padding: '10px', fontSize: 12, textDecoration: 'none', textAlign: 'center' }}>
            View on DexScreener ↗
          </a>
        </div>
      )}
    </div>
  );
}

export default function WatchlistPage({ tokens }: Props) {
  const eligible = useMemo(() => tokens.filter((t) => t.status === 'ELIGIBLE' || t.status === 'SCANNING').sort((a, b) => b.score - a.score), [tokens]);
  const top = useMemo(() => tokens.filter((t) => t.score >= 40).sort((a, b) => b.score - a.score).slice(0, 30), [tokens]);
  const display = eligible.length > 0 ? eligible : top;
  const avgScore = display.length > 0 ? Math.round(display.reduce((s, t) => s + t.score, 0) / display.length) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'Watchlist', value: display.length, color: '#00d4ff', glow: 'card-glow-cyan' },
          { label: 'Eligible', value: tokens.filter((t) => t.status === 'ELIGIBLE').length, color: '#00ff88', glow: 'card-glow-green' },
          { label: 'Avg Score', value: avgScore, color: '#ffd700', glow: 'card-glow-gold' },
        ].map((s) => (
          <div key={s.label} className={`card ${s.glow}`} style={{ padding: '12px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 24, fontWeight: 900, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: '#3a5070', marginTop: 4, fontWeight: 700, letterSpacing: '0.08em' }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      {display.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: '#3a5070' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⭐</div>
          <div style={{ fontWeight: 700, color: '#7090b0', marginBottom: 6 }}>No tokens found yet</div>
          <div style={{ fontSize: 12 }}>Tokens appear here as they pass filters</div>
        </div>
      ) : (
        <>
          <div className="section-label">{eligible.length > 0 ? `${eligible.length} Eligible Tokens` : 'Top Scoring Tokens'}</div>
          {display.map((t) => <TokenRow key={t.mint} token={t} />)}
        </>
      )}
    </div>
  );
}
