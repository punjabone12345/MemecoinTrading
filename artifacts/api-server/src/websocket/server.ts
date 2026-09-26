import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { logger } from '../lib/logger.js';
import { WSMessage } from '../types/index.js';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ ip: req.socket.remoteAddress }, 'WS client connected');

    ws.on('error', (err) => logger.warn({ err }, 'WS error'));
    ws.on('close', () => logger.debug('WS client disconnected'));
    ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });

    try {
      const { processPaperTradingEngine } = await import('../services/altcoin-paper.service.js');
      const { getBalance, getSettings } = await import('../services/settings.service.js');

      const [status, balance, settings] = await Promise.all([
        processPaperTradingEngine(),
        getBalance(),
        getSettings(),
      ]);

      safeSend(ws, { type: 'altcoin_status', data: status });
      safeSend(ws, { type: 'sniper_status', data: status });
      safeSend(ws, { type: 'balance', data: { balance } });
      safeSend(ws, { type: 'settings', data: settings });
    } catch (err) {
      logger.warn({ err }, 'WS initial state push failed');
    }
  });

  setInterval(async () => {
    if (!wss || wss.clients.size === 0) return;
    try {
      const { processPaperTradingEngine } = await import('../services/altcoin-paper.service.js');
      const status = await processPaperTradingEngine();
      broadcast({ type: 'altcoin_status', data: status });
      broadcast({ type: 'sniper_status', data: status });
    } catch (err) {
      logger.debug({ err }, 'WS periodic broadcast failed');
    }
  }, 3_000);

  setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const client = ws as WebSocket & { isAlive?: boolean };
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30_000);

  logger.info('WebSocket server initialized on /ws');
}

function safeSend(ws: WebSocket, msg: WSMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function broadcast(msg: WSMessage): void {
  if (!wss) return;
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export async function broadcastBalance(): Promise<void> {
  const { getBalance } = await import('../services/settings.service.js');
  const balance = await getBalance();
  broadcast({ type: 'balance', data: { balance } });
}

export async function broadcastSettings(): Promise<void> {
  const { getSettings } = await import('../services/settings.service.js');
  const settings = await getSettings();
  broadcast({ type: 'settings', data: settings });
}
