import http from 'http';
import app from './app.js';
import { initDB } from './lib/db.js';
import { initWebSocket } from './websocket/server.js';
import { startAutoTrader } from './services/auto-trader.service.js';
import { startTrenchesScanner, setOnMintSourceUpdated, setOnNewMint, setOnGraduation } from './services/trenches.service.js';
import { startWhaleSniper, addGraduatedToken } from './services/whale-sniper.service.js';
import { startHeliusWatcher } from './services/helius-ws.service.js';
import { addToFreshMintQueue } from './services/scanner.service.js';
import { startPriceMonitor } from './services/price-monitor.service.js';
import { updatePositionSource } from './services/position.service.js';
import { notifyHeartbeat } from './lib/telegram.js';
import { startTelegramCommands, stopTelegramCommands } from './lib/telegram-commands.js';
import { getOpenPositions, getAnalytics } from './services/position.service.js';
import { getBalance } from './services/settings.service.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function main(): Promise<void> {
  await initDB();

  const server = http.createServer(app);
  initWebSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Apex Meme Trader API running');
  });

  // Wire discovery callbacks → freshMintQueue
  setOnNewMint(addToFreshMintQueue);
  setOnGraduation(addGraduatedToken);
  startTrenchesScanner();
  startHeliusWatcher(addToFreshMintQueue);
  startAutoTrader();
  startWhaleSniper();
  startPriceMonitor();
  startTelegramCommands();
  setOnMintSourceUpdated(async (mint, sources) => {
    try { await updatePositionSource(mint, sources); } catch { /* non-fatal */ }
  });

  // Daily summary at midnight IST (18:30 UTC)
  const now = new Date();
  const nextMidnightIST = new Date();
  nextMidnightIST.setUTCHours(18, 30, 0, 0);
  if (nextMidnightIST <= now) nextMidnightIST.setUTCDate(nextMidnightIST.getUTCDate() + 1);
  const msToMidnight = nextMidnightIST.getTime() - now.getTime();

  setTimeout(async () => {
    setInterval(async () => {
      try {
        const analytics = await getAnalytics();
        await import('./lib/telegram.js').then(({ notifyDailySummary }) =>
          notifyDailySummary({
            trades: analytics.totalTrades,
            winRate: analytics.winRate,
            pnlSol: analytics.dailyPnl,
          })
        );
      } catch {}
    }, 24 * 60 * 60 * 1000);
  }, msToMidnight);


  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down');
    stopTelegramCommands();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
