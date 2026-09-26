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
              Tracking ~100 Liquid Non-Meme Altcoins · Multi-Timeframe Trend & Momentum Scoring · Paper Simulation Mode ($100 USD Account)
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

        {/* Primary Metric Pills */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#00d4ff' }}>{stats.totalTracked}</div>
            <div style={{ fontSize: 9, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Tracked Assets</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#9b59ff' }}>{stats.watching}</div>
            <div style={{ fontSize: 9, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Watching</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#ffd700' }}>{stats.nearEntry}</div>
            <div style={{ fontSize: 9, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Near Entry</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#00ff88' }}>{stats.entryReady}</div>
            <div style={{ fontSize: 9, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>Entry Ready</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#ff8844' }}>{stats.openPositions}</div>
            <div style={{ fontSize: 9, color: '#4a6080', fontWeight: 800, textTransform: 'uppercase' }}>In Position</div>
          </div>
        </div>
      </div>

      {/* ── Top Opportunities Highlights ── */}
      {topOps.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 8, textTransform: 'uppercase' }}>
            🔥 TOP AI OPPORTUNITIES (HIGHEST SCORES)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
            {topOps.slice(0, 3).map((sig) => {
              const b = getStatusBadge(sig.status);
              return (
                <div
                  key={sig.assetId}
                  onClick={() => setSelectedSignal(sig)}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(0,212,255,0.25)',
                    borderRadius: 12, padding: '14px', cursor: 'pointer',
                    transition: 'transform 0.2s, border-color 0.2s',
                  }}
                  className="hover-card"
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 900, color: '#ffffff' }}>{sig.symbol}</span>
                        <span style={{ fontSize: 9, color: CATEGORY_COLORS[sig.category] || '#8099bb', fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: `${CATEGORY_COLORS[sig.category] || '#8099bb'}18` }}>
                          {sig.category}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#7090b0', marginTop: 2 }}>{sig.name}</div>
                    </div>
                    <ScoreBadge score={sig.aiScore} />
                  </div>

                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
                    <TrendPill tf="4H" trend={sig.mtfTrend.tf4h} />
                    <TrendPill tf="1H" trend={sig.mtfTrend.tf1h} />
                    <TrendPill tf="15M" trend={sig.mtfTrend.tf15m} />
                    <TrendPill tf="5M" trend={sig.mtfTrend.tf5m} />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 6, background: b.bg, color: b.color, border: `1px solid ${b.border}` }}>
                      {b.label}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 800, color: '#00d4ff' }}>
                      ${sig.price < 1 ? sig.price.toFixed(4) : sig.price.toFixed(2)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Filter Bar ── */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: '#3a5070', marginRight: 4 }}>FILTER BY:</span>
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
              padding: '6px 12px', borderRadius: 8, fontSize: 10, fontWeight: 800,
              border: filter === f.id ? '1px solid #00d4ff' : '1px solid rgba(255,255,255,0.08)',
              background: filter === f.id ? 'rgba(0,212,255,0.15)' : 'rgba(255,255,255,0.03)',
              color: filter === f.id ? '#00d4ff' : '#7090b0',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── Signals & Assets List ── */}
      <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2.5fr 1.5fr 1.5fr 2fr 1.5fr 1.5fr', padding: '12px 16px', background: 'rgba(0,0,0,0.3)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, fontWeight: 800, color: '#3a5070', letterSpacing: '0.06em' }}>
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
              <div
                key={sig.assetId}
                onClick={() => setSelectedSignal(sig)}
                style={{
                  display: 'grid', gridTemplateColumns: '2.5fr 1.5fr 1.5fr 2fr 1.5fr 1.5fr',
                  padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                  alignItems: 'center', cursor: 'pointer', transition: 'background 0.2s',
                }}
                className="hover-row"
              >
                {/* Asset */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 900, color: '#ffffff' }}>{sig.symbol}</span>
                    <span style={{ fontSize: 9, color: CATEGORY_COLORS[sig.category] || '#8099bb', fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: `${CATEGORY_COLORS[sig.category] || '#8099bb'}18` }}>
                      {sig.category}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#4a6080', marginTop: 1 }}>{sig.name}</div>
                </div>

                {/* Price */}
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#ffffff', fontVariantNumeric: 'tabular-nums' }}>
                    ${sig.price < 1 ? sig.price.toFixed(4) : sig.price.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: isPos24h ? '#00ff88' : '#ff4466' }}>
                    {isPos24h ? '+' : ''}{sig.priceChange24h.toFixed(1)}% 24h
                  </div>
                </div>

                {/* Score */}
                <div>
                  <ScoreBadge score={sig.aiScore} />
                </div>

                {/* MTF Trends */}
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  <TrendPill tf="4H" trend={sig.mtfTrend.tf4h} />
                  <TrendPill tf="1H" trend={sig.mtfTrend.tf1h} />
                  <TrendPill tf="15M" trend={sig.mtfTrend.tf15m} />
                  <TrendPill tf="5M" trend={sig.mtfTrend.tf5m} />
                </div>

                {/* Signal State */}
                <div>
                  <span style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 6, background: b.bg, color: b.color, border: `1px solid ${b.border}` }}>
                    {b.label}
                  </span>
                </div>

                {/* Missing Condition / Thesis */}
                <div>
                  {sig.missingCondition ? (
                    <span style={{ fontSize: 10, color: '#ffd700', fontStyle: 'italic' }}>
                      ⚠️ {sig.missingCondition}
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, color: '#00ff88', fontWeight: 700 }}>
                      ✅ R:R {sig.tradeThesis.riskRewardRatio.toFixed(1)} Setup
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ── Coin Detail Modal ── */}
      {selectedSignal && (
        <div
          onClick={() => setSelectedSignal(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 20, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(8px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0c1220', border: '1px solid rgba(0,212,255,0.3)', borderRadius: 20,
              padding: 24, width: '100%', maxWidth: 500, boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20, fontWeight: 900, color: '#ffffff' }}>{selectedSignal.symbol}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 6, background: 'rgba(0,212,255,0.15)', color: '#00d4ff' }}>
                    {selectedSignal.category}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#7090b0', marginTop: 2 }}>{selectedSignal.name}</div>
              </div>
              <ScoreBadge score={selectedSignal.aiScore} />
            </div>

            {/* Score Breakdown */}
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 8 }}>
                AI MODEL SUB-SCORES BREAKDOWN
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, textAlign: 'center' }}>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#00d4ff' }}>{selectedSignal.scoreBreakdown.trend}/20</div><div style={{ fontSize: 8, color: '#4a6080' }}>Trend</div></div>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#00ff88' }}>{selectedSignal.scoreBreakdown.momentum}/20</div><div style={{ fontSize: 8, color: '#4a6080' }}>Momentum</div></div>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#ffd700' }}>{selectedSignal.scoreBreakdown.volume}/20</div><div style={{ fontSize: 8, color: '#4a6080' }}>Volume</div></div>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#a855f7' }}>{selectedSignal.scoreBreakdown.structure}/20</div><div style={{ fontSize: 8, color: '#4a6080' }}>Structure</div></div>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#ff8844' }}>{selectedSignal.scoreBreakdown.volatility}/10</div><div style={{ fontSize: 8, color: '#4a6080' }}>Volatility</div></div>
                <div><div style={{ fontSize: 12, fontWeight: 900, color: '#38bdf8' }}>{selectedSignal.scoreBreakdown.htfAlignment}/10</div><div style={{ fontSize: 8, color: '#4a6080' }}>HTF Align</div></div>
              </div>
            </div>

            {/* Trade Thesis */}
            <div style={{ background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.15)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#00ff88', letterSpacing: '0.08em', marginBottom: 6 }}>
                TRADE THESIS ({selectedSignal.tradeThesis.side})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 11, marginBottom: 8 }}>
                <div><span style={{ color: '#4a6080' }}>Entry: </span><b style={{ color: '#ffffff' }}>${selectedSignal.tradeThesis.entryPrice < 1 ? selectedSignal.tradeThesis.entryPrice.toFixed(4) : selectedSignal.tradeThesis.entryPrice.toFixed(2)}</b></div>
                <div><span style={{ color: '#4a6080' }}>Stop Loss: </span><b style={{ color: '#ff4466' }}>${selectedSignal.tradeThesis.stopLoss < 1 ? selectedSignal.tradeThesis.stopLoss.toFixed(4) : selectedSignal.tradeThesis.stopLoss.toFixed(2)}</b></div>
                <div><span style={{ color: '#4a6080' }}>Take Profit: </span><b style={{ color: '#00ff88' }}>${selectedSignal.tradeThesis.takeProfit < 1 ? selectedSignal.tradeThesis.takeProfit.toFixed(4) : selectedSignal.tradeThesis.takeProfit.toFixed(2)}</b></div>
              </div>
              <div style={{ fontSize: 11, color: '#7090b0', lineHeight: 1.5 }}>
                • <b>Risk/Reward</b>: {selectedSignal.tradeThesis.riskRewardRatio.toFixed(2)}:1 (Risk {selectedSignal.tradeThesis.riskDistancePct.toFixed(1)}% / Target +{selectedSignal.tradeThesis.rewardDistancePct.toFixed(1)}%)<br/>
                {selectedSignal.tradeThesis.explanation.map((exp, idx) => (
                  <span key={idx}>• {exp}<br/></span>
                ))}
              </div>
            </div>

            <button
              onClick={() => setSelectedSignal(null)}
              style={{
                width: '100%', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)', color: '#7090b0', cursor: 'pointer', fontWeight: 700,
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
