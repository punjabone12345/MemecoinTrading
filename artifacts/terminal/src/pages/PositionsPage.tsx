import { useState } from 'react';
import { AltcoinStatusResponse, PaperPosition, ClosedPaperPosition } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  status?: AltcoinStatusResponse | null;
  onRefresh: () => Promise<void>;
}

export default function PositionsPage({ status, onRefresh }: Props) {
  const [closingId, setClosingId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const portfolio = status?.portfolio;
  const openPositions = status?.openPositions ?? [];
  const closedPositions = status?.closedPositions ?? [];

  async function handleClose(id: string) {
    setClosingId(id);
    try {
      await api.closeAltcoinPosition(id, 'Manual user exit');
      await onRefresh();
    } catch {
      // ignore
    } finally {
      setClosingId(null);
    }
  }

  async function handleReset() {
    if (!confirm('Reset Paper Portfolio back to $100.00 USD and close all positions?')) return;
    setResetting(true);
    try {
      await api.resetAltcoinPortfolio(100);
      await onRefresh();
    } catch {
      // ignore
    } finally {
      setResetting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto' }}>
      
      {/* ── Page Header with Reset Balance Action ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 900, color: '#00d4ff', letterSpacing: '0.04em' }}>
          📈 TRADES & PAPER EXECUTION (1% RISK)
        </div>
        <button
          onClick={handleReset}
          disabled={resetting}
          style={{
            padding: '6px 12px',
            borderRadius: 7,
            background: 'rgba(255,68,102,0.1)',
            border: '1px solid rgba(255,68,102,0.3)',
            color: '#ff4466',
            fontSize: 10.5,
            fontWeight: 800,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {resetting ? 'Resetting...' : '🔄 RESET BALANCE & POSITIONS'}
        </button>
      </div>
      
      {/* ── Summary Stats Grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,255,0.2)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: '#00d4ff', fontVariantNumeric: 'tabular-nums' }}>
            ${portfolio?.currentEquityUsd.toFixed(2) ?? '100.00'}
          </div>
          <div style={{ fontSize: 9, color: '#4a6080', marginTop: 3, fontWeight: 800, textTransform: 'uppercase' }}>
            Equity (USD)
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: (portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
            {(portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? '+' : ''}${portfolio?.unrealizedPnlUsd.toFixed(2) ?? '0.00'}
          </div>
          <div style={{ fontSize: 9, color: '#4a6080', marginTop: 3, fontWeight: 800, textTransform: 'uppercase' }}>
            Unrealized P&L
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: (portfolio?.realizedPnlUsd ?? 0) >= 0 ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
            {(portfolio?.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}${portfolio?.realizedPnlUsd.toFixed(2) ?? '0.00'}
          </div>
          <div style={{ fontSize: 9, color: '#4a6080', marginTop: 3, fontWeight: 800, textTransform: 'uppercase' }}>
            Realized P&L
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '12px 14px' }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: '#ffd700', fontVariantNumeric: 'tabular-nums' }}>
            {portfolio?.winRatePct.toFixed(1) ?? '0.0'}%
          </div>
          <div style={{ fontSize: 9, color: '#4a6080', marginTop: 3, fontWeight: 800, textTransform: 'uppercase' }}>
            Win Rate ({portfolio?.totalTrades ?? 0} Trades)
          </div>
        </div>
      </div>

      {/* ── Open Positions Section ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span>📄 OPEN PAPER POSITIONS ({openPositions.length})</span>
          {openPositions.length > 0 && (
            <span style={{ fontSize: 8.5, color: '#00ff88', fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,255,136,0.1)' }}>
              LIVE MONITORING
            </span>
          )}
        </div>

        {openPositions.length === 0 ? (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '30px 16px', textAlign: 'center', color: '#4a6080', fontSize: 11.5 }}>
            No open paper positions right now. Scanning altcoins for <b>ENTRY_READY</b> signals (AI Score &ge; 75).
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {openPositions.map((pos: PaperPosition) => {
              const isPosPnl = pos.unrealizedPnlUsd >= 0;
              return (
                <div
                  key={pos.id}
                  style={{
                    background: 'rgba(255,255,255,0.03)',
                    border: `1.5px solid ${isPosPnl ? 'rgba(0,255,136,0.3)' : 'rgba(255,68,102,0.3)'}`,
                    borderRadius: 12, padding: '14px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 15, fontWeight: 900, color: '#ffffff' }}>{pos.symbol}</span>
                        <span style={{ fontSize: 8.5, fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: pos.side === 'LONG' ? 'rgba(0,255,136,0.18)' : 'rgba(255,68,102,0.18)', color: pos.side === 'LONG' ? '#00ff88' : '#ff4466' }}>
                          {pos.side}
                        </span>
                        <span style={{ fontSize: 8.5, fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(155,89,255,0.15)', color: '#9b59ff' }}>
                          AI {pos.aiScoreAtEntry}/100
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#7090b0', marginTop: 2 }}>
                        {pos.name} · {pos.setupType}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: isPosPnl ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
                        {isPosPnl ? '+' : ''}${pos.unrealizedPnlUsd.toFixed(2)} ({isPosPnl ? '+' : ''}{pos.unrealizedPnlPct.toFixed(2)}%)
                      </div>
                      <div style={{ fontSize: 9.5, color: '#7090b0', fontWeight: 800 }}>
                        {pos.rMultiple.toFixed(2)}R Multiple
                      </div>
                    </div>
                  </div>

                  {/* Metrics grid (Responsive for Android 2x2 or Desktop 4-col) */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))', gap: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.25)', marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 8, color: '#4a6080' }}>ENTRY</div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#ffffff' }}>${pos.entryPrice < 1 ? pos.entryPrice.toFixed(4) : pos.entryPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#4a6080' }}>CURRENT</div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: isPosPnl ? '#00ff88' : '#ff4466' }}>${pos.currentPrice < 1 ? pos.currentPrice.toFixed(4) : pos.currentPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#4a6080' }}>STOP LOSS</div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#ff4466' }}>${pos.stopLoss < 1 ? pos.stopLoss.toFixed(4) : pos.stopLoss.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 8, color: '#4a6080' }}>TAKE PROFIT</div>
                      <div style={{ fontSize: 11, fontWeight: 800, color: '#00ff88' }}>${pos.takeProfit < 1 ? pos.takeProfit.toFixed(4) : pos.takeProfit.toFixed(2)}</div>
                    </div>
                  </div>

                  {/* Risk info & Actions */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ fontSize: 9.5, color: '#7090b0' }}>
                      Size: <b style={{ color: '#ffffff' }}>${pos.positionSizeUsd.toFixed(2)}</b> (Risk: <b style={{ color: '#ff8844' }}>${pos.riskAmountUsd.toFixed(2)}</b> / {pos.riskPct}%)
                    </div>
                    <button
                      onClick={() => handleClose(pos.id)}
                      disabled={closingId === pos.id}
                      style={{
                        padding: '6px 12px', borderRadius: 7, background: 'rgba(255,68,102,0.18)',
                        border: '1px solid rgba(255,68,102,0.4)', color: '#ff4466',
                        fontSize: 10, fontWeight: 800, cursor: 'pointer', minHeight: 32, touchAction: 'manipulation',
                      }}
                    >
                      {closingId === pos.id ? 'CLOSING...' : 'CLOSE'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Closed Positions Section ── */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>
          📜 CLOSED PAPER POSITIONS ({closedPositions.length})
        </div>

        {closedPositions.length === 0 ? (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '20px 16px', textAlign: 'center', color: '#4a6080', fontSize: 11 }}>
            No closed trades yet.
          </div>
        ) : (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, overflow: 'hidden' }}>
            
            {/* Desktop Table Header */}
            <div className="desktop-table-header" style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1.2fr 1.5fr 1.2fr 1.6fr', padding: '10px 14px', background: 'rgba(0,0,0,0.3)', fontSize: 9, fontWeight: 800, color: '#3a5070', letterSpacing: '0.06em' }}>
              <div>ASSET</div>
              <div>ENTRY</div>
              <div>EXIT</div>
              <div>REALIZED P&L</div>
              <div>R MULTIPLE</div>
              <div>CLOSE REASON</div>
            </div>

            {closedPositions.map((pos: ClosedPaperPosition) => {
              const isWin = pos.realizedPnlUsd >= 0;
              return (
                <div key={pos.id}>
                  {/* Desktop Row */}
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: '1.8fr 1.2fr 1.2fr 1.5fr 1.2fr 1.6fr',
                      padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                      alignItems: 'center', fontSize: 11,
                    }}
                    className="desktop-table-row hover-row"
                  >
                    <div>
                      <span style={{ fontWeight: 800, color: '#ffffff' }}>{pos.symbol}</span>
                      <span style={{ fontSize: 9, color: '#4a6080', marginLeft: 6 }}>{pos.side}</span>
                    </div>
                    <div style={{ color: '#7090b0' }}>${pos.entryPrice < 1 ? pos.entryPrice.toFixed(4) : pos.entryPrice.toFixed(2)}</div>
                    <div style={{ color: '#7090b0' }}>${pos.closePrice < 1 ? pos.closePrice.toFixed(4) : pos.closePrice.toFixed(2)}</div>
                    <div style={{ fontWeight: 800, color: isWin ? '#00ff88' : '#ff4466' }}>
                      {isWin ? '+' : ''}${pos.realizedPnlUsd.toFixed(2)} ({isWin ? '+' : ''}{pos.realizedPnlPct.toFixed(2)}%)
                    </div>
                    <div style={{ fontWeight: 800, color: isWin ? '#00ff88' : '#ff4466' }}>
                      {pos.finalR.toFixed(2)}R
                    </div>
                    <div>
                      <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: isWin ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.1)', color: isWin ? '#00ff88' : '#ff4466' }}>
                        {pos.closeReason}
                      </span>
                    </div>
                  </div>

                  {/* Mobile Row */}
                  <div
                    className="mobile-card-row hover-card"
                    style={{
                      display: 'none',
                      flexDirection: 'column',
                      gap: 6,
                      padding: '10px 12px',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      background: 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 900, color: '#ffffff', fontSize: 13 }}>{pos.symbol}</span>
                        <span style={{ fontSize: 8.5, color: '#4a6080' }}>{pos.side}</span>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 13, color: isWin ? '#00ff88' : '#ff4466' }}>
                        {isWin ? '+' : ''}${pos.realizedPnlUsd.toFixed(2)} ({isWin ? '+' : ''}{pos.realizedPnlPct.toFixed(1)}%)
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: '#7090b0' }}>
                      <span>${pos.entryPrice < 1 ? pos.entryPrice.toFixed(4) : pos.entryPrice.toFixed(2)} → ${pos.closePrice < 1 ? pos.closePrice.toFixed(4) : pos.closePrice.toFixed(2)}</span>
                      <span style={{ fontWeight: 800, color: isWin ? '#00ff88' : '#ff4466' }}>{pos.finalR.toFixed(2)}R</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: isWin ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.1)', color: isWin ? '#00ff88' : '#ff4466' }}>
                        {pos.closeReason}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
