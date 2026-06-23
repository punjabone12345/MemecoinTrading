import { useState, useEffect, useRef, useCallback } from 'react';
import { Position, Token, Analytics, Settings, ScanStats } from './lib/types.js';
import { api, createWS } from './lib/api.js';
import DiscoverPage from './pages/DiscoverPage.js';
import PositionsPage from './pages/PositionsPage.js';
import AnalyticsPage from './pages/AnalyticsPage.js';
import SettingsPage from './pages/SettingsPage.js';

const TRADING_MODE = import.meta.env.VITE_TRADING_MODE || 'paper';

type Tab = 'discover' | 'positions' | 'analytics' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('discover');
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

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'discover', label: 'Discover', icon: '🔍' },
    { id: 'positions', label: 'Positions', icon: '📊' },
    { id: 'analytics', label: 'Analytics', icon: '📈' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
  ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--navy)' }}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b" style={{ borderColor: 'var(--navy-border)', background: '#0d1526' }}>
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg font-bold tracking-tight" style={{ color: 'var(--cyan)' }}>
              ⚡ APEX
            </span>
            <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Meme Trader</span>
            <span
              className="px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider"
              style={{
                background: TRADING_MODE === 'live' ? 'rgba(255, 68, 102, 0.2)' : 'rgba(0, 212, 255, 0.15)',
                color: TRADING_MODE === 'live' ? 'var(--red)' : 'var(--cyan)',
                border: `1px solid ${TRADING_MODE === 'live' ? 'var(--red)' : 'var(--cyan)'}`,
              }}
            >
              {TRADING_MODE === 'live' ? '🔴 LIVE MODE' : '📄 PAPER MODE'}
            </span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <div className="text-xs" style={{ color: 'var(--text-dim)' }}>Balance</div>
              <div className="font-bold" style={{ color: 'var(--cyan)' }}>{balance.toFixed(3)} SOL</div>
            </div>
            <div className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full"
                style={{
                  background: wsConnected ? 'var(--green)' : 'var(--red)',
                  boxShadow: wsConnected ? '0 0 6px var(--green)' : 'none',
                }}
              />
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {wsConnected ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Tab Nav */}
      <nav className="border-b" style={{ borderColor: 'var(--navy-border)', background: '#0d1526' }}>
        <div className="max-w-7xl mx-auto px-4 flex">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className="px-5 py-3 text-sm font-medium transition-all relative"
              style={{
                color: tab === t.id ? 'var(--cyan)' : 'var(--text-dim)',
                borderBottom: tab === t.id ? '2px solid var(--cyan)' : '2px solid transparent',
              }}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
              {t.id === 'positions' && openPositions.length > 0 && (
                <span
                  className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold"
                  style={{ background: 'var(--cyan)', color: 'var(--navy)' }}
                >
                  {openPositions.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-4">
        {tab === 'discover' && (
          <DiscoverPage tokens={tokens} scanStats={scanStats} />
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
      </main>
    </div>
  );
}
