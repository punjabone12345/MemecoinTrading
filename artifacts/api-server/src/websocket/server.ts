import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { logger } from '../lib/logger.js';
import { WSMessage } from '../types/index.js';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ ip: req.socket.remoteAddress }, 'WS client connected');

    ws.on('error', (err) => logger.warn({ err }, 'WS error'));
    ws.on('close', () => logger.debug('WS client disconnected'));

    // Send initial ping
    safeSend(ws, { type: 'alert', data: { message: 'Connected to Apex Meme Trader' } });
  });

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
  const { getOpenPositions, getAnalytics } = await import('../services/position.service.js');
  const [positions, analytics] = await Promise.all([getOpenPositions(), getAnalytics()]);
  broadcast({ type: 'positions', data: positions });
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
