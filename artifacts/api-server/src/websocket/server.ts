import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { logger } from "../lib/logger.js";

interface WsMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

let wss: WebSocketServer | null = null;

function sendToClient(ws: WebSocket, msg: WsMessage) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }
}

export function broadcast(msg: WsMessage): void {
  if (!wss) return;
  wss.clients.forEach((client) => sendToClient(client as WebSocket, msg));
}

export function initWebSocketServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    logger.info({ ip: req.socket.remoteAddress }, "WS client connected");

    const pingInterval = setInterval(() => {
      sendToClient(ws, { type: "ping", data: null, timestamp: Date.now() });
    }, 25_000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === "ping") sendToClient(ws, { type: "pong", data: null, timestamp: Date.now() });
      } catch { /* ignore */ }
    });

    ws.on("close", () => { clearInterval(pingInterval); logger.info("WS client disconnected"); });
    ws.on("error", (err) => { logger.warn({ err }, "WS client error"); });
  });

  logger.info("WebSocket server initialized at /ws");
  return wss;
}
