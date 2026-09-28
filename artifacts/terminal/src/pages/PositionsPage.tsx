import { useState } from 'react';
import { AltcoinStatusResponse, PaperPosition, ClosedPaperPosition } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  status?: AltcoinStatusResponse | null;
  onRefresh: () => Promise<void>;
}

function EditTradeModal({
  trade,
  isClosed,
  onClose,
  onSave,
  onDelete
}: {
  trade: PaperPosition | ClosedPaperPosition;
  isClosed: boolean;
  onClose: () => void;
  onSave: (updates: any) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [side, setSide] = useState<'LONG' | 'SHORT'>(trade.side);
  const [entryPrice, setEntryPrice] = useState(trade.entryPrice);
  const [closePrice, setClosePrice] = useState((trade as ClosedPaperPosition).closePrice ?? trade.currentPrice);
  const [stopLoss, setStopLoss] = useState(trade.stopLoss);
  const [takeProfit, setTakeProfit] = useState(trade.takeProfit);
  const [positionSizeUsd, setPositionSizeUsd] = useState(trade.positionSizeUsd);
  const [quantity, setQuantity] = useState(trade.quantity);
  const [aiScoreAtEntry, setAiScoreAtEntry] = useState(trade.aiScoreAtEntry);
  const [setupType, setSetupType] = useState(trade.setupType);
  const [closeReason, setCloseReason] = useState((trade as ClosedPaperPosition).closeReason ?? 'MANUAL_EXIT');
  const [thesisText, setThesisText] = useState(trade.tradeThesis?.join('\n') || '');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const updates: any = {
        side,
        entryPrice: Number(entryPrice),
        currentPrice: Number(closePrice),
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        positionSizeUsd: Number(positionSizeUsd),
        quantity: Number(quantity),
        aiScoreAtEntry: Number(aiScoreAtEntry),
        setupType,
        tradeThesis: thesisText.split('\n').filter(Boolean),
      };
      if (isClosed) {
        updates.closePrice = Number(closePrice);
        updates.closeReason = closeReason;
      }
      await onSave(updates);
      onClose();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.8)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14,
      backdropFilter: 'blur(8px)',
    }}>
      <div style={{
        background: '#0d1527', border: '1px solid rgba(0,212,255,0.3)', borderRadius: 14,
        width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto', padding: 20,
        boxShadow: '0 10px 40px rgba(0,0,0,0.8)', display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: '#00d4ff' }}>
              ✏️ EDIT TRADE — ${trade.symbol} ({trade.name})
            </div>
            <div style={{ fontSize: 10, color: '#7090b0', marginTop: 2 }}>
              ID: {trade.id} · Status: <b style={{ color: isClosed ? '#9b59ff' : '#00ff88' }}>{isClosed ? 'CLOSED' : 'OPEN'}</b>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#7090b0', fontSize: 18, cursor: 'pointer', padding: 4 }}
          >
            ✕
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>SIDE</label>
            <select
              value={side}
              onChange={(e) => setSide(e.target.value as any)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            >
              <option value="LONG">🟢 LONG</option>
              <option value="SHORT">🔴 SHORT</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>SETUP TYPE</label>
            <select
              value={setupType}
              onChange={(e) => setSetupType(e.target.value as any)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            >
              <option value="PULLBACK">PULLBACK</option>
              <option value="BREAKOUT">BREAKOUT</option>
              <option value="REVERSAL">REVERSAL</option>
              <option value="TREND_CONTINUATION">TREND_CONTINUATION</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>ENTRY PRICE ($)</label>
            <input
              type="number"
              step="any"
              value={entryPrice}
              onChange={(e) => {
                const val = parseFloat(e.target.value) || 0;
                setEntryPrice(val);
                if (val > 0) setQuantity(parseFloat((positionSizeUsd / val).toFixed(val < 1 ? 2 : 4)));
              }}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>{isClosed ? 'EXIT PRICE ($)' : 'CURRENT PRICE ($)'}</label>
            <input
              type="number"
              step="any"
              value={closePrice}
              onChange={(e) => setClosePrice(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>STOP LOSS ($)</label>
            <input
              type="number"
              step="any"
              value={stopLoss}
              onChange={(e) => setStopLoss(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>TAKE PROFIT ($)</label>
            <input
              type="number"
              step="any"
              value={takeProfit}
              onChange={(e) => setTakeProfit(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>POSITION SIZE (USD)</label>
            <input
              type="number"
              step="any"
              value={positionSizeUsd}
              onChange={(e) => {
                const val = parseFloat(e.target.value) || 0;
                setPositionSizeUsd(val);
                if (entryPrice > 0) setQuantity(parseFloat((val / entryPrice).toFixed(entryPrice < 1 ? 2 : 4)));
              }}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>QUANTITY</label>
            <input
              type="number"
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(parseFloat(e.target.value) || 0)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>AI SCORE AT ENTRY (0-100)</label>
            <input
              type="number"
              value={aiScoreAtEntry}
              onChange={(e) => setAiScoreAtEntry(parseInt(e.target.value, 10) || 0)}
              style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
            />
          </div>

          {isClosed && (
            <div>
              <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>CLOSE REASON</label>
              <input
                type="text"
                value={closeReason}
                onChange={(e) => setCloseReason(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 12, marginTop: 4 }}
              />
            </div>
          )}
        </div>

        <div>
          <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>REASON / THESIS</label>
          <textarea
            rows={3}
            value={thesisText}
            onChange={(e) => setThesisText(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, flexWrap: 'wrap', gap: 8 }}>
          {onDelete && (
            <button
              onClick={async () => {
                if (!confirm(`Are you sure you want to delete this ${isClosed ? 'closed' : 'open'} trade ($${trade.symbol})? This will permanently remove it and restore your account balance & P&L.`)) return;
                await onDelete(trade.id);
                onClose();
              }}
              style={{ padding: '8px 14px', borderRadius: 6, background: 'rgba(255,68,102,0.15)', border: '1px solid rgba(255,68,102,0.4)', color: '#ff4466', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
            >
              🗑️ Delete Trade
            </button>
          )}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
            <button
              onClick={onClose}
              style={{ padding: '8px 14px', borderRadius: 6, background: 'rgba(255,255,255,0.08)', border: 'none', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{ padding: '8px 16px', borderRadius: 6, background: 'linear-gradient(135deg, #00d4ff, #9b59ff)', border: 'none', color: '#080d1a', fontSize: 11, fontWeight: 900, cursor: 'pointer' }}
            >
              {saving ? 'Saving...' : '💾 Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PositionsPage({ status, onRefresh }: Props) {
  const [closingId, setClosingId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [editingTrade, setEditingTrade] = useState<{ trade: PaperPosition | ClosedPaperPosition; isClosed: boolean } | null>(null);

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

  async function handleDeletePosition(id: string, symbol: string, isClosed: boolean) {
    if (!confirm(`Are you sure you want to delete this ${isClosed ? 'closed' : 'open'} position ($${symbol})? Its margin and P&L impact will be restored to your account.`)) return;
    try {
      await api.deletePaperPosition(id);
      await onRefresh();
    } catch (err: any) {
      alert(`Failed to delete position: ${err?.message || 'Unknown error'}`);
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
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setEditingTrade({ trade: pos, isClosed: false })}
                        style={{
                          padding: '6px 12px', borderRadius: 7, background: 'rgba(0,212,255,0.15)',
                          border: '1px solid rgba(0,212,255,0.3)', color: '#00d4ff',
                          fontSize: 10, fontWeight: 800, cursor: 'pointer', minHeight: 32, touchAction: 'manipulation',
                        }}
                      >
                        ✏️ EDIT
                      </button>
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
                      <button
                        onClick={() => handleDeletePosition(pos.id, pos.symbol, false)}
                        style={{
                          padding: '6px 10px', borderRadius: 7, background: 'rgba(255,68,102,0.12)',
                          border: '1px solid rgba(255,68,102,0.3)', color: '#ff4466',
                          fontSize: 10, fontWeight: 800, cursor: 'pointer', minHeight: 32, touchAction: 'manipulation',
                        }}
                        title="Delete position & restore margin"
                      >
                        🗑️
                      </button>
                    </div>
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
            <div className="desktop-table-header" style={{ display: 'grid', gridTemplateColumns: '1.8fr 1.1fr 1.1fr 1.4fr 1.1fr 1.4fr 0.8fr', padding: '10px 14px', background: 'rgba(0,0,0,0.3)', fontSize: 9, fontWeight: 800, color: '#3a5070', letterSpacing: '0.06em' }}>
              <div>ASSET</div>
              <div>ENTRY</div>
              <div>EXIT</div>
              <div>REALIZED P&L</div>
              <div>R MULTIPLE</div>
              <div>CLOSE REASON</div>
              <div>ACTION</div>
            </div>

            {closedPositions.map((pos: ClosedPaperPosition) => {
              const isWin = pos.realizedPnlUsd >= 0;
              return (
                <div key={pos.id}>
                  {/* Desktop Row */}
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: '1.8fr 1.1fr 1.1fr 1.4fr 1.1fr 1.4fr 0.8fr',
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
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => setEditingTrade({ trade: pos, isClosed: true })}
                        style={{
                          padding: '3px 8px', borderRadius: 5, background: 'rgba(0,212,255,0.12)',
                          border: '1px solid rgba(0,212,255,0.3)', color: '#00d4ff',
                          fontSize: 9.5, fontWeight: 800, cursor: 'pointer'
                        }}
                      >
                        ✏️ Edit
                      </button>
                      <button
                        onClick={() => handleDeletePosition(pos.id, pos.symbol, true)}
                        style={{
                          padding: '3px 6px', borderRadius: 5, background: 'rgba(255,68,102,0.12)',
                          border: '1px solid rgba(255,68,102,0.3)', color: '#ff4466',
                          fontSize: 9.5, fontWeight: 800, cursor: 'pointer'
                        }}
                        title="Delete trade & restore balance"
                      >
                        🗑️
                      </button>
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: isWin ? 'rgba(0,255,136,0.1)' : 'rgba(255,68,102,0.1)', color: isWin ? '#00ff88' : '#ff4466' }}>
                        {pos.closeReason}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={() => setEditingTrade({ trade: pos, isClosed: true })}
                          style={{
                            padding: '3px 8px', borderRadius: 5, background: 'rgba(0,212,255,0.12)',
                            border: '1px solid rgba(0,212,255,0.3)', color: '#00d4ff',
                            fontSize: 9.5, fontWeight: 800, cursor: 'pointer'
                          }}
                        >
                          ✏️ Edit
                        </button>
                        <button
                          onClick={() => handleDeletePosition(pos.id, pos.symbol, true)}
                          style={{
                            padding: '3px 6px', borderRadius: 5, background: 'rgba(255,68,102,0.12)',
                            border: '1px solid rgba(255,68,102,0.3)', color: '#ff4466',
                            fontSize: 9.5, fontWeight: 800, cursor: 'pointer'
                          }}
                          title="Delete trade & restore balance"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Modal Popup */}
      {editingTrade && (
        <EditTradeModal
          trade={editingTrade.trade}
          isClosed={editingTrade.isClosed}
          onClose={() => setEditingTrade(null)}
          onSave={async (updates) => {
            await api.editPaperPosition(editingTrade.trade.id, updates);
            await onRefresh();
          }}
          onDelete={async (id) => handleDeletePosition(id, editingTrade.trade.symbol, editingTrade.isClosed)}
        />
      )}
    </div>
  );
}
