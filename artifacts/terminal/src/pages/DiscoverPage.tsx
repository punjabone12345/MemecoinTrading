import { useState, useEffect, useRef } from 'react';
import { SniperStatus, TrackedToken, BuyerActivityLog, PendingSignal } from '../lib/types.js';
import { api } from '../lib/api.js';

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  /** Real-time sniper status pushed via App-level WebSocket. */
  sniperStatus?: SniperStatus | null;
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

// ── Sniper status hook (polling fallback when WS data is absent) ───────────────

function useSniperStatusFallback(skip: boolean) {
  const [status, setStatus] = useState<SniperStatus | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    async function poll() {
      try {
        const data = await api.getSniperStatus();
        if (!cancelled) setStatus(data);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [skip]);

  return status;
}

// ── Discovery source feed hook ────────────────────────────────────────────────

type GmgnDiscoverySource = 'rank_1m' | 'rank_5m' | 'rank_1h' | 'migrated';
interface DiscoveryEvent { mint: string; ts: number; description?: string; icon?: string; isMigration: boolean; discoverySource?: GmgnDiscoverySource; }
interface GmgnPollerStats { label?: string; pollCount: number; lastSuccessAgoSec: number | null; consecutiveFailures: number; lastError: string | null; intervalMs: number; firedTotal?: number; }
interface SourceActivity {
  dexscreener: { total: number; recent: DiscoveryEvent[] };
  gmgn: {
    total: number;
    recent: DiscoveryEvent[];
    pollers?: { newPairs: GmgnPollerStats; trending: GmgnPollerStats; trending1h?: GmgnPollerStats; migrated?: GmgnPollerStats };
    avgDiscoveryDelaySec?: number | null;
    gmgnApiKeySet?: boolean;
    gmgnBanned?: boolean;
    firedBySource?: { rank_1m: number; rank_5m: number; rank_1h: number; migrated: number };
  };
}

function useSourceActivity() {
  const [data, setData] = useState<SourceActivity | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const json = await api.getScannerSources();
        if (!cancelled) setData(json as unknown as SourceActivity);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return data;
}

// ── Sub-components ────────────────────────────────────────────────────────────

const C = {
  card:   { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: '12px 14px', marginBottom: 10 } as React.CSSProperties,
  label:  { fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: '#3a5070' } as React.CSSProperties,
  accent: '#00bfff',
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
      <span style={{ fontSize: 18, fontWeight: 900, color: color ?? C.accent, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
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
  const biggestBuy = tok.buyerActivity.reduce((max, b) => b.amountUsd > max ? b.amountUsd : max, 0);
  const hasMarket  = (tok.price ?? 0) > 0;

  return (
    <div style={{
      ...C.card, marginBottom: 8,
      borderColor: tok.entryTriggered ? 'rgba(0,255,136,0.25)' : biggestBuy >= 750 ? 'rgba(0,191,255,0.3)' : 'rgba(255,255,255,0.07)',
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
        <div style={{ margin: '10px 0 6px' }}>
          {/* Row 1: price / mcap / liq / vol 24h */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6, padding: '8px 10px',
            borderRadius: '8px 8px 0 0', background: 'rgba(0,191,255,0.04)',
            border: '1px solid rgba(0,191,255,0.08)', borderBottom: 'none',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff', fontVariantNumeric: 'tabular-nums' }}>{fmtPrice(tok.price)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>price</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.mcap)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>mcap</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.liquidity)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>liquidity</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: '#e0e8ff' }}>${fmtCompact(tok.volume24h ?? tok.volume1h ?? tok.volume5m)}</div>
              <div style={{ fontSize: 8, color: C.gray }}>{tok.volume24h != null ? 'vol 24h' : tok.volume1h != null ? 'vol 1h' : 'vol 5m'}</div>
            </div>
          </div>
          {/* Row 2: price changes / txns / updated */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 6, padding: '6px 10px',
            borderRadius: '0 0 8px 8px', background: 'rgba(0,191,255,0.02)',
            border: '1px solid rgba(0,191,255,0.08)',
          }}>
            <PctBadge value={tok.priceChange5m} label="5m chg" />
            <PctBadge value={tok.priceChange1h} label="1h chg" />
            <PctBadge value={tok.priceChange24h} label="24h chg" />
            <div style={{ textAlign: 'center' }}>
              {(tok.txnsH24Buys != null && tok.txnsH24Buys > 0) || (tok.txnsH24Sells != null && tok.txnsH24Sells > 0) ? (
                <>
                  <div style={{ fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: C.green }}>{tok.txnsH24Buys ?? 0}B</span>
                    <span style={{ color: C.gray }}> / </span>
                    <span style={{ color: C.red }}>{tok.txnsH24Sells ?? 0}S</span>
                  </div>
                  <div style={{ fontSize: 8, color: C.gray }}>txns 24h</div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 9, color: C.gray }}>{tok.lastMarketUpdate ? timeAgo(tok.lastMarketUpdate) : '—'}</div>
                  <div style={{ fontSize: 8, color: C.gray }}>updated</div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 9, color: C.gray, margin: '8px 0 4px', fontStyle: 'italic' }}>
          Fetching market data…
        </div>
      )}

      {/* ── Progress bar ── */}
      <div style={{ margin: '6px 0 6px', height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: expired ? C.red : pct > 80 ? `linear-gradient(90deg,${C.yellow},${C.red})` : `linear-gradient(90deg,${C.accent},#7b5ea7)`, transition: 'width 1s linear' }} />
      </div>

      {/* ── Buyer activity chips ── */}
      {tok.buyerActivity.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
          {tok.buyerActivity.slice(0, 5).map((b, i) => (
            <span key={i} style={{
              fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
              background: b.amountUsd >= 2250 ? 'rgba(0,191,255,0.18)' : b.amountUsd >= 1500 ? 'rgba(0,191,255,0.11)' : 'rgba(0,191,255,0.06)',
              color: C.accent, border: '1px solid rgba(0,191,255,0.2)',
            }}>
              📈 {fmtUsd(b.amountUsd)} · {timeAgo(b.detectedAt ?? b.timestamp)}
            </span>
          ))}
        </div>
      )}
      {!hasMarket && tok.buyerActivity.length === 0 && (
        <div style={{ fontSize: 9, color: C.gray }}>Monitoring 10s volume…</div>
      )}
    </div>
  );
}

function BuyerActivityRow({ entry }: { entry: BuyerActivityLog }) {
  const score = entry.walletScore;
  const scoreColor = score == null ? C.gray : score >= 95 ? C.green : score >= 80 ? C.accent : C.gray;
  const modeLabel = entry.consensusMode === 'solo' ? 'SOLO ≥95'
    : entry.consensusMode === 'consensus' ? 'CONSENSUS'
    : entry.consensusMode === 'tracking' ? `${entry.qualifyingWalletsCount ?? 0}/2 QUALIFYING`
    : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)',
    }}>
      <div style={{
        flexShrink: 0, marginTop: 1, width: 34, height: 34, borderRadius: 8,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: `rgba(${score != null && score >= 95 ? '0,255,136' : score != null && score >= 80 ? '0,191,255' : '255,255,255'},0.1)`,
        border: `1px solid ${scoreColor}55`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 900, color: scoreColor, lineHeight: 1 }}>{score ?? '—'}</span>
        <span style={{ fontSize: 6, color: C.gray, lineHeight: 1 }}>GMGN</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 900, color: C.accent }}>{fmtUsd(entry.amountUsd)}</span>
          <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>buy on {entry.symbol}</span>
          <DexLink mint={entry.mint} />
          {modeLabel && (
            <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: 'rgba(155,89,255,0.12)', color: '#9b59ff', border: '1px solid rgba(155,89,255,0.3)' }}>
              {modeLabel}
            </span>
          )}
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
          {shortAddr(entry.wallet)} · {timeAgo(entry.detectedAt ?? entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

// ── Source feed (GMGN discovery events) ──────────────────────────────────────

function DiscoveryFeed() {
  const data = useSourceActivity();

  const gmgn        = data?.gmgn;
  const events      = gmgn?.recent ?? data?.dexscreener?.recent ?? [];
  const total       = gmgn?.total  ?? data?.dexscreener?.total ?? 0;
  const keySet      = gmgn?.gmgnApiKeySet ?? true;  // optimistic until first response
  const banned      = gmgn?.gmgnBanned ?? false;
  const avgDelaySec = gmgn?.avgDiscoveryDelaySec;

  // Status dot colour
  const dotColor = !keySet ? C.yellow : banned ? C.red : C.green;
  const statusLabel = !keySet ? 'NO KEY' : banned ? 'BANNED' : 'LIVE';

  return (
    <div style={C.card}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={C.label}>📡 LATEST TOKENS (GMGN)</span>
        <span style={{ fontSize: 9, color: dotColor, fontWeight: 700 }}>
          <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: dotColor, boxShadow: `0 0 6px ${dotColor}`, marginRight: 4, verticalAlign: 'middle' }} />
          {statusLabel}
        </span>
        <span style={{ fontSize: 9, color: C.gray, marginLeft: 'auto' }}>
          discovered: {total}
          {avgDelaySec != null && ` · avg ${avgDelaySec}s delay`}
        </span>
      </div>

      {/* Status messages */}
      {!keySet ? (
        <div style={{ fontSize: 9, color: C.yellow, padding: '6px 0' }}>
          GMGN_API_KEY not set — discovery requires the key to bypass Cloudflare.<br />
          <span style={{ color: '#2a3a50' }}>Key is configured on Render; push changes to see live tokens.</span>
        </div>
      ) : banned ? (
        <div style={{ fontSize: 9, color: C.red, padding: '6px 0' }}>
          GMGN rate-limited — discovery paused until ban clears.
        </div>
      ) : events.length === 0 ? (
        <div style={{ fontSize: 9, color: C.gray }}>Scanning GMGN for new token pairs…</div>
      ) : (
        events.slice(0, 8).map((ev, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < 7 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
            <div style={{ fontSize: 9, color: '#c0c8e0', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 5 }}>
              {ev.mint.slice(0, 8)}…{ev.mint.slice(-6)}
              {ev.discoverySource && (() => {
                const cfg: Record<string, { bg: string; color: string; border: string; label: string }> = {
                  rank_1h:  { bg: 'rgba(0,200,100,0.12)',   color: '#00c864', border: 'rgba(0,200,100,0.25)',   label: '1H RANK'   },
                  rank_5m:  { bg: 'rgba(80,160,255,0.12)',  color: '#50a0ff', border: 'rgba(80,160,255,0.25)',  label: '5M RANK'   },
                  rank_1m:  { bg: 'rgba(200,80,255,0.12)',  color: '#c850ff', border: 'rgba(200,80,255,0.25)',  label: '1M RANK'   },
                  migrated: { bg: 'rgba(255,140,0,0.12)',   color: '#ff8c00', border: 'rgba(255,140,0,0.25)',   label: 'MIGRATED'  },
                };
                const s = cfg[ev.discoverySource] ?? cfg['rank_1h'];
                return (
                  <span style={{ fontSize: 7, fontWeight: 700, padding: '1px 4px', borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                    {s.label}
                  </span>
                );
              })()}
              {ev.isMigration && (
                <span style={{ fontSize: 7, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: 'rgba(255,215,0,0.12)', color: C.yellow, border: '1px solid rgba(255,215,0,0.25)' }}>RE-TRACKED</span>
              )}
            </div>
            <span style={{ fontSize: 8, color: C.gray }}>{timeAgo(ev.ts)}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DiscoverPage({ sniperStatus: wsProp, wsConnected = false }: Props) {
  // Poll only when WebSocket is offline; WS pushes sniper_status in real time when connected
  const polled = useSniperStatusFallback(wsConnected);
  const status = wsConnected ? (wsProp ?? polled) : (polled ?? wsProp);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  // Filter out locally-expired tokens client-side so the UI clears them immediately
  // even before the next backend prune broadcast arrives (every 2s poll cycle).
  const now      = Date.now();
  const tracked  = (status?.trackedTokens ?? []).filter(t => t.expiresAt > now || t.entryTriggered);
  const buyLogs  = status?.recentBuyLog   ?? [];
  const queued   = status?.queuedSignals  ?? [];
  const stats    = status?.stats ?? { tracking: 0, positions: 0, queued: 0, pending: 0 };
  const gmgnConfigured  = status?.gmgnConfigured ?? true; // avoid a false "not set" flash before the first status arrives
  const gmgnBannedUntil = status?.gmgnBannedUntil ?? 0;

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ ...C.card, marginBottom: 16, background: 'linear-gradient(135deg,rgba(0,191,255,0.06),rgba(123,94,167,0.06))', borderColor: 'rgba(0,191,255,0.2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 900, color: C.accent, letterSpacing: '0.04em' }}>🎯 SNIPER ENGINE</div>
            <div style={{ fontSize: 9, color: C.gray, marginTop: 2 }}>Tracking GMGN tokens · Paper mode</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: 9, color: C.gray }}>
            SOL<br />
            <span style={{ fontSize: 13, fontWeight: 800, color: '#e0e8ff' }}>${status?.solPriceUsd?.toFixed(0) ?? '—'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '0 -2px' }}>
          <StatPill label="Pending" value={stats.pending ?? 0} color={(stats.pending ?? 0) > 0 ? C.accent : C.gray} />
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
            { label: 'Solo score ≥95 → 1%',        color: 'rgba(0,255,136,0.18)' },
            { label: 'Consensus 2x ≥80 → 0.75%',   color: 'rgba(0,191,255,0.22)' },
            { label: 'GMGN wallet scoring',         color: 'rgba(155,89,255,0.18)' },
            { label: 'TP +100%',      color: 'rgba(0,255,136,0.15)' },
            { label: 'SL price -30%', color: 'rgba(255,68,102,0.12)' },
            { label: 'SL liq -40%',   color: 'rgba(255,68,102,0.12)' },
            { label: '1hr window',    color: 'rgba(255,215,0,0.10)' },
          ].map(({ label, color }) => (
            <span key={label} style={{ fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: color, color: '#c0c8e0', border: '1px solid rgba(255,255,255,0.08)' }}>{label}</span>
          ))}
        </div>
      </div>

      {/* ── Queued signals ── */}
      {queued.length > 0 && (
        <div style={{ ...C.card, marginBottom: 16, borderColor: 'rgba(255,215,0,0.2)' }}>
          <div style={{ ...C.label, marginBottom: 8 }}>⏳ QUEUED SIGNALS ({queued.length})</div>
          {queued.map((sig, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < queued.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
              <span style={{ fontSize: 10, color: '#e0e8ff', fontWeight: 700 }}>{sig.symbol}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 9, color: C.accent }}>🎯 {fmtUsd(sig.triggerAmountUsd)}</span>
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
          TRACKED TOKENS — 1HR WATCH WINDOW {tracked.length > 0 && `(${tracked.length})`}
        </div>
        {tracked.length === 0 ? (
          <div style={{ ...C.card, color: C.gray, fontSize: 11, textAlign: 'center', padding: '24px 16px' }}>
            Scanning GMGN for new tokens…<br />
            <span style={{ fontSize: 9, color: '#2a3a50', marginTop: 6, display: 'block' }}>Every discovered token is tracked for 1 hour</span>
          </div>
        ) : (
          tracked
            .slice()
            .sort((a, b) => b.buyerActivity.length - a.buyerActivity.length || b.migrationTime - a.migrationTime)
            .map(tok => <TrackedCard key={tok.mint} tok={tok} tick={tick} />)
        )}
      </div>

      {/* ── Wallet Signal Feed ── */}
      <div style={{ ...C.card, marginBottom: 16 }}>
        <div style={{ ...C.label, marginBottom: 2 }}>🧠 SMART WALLET SIGNAL FEED</div>
        <div style={{ fontSize: 9, color: '#2a3a50', marginBottom: 10 }}>
          Every buyer on a tracked token is scored via GMGN — entry fires on a single ≥95 score (solo conviction) or two+ wallets ≥80 within 5 min (consensus)
        </div>
        {!gmgnConfigured && (
          <div style={{ fontSize: 10, color: C.red, padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.2)' }}>
            ⚠️ GMGN_API_KEY not set — wallet scores will be 0; entries won't trigger until the key is added
          </div>
        )}
        {gmgnBannedUntil > 0 && (
          <div style={{ fontSize: 10, color: C.yellow, padding: '6px 10px', marginBottom: 8, borderRadius: 6, background: 'rgba(255,200,0,0.08)', border: '1px solid rgba(255,200,0,0.2)' }}>
            ⏳ GMGN rate-limited — scoring paused until {new Date(gmgnBannedUntil).toLocaleTimeString()}
          </div>
        )}
        {buyLogs.length === 0 ? (
          <div style={{ fontSize: 11, color: C.gray, textAlign: 'center', padding: '16px 0' }}>No buyer wallets scored yet</div>
        ) : (
          buyLogs.map((log, i) => <BuyerActivityRow key={i} entry={log} />)
        )}
      </div>

      {/* ── DexScreener discovery feed ── */}
      <DiscoveryFeed />
    </div>
  );
}
