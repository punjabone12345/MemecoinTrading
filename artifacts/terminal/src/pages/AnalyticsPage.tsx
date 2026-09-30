import { useState } from 'react';
import { AltcoinStatusResponse, ClosedPaperPosition, PaperPosition } from '../lib/types.js';
import { api } from '../lib/api.js';

interface Props {
  balance: number;
  freeBalance: number;
  onRefresh: () => Promise<void>;
  status?: AltcoinStatusResponse | null;
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 18, fontWeight: 900, color: color ?? '#d4e0f0', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 10, color: '#4a6080', marginTop: 4, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: '#4a6080', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function EquityChart({ positions }: { positions: ClosedPaperPosition[] }) {
  if (positions.length < 1) return null;
  const sorted = [...positions].sort((a, b) => a.closeTime - b.closeTime);
  let running = 0;
  const pts = sorted.map((p, i) => {
    running += p.realizedPnlUsd;
    return { x: i, y: running };
  });
  const allPts = pts.length === 1 ? [{ x: -1, y: 0 }, ...pts] : pts;
  const maxY = Math.max(...allPts.map((p) => p.y), 0);
  const minY = Math.min(...allPts.map((p) => p.y), 0);
  const range = maxY - minY || 1;
  const W = 600, H = 90, pad = 8;
  const mxAll = (_: number, idx: number) => pad + (idx / Math.max(allPts.length - 1, 1)) * (W - pad * 2);
  const my = (y: number) => H - pad - ((y - minY) / range) * (H - pad * 2);
  const path = allPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${mxAll(p.x, i)} ${my(p.y)}`).join(' ');
  const area = `${path} L${mxAll(allPts[allPts.length - 1].x, allPts.length - 1)} ${H} L${mxAll(allPts[0].x, 0)} ${H} Z`;
  const last = allPts[allPts.length - 1].y;
  const col = last >= 0 ? '#00ff88' : '#ff4466';

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '16px', marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#9b59ff', letterSpacing: '0.08em', marginBottom: 12, textTransform: 'uppercase' }}>
        📈 CUMULATIVE REALIZED EQUITY CURVE (USD)
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80, display: 'block' }}>
        <defs>
          <linearGradient id="pnlg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.25" />
            <stop offset="100%" stopColor={col} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#pnlg)" />
        <path d={path} fill="none" stroke={col} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <line x1={pad} y1={my(0)} x2={W - pad} y2={my(0)} stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4,4" />
      </svg>
    </div>
  );
}

function formatDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function formatDuration(start: number, end?: number): string {
  if (!start) return '—';
  const finish = end || Date.now();
  const diffSec = Math.max(0, Math.floor((finish - start) / 1000));
  const mins = Math.floor(diffSec / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${mins}m ${diffSec % 60}s`;
}

interface EditModalProps {
  trade: PaperPosition | ClosedPaperPosition;
  isClosed: boolean;
  onClose: () => void;
  onSave: (updates: any) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

function EditTradeModal({ trade, isClosed, onClose, onSave, onDelete }: EditModalProps) {
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
        {/* Header */}
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

        {/* Inputs Grid */}
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

        {/* Reason / Trade Thesis */}
        <div>
          <label style={{ fontSize: 10, fontWeight: 800, color: '#7090b0' }}>REASON / THESIS (One per line)</label>
          <textarea
            rows={3}
            value={thesisText}
            onChange={(e) => setThesisText(e.target.value)}
            style={{ width: '100%', padding: '8px 10px', background: '#070b14', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: 6, fontSize: 11, marginTop: 4, fontFamily: 'monospace' }}
          />
        </div>

        {/* Modal Actions */}
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

export default function AnalyticsPage({ status, onRefresh }: Props) {
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');
  const [editingTrade, setEditingTrade] = useState<{ trade: PaperPosition | ClosedPaperPosition; isClosed: boolean } | null>(null);

  const portfolio = status?.portfolio;
  const openPositions = status?.openPositions ?? [];
  const closedPositions = status?.closedPositions ?? [];

  const totalTrades = portfolio?.totalTrades ?? 0;
  const winRate = portfolio?.winRatePct ?? 0;
  const profitFactor = portfolio?.profitFactor ?? 0;
  const realizedPnl = portfolio?.realizedPnlUsd ?? 0;
  const unrealizedPnl = portfolio?.unrealizedPnlUsd ?? 0;
  const equity = portfolio?.currentEquityUsd ?? 100;
  const available = portfolio?.availableBalanceUsd ?? 100;
  const drawdown = portfolio?.maxDrawdownPct ?? 0;

  const wins = closedPositions.filter(p => p.realizedPnlUsd > 0).length;
  const losses = closedPositions.filter(p => p.realizedPnlUsd <= 0).length;

  // Unified trades list for history
  const allTrades: { item: PaperPosition | ClosedPaperPosition; isClosed: boolean }[] = [
    ...openPositions.map(p => ({ item: p, isClosed: false })),
    ...closedPositions.map(p => ({ item: p, isClosed: true }))
  ].sort((a, b) => b.item.entryTime - a.item.entryTime);

  const filteredTrades = allTrades.filter(t => {
    if (filter === 'OPEN') return !t.isClosed;
    if (filter === 'CLOSED') return t.isClosed;
    return true;
  });

  async function handleSaveTradeUpdates(updates: any) {
    if (!editingTrade) return;
    await api.editPaperPosition(editingTrade.trade.id, updates);
    await onRefresh();
  }

  async function handleDeleteTrade(id: string, symbol: string, isClosed: boolean) {
    if (!confirm(`Are you sure you want to delete this ${isClosed ? 'closed' : 'open'} trade ($${symbol})? Its margin and P&L impact will be restored to your account.`)) return;
    try {
      await api.deletePaperPosition(id);
      await onRefresh();
    } catch (err: any) {
      alert(`Failed to delete trade: ${err?.message || 'Unknown error'}`);
    }
  }

  function exportTradesToCsv() {
    if (allTrades.length === 0) {
      alert('No trades available to export.');
      return;
    }
    const headers = [
      'Trade ID',
      'Symbol',
      'Side',
      'Status',
      'Setup Type',
      'AI Score',
      'Entry Time (UTC)',
      'Exit Time (UTC)',
      'Duration (Minutes)',
      'Entry Price ($)',
      'Exit/Current Price ($)',
      'Stop Loss ($)',
      'Take Profit ($)',
      'Position Size ($)',
      'Quantity',
      'Risk Amount ($)',
      'Risk Pct (%)',
      'Realized PnL ($)',
      'Realized PnL (%)',
      'R-Multiple',
      'Close Reason',
      'Trade Thesis'
    ];

    const rows = allTrades.map(({ item, isClosed }) => {
      const cp = isClosed ? (item as ClosedPaperPosition) : null;
      const exitPrice = isClosed ? cp!.closePrice : item.currentPrice;
      const exitTime = isClosed && cp!.closeTime ? new Date(cp!.closeTime).toISOString() : '';
      const entryTime = item.entryTime ? new Date(item.entryTime).toISOString() : '';
      const durationMin = isClosed && cp!.closeTime && item.entryTime ? Math.round((cp!.closeTime - item.entryTime) / 60000) : '';
      const realizedPnlUsd = isClosed ? cp!.realizedPnlUsd : '';
      const realizedPnlPct = isClosed ? cp!.realizedPnlPct : '';
      const rMultiple = isClosed ? cp!.finalR : item.rMultiple;
      const closeReason = isClosed ? cp!.closeReason : 'RUNNING';
      const thesis = Array.isArray(item.tradeThesis) ? item.tradeThesis.join(' | ') : (item.tradeThesis || '');

      return [
        `"${item.id}"`,
        `"${item.symbol}"`,
        `"${item.side}"`,
        `"${isClosed ? 'CLOSED' : 'OPEN'}"`,
        `"${item.setupType || 'PULLBACK'}"`,
        item.aiScoreAtEntry ?? '',
        `"${entryTime}"`,
        `"${exitTime}"`,
        durationMin,
        item.entryPrice,
        exitPrice,
        item.stopLoss,
        item.takeProfit,
        item.positionSizeUsd,
        item.quantity,
        item.riskAmountUsd,
        item.riskPct,
        realizedPnlUsd,
        realizedPnlPct,
        rMultiple,
        `"${closeReason}"`,
        `"${thesis.replace(/"/g, '""')}"`
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `trade-history-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function handleResetAccount() {
    if (!confirm('Are you sure you want to reset your portfolio? This will clear all trade history and restore a fresh $100.00 starting balance.')) return;
    try {
      await api.resetAltcoinPortfolio(100);
      await onRefresh();
      alert('Portfolio successfully reset to $100.00 with all trade history cleared.');
    } catch (err: any) {
      alert(`Reset failed: ${err?.message || 'Unknown error'}`);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto' }}>
      
      {/* Top Header Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 900, color: '#00d4ff', letterSpacing: '0.04em' }}>
          📊 PORTFOLIO & PERFORMANCE METRICS
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={exportTradesToCsv}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 800,
              background: 'rgba(0, 212, 255, 0.12)', border: '1px solid rgba(0, 212, 255, 0.35)',
              color: '#00d4ff', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5
            }}
            title="Download full trade history as CSV spreadsheet"
          >
            📥 Export CSV ({allTrades.length})
          </button>
          <button
            onClick={handleResetAccount}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 800,
              background: 'rgba(255, 68, 102, 0.12)', border: '1px solid rgba(255, 68, 102, 0.35)',
              color: '#ff4466', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5
            }}
            title="Reset to clean $100 starting balance and clear history"
          >
            🔄 Reset to $100.00
          </button>
        </div>
      </div>

      {/* Analytics Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <StatCard label="Account Equity" value={`$${equity.toFixed(2)}`} color="#00d4ff" sub="Starting Balance: $100.00" />
        <StatCard label="Available Balance" value={`$${available.toFixed(2)}`} color="#7090b0" />
        <StatCard label="Realized P&L" value={`${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`} color={realizedPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Unrealized P&L" value={`${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`} color={unrealizedPnl >= 0 ? '#00ff88' : '#ff4466'} />
        <StatCard label="Total Trades" value={String(totalTrades)} color="#9b59ff" sub={`Wins: ${wins} | Losses: ${losses}`} />
        <StatCard label="Win Rate" value={`${winRate.toFixed(1)}%`} color={winRate >= 50 ? '#00ff88' : '#ffd700'} />
        <StatCard label="Profit Factor" value={profitFactor >= 99 ? '∞' : profitFactor.toFixed(2)} color={profitFactor >= 1.5 ? '#00ff88' : '#ffd700'} />
        <StatCard label="Max Drawdown" value={`-${drawdown.toFixed(1)}%`} color="#ff4466" />
      </div>

      {/* Equity Chart */}
      <EquityChart positions={closedPositions} />

      {/* ── Comprehensive Trade History Section ── */}
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 900, color: '#00d4ff', letterSpacing: '0.04em' }}>
              📜 DETAILED TRADE HISTORY & AUDIT LOG ({filteredTrades.length})
            </div>
            <div style={{ fontSize: 10, color: '#7090b0', marginTop: 2 }}>
              Full execution record with entry/exit timings, AI scores, setup types, R:R multiples, reasons, and editable trades.
            </div>
          </div>

          {/* Action Toolbar */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={exportTradesToCsv}
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 800,
                background: 'rgba(0,212,255,0.15)', border: '1px solid rgba(0,212,255,0.3)',
                color: '#00d4ff', cursor: 'pointer'
              }}
            >
              📥 Export CSV
            </button>

            {/* Filter Pills */}
            <div style={{ display: 'flex', gap: 6 }}>
              {(['ALL', 'OPEN', 'CLOSED'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 800,
                    background: filter === tab ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.05)',
                    border: filter === tab ? '1px solid rgba(0,212,255,0.4)' : '1px solid rgba(255,255,255,0.08)',
                    color: filter === tab ? '#00d4ff' : '#7090b0', cursor: 'pointer'
                  }}
                >
                  {tab === 'ALL' ? `ALL (${allTrades.length})` : tab === 'OPEN' ? `RUNNING (${openPositions.length})` : `CLOSED (${closedPositions.length})`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {filteredTrades.length === 0 ? (
          <div style={{ padding: '30px 16px', textAlign: 'center', color: '#4a6080', fontSize: 12 }}>
            No trades match this filter yet. When trades are opened or closed, they will appear here.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filteredTrades.map(({ item, isClosed }) => {
              const cp = isClosed ? (item as ClosedPaperPosition) : null;
              const pnlUsd = isClosed ? cp!.realizedPnlUsd : item.unrealizedPnlUsd;
              const pnlPct = isClosed ? cp!.realizedPnlPct : item.unrealizedPnlPct;
              const rVal = isClosed ? cp!.finalR : item.rMultiple;
              const isProfit = pnlUsd >= 0;
              const exitPrice = isClosed ? cp!.closePrice : item.currentPrice;

              return (
                <div
                  key={item.id}
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: `1px solid ${isProfit ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,102,0.2)'}`,
                    borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8
                  }}
                >
                  {/* Top Row: Symbol, Side, Badges, PnL, Edit Button */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 900, color: '#ffffff' }}>${item.symbol}</span>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: item.side === 'LONG' ? 'rgba(0,255,136,0.18)' : 'rgba(255,68,102,0.18)', color: item.side === 'LONG' ? '#00ff88' : '#ff4466' }}>
                        {item.side}
                      </span>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: isClosed ? 'rgba(155,89,255,0.15)' : 'rgba(0,212,255,0.15)', color: isClosed ? '#9b59ff' : '#00d4ff' }}>
                        {isClosed ? 'CLOSED' : 'RUNNING'}
                      </span>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: '#d4e0f0' }}>
                        {item.setupType}
                      </span>
                      <span style={{ fontSize: 8.5, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,215,0,0.12)', color: '#ffd700' }}>
                        AI {item.aiScoreAtEntry}/100
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: 13, fontWeight: 900, color: isProfit ? '#00ff88' : '#ff4466', fontVariantNumeric: 'tabular-nums' }}>
                          {isProfit ? '+' : ''}${pnlUsd.toFixed(2)} ({isProfit ? '+' : ''}{pnlPct.toFixed(1)}%)
                        </span>
                        <span style={{ fontSize: 9.5, color: '#7090b0', marginLeft: 6, fontWeight: 800 }}>
                          {rVal >= 0 ? '+' : ''}{rVal.toFixed(2)}R
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => setEditingTrade({ trade: item, isClosed })}
                          style={{
                            padding: '4px 8px', borderRadius: 6, background: 'rgba(0,212,255,0.1)',
                            border: '1px solid rgba(0,212,255,0.3)', color: '#00d4ff', fontSize: 10,
                            fontWeight: 800, cursor: 'pointer'
                          }}
                        >
                          ✏️ Edit
                        </button>
                        <button
                          onClick={() => handleDeleteTrade(item.id, item.symbol, isClosed)}
                          style={{
                            padding: '4px 8px', borderRadius: 6, background: 'rgba(255,68,102,0.12)',
                            border: '1px solid rgba(255,68,102,0.3)', color: '#ff4466', fontSize: 10,
                            fontWeight: 800, cursor: 'pointer'
                          }}
                          title="Delete trade & restore balance"
                        >
                          🗑️
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Execution Metrics Strip */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(85px, 1fr))', gap: 6, padding: '8px 10px', borderRadius: 6, background: 'rgba(0,0,0,0.25)', fontSize: 10 }}>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>ENTRY PRICE</div>
                      <div style={{ color: '#fff', fontWeight: 700 }}>${item.entryPrice < 1 ? item.entryPrice.toFixed(4) : item.entryPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>{isClosed ? 'EXIT PRICE' : 'CURRENT PRICE'}</div>
                      <div style={{ color: isProfit ? '#00ff88' : '#ff4466', fontWeight: 700 }}>${exitPrice < 1 ? exitPrice.toFixed(4) : exitPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>STOP LOSS</div>
                      <div style={{ color: '#ff4466', fontWeight: 700 }}>${item.stopLoss < 1 ? item.stopLoss.toFixed(4) : item.stopLoss.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>TAKE PROFIT</div>
                      <div style={{ color: '#00ff88', fontWeight: 700 }}>${item.takeProfit < 1 ? item.takeProfit.toFixed(4) : item.takeProfit.toFixed(2)}</div>
                    </div>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>SIZE (1% RISK)</div>
                      <div style={{ color: '#fff', fontWeight: 700 }}>${item.positionSizeUsd.toFixed(2)} (${item.riskAmountUsd.toFixed(2)})</div>
                    </div>
                    <div>
                      <div style={{ color: '#4a6080', fontSize: 8, fontWeight: 800 }}>DURATION</div>
                      <div style={{ color: '#d4e0f0', fontWeight: 700 }}>{formatDuration(item.entryTime, isClosed ? cp!.closeTime : undefined)}</div>
                    </div>
                  </div>

                  {/* Timing & Reason info */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 6, fontSize: 9.5, color: '#7090b0' }}>
                    <div>
                      <span>Entered: <b style={{ color: '#d4e0f0' }}>{formatDate(item.entryTime)}</b></span>
                      {isClosed && <span> · Closed: <b style={{ color: '#d4e0f0' }}>{formatDate(cp!.closeTime)}</b> ({cp!.closeReason})</span>}
                    </div>
                    {item.tradeThesis && item.tradeThesis.length > 0 && (
                      <div style={{ color: '#4a6080', fontStyle: 'italic', maxWidth: '60%' }}>
                        💡 {item.tradeThesis[0]}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Trade Modal Popup */}
      {editingTrade && (
        <EditTradeModal
          trade={editingTrade.trade}
          isClosed={editingTrade.isClosed}
          onClose={() => setEditingTrade(null)}
          onSave={handleSaveTradeUpdates}
          onDelete={async (id) => handleDeleteTrade(id, editingTrade.trade.symbol, editingTrade.isClosed)}
        />
      )}

      {/* Setup Performance Breakdown */}
      <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '14px' }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: '#00d4ff', letterSpacing: '0.08em', marginBottom: 10, textTransform: 'uppercase' }}>
          🎯 QUANTITATIVE RISK & STRATEGY ATTRIBUTES
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, fontSize: 11 }}>
          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
            <div style={{ color: '#9b59ff', fontWeight: 800, marginBottom: 4 }}>Position Sizing Model</div>
            <div style={{ color: '#7090b0', lineHeight: 1.5 }}>
              Risk-based sizing: <b>1.0% max risk per trade ($1.00 USD)</b>.<br/>
              Position Size = Max Risk / SL Distance %. Dual LONG &amp; SHORT execution.
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
            <div style={{ color: '#00ff88', fontWeight: 800, marginBottom: 4 }}>Price Action & AI Gates</div>
            <div style={{ color: '#7090b0', lineHeight: 1.5 }}>
              Minimum AI Score for entry: <b>88 / 100</b>.<br/>
              Minimum Risk:Reward Ratio: <b>2.0 : 1</b> (Targets 1:2.3+).
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
            <div style={{ color: '#ffd700', fontWeight: 800, marginBottom: 4 }}>Execution Safety</div>
            <div style={{ color: '#7090b0', lineHeight: 1.5 }}>
              Crash-resilient Postgres persistence.<br/>
              Max open positions capped at <b>2 (Quality over Quantity)</b>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

