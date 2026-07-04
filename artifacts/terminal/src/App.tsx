import { useState, useEffect, useRef, useCallback, useTransition, memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Position, Token, Analytics, Settings, ScanStats, WhaleStatus } from './lib/types.js';
import { api, createWS } from './lib/api.js';
import DiscoverPage from './pages/DiscoverPage.js';
import PositionsPage from './pages/PositionsPage.js';
import AnalyticsPage from './pages/AnalyticsPage.js';
import SettingsPage from './pages/SettingsPage.js';

const TRADING_MODE = import.meta.env.VITE_TRADING_MODE || 'paper';

type Tab = 'discover' | 'positions' | 'analytics' | 'settings';
const TAB_ORDER: Tab[] = ['discover', 'positions', 'analytics', 'settings'];

const DEFAULT_SETTINGS: Settings = {
  minMc: 500000, maxMc: 7000000, minVolume24h: 100000,
  minAgeHours: 0, maxAgeHours: 720, scanFrequencyMs: 30000,
  minBuySellRatio: 1.1, maxTopHolder: 25, maxCreatorPct: 15,
  minLiquidity: 20000, rugcheckEnabled: false, minEntryScore: 50,
  trendChecksRequired: 2, maxOpenPositions: 5,
  sizeScore90: 1, sizeScore80: 0.75, sizeScore70: 0.5,
  slPct: 25, tp1Pct: 70, tp1ClosePct: 30, tp2Pct: 150,
  tp2ClosePct: 30, tp2TrailPct: 30, tp3Pct: 300, tp3ClosePct: 20, trailingSLPct: 20, trailActivatePct: 50,
  maxDailyLossPct: 5, startingBalanceSol: 10, currentBalanceSol: 10,
  rpcEndpoint: 'https://api.mainnet-beta.solana.com',
  slippagePct: 1, priorityFeeSol: 0.001, walletPublicKey: '', whaleSlippagePct: 20,
};

interface NavTab { id: Tab; label: string; color: string; icon: React.ReactNode }

const NAV: NavTab[] = [
  { id: 'discover', label: 'Scan', color: '#00d4ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> },
  { id: 'positions', label: 'Trades', color: '#00ff88', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> },
  { id: 'analytics', label: 'Stats', color: '#9b59ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { id: 'settings', label: 'Setup', color: '#8099bb', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> },
];

// Lightweight fade + tiny upward slide — much cheaper than 55% horizontal
const pageVariants = {
  enter: { opacity: 0, y: 10 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};
const pageTrans = { duration: 0.14, ease: 'easeOut' as const };

// Memoized pages — only re-render when their own props change
const MemoDiscover = memo(DiscoverPage);
const MemoPositions = memo(PositionsPage);
const MemoAnalytics = memo(AnalyticsPage);
const MemoSettings = memo(SettingsPage);

export default function App() {
  const [tab, setTab] = useState<Tab>('discover');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [scanStats, setScanStats] = useState<ScanStats>({ scanning: 0, passed: 0, eligible: 0 });
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<Position[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [balance, setBalance] = useState<number>(10);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [whaleStatus, setWhaleStatus] = useState<WhaleStatus | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [, startTransition] = useTransition();

  // Use a ref so polling closure always sees latest WS state without re-creating interval
  const wsConnectedRef = useRef(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadInitial = useCallback(async () => {
    try {
      const [posData, scanData, settingsData, analyticsData] = await Promise.all([
        api.getPositions(),
        api.getScanner(),
        api.getSettings(),
        api.getAnalytics(),
      ]);
      setOpenPositions(posData.open);
      setClosedPositions(posData.closed);
      setTokens(scanData.tokens);
      setScanStats(scanData.stats);
      setSettings(settingsData);
      setBalance(settingsData.currentBalanceSol);
      setAnalytics(analyticsData);
      setDataLoaded(true);
    } catch {
      retryRef.current = setTimeout(loadInitial, 3000);
    }
  }, []);

  useEffect(() => {
    loadInitial();
    return () => { if (retryRef.current) clearTimeout(retryRef.current); };
  }, [loadInitial]);

  // WebSocket — reconnects fast, feeds all real-time data
  useEffect(() => {
    let reconnectDelay = 500;
    let destroyed = false;

    const connect = async () => {
      if (destroyed) return;
      const ws = await createWS((msg) => {
        // All setState calls inside a single WS message handler are auto-batched
        // by React 18 — no extra work needed.
        if (msg.type === 'positions') {
          const p = msg.data as { open: Position[]; closed: Position[] } | Position[];
          if (Array.isArray(p)) {
            setOpenPositions(p.filter((x) => x.status === 'OPEN'));
          } else {
            setOpenPositions(p.open);
            setClosedPositions(p.closed);
          }
        }
        if (msg.type === 'tokens') {
          const d = msg.data as { tokens: Token[]; stats: ScanStats };
          // Wrap in startTransition so heavy token list re-render doesn't
          // block urgent input/animation frames
          startTransition(() => {
            setTokens(d.tokens);
            setScanStats(d.stats);
          });
        }
        if (msg.type === 'analytics') setAnalytics(msg.data as Analytics);
        if (msg.type === 'balance') setBalance((msg.data as { balance: number }).balance);
        if (msg.type === 'settings') setSettings(msg.data as Settings);
        if (msg.type === 'whale_status') setWhaleStatus(msg.data as WhaleStatus);
      });
      if (destroyed) { ws.close(); return; }
      ws.onopen = () => {
        setWsConnected(true);
        wsConnectedRef.current = true;
        reconnectDelay = 500;
      };
      ws.onclose = () => {
        setWsConnected(false);
        wsConnectedRef.current = false;
        if (!destroyed) setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
      };
      ws.onerror = () => { ws.close(); };
      wsRef.current = ws;
    };

    connect();
    return () => { destroyed = true; wsRef.current?.close(); };
  }, []);

  // Fallback poll — two responsibilities:
  // 1. When WS is OFFLINE: keep positions + balance fresh via HTTP every 3s.
  //    (Never overwrite positions when WS is live — WS sends price-enriched data
  //     with real currentPrice/pnlPct; the HTTP API returns raw DB rows with pnlPct=null)
  // 2. Always: refresh scanner + analytics every 15s as a safety net.
  useEffect(() => {
    let scannerTick = 0;
    const poll = async () => {
      try {
        scannerTick++;
        const wsLive = wsConnectedRef.current;

        if (!wsLive) {
          // WS offline — pull positions + balance from HTTP
          const [posData, settingsData] = await Promise.all([
            api.getPositions(),
            api.getSettings(),
          ]);
          setOpenPositions(posData.open);
          setClosedPositions(posData.closed);
          setBalance(settingsData.currentBalanceSol);
        }

        // Scanner + analytics: refresh every 15s regardless of WS state
        if (scannerTick % 5 === 0) {
          const [scanData, analyticsData] = await Promise.all([
            api.getScanner(),
            api.getAnalytics(),
          ]);
          startTransition(() => {
            setTokens(scanData.tokens);
            setScanStats(scanData.stats);
            setAnalytics(analyticsData);
          });
        }
      } catch {
        // Silently ignore
      }
    };
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const refreshClosed = useCallback(async () => {
    try { setClosedPositions(await api.getClosedPositions()); } catch {}
  }, []);

  const handleTab = useCallback((t: Tab) => {
    if (t === tab) return;
    startTransition(() => setTab(t));
  }, [tab]);

  const openCount = openPositions.length;
  const eligibleCount = tokens.filter((t) => t.status === 'ELIGIBLE').length;
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  // Unrealized PnL across all open positions — uses live currentPrice from price monitor WS ticks.
  // Falls back to entryPrice (zero gain) only when no live price has arrived yet.
  const unrealizedPnl = openPositions.reduce((sum, p) => {
    const current = p.currentPrice ?? p.entryPrice;
    const pct = (current - p.entryPrice) / p.entryPrice;
    return sum + p.sizeSol * pct;
  }, 0);

  // Portfolio value = starting balance + all realised P&L from closed trades + live unrealised P&L.
  // This formula is always correct regardless of any free-cash tracking drift in the DB.
  const startingBalance = effectiveSettings.startingBalanceSol;
  const realizedPnl = analytics?.totalPnlSol ?? 0;
  const portfolioValue = startingBalance + realizedPnl + unrealizedPnl;

  // Free balance = total equity minus capital currently deployed in open positions
  const deployedCapital = openPositions.reduce((s, p) => s + p.sizeSol, 0);
  const freeBalance = startingBalance + realizedPnl - deployedCapital;

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: '#080d1a', overflow: 'hidden' }}>

      {/* ── Header ── */}
      <header style={{
        flexShrink: 0, height: 60, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 20px',
        background: 'linear-gradient(180deg, rgba(0,212,255,0.04) 0%, rgba(8,13,26,0) 100%)',
        borderBottom: '1px solid rgba(0,212,255,0.1)',
        backdropFilter: 'blur(20px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 12,
            background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(155,89,255,0.2))',
            border: '1px solid rgba(0,212,255,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, boxShadow: '0 0 16px rgba(0,212,255,0.15)',
          }}>⚡</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: '0.06em', background: 'linear-gradient(90deg, #00d4ff, #9b59ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>APEX</div>
            <div style={{ fontSize: 8, color: '#4a6080', letterSpacing: '0.14em', fontWeight: 700, marginTop: -2 }}>MEME TRADER</div>
          </div>
          <div style={{
            padding: '3px 9px', borderRadius: 6, fontSize: 9, fontWeight: 800, letterSpacing: '0.07em',
            background: TRADING_MODE === 'live' ? 'rgba(255,68,102,0.15)' : 'rgba(0,212,255,0.1)',
            color: TRADING_MODE === 'live' ? '#ff4466' : '#00d4ff',
            border: `1px solid ${TRADING_MODE === 'live' ? 'rgba(255,68,102,0.4)' : 'rgba(0,212,255,0.3)'}`,
          }}>
            {TRADING_MODE === 'live' ? '🔴 LIVE' : '📄 PAPER'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 8, color: '#4a6080', letterSpacing: '0.1em', fontWeight: 700 }}>
              PORTFOLIO{openPositions.length > 0 && (
                <span style={{ marginLeft: 4, color: unrealizedPnl >= 0 ? '#00ff88' : '#ff4466' }}>
                  {unrealizedPnl >= 0 ? '▲' : '▼'}{Math.abs(unrealizedPnl).toFixed(3)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#00d4ff', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
              {portfolioValue.toFixed(3)}<span style={{ fontSize: 9, opacity: 0.6, marginLeft: 3 }}>SOL</span>
            </div>
            {openPositions.length > 0 && (
              <div style={{ fontSize: 8, color: '#3a5070', marginTop: 1 }}>{freeBalance.toFixed(3)} free</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: wsConnected ? '#00ff88' : '#ff4466',
              boxShadow: wsConnected ? '0 0 8px #00ff88' : 'none',
            }} className={wsConnected ? 'pulse-live' : ''} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', color: wsConnected ? '#00ff88' : '#ff4466' }}>
              {wsConnected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
        </div>
      </header>

      {/* ── Pages ── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={tab}
            variants={pageVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={pageTrans}
            style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', padding: '16px 16px 12px' }}
          >
            {tab === 'discover' && <MemoDiscover tokens={tokens} scanStats={scanStats} settings={settings} whaleStatus={whaleStatus} wsConnected={wsConnected} />}
            {tab === 'positions' && (
              <MemoPositions
                openPositions={openPositions} closedPositions={closedPositions}
                balance={portfolioValue} analytics={analytics}
                settings={settings}
                whaleStatus={whaleStatus}
                onRefresh={async () => { await loadInitial(); await refreshClosed(); }}
              />
            )}
            {tab === 'analytics' && (
              <MemoAnalytics analytics={analytics} closedPositions={closedPositions} balance={portfolioValue} onRefresh={refreshClosed} />
            )}
            {tab === 'settings' && (
              <MemoSettings settings={effectiveSettings} onUpdate={(s) => setSettings(s)} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Bottom Nav ── */}
      <nav style={{
        flexShrink: 0,
        background: 'rgba(6,10,20,0.97)',
        backdropFilter: 'blur(28px)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        paddingBottom: 'env(safe-area-inset-bottom, 4px)',
        zIndex: 60,
      }}>
        {NAV.map((t) => {
          const active = tab === t.id;
          const badge = t.id === 'positions' ? openCount : t.id === 'discover' ? eligibleCount : 0;
          return (
            <button
              key={t.id}
              onClick={() => handleTab(t.id)}
              style={{
                flex: 1, border: 'none', background: 'transparent', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', padding: '10px 4px 8px', gap: 5, position: 'relative',
              }}
            >
              {active && (
                <motion.div layoutId="nav-bar" style={{
                  position: 'absolute', top: 0, left: '20%', right: '20%', height: 2.5,
                  borderRadius: '0 0 4px 4px',
                  background: t.color,
                  boxShadow: `0 0 12px ${t.color}99`,
                }} transition={{ type: 'spring', stiffness: 500, damping: 42 }} />
              )}
              <div style={{ position: 'relative', color: active ? t.color : '#3a5070', transition: 'color 0.2s, transform 0.2s', transform: active ? 'scale(1.12)' : 'scale(1)' }}>
                {t.icon}
                {badge > 0 && (
                  <span style={{
                    position: 'absolute', top: -5, right: -7,
                    minWidth: 16, height: 16, borderRadius: 8,
                    background: t.id === 'positions' ? '#00ff88' : '#ffd700',
                    color: '#080d1a', fontSize: 9, fontWeight: 900,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
                  }}>{badge}</span>
                )}
              </div>
              <span style={{ fontSize: 9.5, fontWeight: active ? 800 : 500, letterSpacing: '0.05em', color: active ? t.color : '#3a5070', transition: 'color 0.2s' }}>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
