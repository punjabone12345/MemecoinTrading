import http from 'http';
import app from './app.js';
import { initDB } from './lib/db.js';
import { initWebSocket } from './websocket/server.js';
import { startTrenchesScanner, setOnGraduation } from './services/trenches.service.js';
import { startWhaleSniper, addGraduatedToken } from './services/whale-sniper.service.js';
import { startTelegramCommands, stopTelegramCommands } from './lib/telegram-commands.js';
import { logger } from './lib/logger.js';

const PORT = parseInt(process.env.PORT || '8080', 10);

async function main(): Promise<void> {
  await initDB();

  const server = http.createServer(app);
  initWebSocket(server);

  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'Apex Meme Trader API running');
  });

  // Wire pump.fun graduation detection → whale sniper
  setOnGraduation(addGraduatedToken);
  startTrenchesScanner();
  await startWhaleSniper();
  startTelegramCommands();

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
