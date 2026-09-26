import { useState } from 'react';
import { AltcoinStatusResponse, PaperPosition, ClosedPaperPosition } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  status?: AltcoinStatusResponse | null;
  onRefresh: () => Promise<void>;
}

export default function PositionsPage({ status, onRefresh }: Props) {
  const [closingId, setClosingId] = useState<string | null>(null);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto' }}>
      
      {/* ── Summary Stats Grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(0,212,255,0.2)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#00d4ff', fontVariantNumeric: 'tabular-nums' }}>
            ${portfolio?.currentEquityUsd.toFixed(2) ?? '100.00'}
          </div>
          <div style={{ fontSize: 10, color: '#4a6080', marginTop: 4, fontWeight: 800, textTransform: 'uppercase' }}>
            Current Equity (USD)
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: (portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
            {(portfolio?.unrealizedPnlUsd ?? 0) >= 0 ? '+' : ''}${portfolio?.unrealizedPnlUsd.toFixed(2) ?? '0.00'}
          </div>
          <div style={{ fontSize: 10, color: '#4a6080', marginTop: 4, fontWeight: 800, textTransform: 'uppercase' }}>
            Unrealized P&L
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: (portfolio?.realizedPnlUsd ?? 0) >= 0 ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
            {(portfolio?.realizedPnlUsd ?? 0) >= 0 ? '+' : ''}${portfolio?.realizedPnlUsd.toFixed(2) ?? '0.00'}
          </div>
          <div style={{ fontSize: 10, color: '#4a6080', marginTop: 4, fontWeight: 800, textTransform: 'uppercase' }}>
            Realized P&L
          </div>
        </div>

        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px' }}>
          <div style={{ fontSize: 18, fontWeight: 900, color: '#ffd700', fontVariantNumeric: 'tabular-nums' }}>
            {portfolio?.winRatePct.toFixed(1) ?? '0.0'}%
          </div>
          <div style={{ fontSize: 10, color: '#4a6080', marginTop: 4, fontWeight: 800, textTransform: 'uppercase' }}>
            Win Rate ({portfolio?.totalTrades ?? 0} Trades)
          </div>
        </div>
      </div>

      {/* ── Open Positions Section ── */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>📄 OPEN PAPER POSITIONS ({openPositions.length})</span>
          {openPositions.length > 0 && (
            <span style={{ fontSize: 9, color: '#00ff88', fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,255,136,0.1)' }}>
              LIVE PRICE MONITORING
            </span>
          )}
        </div>

        {openPositions.length === 0 ? (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '36px 20px', textAlign: 'center', color: '#4a6080', fontSize: 12 }}>
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
                    borderRadius: 14, padding: '16px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 16, fontWeight: 900, color: '#ffffff' }}>{pos.symbol}</span>
                        <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: pos.side === 'LONG' ? 'rgba(0,255,136,0.18)' : 'rgba(255,68,102,0.18)', color: pos.side === 'LONG' ? '#00ff88' : '#ff4466' }}>
                          {pos.side}
                        </span>
                        <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(155,89,255,0.15)', color: '#9b59ff' }}>
                          AI {pos.aiScoreAtEntry}/100
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: '#7090b0', marginTop: 2 }}>
                        {pos.name} · {pos.setupType}
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 16, fontWeight: 900, color: isPosPnl ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
                        {isPosPnl ? '+' : ''}${pos.unrealizedPnlUsd.toFixed(2)} ({isPosPnl ? '+' : ''}{pos.unrealizedPnlPct.toFixed(2)}%)
                      </div>
                      <div style={{ fontSize: 10, color: '#7090b0', fontWeight: 800 }}>
                        {pos.rMultiple.toFixed(2)}R Multiple
                      </div>
                    </div>
                  </div>

                  {/* Metrics grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '10px 12px', borderRadius: 8, background: 'rgba(0,0,0,0.25)', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 9, color: '#4a6080' }}>ENTRY PRICE</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: '#ffffff' }}>${pos.entryPrice < 1 ? pos.entryPrice.toFixed(4) : pos.entryPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: '#4a6080' }}>CURRENT PRICE</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: isPosPnl ? '#00ff88' : '#ff4466' }}>${pos.currentPrice < 1 ? pos.currentPrice.toFixed(4) : pos.currentPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: '#4a6080' }}>STOP LOSS</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: '#ff4466' }}>${pos.stopLoss < 1 ? pos.stopLoss.toFixed(4) : pos.stopLoss.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: '#4a6080' }}>TAKE PROFIT</div>
                      <div style={{ fontSize: 12, fontWeight: 800, color: '#00ff88' }}>${pos.takeProfit < 1 ? pos.takeProfit.toFixed(4) : pos.takeProfit.toFixed(2)}</div>
                    </div>
                  </div>

                  {/* Risk info & Actions */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 10, color: '#7090b0' }}>
                      Position Size: <b style={{ color: '#ffffff' }}>${pos.positionSizeUsd.toFixed(2)}</b> (Risk: <b style={{ color: '#ff8844' }}>${pos.riskAmountUsd.toFixed(2)}</b> / {pos.riskPct}%)
                    </div>
                    <button
                      onClick={() => handleClose(pos.id)}
                      disabled={closingId === pos.id}
                      style={{
                        padding: '8px 16px', borderRadius: 8, background: 'rgba(255,68,102,0.18)',
                        border: '1px solid rgba(255,68,102,0.4)', color: '#ff4466',
                        fontSize: 11, fontWeight: 800, cursor: 'pointer',
                      }}
                    >
                      {closingId === pos.id ? 'CLOSING...' : 'CLOSE POSITION'}
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
        <div style={{ fontSize: 12, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>
          📜 CLOSED PAPER POSITIONS ({closedPositions.length})
        </div>

        {closedPositions.length === 0 ? (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, padding: '24px 20px', textAlign: 'center', color: '#4a6080', fontSize: 11 }}>
            No closed trades yet.
          </div>
        ) : (
          <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.5fr 1.2fr 1.5fr', padding: '10px 14px', background: 'rgba(0,0,0,0.3)', fontSize: 9, fontWeight: 800, color: '#3a5070', letterSpacing: '0.06em' }}>
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
                <div
                  key={pos.id}
                  style={{
                    display: 'grid', gridTemplateColumns: '2fr 1.2fr 1.2fr 1.5fr 1.2fr 1.5fr',
                    padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)',
                    alignItems: 'center', fontSize: 11,
                  }}
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
