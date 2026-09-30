import { useState } from 'react';
import { AltcoinStatusResponse, AltcoinSignal, SignalStatus } from '../lib/types.js';

interface Props {
  status?: AltcoinStatusResponse | null;
  wsConnected?: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  'Layer 1': '#00d4ff',
  'Layer 2': '#9b59ff',
  DeFi: '#00ff88',
  AI: '#ff8844',
  Infrastructure: '#ffd700',
  Interop: '#a855f7',
  RWA: '#38bdf8',
  Gaming: '#f43f5e',
};

function getStatusBadge(status: SignalStatus) {
  switch (status) {
    case 'ENTRY_READY':
      return { label: 'ENTRY READY', bg: 'rgba(0,255,136,0.18)', color: '#00ff88', border: 'rgba(0,255,136,0.4)' };
    case 'NEAR_ENTRY':
      return { label: 'NEAR ENTRY', bg: 'rgba(255,215,0,0.18)', color: '#ffd700', border: 'rgba(255,215,0,0.4)' };
    case 'IN_POSITION':
      return { label: 'IN POSITION', bg: 'rgba(0,212,255,0.18)', color: '#00d4ff', border: 'rgba(0,212,255,0.4)' };
    case 'WATCHING':
      return { label: 'WATCHING', bg: 'rgba(155,89,255,0.15)', color: '#9b59ff', border: 'rgba(155,89,255,0.3)' };
    case 'COOLDOWN':
      return { label: 'COOLDOWN', bg: 'rgba(255,136,68,0.15)', color: '#ff8844', border: 'rgba(255,136,68,0.3)' };
    default:
      return { label: 'NO SETUP', bg: 'rgba(255,255,255,0.05)', color: '#4a6080', border: 'rgba(255,255,255,0.1)' };
  }
}

function TrendPill({ tf, trend }: { tf: string; trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' }) {
  const isBull = trend === 'BULLISH';
  const isBear = trend === 'BEARISH';
  const color = isBull ? '#00ff88' : isBear ? '#ff4466' : '#8099bb';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '2px 5px', borderRadius: 4, fontSize: 9, fontWeight: 800,
      background: `${color}15`, color, border: `1px solid ${color}33`
    }}>
      <span style={{ fontSize: 8, color: '#4a6080' }}>{tf}:</span>
      <span>{isBull ? '▲' : isBear ? '▼' : '►'} {trend.slice(0, 4)}</span>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const isHigh = score >= 80;
  const isMid = score >= 70;
  const color = isHigh ? '#00ff88' : isMid ? '#ffd700' : '#ff8844';
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '4px 10px', borderRadius: 8,
      background: `${color}18`, border: `1px solid ${color}44`,
    }}>
      <span style={{ fontSize: 13, fontWeight: 900, color, fontVariantNumeric: 'tabular-nums' }}>{score}</span>
      <span style={{ fontSize: 9, color: '#3a5070', fontWeight: 800 }}>/100</span>
    </div>
  );
}

export default function DiscoverPage({ status }: Props) {
  const [filter, setFilter] = useState<string>('ALL');
  const [selectedSignal, setSelectedSignal] = useState<AltcoinSignal | null>(null);

  const signals = status?.signals ?? [];
  const topOps = status?.topOpportunities ?? [];
  const stats = status?.stats ?? { totalTracked: 100, watching: 0, nearEntry: 0, entryReady: 0, openPositions: 0 };

  const filteredSignals = signals.filter((s) => {
    if (filter === 'ALL') return true;
    if (filter === 'ENTRY_READY') return s.status === 'ENTRY_READY';
    if (filter === 'NEAR_ENTRY') return s.status === 'NEAR_ENTRY';
    if (filter === 'WATCHING') return s.status === 'WATCHING';
    if (filter === 'IN_POSITION') return s.status === 'IN_POSITION';
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto' }}>
      
      {/* ── Top Dashboard Header ── */}
      <div style={{
        background: 'linear-gradient(135deg, rgba(0,212,255,0.08) 0%, rgba(155,89,255,0.08) 100%)',
        border: '1px solid rgba(0,212,255,0.2)',
        borderRadius: 14, padding: '16px 20px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#00d4ff', letterSpacing: '0.04em' }}>
              ⚡ ALTCOIN MARKET SCANNER & AI RADAR
            </div>
            <div style={{ fontSize: 10, color: '#7090b0', marginTop: 3 }}>
              Institutional Price Action Strategy (20 EMA Retest) · 1.0% Risk Per Trade · Quality Over Quantity Filter ($100 Account)
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '4px 10px', borderRadius: 6, background: 'rgba(0,255,136,0.12)', color: '#00ff88', border: '1px solid rgba(0,255,136,0.3)' }}>
              BTC REGIME: BULLISH
            </span>
            <span style={{ fontSize: 9, fontWeight: 800, padding: '4px 10px', borderRadius: 6, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.3)' }}>
              UNIVERSE: 100 ASSETS
            </span>
          </div>
        </div>

        {/* Primary Metric Pills (Responsive auto-fit for Android & Desktop) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(64px, 1fr))', gap: 6, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 4px', borderRadius: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#00d4ff' }}>{stats.totalTracked}</div>
            <div style={{ fontSize: 8, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Assets</div>
          </div>
          <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 4px', borderRadius: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#9b59ff' }}>{stats.watching}</div>
            <div style={{ fontSize: 8, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Watching</div>
          </div>
          <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 4px', borderRadius: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#ffd700' }}>{stats.nearEntry}</div>
            <div style={{ fontSize: 8, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Near</div>
          </div>
          <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 4px', borderRadius: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#00ff88' }}>{stats.entryReady}</div>
            <div style={{ fontSize: 8, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Ready</div>
          </div>
          <div style={{ textAlign: 'center', background: 'rgba(0,0,0,0.2)', padding: '6px 4px', borderRadius: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#ff8844' }}>{stats.openPositions}</div>
            <div style={{ fontSize: 8, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Position</div>
          </div>
        </div>
      </div>

      {/* ── Active Portfolio Execution Capacity Banner ── */}
      {status?.openPositions && status.openPositions.length >= 3 && (
        <div style={{
          background: 'rgba(255,215,0,0.08)',
          border: '1px solid rgba(255,215,0,0.3)',
          borderRadius: 10, padding: '10px 14px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
          fontSize: 11, color: '#ffd700'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14 }}>🛡️</span>
            <span>
              <strong>Portfolio Safeguard Active:</strong> {status.openPositions.length} active positions running ({status.openPositions.map(p => p.symbol).join(', ')}). High-scoring ENTRY READY setups are queued and will execute automatically as active positions hit Take Profit/Stop Loss or daily trade window advances.
            </span>
          </div>
        </div>
      )}

      {/* ── Top Opportunities Highlights ── */}
      {topOps.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>
            🔥 TOP AI OPPORTUNITIES (HIGHEST SCORES)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
            {topOps.slice(0, 3).map((sig) => {
              const b = getStatusBadge(sig.status);
              return (
                <div
                  key={sig.assetId}
                  onClick={() => setSelectedSignal(sig)}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(0,212,255,0.25)',
                    borderRadius: 12, padding: '12px', cursor: 'pointer',
                  }}
                  className="hover-card"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 900, color: '#ffffff' }}>{sig.symbol}</span>
                        <span style={{ fontSize: 8.5, color: CATEGORY_COLORS[sig.category] || '#8099bb', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: `${CATEGORY_COLORS[sig.category] || '#8099bb'}18` }}>
                          {sig.category}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#7090b0', marginTop: 1 }}>{sig.name}</div>
                    </div>
                    <ScoreBadge score={sig.aiScore} />
                  </div>

                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 8 }}>
                    <TrendPill tf="4H" trend={sig.mtfTrend.tf4h} />
                    <TrendPill tf="1H" trend={sig.mtfTrend.tf1h} />
                    <TrendPill tf="15M" trend={sig.mtfTrend.tf15m} />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 5, background: b.bg, color: b.color, border: `1px solid ${b.border}` }}>
                      {b.label}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: '#00d4ff' }}>
                      ${sig.price < 1 ? sig.price.toFixed(4) : sig.price.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Horizontally Scrollable Filter Bar for Android & Desktop ── */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 4, scrollbarWidth: 'none', alignItems: 'center' }}>
        <span style={{ fontSize: 9.5, fontWeight: 800, color: '#3a5070', marginRight: 2, flexShrink: 0 }}>FILTER:</span>
        {[
          { id: 'ALL', label: `ALL (${signals.length})` },
          { id: 'ENTRY_READY', label: `ENTRY READY (${signals.filter(s => s.status === 'ENTRY_READY').length})` },
          { id: 'NEAR_ENTRY', label: `NEAR ENTRY (${signals.filter(s => s.status === 'NEAR_ENTRY').length})` },
          { id: 'WATCHING', label: `WATCHING (${signals.filter(s => s.status === 'WATCHING').length})` },
          { id: 'IN_POSITION', label: `IN POSITION (${signals.filter(s => s.status === 'IN_POSITION').length})` },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '5px 11px', borderRadius: 7, fontSize: 9.5, fontWeight: 800, flexShrink: 0,
              border: filter === f.id ? '1px solid #00d4ff' : '1px solid rgba(255,255,255,0.08)',
              background: filter === f.id ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
              color: filter === f.id ? '#00d4ff' : '#7090b0',
              cursor: 'pointer', transition: 'all 0.2s', minHeight: 32, touchAction: 'manipulation',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Signals & Assets List ── */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, overflow: 'hidden' }}>
        
        {/* Desktop Table Header (Hidden on Android / Mobile) */}
        <div className="desktop-table-header" style={{ display: 'grid', gridTemplateColumns: '2.2fr 1.5fr 1.2fr 2fr 1.5fr 1.8fr', padding: '10px 14px', background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 9.5, fontWeight: 800, color: '#3a5070', letterSpacing: '0.06em' }}>
          <div>ASSET</div>
          <div>PRICE & 24H</div>
          <div>AI SCORE</div>
          <div>MTF TRENDS</div>
          <div>SIGNAL STATE</div>
          <div>STATUS & THESIS</div>
        </div>

        {filteredSignals.length === 0 ? (
          <div style={{ padding: '36px 20px', textAlign: 'center', color: '#4a6080', fontSize: 12 }}>
            No altcoin signals match the selected filter.
          </div>
        ) : (
          filteredSignals.map((sig) => {
            const b = getStatusBadge(sig.status);
            const isPos24h = sig.priceChange24h >= 0;
            return (
              <div key={sig.assetId}>
                
                {/* Desktop Row */}
                <div
                  onClick={() => setSelectedSignal(sig)}
                  style={{
                    display: 'grid', gridTemplateColumns: '2.2fr 1.5fr 1.2fr 2fr 1.5fr 1.8fr',
                    padding: '11px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    alignItems: 'center', cursor: 'pointer',
                  }}
                  className="desktop-table-row hover-row"
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 900, color: '#ffffff' }}>{sig.symbol}</span>
                      <span style={{ fontSize: 8.5, color: CATEGORY_COLORS[sig.category] || '#8099bb', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: `${CATEGORY_COLORS[sig.category] || '#8099bb'}18` }}>
                        {sig.category}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: '#4a6080', marginTop: 1 }}>{sig.name}</div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: '#ffffff', fontVariantNumeric: 'tabular-nums' }}>
                      ${sig.price < 1 ? sig.price.toFixed(4) : sig.price.toFixed(2)}
                    </div>
                    <div style={{ fontSize: 9.5, fontWeight: 800, color: isPos24h ? '#00ff88' : '#ff4466' }}>
                      {isPos24h ? '+' : ''}{sig.priceChange24h.toFixed(1)}% 24h
                    </div>
                  </div>

                  <div>
                    <ScoreBadge score={sig.aiScore} />
                  </div>

                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                    <TrendPill tf="4H" trend={sig.mtfTrend.tf4h} />
                    <TrendPill tf="1H" trend={sig.mtfTrend.tf1h} />
                    <TrendPill tf="15M" trend={sig.mtfTrend.tf15m} />
                  </div>

                  <div>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 6, background: b.bg, color: b.color, border: `1px solid ${b.border}` }}>
                      {b.label}
                    </span>
                  </div>

                  <div>
                    {sig.missingCondition ? (
                      <span style={{ fontSize: 9.5, color: '#ffd700', fontStyle: 'italic' }}>
                        ⚠️ {sig.missingCondition}
                      </span>
                    ) : (
                      <span style={{ fontSize: 9.5, color: '#00ff88', fontWeight: 700 }}>
                        ✅ R:R {sig.tradeThesis.riskRewardRatio.toFixed(1)} Setup
                      </span>
                    )}
                  </div>
                </div>

                {/* Mobile / Android Card Row */}
                <div
                  onClick={() => setSelectedSignal(sig)}
                  className="mobile-card-row hover-card"
                  style={{
                    display: 'none',
                    flexDirection: 'column',
                    gap: 7,
                    padding: '11px 12px',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    background: 'rgba(255,255,255,0.02)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 900, color: '#ffffff' }}>{sig.symbol}</span>
                      <span style={{ fontSize: 8.5, color: CATEGORY_COLORS[sig.category] || '#8099bb', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: `${CATEGORY_COLORS[sig.category] || '#8099bb'}18` }}>
                        {sig.category}
                      </span>
                      <span style={{ fontSize: 10, color: '#4a6080' }}>{sig.name}</span>
                    </div>
                    <ScoreBadge score={sig.aiScore} />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 900, color: '#00d4ff', fontVariantNumeric: 'tabular-nums' }}>
                        ${sig.price < 1 ? sig.price.toFixed(4) : sig.price.toFixed(2)}
                      </span>
                      <span style={{ fontSize: 9.5, fontWeight: 800, color: isPos24h ? '#00ff88' : '#ff4466' }}>
                        {isPos24h ? '+' : ''}{sig.priceChange24h.toFixed(2)}%
                      </span>
                    </div>
                    <div style={{ fontSize: 9.5, color: '#7090b0' }}>
                      24h Vol: ${(sig.volume24h / 1_000_000).toFixed(1)}M
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      <TrendPill tf="4H" trend={sig.mtfTrend.tf4h} />
                      <TrendPill tf="1H" trend={sig.mtfTrend.tf1h} />
                      <TrendPill tf="15M" trend={sig.mtfTrend.tf15m} />
                    </div>
                    <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 7px', borderRadius: 5, background: b.bg, color: b.color, border: `1px solid ${b.border}` }}>
                      {b.label}
                    </span>
                  </div>

                  {sig.missingCondition ? (
                    <div style={{ fontSize: 9, color: '#ffd700', fontStyle: 'italic', background: 'rgba(255,215,0,0.06)', padding: '3px 7px', borderRadius: 5 }}>
                      ⚠️ {sig.missingCondition}
                    </div>
                  ) : (
                    <div style={{ fontSize: 9, color: '#00ff88', fontWeight: 700, background: 'rgba(0,255,136,0.06)', padding: '3px 7px', borderRadius: 5 }}>
                      ✅ Setup: Stop ${sig.tradeThesis.stopLoss} · Target ${sig.tradeThesis.takeProfit} (R:R {sig.tradeThesis.riskRewardRatio.toFixed(1)})
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Coin Detail Modal (Android Screen Friendly) ── */}
      {selectedSignal && (
        <div
          onClick={() => setSelectedSignal(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 12, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0c1220', border: '1px solid rgba(0,212,255,0.3)', borderRadius: 16,
              padding: 16, width: '100%', maxWidth: 460, maxHeight: '88dvh', overflowY: 'auto',
              boxShadow: '0 24px 64px rgba(0,0,0,0.85)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 18, fontWeight: 900, color: '#ffffff' }}>{selectedSignal.symbol}</span>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 5, background: 'rgba(0,212,255,0.15)', color: '#00d4ff' }}>
                    {selectedSignal.category}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#7090b0', marginTop: 1 }}>{selectedSignal.name}</div>
              </div>
              <ScoreBadge score={selectedSignal.aiScore} />
            </div>

            {/* Score Breakdown */}
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 10, marginBottom: 12 }}>
              <div style={{ fontSize: 9.5, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 6 }}>
                AI MODEL SUB-SCORES BREAKDOWN
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, textAlign: 'center' }}>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#00d4ff' }}>{selectedSignal.scoreBreakdown.trend}/20</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>Trend</div></div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#00ff88' }}>{selectedSignal.scoreBreakdown.momentum}/20</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>Momentum</div></div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#ffd700' }}>{selectedSignal.scoreBreakdown.volume}/20</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>Volume</div></div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#a855f7' }}>{selectedSignal.scoreBreakdown.structure}/20</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>Structure</div></div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#ff8844' }}>{selectedSignal.scoreBreakdown.volatility}/10</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>Volatility</div></div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: 6, borderRadius: 6 }}><div style={{ fontSize: 11, fontWeight: 900, color: '#38bdf8' }}>{selectedSignal.scoreBreakdown.htfAlignment}/10</div><div style={{ fontSize: 7.5, color: '#4a6080' }}>HTF Align</div></div>
              </div>
            </div>

            {/* Trade Thesis */}
            <div style={{ background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: 10, padding: 10, marginBottom: 12 }}>
              <div style={{ fontSize: 9.5, fontWeight: 800, color: '#00ff88', letterSpacing: '0.08em', marginBottom: 6 }}>
                TRADE THESIS ({selectedSignal.tradeThesis.side})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, fontSize: 10, marginBottom: 8 }}>
                <div><span style={{ color: '#4a6080' }}>Entry: </span><b style={{ color: '#ffffff' }}>${selectedSignal.tradeThesis.entryPrice < 1 ? selectedSignal.tradeThesis.entryPrice.toFixed(4) : selectedSignal.tradeThesis.entryPrice.toFixed(2)}</b></div>
                <div><span style={{ color: '#4a6080' }}>SL: </span><b style={{ color: '#ff4466' }}>${selectedSignal.tradeThesis.stopLoss < 1 ? selectedSignal.tradeThesis.stopLoss.toFixed(4) : selectedSignal.tradeThesis.stopLoss.toFixed(2)}</b></div>
                <div><span style={{ color: '#4a6080' }}>TP: </span><b style={{ color: '#00ff88' }}>${selectedSignal.tradeThesis.takeProfit < 1 ? selectedSignal.tradeThesis.takeProfit.toFixed(4) : selectedSignal.tradeThesis.takeProfit.toFixed(2)}</b></div>
              </div>
              <div style={{ fontSize: 10, color: '#7090b0', lineHeight: 1.5 }}>
                • <b>Risk/Reward</b>: 1:{selectedSignal.tradeThesis.riskRewardRatio.toFixed(2)} (Risk {selectedSignal.tradeThesis.riskDistancePct.toFixed(1)}% / Target +{selectedSignal.tradeThesis.rewardDistancePct.toFixed(1)}%)<br/>
                {selectedSignal.tradeThesis.explanation.map((exp, idx) => (
                  <span key={idx}>• {exp}<br/></span>
                ))}
              </div>
            </div>

            <button
              onClick={() => setSelectedSignal(null)}
              style={{
                width: '100%', padding: 10, borderRadius: 8, background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)', color: '#ffffff', cursor: 'pointer', fontWeight: 800,
                fontSize: 12, minHeight: 40, touchAction: 'manipulation',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
