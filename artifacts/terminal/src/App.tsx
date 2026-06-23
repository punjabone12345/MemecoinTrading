import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Position, Token, Analytics, Settings, ScanStats } from './lib/types.js';
import { api, createWS } from './lib/api.js';
import DiscoverPage from './pages/DiscoverPage.js';
import PositionsPage from './pages/PositionsPage.js';
import AnalyticsPage from './pages/AnalyticsPage.js';
import SettingsPage from './pages/SettingsPage.js';
import WatchlistPage from './pages/WatchlistPage.js';

const TRADING_MODE = import.meta.env.VITE_TRADING_MODE || 'paper';

type Tab = 'discover' | 'watchlist' | 'positions' | 'analytics' | 'settings';
const TAB_ORDER: Tab[] = ['discover', 'watchlist', 'positions', 'analytics', 'settings'];

const DEFAULT_SETTINGS: Settings = {
  minMc: 500000, maxMc: 7000000, minVolume24h: 100000,
  minAgeHours: 0, maxAgeHours: 720, scanFrequencyMs: 30000,
  minBuySellRatio: 1.1, maxTopHolder: 25, maxCreatorPct: 15,
  minLiquidity: 20000, rugcheckEnabled: false, minEntryScore: 50,
  trendChecksRequired: 2, maxOpenPositions: 5,
  sizeScore90: 1, sizeScore80: 0.75, sizeScore70: 0.5,
  slPct: 25, tp1Pct: 70, tp1ClosePct: 30, tp2Pct: 150,
  tp2ClosePct: 30, tp3Pct: 300, tp3ClosePct: 20, trailingSLPct: 20,
  maxDailyLossPct: 5, startingBalanceSol: 10, currentBalanceSol: 10,
  rpcEndpoint: 'https://api.mainnet-beta.solana.com',
  slippagePct: 1, priorityFeeSol: 0.001, walletPublicKey: '',
};

interface NavTab { id: Tab; label: string; color: string; icon: React.ReactNode }

const NAV: NavTab[] = [
  { id: 'discover', label: 'Scan', color: '#00d4ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> },
  { id: 'watchlist', label: 'Watch', color: '#ffd700', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> },
  { id: 'positions', label: 'Trades', color: '#00ff88', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> },
  { id: 'analytics', label: 'Stats', color: '#9b59ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { id: 'settings', label: 'Setup', color: '#8099bb', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> },
];

const slide = {
  enter: (d: number) => ({ x: d > 0 ? '55%' : '-55%', opacity: 0, scale: 0.97 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (d: number) => ({ x: d < 0 ? '55%' : '-55%', opacity: 0, scale: 0.97 }),
};
const spring = { type: 'spring' as const, stiffness: 420, damping: 40, mass: 0.85 };

export default function App() {
  const [tab, setTab] = useState<Tab>('discover');
  const [prevTab, setPrevTab] = useState<Tab>('discover');
  const [tokens, setTokens] = useState<Token[]>([]);
  const [scanStats, setScanStats] = useState<ScanStats>({ scanning: 0, passed: 0, eligible: 0 });
  const [openPositions, setOpenPositions] = useState<Position[]>([]);
  const [closedPositions, setClosedPositions] = useState<Position[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [balance, setBalance] = useState<number>(10);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // Retry every 4 seconds until API is reachable
      retryRef.current = setTimeout(loadInitial, 4000);
    }
  }, []);

  useEffect(() => {
    loadInitial();
    return () => { if (retryRef.current) clearTimeout(retryRef.current); };
  }, [loadInitial]);

  useEffect(() => {
    let reconnectDelay = 1500;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      const ws = createWS((msg) => {
        if (msg.type === 'positions') {
          const p = msg.data as Position[];
          setOpenPositions(p.filter((x) => x.status === 'OPEN'));
        }
        if (msg.type === 'tokens') {
          const d = msg.data as { tokens: Token[]; stats: ScanStats };
          setTokens(d.tokens);
          setScanStats(d.stats);
        }
        if (msg.type === 'analytics') setAnalytics(msg.data as Analytics);
        if (msg.type === 'balance') setBalance((msg.data as { balance: number }).balance);
      });
      ws.onopen = () => { setWsConnected(true); reconnectDelay = 1500; };
      ws.onclose = () => {
        setWsConnected(false);
        if (!destroyed) setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
      };
      ws.onerror = () => { ws.close(); };
      wsRef.current = ws;
    };

    connect();
    return () => { destroyed = true; wsRef.current?.close(); };
  }, []);

  const refreshClosed = useCallback(async () => {
    try { setClosedPositions(await api.getClosedPositions()); } catch {}
  }, []);

  const handleTab = (t: Tab) => { if (t === tab) return; setPrevTab(tab); setTab(t); };
  const dir = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(prevTab) ? 1 : -1;

  const openCount = openPositions.length;
  const eligibleCount = tokens.filter((t) => t.status === 'ELIGIBLE').length;

  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

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
        {/* Logo */}
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

        {/* Right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 8, color: '#4a6080', letterSpacing: '0.1em', fontWeight: 700 }}>BALANCE</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: '#00d4ff', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums' }}>
              {balance.toFixed(3)}<span style={{ fontSize: 9, opacity: 0.6, marginLeft: 3 }}>SOL</span>
            </div>
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
        <AnimatePresence initial={false} custom={dir} mode="popLayout">
          <motion.div
            key={tab}
            custom={dir}
            variants={slide}
            initial="enter"
            animate="center"
            exit="exit"
            transition={spring}
            style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', padding: '16px 16px 12px' }}
          >
            {tab === 'discover' && <DiscoverPage tokens={tokens} scanStats={scanStats} settings={settings} />}
            {tab === 'watchlist' && <WatchlistPage tokens={tokens} />}
            {tab === 'positions' && (
              <PositionsPage
                openPositions={openPositions} closedPositions={closedPositions}
                balance={balance} analytics={analytics}
                onRefresh={async () => { await loadInitial(); await refreshClosed(); }}
              />
            )}
            {tab === 'analytics' && (
              <AnalyticsPage analytics={analytics} closedPositions={closedPositions} balance={balance} onRefresh={refreshClosed} />
            )}
            {tab === 'settings' && (
              <SettingsPage settings={effectiveSettings} onUpdate={(s) => setSettings(s)} />
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
          const badge = t.id === 'positions' ? openCount : t.id === 'watchlist' ? eligibleCount : 0;
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
