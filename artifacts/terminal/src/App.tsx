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

const NAV_TABS: { id: Tab; label: string; icon: JSX.Element; activeColor: string }[] = [
  {
    id: 'discover',
    label: 'Scan',
    activeColor: 'var(--cyan)',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
    ),
  },
  {
    id: 'watchlist',
    label: 'Watch',
    activeColor: 'var(--gold)',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
  },
  {
    id: 'positions',
    label: 'Trades',
    activeColor: 'var(--green)',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
        <path d="m7 10 3 3 4-5 3 3" />
      </svg>
    ),
  },
  {
    id: 'analytics',
    label: 'Stats',
    activeColor: 'var(--purple)',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Setup',
    activeColor: 'var(--text-mid)',
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
  },
];

const pageVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? '60%' : '-60%', opacity: 0, scale: 0.96 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (dir: number) => ({ x: dir < 0 ? '60%' : '-60%', opacity: 0, scale: 0.96 }),
};

const pageTransition = { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 };

const TAB_ORDER: Tab[] = ['discover', 'watchlist', 'positions', 'analytics', 'settings'];

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
    } catch (err) {
      console.error('Initial load error:', err);
    }
  }, []);

  useEffect(() => {
    loadInitial();

    const connectWS = () => {
      const ws = createWS((msg) => {
        if (msg.type === 'positions') {
          const positions = msg.data as Position[];
          setOpenPositions(positions.filter((p) => p.status === 'OPEN'));
        }
        if (msg.type === 'tokens') {
          const data = msg.data as { tokens: Token[]; stats: ScanStats };
          setTokens(data.tokens);
          setScanStats(data.stats);
        }
        if (msg.type === 'analytics') {
          setAnalytics(msg.data as Analytics);
        }
        if (msg.type === 'balance') {
          setBalance((msg.data as { balance: number }).balance);
        }
      });
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        setTimeout(connectWS, 3000);
      };
      wsRef.current = ws;
    };

    connectWS();
    return () => wsRef.current?.close();
  }, [loadInitial]);

  const refreshClosed = useCallback(async () => {
    const closed = await api.getClosedPositions();
    setClosedPositions(closed);
  }, []);

  const direction = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(prevTab) ? 1 : -1;

  const handleTabChange = (newTab: Tab) => {
    if (newTab === tab) return;
    setPrevTab(tab);
    setTab(newTab);
  };

  const openCount = openPositions.length;
  const eligibleCount = tokens.filter((t) => t.status === 'ELIGIBLE').length;

  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--navy)',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ─────────────────────────────────────── */}
      <header
        style={{
          flexShrink: 0,
          background: 'rgba(8,13,26,0.92)',
          backdropFilter: 'blur(20px)',
          borderBottom: '1px solid var(--navy-border)',
          padding: '0 16px',
          height: 56,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          zIndex: 50,
        }}
      >
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #00d4ff22, #9b59ff22)',
              border: '1px solid rgba(0,212,255,0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 16,
            }}
          >
            ⚡
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.05em', color: 'var(--text)' }}>
              APEX
            </div>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.1em', marginTop: -2 }}>
              MEME TRADER
            </div>
          </div>
          <div
            style={{
              marginLeft: 4,
              padding: '2px 8px',
              borderRadius: 6,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              background: TRADING_MODE === 'live' ? 'rgba(255,68,102,0.15)' : 'rgba(0,212,255,0.1)',
              color: TRADING_MODE === 'live' ? 'var(--red)' : 'var(--cyan)',
              border: `1px solid ${TRADING_MODE === 'live' ? 'rgba(255,68,102,0.3)' : 'rgba(0,212,255,0.25)'}`,
            }}
          >
            {TRADING_MODE === 'live' ? '🔴 LIVE' : '📄 PAPER'}
          </div>
        </div>

        {/* Right — balance + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: 'var(--text-dim)', letterSpacing: '0.08em' }}>BALANCE</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--cyan)', fontVariantNumeric: 'tabular-nums' }}>
              {balance.toFixed(3)} <span style={{ fontSize: 10, opacity: 0.7 }}>SOL</span>
            </div>
          </div>

          {/* WS status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: wsConnected ? 'var(--green)' : 'var(--red)',
                flexShrink: 0,
              }}
              className={wsConnected ? 'pulse-live' : ''}
            />
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: wsConnected ? 'var(--green)' : 'var(--red)',
              }}
            >
              {wsConnected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
        </div>
      </header>

      {/* ── Page Content ───────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <AnimatePresence initial={false} custom={direction} mode="popLayout">
          <motion.div
            key={tab}
            custom={direction}
            variants={pageVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={pageTransition}
            className="page-layer"
            style={{ padding: '12px 16px 16px' }}
          >
            {tab === 'discover' && (
              <DiscoverPage tokens={tokens} scanStats={scanStats} />
            )}
            {tab === 'watchlist' && (
              <WatchlistPage tokens={tokens} />
            )}
            {tab === 'positions' && (
              <PositionsPage
                openPositions={openPositions}
                closedPositions={closedPositions}
                balance={balance}
                analytics={analytics}
                onRefresh={async () => { await loadInitial(); await refreshClosed(); }}
              />
            )}
            {tab === 'analytics' && (
              <AnalyticsPage
                analytics={analytics}
                closedPositions={closedPositions}
                balance={balance}
                onRefresh={refreshClosed}
              />
            )}
            {tab === 'settings' && settings && (
              <SettingsPage
                settings={settings}
                onUpdate={(s) => setSettings(s)}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Bottom Navigation ──────────────────────────── */}
      <nav
        style={{
          flexShrink: 0,
          background: 'rgba(8,13,26,0.96)',
          backdropFilter: 'blur(24px)',
          borderTop: '1px solid var(--navy-border)',
          display: 'flex',
          alignItems: 'stretch',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          zIndex: 50,
        }}
      >
        {NAV_TABS.map((t) => {
          const isActive = tab === t.id;
          const badge =
            t.id === 'positions' ? openCount :
            t.id === 'watchlist' ? eligibleCount :
            0;

          return (
            <button
              key={t.id}
              onClick={() => handleTabChange(t.id)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '10px 4px 10px',
                gap: 4,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                position: 'relative',
                transition: 'all 0.15s ease',
              }}
            >
              {/* Active indicator */}
              {isActive && (
                <motion.div
                  layoutId="nav-indicator"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: '15%',
                    right: '15%',
                    height: 2,
                    borderRadius: '0 0 3px 3px',
                    background: t.activeColor,
                    boxShadow: `0 0 8px ${t.activeColor}`,
                  }}
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}

              {/* Icon */}
              <div
                style={{
                  color: isActive ? t.activeColor : 'var(--text-dim)',
                  transition: 'all 0.2s ease',
                  transform: isActive ? 'scale(1.1)' : 'scale(1)',
                  position: 'relative',
                }}
              >
                {t.icon}

                {/* Badge */}
                {badge > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -6,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 8,
                      background: t.id === 'positions' ? 'var(--green)' : 'var(--gold)',
                      color: 'var(--navy)',
                      fontSize: 9,
                      fontWeight: 900,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0 3px',
                    }}
                  >
                    {badge}
                  </span>
                )}
              </div>

              {/* Label */}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isActive ? 700 : 500,
                  letterSpacing: '0.04em',
                  color: isActive ? t.activeColor : 'var(--text-dim)',
                  transition: 'all 0.2s ease',
                }}
              >
                {t.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
