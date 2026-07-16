import http from 'http';
import app from './app.js';
import { initDB } from './lib/db.js';
import { initWebSocket } from './websocket/server.js';
import { startTrenchesScanner, setOnGraduation } from './services/trenches.service.js';
// Discovery is now DexScreener token-profiles based — no on-chain imports needed
import { startSniperEngine, addGraduatedToken } from './services/sniper-engine.service.js';
import { startTelegramCommands, stopTelegramCommands } from './lib/telegram-commands.js';
import { initSessionManager } from './lib/session-manager.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function main(): Promise<void> {
  await initDB();

  const server = http.createServer(app);
  initWebSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Apex Meme Trader API running');
  });

  // Wire DexScreener token discovery → sniper engine
  setOnGraduation(addGraduatedToken);
  startTrenchesScanner();
  await startSniperEngine();
  startTelegramCommands();

  // Session manager: honours the persisted botEnabled flag — stops all services
  // immediately if the bot was saved as disabled, and handles future toggles.
  await initSessionManager();

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down');
    stopTelegramCommands();
    server.close(() => process.exit(0));
  });
}

// Keep the process alive — log but never crash on unhandled errors.
// Without these handlers, a single unhandled rejection (e.g. a flaky RPC call
// escaping try/catch) can silently kill the server and stop all trading.
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — process kept alive');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection — process kept alive');
});

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
