import { AltcoinStatusResponse, ClosedPaperPosition } from '../lib/types.js';

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

export default function AnalyticsPage({ status }: Props) {
  const portfolio = status?.portfolio;
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1200, margin: '0 auto' }}>
      
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
              Position Size = Max Risk / SL Distance %.
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
            <div style={{ color: '#00ff88', fontWeight: 800, marginBottom: 4 }}>Price Action & AI Gates</div>
            <div style={{ color: '#7090b0', lineHeight: 1.5 }}>
              Minimum AI Score for entry: <b>88 / 100</b>.<br/>
              Minimum Risk:Reward Ratio: <b>2.0 : 1</b>.
            </div>
          </div>

          <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 8 }}>
            <div style={{ color: '#ffd700', fontWeight: 800, marginBottom: 4 }}>Execution Safety</div>
            <div style={{ color: '#7090b0', lineHeight: 1.5 }}>
              Paper Simulation Mode enabled.<br/>
              Max open positions capped at <b>2 (Quality over Quantity)</b>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
