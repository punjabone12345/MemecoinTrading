import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocketServer } from "./websocket/server.js";
import { startCommandPolling, registerCommandHandler, toIST, sendTelegram, isTelegramConfigured } from "./lib/telegram.js";
import { graduationSniperService } from "./services/graduation-sniper.service.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function fmt(n: number, d = 4): string {
  return (n >= 0 ? "+" : "") + n.toFixed(d);
}

// ── Telegram commands (sniper-focused) ────────────────────────────────────────

registerCommandHandler(async (command: string) => {
  switch (command) {

    case "/command1": {
      const status = graduationSniperService.getStatus();
      const open = [...graduationSniperService.getOpenPositions()];
      if (open.length === 0) {
        return (
          `🎯 <b>Memecoin Sniper — No Open Positions</b>\n` +
          `──────────────────────\n` +
          `💰 Balance: <b>${Number(status.virtualBalance).toFixed(4)} SOL</b>\n` +
          `📊 Realized PNL: <b>${fmt(status.totalRealizedPnlSol)} SOL</b>\n` +
          `🏆 Wins: <b>${status.wins}</b> | 💀 Losses: <b>${status.losses}</b>\n` +
          `🕐 ${toIST(new Date())}`
        );
      }
      let msg = `🎯 <b>Open Sniper Positions (${open.length})</b>\n──────────────────────\n`;
      for (const pos of open) {
        const pnl = pos.currentPrice && pos.entryPrice
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : 0;
        const sign = pnl >= 0 ? "📈" : "📉";
        msg +=
          `${sign} <b>$${pos.symbol}</b>\n` +
          `   📍 <code>${pos.mint}</code>\n` +
          `   💰 Entry: $${pos.entryPrice?.toFixed(10)} | Now: $${pos.currentPrice?.toFixed(10)}\n` +
          `   📊 Change: <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%</b>\n` +
          `──────────────────────\n`;
      }
      msg +=
        `💰 Balance: <b>${Number(status.virtualBalance).toFixed(4)} SOL</b>\n` +
        `📊 Realized: <b>${fmt(status.totalRealizedPnlSol)} SOL</b>\n` +
        `🕐 ${toIST(new Date())}`;
      return msg;
    }

    case "/command2": {
      const status = graduationSniperService.getStatus();
      const winRate = (status.wins + status.losses) > 0
        ? ((status.wins / (status.wins + status.losses)) * 100).toFixed(1)
        : "—";
      return (
        `📊 <b>Sniper Performance Report</b>\n` +
        `──────────────────────\n` +
        `✅ Status: <b>${status.enabled ? "SNIPING" : "PAUSED"}</b>\n` +
        `🔌 WebSocket: <b>${status.wsConnected ? "LIVE" : "DISCONNECTED"}</b>\n` +
        `\n` +
        `📈 <b>Trade Stats</b>\n` +
        `├ Total Trades: <b>${status.tradesTotal}</b>\n` +
        `├ Wins: <b>${status.wins}</b> | Losses: <b>${status.losses}</b>\n` +
        `├ Win Rate: <b>${winRate}%</b>\n` +
        `├ Open Now: <b>${status.openCount}</b>/${status.config.maxOpenPositions}\n` +
        `└ Grads Today: <b>${status.graduationsToday}</b>\n` +
        `\n` +
        `💰 <b>P&L Summary</b>\n` +
        `├ Realized: <b>${fmt(status.totalRealizedPnlSol)} SOL</b>\n` +
        `├ Unrealized: <b>${fmt(status.totalUnrealizedPnlSol)} SOL</b>\n` +
        `└ Balance: <b>${Number(status.virtualBalance).toFixed(4)} SOL</b>\n` +
        `\n🕐 ${toIST(new Date())}`
      );
    }

    case "/command3": {
      const status = graduationSniperService.getStatus();
      const healthy = status.wsConnected && status.enabled;
      return (
        `${healthy ? "✅" : "⚠️"} <b>Sniper Health Check</b>\n` +
        `──────────────────────\n` +
        `🔌 WebSocket: <b>${status.wsConnected ? "✅ LIVE" : "❌ DISCONNECTED"}</b>\n` +
        `🎯 Sniping: <b>${status.enabled ? "✅ ENABLED" : "⏸️ PAUSED"}</b>\n` +
        `📍 Open Positions: <b>${status.openCount}/${status.config.maxOpenPositions}</b>\n` +
        `🌅 Grads Today: <b>${status.graduationsToday}</b>\n` +
        `💰 Balance: <b>${Number(status.virtualBalance).toFixed(4)} SOL</b>\n` +
        `🕐 ${toIST(new Date())}`
      );
    }

    case "/start":
      return (
        `🎯 <b>Memecoin Sniper — Command Menu</b>\n` +
        `──────────────────────\n` +
        `/command1 — 💼 Open positions & live P&L\n` +
        `/command2 — 📊 Performance stats\n` +
        `/command3 — 🔍 Health check\n`
      );

    default:
      return `❓ Unknown command: <b>${command}</b>\nAvailable: /command1 /command2 /command3`;
  }
});

const server = http.createServer(app);
initWebSocketServer(server);

// ── DB migration (idempotent — safe to run on every startup) ──────────────────
if (process.env["DATABASE_URL"]) {
  try {
    const { pool: dbPool } = await import("./lib/db.js");
    const migClient = await dbPool.connect();
    try {
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS app_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS kv_store (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS sniper_positions (
          id TEXT PRIMARY KEY,
          mint TEXT NOT NULL,
          symbol TEXT,
          name TEXT,
          detected_at BIGINT,
          entry_at BIGINT,
          entry_price DOUBLE PRECISION,
          current_price DOUBLE PRECISION,
          size_sol DOUBLE PRECISION,
          tp1_hit BOOLEAN DEFAULT FALSE,
          tp2_hit BOOLEAN DEFAULT FALSE,
          remaining_fraction DOUBLE PRECISION DEFAULT 1.0,
          effective_sl_price DOUBLE PRECISION,
          trailing_high DOUBLE PRECISION,
          status TEXT DEFAULT 'open',
          realized_pnl_sol DOUBLE PRECISION DEFAULT 0,
          close_reason TEXT,
          closed_at BIGINT,
          exit_price DOUBLE PRECISION,
          tx_signature TEXT,
          tp1_realized_sol DOUBLE PRECISION DEFAULT 0,
          tp2_realized_sol DOUBLE PRECISION DEFAULT 0,
          runner_realized_sol DOUBLE PRECISION DEFAULT 0
        )
      `);
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS tp1_realized_sol DOUBLE PRECISION DEFAULT 0`);
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS tp2_realized_sol DOUBLE PRECISION DEFAULT 0`);
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS runner_realized_sol DOUBLE PRECISION DEFAULT 0`);
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS token_amount DOUBLE PRECISION DEFAULT 0`);
      // Separate entry/exit tx signatures — entry_sig = buy tx (never changes),
      // exit_sig = confirmed sell tx (NULL means sell was never confirmed on-chain).
      // Positions with NULL exit_sig are "unverified" and may have fake P&L.
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS entry_sig TEXT DEFAULT ''`);
      await migClient.query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS exit_sig TEXT`);
      logger.info("DB migration: all tables ready");
    } finally {
      migClient.release();
    }
  } catch (migErr) {
    logger.warn({ err: (migErr as Error).message }, "DB migration: failed (continuing anyway)");
  }
}

// ── Start services ────────────────────────────────────────────────────────────
await graduationSniperService.init();
graduationSniperService.start();

server.listen(port, () => {
  logger.info({ port }, "Memecoin Sniper — server listening");
  startCommandPolling();
  logger.info("All services started");

  if (isTelegramConfigured()) {
    const env = process.env["RENDER"] ? "🌐 Render (Production)" : "💻 Replit (Dev)";
    sendTelegram(
      `🎯 <b>Memecoin Sniper — Bot Online</b>\n` +
      `──────────────────────\n` +
      `🌍 Environment: <b>${env}</b>\n` +
      `🕐 ${toIST(new Date())}\n` +
      `\nCommands: /command1 /command2 /command3`,
    ).catch(() => {});
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
