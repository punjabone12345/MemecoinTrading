import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger.js";

export type WsMessage = { type: string; data: unknown; timestamp: number };

let _wss: WebSocketServer | null = null;

function send(ws: WebSocket, msg: WsMessage) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

export function broadcast(msg: WsMessage) {
  if (!_wss) return;
  _wss.clients.forEach((client) => send(client as WebSocket, msg));
}

export function initWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  _wss = wss;

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ ip: req.socket.remoteAddress }, "WS client connected");

    const pingInterval = setInterval(() => {
      send(ws, { type: "ping", data: null, timestamp: Date.now() });
    }, 25_000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === "ping") send(ws, { type: "pong", data: null, timestamp: Date.now() });
      } catch { /* ignore */ }
    });

    ws.on("close", () => { clearInterval(pingInterval); logger.info("WS client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "WS client error"); });
  });

  logger.info("WebSocket server initialized at /ws");
  return wss;
}
