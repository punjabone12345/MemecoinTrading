import { useState, useEffect, useRef } from 'react';
import { Token, ScanStats, Settings, WhaleStatus, TrackedToken, WhaleBuyLog, WhalePosition, ClosedWhalePosition, PendingSignal } from '../lib/types.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  tokens: Token[];
  scanStats: ScanStats;
  settings: Settings | null;
  /** Real-time whale status pushed via App-level WebSocket. */
  whaleStatus?: WhaleStatus | null;
  /** True when the App-level WebSocket is connected. Polling resumes when false. */
  wsConnected?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

function countdown(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

function countdownPct(migrationTime: number, expiresAt: number): number {
  const total = expiresAt - migrationTime;
  const elapsed = Date.now() - migrationTime;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPnl(pct: number): string {
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

function shortAddr(addr: string): string {
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

// ── Whale status hook (polling fallback when WS data is absent) ───────────────

function useWhaleStatusFallback(skip: boolean) {
  const [status, setStatus] = useState<WhaleStatus | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch('/api/whale/status');
        if (!r.ok) return;
        const data: WhaleStatus = await r.json();
        if (!cancelled) setStatus(data);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [skip]);

  return status;
}

// ── Discovery source feed hook (graduation events) ───────────────────────────

interface DiscoveryEvent { mint: string; ts: number; txSig?: string; instructionType?: string; }
interface SourceActivity {
  pumpfun: { total: number; recent: DiscoveryEvent[] };
}

function useSourceActivity() {
  const [data, setData] = useState<SourceActivity | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch('/api/scanner/sources');
        if (!r.ok) return;
        const json = await r.json();
        if (!cancelled) setStatus(json);
      } catch { /* ignore */ }
      function setStatus(d: SourceActivity) { if (!cancelled) setData(d); }
    }
    poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return data;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const C = {
  card:   { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 } as React.CSSProperties,
  label:  { fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: '#3a5070' } as React.CSSProperties,
  whale:  '#00bfff',
  green:  '#00ff88',
  red:    '#ff4466',
  yellow: '#ffd700',
  gray:   '#4a6080',
};

function dexUrl(mintOrPool: string): string {
  return `https://dexscreener.com/solana/${mintOrPool}`;
}

function DexLink({ mint, pool }: { mint: string; pool?: string }) {
  return (
    <a
      href={dexUrl(pool ?? mint)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 8, fontWeight: 800, letterSpacing: '0.05em',
        padding: '2px 6px', borderRadius: 4,
        background: 'rgba(255,196,0,0.08)',
        color: '#ffc400',
        border: '1px solid rgba(255,196,0,0.25)',
        textDecoration: 'none',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      ↗ DEX
    </a>
  );
}

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 54 }}>
      <span style={{ fontSize: 18, fontWeight: 900, color: color ?? C.whale, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', color: C.gray, textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}

// ── Market-data helpers ───────────────────────────────────────────────────────

function fmtCompact(n?: number): string {
  if (!n) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return `${n.toFixed(2)}`;
}

function fmtPrice(p?: number): string {
  if (!p) return '—';
  if (p < 0.000001) return `${p.toExponential(2)}`;
  if (p < 0.01)     return `${p.toFixed(6)}`;
  if (p < 1)        return `${p.toFixed(4)}`;
  return `${p.toFixed(2)}`;
}

function PctBadge({ value, label }: { value?: number; label: string }) {
  if (value == null) return null;
  const pos = value >= 0;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: pos ? C.green : C.red }}>
        {pos ? '+' : ''}{value.toFixed(1)}%
      </div>
      <div style={{ fontSize: 8, color: C.gray }}>{label}</div>
    </div>
  );
}

// ── TrackedCard ───────────────────────────────────────────────────────────────

function TrackedCard({ tok, tick }: { tok: TrackedToken; tick: number }) {
  void tick;
  const pct        = countdownPct(tok.migrationTime, tok.expiresAt);
  const remaining  = countdown(tok.expiresAt);
  const expired    = tok.expiresAt <= Date.now();
  const biggestBuy = tok.whaleBuys.reduce((max, b) => b.amountUsd > max ? b.amountUsd : max, 0);
  const hasMarket  = (tok.price ?? 0) > 0;

  return (
    <div style={{
      ...C.card, marginBottom: 8,
      borderColor: tok.entryTriggered ? 'rgba(0,255,136,0.25)' : biggestBuy >= 500 ? 'rgba(0,191,255,0.3)' : 'rgba(255,255,255,0.07)',
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 900, color: '#e0e8ff' }}>{tok.symbol}</span>
            <span style={{ fontSize: 9, color: C.gray }}>{tok.name}</span>
            {tok.entryTriggered && (
              <span style={{ fontSize: 8, fontWeight: 800, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,255,136,0.12)', color: C.green, border: '1px solid rgba(0,255,136,0.3)' }}>ENTERED</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <span style={{ fontSize: 9, color: C.gray, fontFamily: 'monospace' }}>{shortAddr(tok.mint)}</span>
            <DexLink mint={tok.mint} pool={tok.poolAddress} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 13, fontWeight: 900, fontVariantNumeric: 'tabular-nums', color: expired ? C.red : pct > 80 ? C.yellow : '#00d4ff' }}>
            {remaining}
          </div>
          <div style={{ fontSize: 8, color: C.gray }}>remaining</div>
        </div>
      </div>

      {/* ── Market stats grid ── */}
      {hasMarket ? (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 6, margin: '10px 0 6px', padding: '8px 10px',
          borderRadius: 8, background: 'rgba(0,191,255,0.04)',
          border: '1px solid rgba(0,191,255,0.08)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(tok.price)}</div>
            <div style={{ fontSize: 8, color: C.gray }}>price</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>{fmtCompact(tok.mcap)}</div>
            <div style={{ fontSize: 8, color: C.gray }}>mcap</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>{fmtCompact(tok.liquidity)}</div>
            <div style={{ fontSize: 8, color: C.gray }}>liq</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>{fmtCompact(tok.volume5m)}</div>
            <div style={{ fontSize: 8, color: C.gray }}>vol 5m</div>
          </div>
          <PctBadge value={tok.priceChange5m} label="5m chg" />
          <PctBadge value={tok.priceChange1h} label="1h chg" />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: tok.whaleBuys.length > 0 ? C.whale : C.gray }}>
              {tok.whaleBuys.length}
            </div>
            <div style={{ fontSize: 8, color: C.gray }}>🐋 buys</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: C.gray }}>
              {tok.lastMarketUpdate ? timeAgo(tok.lastMarketUpdate) : '—'}
            </div>
            <div style={{ fontSize: 8, color: C.gray }}>updated</div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: C.gray, margin: '8px 0 4px', fontStyle: 'italic' }}>
          Fetching market data…
        </div>
      )}

      {/* ── Progress bar ── */}
      <div style={{ margin: '6px 0 6px', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: expired ? C.red : pct > 80 ? `linear-gradient(90deg,${C.yellow},${C.red})` : `linear-gradient(90deg,${C.whale},#7b5ea7)`, transition: 'width 1s linear' }} />
      </div>

      {/* ── Whale buy chips ── */}
      {tok.whaleBuys.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {tok.whaleBuys.slice(0, 5).map((b, i) => (
            <span key={i} style={{
              fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
              background: b.amountUsd >= 2000 ? 'rgba(0,191,255,0.18)' : b.amountUsd >= 1000 ? 'rgba(0,191,255,0.11)' : 'rgba(0,191,255,0.06)',
              color: C.whale, border: '1px solid rgba(0,191,255,0.2)',
            }}>
              🐋 {fmtUsd(b.amountUsd)} · {timeAgo(b.timestamp)}
            </span>
          ))}
        </div>
      )}
      {!hasMarket && tok.whaleBuys.length === 0 && (
        <div style={{ fontSize: 9, color: C.gray }}>Monitoring for whale buys…</div>
      )}
    </div>
  );
}

function WhaleBuyRow({ entry }: { entry: WhaleBuyLog }) {
  const tier = entry.amountUsd >= 2000 ? '🐳' : entry.amountUsd >= 1000 ? '🐋' : '🐬';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{tier}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 900, color: C.whale }}>{fmtUsd(entry.amountUsd)}</span>
          <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>buy on {entry.symbol}</span>
          <DexLink mint={entry.mint} />
          {entry.entered ? (
            <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(0,255,136,0.12)', color: C.green, border: '1px solid rgba(0,255,136,0.25)' }}>
              ENTERED
            </span>
          ) : (
            <span style={{ fontSize: 8, padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.04)', color: C.gray }}>
              {entry.skipReason ?? 'skipped'}
            </span>
          )}
        </div>
        <div style={{ fontSize: 8, color: C.gray, marginTop: 2 }}>
          {shortAddr(entry.wallet)} · {timeAgo(entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

function PositionCard({ pos }: { pos: WhalePosition }) {
  const pnlColor = pos.pnlPct >= 0 ? C.green : C.red;
  const tpPct    = ((pos.lastPrice / pos.entryPrice) / 2) * 100; // progress toward +100%
  return (
    <div style={{
      ...C.card, marginBottom: 8,
      borderColor: pos.pnlPct >= 0 ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,102,0.2)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 900, color: '#e0e8ff' }}>{pos.symbol}</span>
            <span style={{ fontSize: 9, color: C.gray }}>{pos.sizePct}% position</span>
            <DexLink mint={pos.mint} />
          </div>
          <div style={{ fontSize: 9, color: C.gray, marginTop: 2 }}>
            Entry ${pos.entryPrice < 0.001 ? pos.entryPrice.toExponential(3) : pos.entryPrice.toFixed(6)} · {pos.sizeSol.toFixed(3)} SOL
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: pnlColor, fontVariantNumeric: 'tabular-nums' }}>{fmtPnl(pos.pnlPct)}</div>
          <div style={{ fontSize: 8, color: C.gray }}>peak {fmtPnl(((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100)}</div>
        </div>
      </div>
      {/* TP progress bar */}
      <div style={{ marginTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 8, color: C.gray }}>Progress to +100% TP</span>
          <span style={{ fontSize: 8, color: pnlColor, fontWeight: 700 }}>{Math.min(100, Math.max(0, tpPct)).toFixed(0)}%</span>
        </div>
        <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, Math.max(0, tpPct))}%`, height: '100%', borderRadius: 2, background: `linear-gradient(90deg,${C.whale},${C.green})` }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 7 }}>
        <span style={{ fontSize: 8, color: C.gray }}>Liq ${pos.lastLiquidity >= 1000 ? (pos.lastLiquidity / 1000).toFixed(1) + 'k' : pos.lastLiquidity.toFixed(0)}</span>
        <span style={{ fontSize: 8, color: C.gray }}>· {timeAgo(pos.entryTime)}</span>
      </div>
    </div>
  );
}

function ClosedCard({ pos }: { pos: ClosedWhalePosition }) {
  const pnlColor = pos.closePnlPct >= 0 ? C.green : C.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#c0c8e0' }}>{pos.symbol}</span>
          <DexLink mint={pos.mint} />
        </div>
        <span style={{ fontSize: 9, color: C.gray }}>{pos.closeReason}</span>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: pnlColor }}>{fmtPnl(pos.closePnlPct)}</div>
        <div style={{ fontSize: 8, color: C.gray }}>{timeAgo(pos.closeTime)}</div>
      </div>
    </div>
  );
}

// ── Source feed (graduation events) ──────────────────────────────────────────

function GraduationFeed() {
  const data = useSourceActivity();
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 5_000); return () => clearInterval(id); }, []);
  void tick;

  const events = data?.pumpfun?.recent ?? [];

  return (
    <div style={C.card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={C.label}>🔥 RECENT PUMP.FUN GRADUATIONS</span>
        <span style={{ fontSize: 9, color: C.green, fontWeight: 700 }}>
          <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: C.green, boxShadow: `0 0 6px ${C.green}`, marginRight: 4, verticalAlign: 'middle' }} />
          LIVE
        </span>
        {data && <span style={{ fontSize: 9, color: C.gray, marginLeft: 'auto' }}>total: {data.pumpfun?.total ?? 0}</span>}
      </div>
      {events.length === 0 ? (
        <div style={{ fontSize: 9, color: C.gray }}>Waiting for graduation events…</div>
      ) : (
        events.slice(0, 8).map((ev, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < 7 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
            <div style={{ fontSize: 9, color: '#c0c8e0', fontFamily: 'monospace' }}>
              {ev.mint.slice(0, 8)}…{ev.mint.slice(-6)}
              <span style={{ fontSize: 8, color: C.gray, marginLeft: 6 }}>{ev.instructionType}</span>
            </div>
            <span style={{ fontSize: 8, color: C.gray }}>{timeAgo(ev.ts)}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DiscoverPage({ whaleStatus: wsProp, wsConnected = false }: Props) {
  // Poll only when WebSocket is offline; WS pushes whale_status in real time when connected
  const polled = useWhaleStatusFallback(wsConnected);
  const status = wsConnected ? (wsProp ?? polled) : (polled ?? wsProp);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  const tracked  = status?.trackedTokens  ?? [];
  const positions = status?.openPositions ?? [];
  const buyLogs  = status?.recentBuyLog   ?? [];
  const closed   = status?.closedPositions ?? [];
  const queued   = status?.queuedSignals  ?? [];
  const stats    = status?.stats ?? { tracking: 0, positions: 0, queued: 0, pending: 0 };

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ ...C.card, marginBottom: 16, background: 'linear-gradient(135deg,rgba(0,191,255,0.06),rgba(123,94,167,0.06))', borderColor: 'rgba(0,191,255,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: C.whale, letterSpacing: '0.04em' }}>🐋 WHALE SNIPER</div>
            <div style={{ fontSize: 9, color: C.gray, marginTop: 2 }}>Following pump.fun graduations · Paper mode</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 9, color: C.gray }}>
            SOL<br />
            <span style={{ fontSize: 13, fontWeight: 800, color: '#e0e8ff' }}>${status?.solPriceUsd?.toFixed(0) ?? '—'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '0 -2px' }}>
          <StatPill label="Pending" value={stats.pending ?? 0} color={(stats.pending ?? 0) > 0 ? C.whale : C.gray} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label="Tracking" value={stats.tracking} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label={`Positions`} value={`${stats.positions}/10`} color={stats.positions >= 10 ? C.yellow : C.green} />
          <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }} />
          <StatPill label="Queued" value={stats.queued} color={stats.queued > 0 ? C.yellow : C.gray} />
        </div>

        {/* Strategy summary */}
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { label: '≥$500 → 0.5%', color: 'rgba(0,191,255,0.15)' },
            { label: '≥$1k → 0.75%', color: 'rgba(0,191,255,0.22)' },
            { label: '≥$2k → 1%',    color: 'rgba(0,191,255,0.30)' },
            { label: 'TP +100%',      color: 'rgba(0,255,136,0.15)' },
            { label: 'SL price -30%', color: 'rgba(255,68,102,0.12)' },
            { label: 'SL liq -40%',   color: 'rgba(255,68,102,0.12)' },
            { label: '30min window',  color: 'rgba(255,215,0,0.10)' },
          ].map(({ label, color }) => (
            <span key={label} style={{ fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: color, color: '#c0c8e0', border: '1px solid rgba(255,255,255,0.08)' }}>{label}</span>
          ))}
        </div>
      </div>

      {/* ── Open Positions ── */}
      {positions.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ ...C.label, marginBottom: 8 }}>OPEN POSITIONS ({positions.length}/10)</div>
          {positions.map(pos => <PositionCard key={pos.id} pos={pos} />)}
        </div>
      )}

      {/* ── Queued signals ── */}
      {queued.length > 0 && (
        <div style={{ ...C.card, marginBottom: 16, borderColor: 'rgba(255,215,0,0.2)' }}>
          <div style={{ ...C.label, marginBottom: 8 }}>⏳ QUEUED SIGNALS ({queued.length})</div>
          {queued.map((sig, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < queued.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>{sig.symbol}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: C.whale }}>🐋 {fmtUsd(sig.triggerAmountUsd)}</span>
                <span style={{ fontSize: 9, color: C.yellow }}>{sig.sizePct}% position</span>
                <span style={{ fontSize: 8, color: C.gray }}>{timeAgo(sig.queuedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Tracked Tokens ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ ...C.label, marginBottom: 8 }}>
          TRACKED TOKENS — 30min WATCH WINDOW {tracked.length > 0 && `(${tracked.length})`}
        </div>
        {tracked.length === 0 ? (
          <div style={{ ...C.card, color: C.gray, fontSize: 11, textAlign: 'center', padding: '24px 16px' }}>
            Watching for pump.fun graduations…<br />
            <span style={{ fontSize: 9, color: '#2a3a50', marginTop: 6, display: 'block' }}>Every migrated token is tracked for 30 minutes</span>
          </div>
        ) : (
          tracked
            .slice()
            .sort((a, b) => b.whaleBuys.length - a.whaleBuys.length || b.migrationTime - a.migrationTime)
            .map(tok => <TrackedCard key={tok.mint} tok={tok} tick={tick} />)
        )}
      </div>

      {/* ── Whale Buy Feed ── */}
      <div style={{ ...C.card, marginBottom: 16 }}>
        <div style={{ ...C.label, marginBottom: 2 }}>WHALE BUY FEED</div>
        <div style={{ fontSize: 9, color: '#2a3a50', marginBottom: 10 }}>All detected buys ≥$500 on tracked tokens</div>
        {buyLogs.length === 0 ? (
          <div style={{ fontSize: 11, color: C.gray, textAlign: 'center', padding: '16px 0' }}>No whale buys detected yet</div>
        ) : (
          buyLogs.map((log, i) => <WhaleBuyRow key={i} entry={log} />)
        )}
      </div>

      {/* ── Recently Closed ── */}
      {closed.length > 0 && (
        <div style={{ ...C.card, marginBottom: 16 }}>
          <div style={{ ...C.label, marginBottom: 8 }}>RECENTLY CLOSED</div>
          {closed.slice(0, 10).map((pos, i) => <ClosedCard key={i} pos={pos} />)}
        </div>
      )}

      {/* ── Graduation source feed ── */}
      <GraduationFeed />
    </div>
  );
}
