import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger.js";
import { scannerService } from "../services/scanner.service.js";
import { paperTradingService } from "../services/paper-trading.service.js";
import { alertsService } from "../services/alerts.service.js";
import { graduationSniperService } from "../services/graduation-sniper.service.js";
import { paperSniperService } from "../services/paper-sniper.service.js";
import type { Alert, ScannedToken, WsMessage } from "../types/index.js";

function send(ws: WebSocket, msg: WsMessage) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

function broadcast(wss: WebSocketServer, msg: WsMessage) {
  wss.clients.forEach((client) => send(client as WebSocket, msg));
}

export function initWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ ip: req.socket.remoteAddress }, "WS client connected");

    const pingInterval = setInterval(() => {
      send(ws, { type: "ping", data: null, timestamp: Date.now() });
    }, 25_000);

    const initialTokens = scannerService.getAll();
    if (initialTokens.length > 0) {
      send(ws, { type: "scanner_update", data: initialTokens, timestamp: Date.now() });
    }

    const portfolio = paperTradingService.getPortfolio();
    send(ws, { type: "portfolio_update", data: portfolio, timestamp: Date.now() });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === "ping") send(ws, { type: "ping", data: null, timestamp: Date.now() });
      } catch { /* ignore */ }
    });

    ws.on("close", () => { clearInterval(pingInterval); logger.info("WS client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "WS client error"); });
  });

  scannerService.setBroadcaster((tokens: ScannedToken[]) => {
    broadcast(wss, { type: "scanner_update", data: tokens, timestamp: Date.now() });
  });

  paperTradingService.setPositionBroadcaster(() => {
    const positions = paperTradingService.getOpenPositionsWithLivePnl();
    const portfolio = paperTradingService.getPortfolio();
    broadcast(wss, { type: "position_update", data: { positions, portfolio }, timestamp: Date.now() });
    broadcast(wss, { type: "portfolio_update", data: portfolio, timestamp: Date.now() });
  });

  alertsService.setBroadcaster((alert: Alert) => {
    broadcast(wss, { type: "alert", data: alert, timestamp: Date.now() });
  });

  graduationSniperService.setBroadcaster(() => {
    broadcast(wss, { type: "sniper_update", data: null, timestamp: Date.now() });
  });

  paperSniperService.setBroadcaster(() => {
    broadcast(wss, { type: "paper_sniper_update", data: null, timestamp: Date.now() });
  });

  logger.info("WebSocket server initialized at /ws");
  return wss;
}
