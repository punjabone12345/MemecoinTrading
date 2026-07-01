import { useState, useMemo, useEffect, useRef, memo } from 'react';
import { Token, ScanStats, Settings } from '../lib/types.js';
import { formatMC, formatAge, formatPrice } from '../lib/utils.js';

interface Props { tokens: Token[]; scanStats: ScanStats; settings: Settings | null }
type Sort = 'score' | 'marketCap' | 'age' | 'priceChange24h' | 'priceChange5m';
type Filter = 'ALL' | 'ELIGIBLE' | 'SCANNING' | 'ENTERED' | 'REJECTED';
type SourceFilter = 'ALL' | 'pumpfun' | 'trenches' | 'bot';

const ScoreRing = memo(function ScoreRing({ score }: { score: number }) {
  const size = 46, r = 18, circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score >= 70 ? '#00ff88' : score >= 50 ? '#ffd700' : '#ff4466';
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={4}
          strokeDasharray={`${filled} ${circ - filled}`} strokeLinecap="round"
          className="score-ring" style={{ filter: `drop-shadow(0 0 4px ${color}66)` }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 900, color }}>{score}</span>
      </div>
    </div>
  );
});

const StatusBadge = memo(function StatusBadge({ status }: { status: Token['status'] }) {
  const cls = { ELIGIBLE: 'badge-eligible', SCANNING: 'badge-scanning', ENTERED: 'badge-entered', REJECTED: 'badge-rejected' }[status];
  return <span className={`badge ${cls}`}>{status}</span>;
});

const SOURCE_STYLES: Record<string, { bg: string; border: string; color: string; label: string }> = {
  pumpfun:  { bg: 'rgba(255,140,0,0.12)',  border: 'rgba(255,140,0,0.35)',  color: '#ff8c00', label: '🔥 PumpFun' },
  trenches: { bg: 'rgba(155,89,255,0.12)', border: 'rgba(155,89,255,0.35)', color: '#9b59ff', label: '⚔️ Trenches' },
  bot:      { bg: 'rgba(0,212,255,0.10)',  border: 'rgba(0,212,255,0.28)',  color: '#00d4ff', label: '🤖 Bot' },
};

const SourceBadges = memo(function SourceBadges({ sources }: { sources?: string[] }) {
  if (!sources || sources.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {sources.map((src) => {
        const s = SOURCE_STYLES[src] ?? { bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.15)', color: '#7090b0', label: src };
        return (
          <span key={src} style={{
            padding: '1px 6px', borderRadius: 5, fontSize: 9, fontWeight: 800,
            background: s.bg, border: `1px solid ${s.border}`, color: s.color,
            letterSpacing: '0.02em',
          }}>{s.label}</span>
        );
      })}
    </span>
  );
});

// Single clock ticks in DiscoverPage — now is passed down; no per-card timers
function FreshnessDot({ lastChecked, now }: { lastChecked: number; now: number }) {
  const ageMs = now - lastChecked;
  const ageSec = Math.floor(ageMs / 1000);
  const isHot = ageMs < 5_000;
  const isRecent = ageMs < 20_000;
  const color = isHot ? '#00ff88' : isRecent ? '#00d4ff' : '#3a5070';
  const label = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  return (
    <span title={`Data refreshed ${label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color, fontWeight: isHot ? 800 : 600 }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color,
        boxShadow: isHot ? `0 0 6px ${color}` : 'none',
        animation: isHot ? 'pulse-dot 1s ease-in-out infinite' : 'none',
      }} />
      {label}
    </span>
  );
}

function TradeBlockBanner({ token, settings, dailyLossLimitHit, dailyPnl, dailyLossLimit }: {
  token: Token; settings: Settings;
  dailyLossLimitHit?: boolean; dailyPnl?: number; dailyLossLimit?: number;
}) {
  if (dailyLossLimitHit) {
    const pnlStr = dailyPnl !== undefined ? dailyPnl.toFixed(4) : '?';
    const limitStr = dailyLossLimit !== undefined ? dailyLossLimit.toFixed(4) : '?';
    return (
      <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.25)', fontSize: 11 }}>
        <div style={{ color: '#ff4466', fontWeight: 700, marginBottom: 4 }}>🚫 Daily loss limit hit — trading paused until midnight</div>
        <div style={{ color: '#a03050' }}>Today P&amp;L: <b style={{ color: '#ff4466' }}>{pnlStr} SOL</b> / limit: <b>{limitStr} SOL</b></div>
        <div style={{ color: '#a03050', marginTop: 3, fontSize: 10 }}>Reset settings &gt; max daily loss % to unlock, or wait for next day</div>
      </div>
    );
  }

  const reasons: string[] = [];
  const ageMin = (token.age ?? 0) * 60;
  const ageBucket = ageMin < 30 ? '0–30m' : ageMin < 60 ? '30–60m' : '≥1h';
  const ageAdjMin = ageMin < 30
    ? Math.max(settings.minEntryScore, 90)
    : ageMin < 60
      ? Math.max(settings.minEntryScore, 85)
      : Math.max(settings.minEntryScore, 80);
  if (token.score < ageAdjMin)
    reasons.push(`Score ${token.score} below min ${ageAdjMin} (${ageBucket} age bucket)`);
  if (token.buySellRatio < settings.minBuySellRatio)
    reasons.push(`Buy/Sell ratio ${token.buySellRatio.toFixed(2)}x below ${settings.minBuySellRatio}x`);
  if (token.priceChange5m > 50)
    reasons.push(`5m pump +${token.priceChange5m.toFixed(1)}% — FOMO guard (>50% in 5m blocks entry)`);

  if (reasons.length === 0) {
    return (
      <div style={{ marginTop: 8, padding: '7px 12px', borderRadius: 8, background: 'rgba(0,255,136,0.06)', border: '1px solid rgba(0,255,136,0.2)', fontSize: 11, color: '#00ff88' }}>
        ✅ All conditions met — entering position next cycle
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,180,0,0.06)', border: '1px solid rgba(255,180,0,0.2)', fontSize: 11 }}>
      <div style={{ color: '#ffd700', fontWeight: 700, marginBottom: 5 }}>⏳ Waiting to trade — conditions not met:</div>
      {reasons.map((r, i) => <div key={i} style={{ color: '#b08830', marginBottom: 2 }}>• {r}</div>)}
    </div>
  );
}

// Memoized — only re-renders when token data or now-bucket (5s rounding) changes
const TokenCard = memo(function TokenCard({ token, settings, scanStats, now }: { token: Token; settings: Settings | null; scanStats: ScanStats; now: number }) {
  const [open, setOpen] = useState(false);
  const isEligible = token.status === 'ELIGIBLE';
  const isEntered = token.status === 'ENTERED';
  const c5m = token.priceChange5m;
  const c1h = token.priceChange1h ?? 0;

  return (
    <div className={`card ${isEligible ? 'card-glow-green' : isEntered ? 'card-glow-gold' : ''}`}
      style={{ borderColor: isEligible ? 'rgba(0,255,136,0.2)' : isEntered ? 'rgba(255,215,0,0.2)' : undefined, overflow: 'hidden' }}>
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ScoreRing score={token.score} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <span style={{ fontWeight: 800, fontSize: 14, color: '#d4e0f0' }}>{token.symbol}</span>
              <span style={{ fontSize: 11, color: '#3a5070', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{token.name}</span>
              <StatusBadge status={token.status} />
              <SourceBadges sources={token.sources} />
              {token.lastChecked && <FreshnessDot lastChecked={token.lastChecked} now={now} />}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: '#3a5070' }}>
              <span>MC <b style={{ color: '#7090b0' }}>{formatMC(token.marketCap)}</b></span>
              <span>Vol <b style={{ color: '#7090b0' }}>{formatMC(token.volume24h)}</b></span>
              <span>Age <b style={{ color: '#7090b0' }}>{formatAge(token.age)}</b></span>
              <span style={{ color: token.priceChange24h >= 0 ? '#00ff88' : '#ff4466', fontWeight: 700 }}>
                {token.priceChange24h >= 0 ? '+' : ''}{token.priceChange24h.toFixed(1)}% 24h
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, marginTop: 3 }}>
              <span style={{ color: c5m >= 3 ? '#00ff88' : c5m >= 0 ? '#7090b0' : '#ff4466', fontWeight: 700 }}>
                5m {c5m >= 0 ? '+' : ''}{c5m.toFixed(1)}%
              </span>
              <span style={{ color: c1h >= 0 ? '#7090b0' : '#ff4466' }}>
                1h {c1h >= 0 ? '+' : ''}{c1h.toFixed(1)}%
              </span>
              <span style={{ color: token.buySellRatio >= 1.5 ? '#00ff88' : token.buySellRatio >= 1.1 ? '#7090b0' : '#ff4466' }}>
                B/S {token.buySellRatio.toFixed(2)}x
              </span>
              <span style={{ color: '#3a5070' }}>
                Trend <b style={{ color: token.consecutiveTrending >= (settings?.trendChecksRequired ?? 2) ? '#00ff88' : '#7090b0' }}>
                  {token.consecutiveTrending}/{settings?.trendChecksRequired ?? 2}↑
                </b>
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <a href={`https://dexscreener.com/solana/${token.mint}`} target="_blank" rel="noopener noreferrer"
              className="btn-primary" style={{ padding: '5px 10px', fontSize: 11, textDecoration: 'none', display: 'inline-block' }}
              onClick={(e) => e.stopPropagation()}>DEX ↗</a>
            <button onClick={() => setOpen(!open)}
              style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#7090b0', cursor: 'pointer', fontSize: 11 }}>
              {open ? '▲' : '▼'}
            </button>
          </div>
        </div>

        {token.tradedToday && token.status !== 'ENTERED' && (
          <div style={{ marginTop: 6, padding: '7px 12px', borderRadius: 8, background: 'rgba(155,89,255,0.08)', border: '1px solid rgba(155,89,255,0.25)', fontSize: 11 }}>
            <span style={{ color: '#9b59ff', fontWeight: 700 }}>🚫 Already traded today</span>
            <span style={{ color: '#6a3a9a', marginLeft: 6 }}>— no re-entry until IST midnight</span>
          </div>
        )}
        {isEligible && settings && (
          <TradeBlockBanner token={token} settings={settings} dailyLossLimitHit={scanStats.dailyLossLimitHit} dailyPnl={scanStats.dailyPnl} dailyLossLimit={scanStats.dailyLossLimit} />
        )}
        {token.status === 'REJECTED' && token.rejectReason && (
          <div style={{ marginTop: 6, padding: '5px 10px', borderRadius: 6, background: 'rgba(255,68,102,0.06)', border: '1px solid rgba(255,68,102,0.15)', fontSize: 11, color: '#ff6680' }}>
            ❌ {token.rejectReason}
          </div>
        )}
      </div>

      {open && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '14px 16px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div className="section-label" style={{ marginBottom: 10 }}>Score Breakdown</div>
              {[
                { label: 'Price Momentum', v: token.scoreBreakdown?.priceMomentum ?? 0, color: '#00d4ff' },
                { label: 'Volume Momentum', v: token.scoreBreakdown?.volumeMomentum ?? 0, color: '#9b59ff' },
                { label: 'Buy Pressure', v: token.scoreBreakdown?.buyPressure ?? 0, color: '#00ff88' },
                { label: 'MC Quality', v: token.scoreBreakdown?.mcQuality ?? 0, color: '#ffd700' },
              ].map((item) => (
                <div key={item.label} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4, color: '#3a5070' }}>
                    <span>{item.label}</span>
                    <span style={{ color: item.color, fontWeight: 700 }}>{item.v}/25</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.06)' }}>
                    <div style={{ height: '100%', borderRadius: 4, width: `${(item.v / 25) * 100}%`, background: item.color, boxShadow: `0 0 6px ${item.color}55`, transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 11 }}>
                <span style={{ color: '#3a5070' }}>Price </span>
                <b style={{ color: '#7090b0' }}>${formatPrice(token.price)}</b>
              </div>
            </div>
            <div>
              <div className="section-label" style={{ marginBottom: 10 }}>Filter Checks</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {(token.filterResults ?? []).map((f) => (
                  <div key={f.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>{f.passed ? '✅' : '❌'}</span>
                      <span style={{ color: f.passed ? '#7090b0' : '#ff4466' }}>{f.name}</span>
                    </div>
                    <span style={{ color: f.passed ? '#3a5070' : '#ff6688', fontWeight: f.passed ? 400 : 700 }}>{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {token.rejectReason && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 10, background: 'rgba(255,68,102,0.08)', border: '1px solid rgba(255,68,102,0.18)', fontSize: 11, color: '#ff4466' }}>
              ❌ Rejected: {token.rejectReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render if only `now` changed but freshness bucket didn't
  // FreshnessDot buckets: hot (<5s), recent (<20s), old (>=20s) → 5s resolution is fine
  const prevBucket = prev.now - (prev.token.lastChecked ?? 0);
  const nextBucket = next.now - (next.token.lastChecked ?? 0);
  const bucketChanged =
    (prevBucket < 5000) !== (nextBucket < 5000) ||
    (prevBucket < 20000) !== (nextBucket < 20000) ||
    Math.floor(prevBucket / 5000) !== Math.floor(nextBucket / 5000);

  return (
    prev.token === next.token &&
    prev.settings === next.settings &&
    prev.scanStats === next.scanStats &&
    !bucketChanged
  );
});

function LiveDot() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#00ff88', fontWeight: 800, letterSpacing: '0.08em' }}>
      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 8px #00ff88', animation: 'pulse-dot 1.2s ease-in-out infinite' }} />
      LIVE
    </span>
  );
}

const FILTERS: Filter[] = ['ALL', 'ELIGIBLE', 'SCANNING', 'ENTERED', 'REJECTED'];
const FILTER_COLOR: Record<Filter, string> = { ALL: '#00d4ff', ELIGIBLE: '#00ff88', SCANNING: '#00d4ff', ENTERED: '#ffd700', REJECTED: '#ff4466' };

export default function DiscoverPage({ tokens, scanStats, settings }: Props) {
  const [sort, setSort] = useState<Sort>('score');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [search, setSearch] = useState('');

  // Single shared clock — replaces N per-card setInterval timers
  // Rounds to nearest 5s so TokenCard memo skips renders when bucket unchanged
  const [now, setNow] = useState(() => Math.round(Date.now() / 5000) * 5000);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    clockRef.current = setInterval(() => {
      setNow(Math.round(Date.now() / 5000) * 5000);
    }, 5000);
    return () => { if (clockRef.current) clearInterval(clockRef.current); };
  }, []);

  const filtered = useMemo(() => {
    let arr = [...tokens];
    if (filter !== 'ALL') arr = arr.filter((t) => t.status === filter);
    if (sourceFilter !== 'ALL') arr = arr.filter((t) => t.sources?.includes(sourceFilter));
    if (search) { const q = search.toLowerCase(); arr = arr.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)); }
    arr.sort((a, b) =>
      sort === 'score' ? b.score - a.score :
      sort === 'marketCap' ? b.marketCap - a.marketCap :
      sort === 'age' ? a.age - b.age :
      sort === 'priceChange5m' ? b.priceChange5m - a.priceChange5m :
      b.priceChange24h - a.priceChange24h
    );
    return arr;
  }, [tokens, sort, filter, sourceFilter, search]);

  const trenchesCount = scanStats.trenchesCount ?? 0;
  const pumpfunCount = scanStats.pumpfunCount ?? 0;
  const botCount = tokens.filter((t) => t.sources?.includes('bot') && !t.sources?.includes('pumpfun') && !t.sources?.includes('trenches')).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Source discovery counters */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'PumpFun', value: pumpfunCount, color: '#ff8c00', glow: '', src: 'pumpfun', icon: '🔥' },
          { label: 'Trenches', value: trenchesCount, color: '#9b59ff', glow: '', src: 'trenches', icon: '⚔️' },
          { label: 'Bot', value: botCount, color: '#00d4ff', glow: 'card-glow-cyan', src: 'bot', icon: '🤖' },
        ].map((s) => {
          const active = sourceFilter === s.src;
          return (
            <button key={s.label} onClick={() => setSourceFilter(active ? 'ALL' : s.src as SourceFilter)}
              className={`card ${s.glow}`}
              style={{
                padding: '10px 8px', textAlign: 'center', cursor: 'pointer', border: `1px solid ${active ? s.color + '55' : 'rgba(255,255,255,0.06)'}`,
                background: active ? `${s.color}18` : undefined,
                boxShadow: active ? `0 0 14px ${s.color}22` : undefined,
                transition: 'all 0.2s',
              }}>
              <div style={{ fontSize: 10, marginBottom: 2 }}>{s.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 9, color: active ? s.color : '#3a5070', marginTop: 3, letterSpacing: '0.08em', fontWeight: 700 }}>
                {s.label.toUpperCase()} {active && '●'}
              </div>
            </button>
          );
        })}
      </div>

      {/* Scan stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        {[
          { label: 'Scanning', value: scanStats.scanning, color: '#00d4ff', glow: 'card-glow-cyan' },
          { label: 'Passed', value: scanStats.passed, color: '#ffd700', glow: 'card-glow-gold' },
          { label: 'Eligible', value: scanStats.eligible, color: '#00ff88', glow: 'card-glow-green' },
        ].map((s) => (
          <div key={s.label} className={`card ${s.glow}`} style={{ padding: '12px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 900, color: s.color, lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 9, color: '#3a5070', marginTop: 4, letterSpacing: '0.08em', fontWeight: 700 }}>{s.label.toUpperCase()}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderRadius: 10, background: 'rgba(0,255,136,0.04)', border: '1px solid rgba(0,255,136,0.1)' }}>
        <LiveDot />
        <span style={{ fontSize: 10, color: '#3a5070', flex: 1, marginLeft: 8 }}>
          Full scan every <b style={{ color: '#7090b0' }}>15s</b> · Hot refresh every <b style={{ color: '#7090b0' }}>3s</b>
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {scanStats.ageBanned !== undefined && scanStats.ageBanned > 0 && (
            <span style={{ fontSize: 9, color: '#ff4466', fontWeight: 700, background: 'rgba(255,68,102,0.1)', border: '1px solid rgba(255,68,102,0.2)', borderRadius: 4, padding: '2px 6px' }}>
              {scanStats.ageBanned} age-banned
            </span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9, fontWeight: 700, color: scanStats.pumpPortalConnected ? '#00ff88' : '#7090b0', background: scanStats.pumpPortalConnected ? 'rgba(0,255,136,0.08)' : 'rgba(255,255,255,0.03)', border: `1px solid ${scanStats.pumpPortalConnected ? 'rgba(0,255,136,0.2)' : 'rgba(255,255,255,0.06)'}`, borderRadius: 4, padding: '2px 6px' }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: scanStats.pumpPortalConnected ? '#00ff88' : '#3a5070', display: 'inline-block' }} />
            PUMP.FUN WS {scanStats.pumpPortalConnected ? 'LIVE' : 'OFF'}
          </span>
        </div>
      </div>

      {scanStats.rejectionCounts && Object.keys(scanStats.rejectionCounts).length > 0 && (
        <div className="card" style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.1em', color: '#3a5070', marginBottom: 10 }}>
            REJECTION BREAKDOWN <span style={{ color: '#1a3050', fontWeight: 600 }}>({Object.values(scanStats.rejectionCounts).reduce((a, b) => a + b, 0)} filtered out)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {Object.entries(scanStats.rejectionCounts).map(([reason, count]) => {
              const total = Object.values(scanStats.rejectionCounts!).reduce((a, b) => a + b, 0);
              const pct = total > 0 ? (count / total) * 100 : 0;
              const isPreReject = ['MC too low', 'MC too high', 'Vol24h too low', 'Age too new', 'Age too old', 'Already pumped >500%'].includes(reason);
              return (
                <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                      <span style={{ fontSize: 10, color: isPreReject ? '#7090b0' : '#ff6688', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {reason}
                      </span>
                      <span style={{ fontSize: 10, color: '#3a5070', marginLeft: 8, flexShrink: 0 }}>
                        <b style={{ color: '#7090b0' }}>{count}</b>
                      </span>
                    </div>
                    <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, borderRadius: 2, background: isPreReject ? 'rgba(0,212,255,0.4)' : 'rgba(255,68,102,0.5)', transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" placeholder="Search token..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="input-premium" style={{ flex: 1, padding: '9px 12px', fontSize: 13 }} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, color: '#d4e0f0', padding: '9px 10px', fontSize: 12, cursor: 'pointer' }}>
          <option value="score">Score</option>
          <option value="marketCap">Mkt Cap</option>
          <option value="age">Newest</option>
          <option value="priceChange5m">5m Change</option>
          <option value="priceChange24h">24h Change</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const active = filter === f;
          const c = FILTER_COLOR[f];
          const count = f === 'ALL' ? tokens.length : tokens.filter((t) => t.status === f).length;
          return (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                padding: '5px 12px', borderRadius: 20, fontSize: 10, fontWeight: 800, letterSpacing: '0.05em', cursor: 'pointer',
                background: active ? `${c}22` : 'rgba(255,255,255,0.03)',
                border: `1px solid ${active ? `${c}55` : 'rgba(255,255,255,0.07)'}`,
                color: active ? c : '#3a5070',
                boxShadow: active ? `0 0 12px ${c}22` : 'none',
              }}>{f} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}</button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: '#3a5070' }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🔍</div>
          <div style={{ fontWeight: 700, color: '#7090b0', marginBottom: 6 }}>
            {filter !== 'ALL' ? `No ${filter} tokens right now` : 'Scanning Solana...'}
          </div>
          <div style={{ fontSize: 12 }}>Full scan every 15s · hot refresh every 3s</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((t) => <TokenCard key={t.mint} token={t} settings={settings} scanStats={scanStats} now={now} />)}
        </div>
      )}
    </div>
  );
}
