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

    // Push current state immediately so the UI doesn't wait for the next broadcast cycle
    try {
      const { getOpenPositions, getClosedPositions, getAnalytics } = await import('../services/position.service.js');
      const { getAllTokens, getScanStats } = await import('../services/scanner.service.js');
      const { getBalance } = await import('../services/settings.service.js');

      const [open, closed, analytics, balance] = await Promise.all([
        getOpenPositions(),
        getClosedPositions(),
        getAnalytics(),
        getBalance(),
      ]);
      const tokens = getAllTokens();
      const stats = getScanStats();

      safeSend(ws, { type: 'positions', data: { open, closed } });
      safeSend(ws, { type: 'analytics', data: analytics });
      safeSend(ws, { type: 'balance', data: { balance } });
      safeSend(ws, { type: 'tokens', data: { tokens, stats } });
    } catch (err) {
      logger.warn({ err }, 'WS initial state push failed');
    }
  });

  // Keepalive ping every 30s — prevents Replit proxy from dropping idle connections
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

export async function broadcastPositions(): Promise<void> {
  // Imported lazily to avoid circular deps
  const { getOpenPositions, getClosedPositions, getAnalytics } = await import('../services/position.service.js');
  const [open, closed, analytics] = await Promise.all([getOpenPositions(), getClosedPositions(), getAnalytics()]);
  // Send both open + closed so the frontend never needs to poll for closed trades
  broadcast({ type: 'positions', data: { open, closed } });
  broadcast({ type: 'analytics', data: analytics });
}

export async function broadcastBalance(): Promise<void> {
  const { getBalance } = await import('../services/settings.service.js');
  const balance = await getBalance();
  broadcast({ type: 'balance', data: { balance } });
}

export async function broadcastTokens(): Promise<void> {
  const { getAllTokens, getScanStats } = await import('../services/scanner.service.js');
  const tokens = getAllTokens();
  const stats = getScanStats();
  broadcast({ type: 'tokens', data: { tokens, stats } });
}

export async function broadcastSettings(): Promise<void> {
  const { getSettings } = await import('../services/settings.service.js');
  const settings = await getSettings();
  broadcast({ type: 'settings', data: settings });
}
