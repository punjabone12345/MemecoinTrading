import { useState, useEffect, useRef, useCallback, useTransition, memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Settings, AltcoinStatusResponse } from './lib/types.js';
import { api, createWS } from './lib/api.js';
import DiscoverPage from './pages/DiscoverPage.js';
import PositionsPage from './pages/PositionsPage.js';
import AnalyticsPage from './pages/AnalyticsPage.js';
import SettingsPage from './pages/SettingsPage.js';
import DiagnosticsPage from './pages/DiagnosticsPage.js';

type Tab = 'discover' | 'positions' | 'analytics' | 'diagnostics' | 'settings';

const DEFAULT_SETTINGS: Settings = {
  botEnabled: true,
  startingBalanceUsd: 100,
  currentBalanceUsd: 100,
  riskPerTradePct: 0.5,
  maxOpenPositions: 5,
  minAiScore: 75,
  minRiskRewardRatio: 1.5,
  universeSize: 100,
  paperTradingOnly: true,
  liveTradingEnabled: false,
};

interface NavTab { id: Tab; label: string; color: string; icon: React.ReactNode }

const NAV: NavTab[] = [
  { id: 'discover',     label: 'Scan',      color: '#00d4ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg> },
  { id: 'positions',    label: 'Trades',    color: '#00ff88', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg> },
  { id: 'analytics',    label: 'Stats',     color: '#9b59ff', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg> },
  { id: 'diagnostics',  label: 'AI Health', color: '#ff8844', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg> },
  { id: 'settings',     label: 'Setup',     color: '#8099bb', icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg> },
];

const pageVariants = {
  enter: { opacity: 0, y: 10 },
  center: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};
const pageTrans = { duration: 0.14, ease: 'easeOut' as const };

const MemoDiscover     = memo(DiscoverPage);
const MemoPositions    = memo(PositionsPage);
const MemoAnalytics    = memo(AnalyticsPage);
const MemoDiagnostics  = memo(DiagnosticsPage);
const MemoSettings     = memo(SettingsPage);

export default function App() {
  const [tab, setTab] = useState<Tab>('discover');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [altcoinStatus, setAltcoinStatus] = useState<AltcoinStatusResponse | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [httpConnected, setHttpConnected] = useState(false);
  const [, startTransition] = useTransition();

  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const isOnline = wsConnected || httpConnected;

  const loadInitial = useCallback(async () => {
    try {
      const [settingsData, statusData] = await Promise.all([
        api.getSettings(),
        api.getAltcoinStatus(),
      ]);
      setSettings(settingsData);
      setAltcoinStatus(statusData);
      setHttpConnected(true);
    } catch {
      retryRef.current = setTimeout(loadInitial, 3000);
    }
  }, []);

  useEffect(() => {
    loadInitial();
    return () => { if (retryRef.current) clearTimeout(retryRef.current); };
  }, [loadInitial]);

  // WebSocket connect with immediate state detection
  useEffect(() => {
    let reconnectDelay = 500;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      const ws = createWS(
        (msg) => {
          if (msg.type === 'settings') setSettings(msg.data as Settings);
          if (msg.type === 'altcoin_status' || msg.type === 'sniper_status') {
            setAltcoinStatus(msg.data as AltcoinStatusResponse);
            setHttpConnected(true);
          }
        },
        () => {
          setWsConnected(true);
          setHttpConnected(true);
          reconnectDelay = 500;
          api.getAltcoinStatus().then((s) => { setAltcoinStatus(s); setHttpConnected(true); }).catch(() => {});
        },
        () => {
          setWsConnected(false);
          if (!destroyed) setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
        },
        () => {
          setWsConnected(false);
        }
      );

      if (ws.readyState === WebSocket.OPEN) {
        setWsConnected(true);
        setHttpConnected(true);
      }

      wsRef.current = ws;
    };

    connect();
    return () => { destroyed = true; wsRef.current?.close(); };
  }, []);

  // Fallback HTTP Polling (guarantees LIVE connection even if WS proxy blocks)
  useEffect(() => {
    const poll = async () => {
      try {
        const statusData = await api.getAltcoinStatus();
        setAltcoinStatus(statusData);
        setHttpConnected(true);
      } catch {
        // network offline
      }
    };
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, []);

  const refreshAll = useCallback(async () => {
    await loadInitial();
  }, [loadInitial]);

  const handleTab = useCallback((t: Tab) => {
    if (t === tab) return;
    startTransition(() => setTab(t));
  }, [tab]);

  const portfolio = altcoinStatus?.portfolio;
  const openPositions = altcoinStatus?.openPositions ?? [];
  const openCount = openPositions.length;
  const effectiveSettings = settings ?? DEFAULT_SETTINGS;

  const currentEquity = portfolio?.currentEquityUsd ?? 100.00;
  const unrealizedPnl = portfolio?.unrealizedPnlUsd ?? 0.00;

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: '#080d1a', overflow: 'hidden' }}>

      {/* ── Responsive Mobile & Android Optimized Header ── */}
      <header style={{
        flexShrink: 0, minHeight: 54, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 12px',
        background: 'linear-gradient(180deg, rgba(0,212,255,0.04) 0%, rgba(8,13,26,0) 100%)',
        borderBottom: '1px solid rgba(0,212,255,0.1)',
        backdropFilter: 'blur(20px)', gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{
            width: 32, height: 32, flexShrink: 0, borderRadius: 10,
            background: 'linear-gradient(135deg, rgba(0,212,255,0.2), rgba(155,89,255,0.2))',
            border: '1px solid rgba(0,212,255,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 16px rgba(0,212,255,0.15)',
            overflow: 'hidden', padding: 3,
          }}>
            <img src="/favicon.svg" alt="Logo" style={{ width: '100%', height: '100%' }} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 900, letterSpacing: '0.04em', background: 'linear-gradient(90deg, #00d4ff, #9b59ff, #00ff88)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', whiteSpace: 'nowrap' }}>
              ALTCOIN BOT
            </div>
            <div style={{ fontSize: 7.5, color: '#4a6080', letterSpacing: '0.1em', fontWeight: 700, marginTop: -2, whiteSpace: 'nowrap' }}>
              AI INTRADAY
            </div>
          </div>
          <div style={{
            padding: '2px 7px', borderRadius: 5, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.04em',
            background: 'rgba(0,212,255,0.1)', color: '#00d4ff', border: '1px solid rgba(0,212,255,0.3)',
            whiteSpace: 'nowrap',
          }}>
            📄 $100
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 7.5, color: '#4a6080', letterSpacing: '0.08em', fontWeight: 700, whiteSpace: 'nowrap' }}>
              EQUITY{openPositions.length > 0 && (
                <span style={{ marginLeft: 3, color: unrealizedPnl >= 0 ? '#00ff88' : '#ff4466' }}>
                  {unrealizedPnl >= 0 ? '▲' : '▼'}${Math.abs(unrealizedPnl).toFixed(2)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 14, fontWeight: 900, color: '#00d4ff', letterSpacing: '-0.01em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              ${currentEquity.toFixed(2)}<span style={{ fontSize: 8, opacity: 0.6, marginLeft: 2 }}>USD</span>
            </div>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: isOnline ? 'rgba(0,255,136,0.08)' : 'rgba(255,68,102,0.08)',
            border: `1px solid ${isOnline ? 'rgba(0,255,136,0.25)' : 'rgba(255,68,102,0.25)'}`,
            padding: '4px 8px', borderRadius: 8,
          }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%',
              background: isOnline ? '#00ff88' : '#ff4466',
              boxShadow: isOnline ? '0 0 8px #00ff88' : 'none',
            }} className={isOnline ? 'pulse-live' : ''} />
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.06em', color: isOnline ? '#00ff88' : '#ff4466' }}>
              {isOnline ? 'LIVE' : 'OFFLINE'}
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
            style={{ position: 'absolute', inset: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', padding: '12px 10px 10px' }}
          >
            {tab === 'discover' && <MemoDiscover status={altcoinStatus} wsConnected={isOnline} />}
            {tab === 'positions' && (
              <MemoPositions
                status={altcoinStatus}
                onRefresh={refreshAll}
              />
            )}
            {tab === 'analytics' && (
              <MemoAnalytics balance={currentEquity} freeBalance={portfolio?.availableBalanceUsd ?? 100} onRefresh={refreshAll} status={altcoinStatus} />
            )}
            {tab === 'diagnostics' && <MemoDiagnostics status={altcoinStatus} />}
            {tab === 'settings' && (
              <MemoSettings settings={effectiveSettings} onUpdate={(s) => setSettings(s)} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Bottom Nav Optimized for Android Safe Area ── */}
      <nav style={{
        flexShrink: 0,
        background: 'rgba(6,10,20,0.97)',
        backdropFilter: 'blur(28px)',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        paddingBottom: 'max(env(safe-area-inset-bottom, 8px), 8px)',
        zIndex: 60,
      }}>
        {NAV.map((t) => {
          const active = tab === t.id;
          const badge = t.id === 'positions' ? openCount : 0;
          return (
            <button
              key={t.id}
              onClick={() => handleTab(t.id)}
              style={{
                flex: 1, border: 'none', background: 'transparent', cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', padding: '8px 2px 6px', gap: 4, position: 'relative',
                minHeight: 48, touchAction: 'manipulation',
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
              <div style={{ position: 'relative', color: active ? t.color : '#3a5070', transition: 'color 0.2s, transform 0.2s', transform: active ? 'scale(1.08)' : 'scale(1)' }}>
                {t.icon}
                {badge > 0 && (
                  <span style={{
                    position: 'absolute', top: -5, right: -7,
                    minWidth: 15, height: 15, borderRadius: 8,
                    background: '#00ff88',
                    color: '#080d1a', fontSize: 8.5, fontWeight: 900,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
                  }}>{badge}</span>
                )}
              </div>
              <span style={{ fontSize: 9, fontWeight: active ? 800 : 500, letterSpacing: '0.04em', color: active ? t.color : '#3a5070', transition: 'color 0.2s' }}>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
