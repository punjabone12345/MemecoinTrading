import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocketServer } from "./websocket/server.js";
import { startCommandPolling, registerCommandHandler, toIST, sendTelegram, isTelegramConfigured } from "./lib/telegram.js";
import { earlyDiscoveryService } from "./services/early-discovery.service.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

registerCommandHandler(async (command: string) => {
  switch (command) {
    case "/status": {
      const s = earlyDiscoveryService.getStatus();
      const pos = earlyDiscoveryService.getPositions();
      const winRate = (s.wins + s.losses) > 0
        ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(1) + "%"
        : "—";
      return (
        `🔬 <b>Early Demand Discovery — Status</b>\n` +
        `──────────────────────\n` +
        `🟢 WS: <b>${s.wsConnected ? "LIVE" : "OFFLINE"}</b> | Active: <b>${s.enabled ? "YES" : "PAUSED"}</b>\n` +
        `📊 Tracked: <b>${s.trackedCount}</b> | Eligible: <b>${s.eligibleCount}</b> | Entered: <b>${s.enteredCount}</b>\n` +
        `🚀 Launches Detected: <b>${s.launchesDetected}</b>\n\n` +
        `💰 Balance: <b>${s.virtualBalance.toFixed(3)} SOL</b>\n` +
        `📈 Realized PnL: <b>${s.totalRealizedPnlSol >= 0 ? "+" : ""}${s.totalRealizedPnlSol.toFixed(4)} SOL</b>\n` +
        `🏆 Wins: <b>${s.wins}</b> | 💀 Losses: <b>${s.losses}</b> | Win Rate: <b>${winRate}</b>\n` +
        `📂 Open: <b>${pos.open.length}</b> | Closed: <b>${pos.closed.length}</b>\n` +
        `🕐 ${toIST(new Date())}`
      );
    }
    case "/trades": {
      const pos = earlyDiscoveryService.getPositions();
      if (pos.open.length === 0) return "📭 No open trades right now.";
      let msg = `💼 <b>Open Paper Trades (${pos.open.length})</b>\n──────────────────────\n`;
      for (const p of pos.open) {
        const sign = p.pnlPct >= 0 ? "📈" : "📉";
        msg +=
          `${sign} <b>$${p.symbol}</b> (Score: ${p.entryScore})\n` +
          `   PnL: <b>${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%</b> | ${p.unrealizedPnlSol >= 0 ? "+" : ""}${p.unrealizedPnlSol.toFixed(4)} SOL\n` +
          `   TP1: ${p.tp1Hit ? "✅" : "○"} | TP2: ${p.tp2Hit ? "✅" : "○"}\n` +
          `──────────────────────\n`;
      }
      return msg + `🕐 ${toIST(new Date())}`;
    }
    case "/start":
      return (
        `🔬 <b>Apex Meme Trader — Commands</b>\n` +
        `──────────────────────\n` +
        `/status — Bot status & P&L\n` +
        `/trades — Open paper trades\n`
      );
    default:
      return `❓ Unknown: <b>${command}</b>\nTry /status or /trades`;
  }
});

const server = http.createServer(app);
initWebSocketServer(server);

if (process.env["DATABASE_URL"]) {
  try {
    const { pool: dbPool } = await import("./lib/db.js");
    const migClient = await dbPool.connect();
    try {
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS ed_positions (
          id TEXT PRIMARY KEY,
          mint TEXT NOT NULL,
          symbol TEXT,
          name TEXT,
          entry_at BIGINT,
          entry_price DOUBLE PRECISION,
          entry_mcap DOUBLE PRECISION,
          entry_score DOUBLE PRECISION,
          current_price DOUBLE PRECISION,
          current_mcap DOUBLE PRECISION,
          size_sol DOUBLE PRECISION,
          remaining_fraction DOUBLE PRECISION DEFAULT 1.0,
          effective_sl_price DOUBLE PRECISION,
          trailing_high DOUBLE PRECISION,
          tp1_hit BOOLEAN DEFAULT FALSE,
          tp2_hit BOOLEAN DEFAULT FALSE,
          status TEXT DEFAULT 'open',
          realized_pnl_sol DOUBLE PRECISION DEFAULT 0,
          unrealized_pnl_sol DOUBLE PRECISION DEFAULT 0,
          total_pnl_sol DOUBLE PRECISION DEFAULT 0,
          pnl_pct DOUBLE PRECISION DEFAULT 0,
          close_reason TEXT,
          closed_at BIGINT,
          exit_price DOUBLE PRECISION,
          tp1_realized_sol DOUBLE PRECISION DEFAULT 0,
          tp2_realized_sol DOUBLE PRECISION DEFAULT 0,
          runner_realized_sol DOUBLE PRECISION DEFAULT 0,
          closing_score INTEGER,
          position_multiplier DOUBLE PRECISION DEFAULT 1
        )
      `);
      logger.info("DB migration: all tables ready");
    } finally {
      migClient.release();
    }
  } catch (migErr) {
    logger.warn({ err: (migErr as Error).message }, "DB migration: failed (continuing anyway)");
  }
}

await earlyDiscoveryService.init();
earlyDiscoveryService.start();

server.listen(port, () => {
  logger.info({ port }, "Apex Meme Trader — Early Demand Discovery server listening");
  startCommandPolling();
  logger.info("All services started");

  if (isTelegramConfigured()) {
    const env = process.env["RENDER"] ? "🌐 Render (Production)" : "💻 Replit (Dev)";
    void sendTelegram(
      `🔬 <b>Apex Meme Trader — Online</b>\n` +
      `Strategy: Early Demand Discovery\n` +
      `🌍 ${env} | 🕐 ${toIST(new Date())}`
    );
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
