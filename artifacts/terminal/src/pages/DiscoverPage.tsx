import { useState, useMemo } from 'react';
import { Token, ScanStats } from '../lib/types.js';
import { formatMC, formatAge, formatPrice } from '../lib/utils.js';

interface Props {
  tokens: Token[];
  scanStats: ScanStats;
}

type SortKey = 'score' | 'marketCap' | 'age' | 'priceChange24h';
type StatusFilter = 'ALL' | 'ELIGIBLE' | 'SCANNING' | 'ENTERED' | 'REJECTED';

function ScoreRing({ score }: { score: number }) {
  const size = 44;
  const r = 18;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score >= 70 ? '#00ff88' : score >= 50 ? '#ffd700' : '#ff4466';

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1e2a3a" strokeWidth={4} />
        <circle
          cx={size / 2} cy={size / 2} r={r}
          fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeLinecap="round"
          className="score-ring"
          style={{ transform: 'rotate(-90deg)', transformOrigin: `${size / 2}px ${size / 2}px` }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-xs font-bold" style={{ color }}>{score}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: Token['status'] }) {
  const colors: Record<Token['status'], { bg: string; text: string }> = {
    ELIGIBLE: { bg: 'rgba(0,255,136,0.15)', text: '#00ff88' },
    SCANNING: { bg: 'rgba(0,212,255,0.1)', text: '#00d4ff' },
    ENTERED: { bg: 'rgba(255,215,0,0.15)', text: '#ffd700' },
    REJECTED: { bg: 'rgba(255,68,102,0.1)', text: '#ff4466' },
  };
  const c = colors[status];
  return (
    <span
      className="px-2 py-0.5 rounded text-xs font-bold uppercase"
      style={{ background: c.bg, color: c.text }}
    >
      {status}
    </span>
  );
}

function TokenCard({ token }: { token: Token }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="rounded-xl border transition-all"
      style={{
        background: 'var(--navy-card)',
        borderColor: token.status === 'ELIGIBLE' ? 'rgba(0,255,136,0.3)' : token.status === 'ENTERED' ? 'rgba(255,215,0,0.3)' : 'var(--navy-border)',
      }}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <ScoreRing score={token.score} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-sm truncate" style={{ color: 'var(--text)' }}>{token.symbol}</span>
                <span className="text-xs truncate" style={{ color: 'var(--text-dim)' }}>{token.name}</span>
                <StatusBadge status={token.status} />
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs flex-wrap" style={{ color: 'var(--text-dim)' }}>
                <span>MC: <b style={{ color: 'var(--text)' }}>{formatMC(token.marketCap)}</b></span>
                <span>Vol: <b style={{ color: 'var(--text)' }}>{formatMC(token.volume24h)}</b></span>
                <span>Age: <b style={{ color: 'var(--text)' }}>{formatAge(token.age)}</b></span>
                <span style={{ color: token.priceChange24h >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  24h: {token.priceChange24h >= 0 ? '+' : ''}{token.priceChange24h.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={`https://dexscreener.com/solana/${token.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-1 rounded text-xs font-medium transition-opacity hover:opacity-80"
              style={{ background: 'rgba(0,212,255,0.1)', color: 'var(--cyan)', border: '1px solid rgba(0,212,255,0.2)' }}
              onClick={(e) => e.stopPropagation()}
            >
              DEX ↗
            </a>
            <button
              onClick={() => setExpanded(!expanded)}
              className="px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
              style={{ background: 'var(--navy-border)', color: 'var(--text-dim)' }}
            >
              {expanded ? '▲' : '▼'}
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: 'var(--navy-border)' }}>
          <div className="pt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Score Breakdown */}
            <div>
              <div className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>Score Breakdown</div>
              {[
                { label: 'Price Momentum', val: token.scoreBreakdown?.priceMomentum ?? 0, max: 25 },
                { label: 'Volume Momentum', val: token.scoreBreakdown?.volumeMomentum ?? 0, max: 25 },
                { label: 'Buy Pressure', val: token.scoreBreakdown?.buyPressure ?? 0, max: 25 },
                { label: 'MC Quality', val: token.scoreBreakdown?.mcQuality ?? 0, max: 25 },
              ].map((item) => (
                <div key={item.label} className="mb-1.5">
                  <div className="flex justify-between text-xs mb-0.5">
                    <span style={{ color: 'var(--text-dim)' }}>{item.label}</span>
                    <span style={{ color: 'var(--cyan)' }}>{item.val}/{item.max}</span>
                  </div>
                  <div className="h-1.5 rounded-full" style={{ background: 'var(--navy-border)' }}>
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${(item.val / item.max) * 100}%`,
                        background: item.val >= item.max * 0.8 ? 'var(--green)' : item.val >= item.max * 0.5 ? 'var(--cyan)' : 'var(--text-dim)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Filter Checklist */}
            <div>
              <div className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>Filter Checks</div>
              <div className="space-y-1">
                {(token.filterResults ?? []).map((f) => (
                  <div key={f.name} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span>{f.passed ? '✅' : '❌'}</span>
                      <span style={{ color: f.passed ? 'var(--text)' : 'var(--red)' }}>{f.name}</span>
                    </div>
                    <span style={{ color: 'var(--text-dim)' }}>{f.value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t grid grid-cols-2 gap-2 text-xs" style={{ borderColor: 'var(--navy-border)' }}>
                <div>
                  <span style={{ color: 'var(--text-dim)' }}>Price: </span>
                  <span style={{ color: 'var(--text)' }}>${formatPrice(token.price)}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-dim)' }}>B/S: </span>
                  <span style={{ color: token.buySellRatio >= 1.5 ? 'var(--green)' : 'var(--text)' }}>{token.buySellRatio.toFixed(2)}x</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-dim)' }}>5m: </span>
                  <span style={{ color: token.priceChange5m >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {token.priceChange5m >= 0 ? '+' : ''}{token.priceChange5m.toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-dim)' }}>Trend: </span>
                  <span style={{ color: token.consecutiveTrending >= 3 ? 'var(--green)' : 'var(--text)' }}>
                    {token.consecutiveTrending}/3 ↑
                  </span>
                </div>
              </div>
            </div>
          </div>

          {token.rejectReason && (
            <div className="mt-3 px-3 py-2 rounded text-xs" style={{ background: 'rgba(255,68,102,0.1)', color: 'var(--red)', border: '1px solid rgba(255,68,102,0.2)' }}>
              ❌ Rejected: {token.rejectReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DiscoverPage({ tokens, scanStats }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let arr = [...tokens];
    if (statusFilter !== 'ALL') arr = arr.filter((t) => t.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
    }
    arr.sort((a, b) => {
      if (sortKey === 'score') return b.score - a.score;
      if (sortKey === 'marketCap') return b.marketCap - a.marketCap;
      if (sortKey === 'age') return a.age - b.age;
      if (sortKey === 'priceChange24h') return b.priceChange24h - a.priceChange24h;
      return 0;
    });
    return arr;
  }, [tokens, sortKey, statusFilter, search]);

  return (
    <div>
      {/* Stats Header */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[
          { label: 'Scanning', value: scanStats.scanning, color: 'var(--cyan)' },
          { label: 'Passed Filters', value: scanStats.passed, color: 'var(--gold)' },
          { label: 'Eligible', value: scanStats.eligible, color: 'var(--green)' },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl p-3 text-center border"
            style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}
          >
            <div className="text-2xl font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input
          type="text"
          placeholder="Search token..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-1.5 rounded-lg text-sm flex-1 min-w-[150px]"
          style={{
            background: 'var(--navy-card)',
            border: '1px solid var(--navy-border)',
            color: 'var(--text)',
            outline: 'none',
          }}
        />
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="px-3 py-1.5 rounded-lg text-sm"
          style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', color: 'var(--text)' }}
        >
          <option value="score">Sort: Score</option>
          <option value="marketCap">Sort: Market Cap</option>
          <option value="age">Sort: Newest</option>
          <option value="priceChange24h">Sort: 24h Change</option>
        </select>
        <div className="flex gap-1">
          {(['ALL', 'ELIGIBLE', 'SCANNING', 'ENTERED', 'REJECTED'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: statusFilter === s ? 'rgba(0,212,255,0.15)' : 'var(--navy-card)',
                border: `1px solid ${statusFilter === s ? 'var(--cyan)' : 'var(--navy-border)'}`,
                color: statusFilter === s ? 'var(--cyan)' : 'var(--text-dim)',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Token List */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-16" style={{ color: 'var(--text-dim)' }}>
            <div className="text-4xl mb-3">🔍</div>
            <div>Scanning Solana for momentum tokens...</div>
            <div className="text-xs mt-1">Updates every 30 seconds</div>
          </div>
        ) : (
          filtered.map((token) => <TokenCard key={token.mint} token={token} />)
        )}
      </div>
    </div>
  );
}
