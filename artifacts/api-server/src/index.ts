import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocketServer } from "./websocket/server.js";
import { startCommandPolling, registerCommandHandler, toIST, sendTelegram, isTelegramConfigured } from "./lib/telegram.js";
import { earlyDiscoveryService } from "./services/early-discovery.service.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT value: "${rawPort}"`);

// ── Telegram commands ──────────────────────────────────────────────────────────
registerCommandHandler(async (command: string) => {
  switch (command) {
    case "/command1": {
      const status = earlyDiscoveryService.getStatus();
      const positions = earlyDiscoveryService.getPositions();
      const open = positions.open;
      if (open.length === 0) {
        return (
          `🔍 <b>Early Discovery — No Open Trades</b>\n` +
          `──────────────────────\n` +
          `💰 Paper Balance: <b>${status.virtualBalance.toFixed(4)} SOL</b>\n` +
          `📡 Tracking: <b>${status.trackedCount}</b> tokens | Eligible: <b>${status.eligibleCount}</b>\n` +
          `🕐 ${toIST(new Date())}`
        );
      }
      let msg = `🔍 <b>Early Discovery — Open Trades (${open.length})</b>\n──────────────────────\n`;
      for (const pos of open) {
        const pnlSign = pos.pnlPct >= 0 ? "📈" : "📉";
        msg +=
          `${pnlSign} <b>$${pos.symbol}</b> — Score: ${pos.entryScore}\n` +
          `   P&L: <b>${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%</b> | TP1: ${pos.tp1Hit ? "✅" : "○"} TP2: ${pos.tp2Hit ? "✅" : "○"}\n` +
          `──────────────────────\n`;
      }
      msg += `💰 Balance: <b>${status.virtualBalance.toFixed(4)} SOL</b>\n🕐 ${toIST(new Date())}`;
      return msg;
    }
    case "/command2": {
      const status = earlyDiscoveryService.getStatus();
      const winRate = (status.wins + status.losses) > 0
        ? ((status.wins / (status.wins + status.losses)) * 100).toFixed(1) : "—";
      return (
        `📊 <b>Early Discovery — Performance</b>\n──────────────────────\n` +
        `🌐 WebSocket: <b>${status.wsConnected ? "LIVE" : "DISCONNECTED"}</b>\n` +
        `📡 Launches detected: <b>${status.launchesDetected}</b>\n` +
        `🔎 Tracking: <b>${status.trackedCount}</b> | Eligible: <b>${status.eligibleCount}</b>\n\n` +
        `📈 <b>Trade Stats</b>\n` +
        `├ Total: <b>${status.tradesTotal}</b> | W: <b>${status.wins}</b> L: <b>${status.losses}</b>\n` +
        `├ Win Rate: <b>${winRate}%</b>\n` +
        `└ Realized PnL: <b>${status.totalRealizedPnlSol >= 0 ? "+" : ""}${status.totalRealizedPnlSol.toFixed(4)} SOL</b>\n\n` +
        `💰 Balance: <b>${status.virtualBalance.toFixed(4)} SOL</b>\n🕐 ${toIST(new Date())}`
      );
    }
    case "/command3": {
      const status = earlyDiscoveryService.getStatus();
      return (
        `${status.wsConnected ? "✅" : "⚠️"} <b>System Health</b>\n──────────────────────\n` +
        `🔌 WS: <b>${status.wsConnected ? "LIVE" : "DISCONNECTED"}</b> (${status.wsReconnects} reconnects)\n` +
        `📡 Tracking: <b>${status.trackedCount}</b> tokens\n` +
        `🎯 Open trades: <b>${status.openCount}</b>\n` +
        `💰 Balance: <b>${status.virtualBalance.toFixed(4)} SOL</b>\n🕐 ${toIST(new Date())}`
      );
    }
    case "/start":
      return (
        `🔍 <b>Apex — Early Demand Discovery</b>\n──────────────────────\n` +
        `/command1 — 💼 Open trades & P&L\n/command2 — 📊 Performance stats\n/command3 — 🔍 Health check\n`
      );
    default:
      return `❓ Unknown: <b>${command}</b>`;
  }
});

const server = http.createServer(app);
initWebSocketServer(server);

// ── DB migration ───────────────────────────────────────────────────────────────
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
        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
          entry_score INTEGER DEFAULT 0,
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
          close_reason TEXT DEFAULT '',
          closed_at BIGINT,
          exit_price DOUBLE PRECISION,
          tp1_realized_sol DOUBLE PRECISION DEFAULT 0,
          tp2_realized_sol DOUBLE PRECISION DEFAULT 0,
          runner_realized_sol DOUBLE PRECISION DEFAULT 0,
          closing_score INTEGER,
          position_multiplier DOUBLE PRECISION DEFAULT 1.0
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

// ── Start services ─────────────────────────────────────────────────────────────
await earlyDiscoveryService.init();
earlyDiscoveryService.start();

server.listen(port, () => {
  logger.info({ port }, "Apex Meme Trader — Early Discovery server listening");
  startCommandPolling();
  logger.info("All services started");

  if (isTelegramConfigured()) {
    const env = process.env["RENDER"] ? "🌐 Render (Production)" : "💻 Replit (Dev)";
    sendTelegram(
      `🔍 <b>Apex — Early Discovery Bot Online</b>\n──────────────────────\n` +
      `🌍 Environment: <b>${env}</b>\n🕐 ${toIST(new Date())}\n\nCommands: /command1 /command2 /command3`,
    ).catch(() => {});
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
