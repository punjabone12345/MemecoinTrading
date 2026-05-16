import http from "http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initWebSocketServer } from "./websocket/server.js";
import { scannerService } from "./services/scanner.service.js";
import { paperTradingService } from "./services/paper-trading.service.js";
import { autoTraderService } from "./services/auto-trader.service.js";
import { startCommandPolling, registerCommandHandler, toIST, sendTelegram, isTelegramConfigured } from "./lib/telegram.js";
import { lossJournalService } from "./services/loss-journal.service.js";

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

function formatMcap(mcap: number): string {
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

function formatPrice(price: number): string {
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

/** /command1 — Check current positions and live P&L */
async function handleCommand1(): Promise<string> {
  const positions = paperTradingService.getOpenPositionsWithLivePnl();
  const portfolio = paperTradingService.getPortfolio();

  if (positions.length === 0) {
    return (
      `📭 <b>No Open Positions</b>\n` +
      `──────────────────────\n` +
      `💰 Balance: <b>${portfolio.solBalance.toFixed(4)} SOL</b>\n` +
      `📊 Total PNL: <b>${portfolio.totalPnlSol >= 0 ? "+" : ""}${portfolio.totalPnlSol.toFixed(4)} SOL</b>\n` +
      `🕐 ${toIST(new Date())}`
    );
  }

  let msg =
    `💼 <b>Open Positions (${positions.length})</b>\n` +
    `──────────────────────\n`;

  for (const pos of positions) {
    const sign = pos.livePnlSol >= 0 ? "+" : "";
    const pnlEmoji = pos.livePnlSol >= 0 ? "📈" : "📉";
    msg +=
      `${pnlEmoji} <b>$${pos.symbol}</b>\n` +
      `   📍 CA: <code>${pos.contractAddress || pos.pairAddress}</code>\n` +
      `   💰 Entry: $${formatPrice(pos.entryPrice)} | Now: $${formatPrice(pos.currentPrice)}\n` +
      `   📊 PNL: <b>${sign}${pos.livePnlPercent.toFixed(1)}% | ${sign}${pos.livePnlSol.toFixed(4)} SOL</b>\n` +
      `   🎯 TP: $${formatPrice(pos.tpPrice)} (+${pos.tpPercent}%)\n` +
      `   🛑 SL: $${formatPrice(pos.slPrice)} (-${pos.slPercent}%)\n` +
      `   📊 Entry MCap: ${formatMcap(pos.entryMarketCap || 0)}\n` +
      `──────────────────────\n`;
  }

  const totalLivePnl = positions.reduce((s, p) => s + p.livePnlSol, 0);
  const totalSign = totalLivePnl >= 0 ? "+" : "";
  msg +=
    `💰 Balance: <b>${portfolio.solBalance.toFixed(4)} SOL</b>\n` +
    `📈 Live Open PNL: <b>${totalSign}${totalLivePnl.toFixed(4)} SOL</b>\n` +
    `📊 All-Time PNL: <b>${portfolio.totalPnlSol >= 0 ? "+" : ""}${portfolio.totalPnlSol.toFixed(4)} SOL</b>\n` +
    `🕐 ${toIST(new Date())}`;

  return msg;
}

/** /command2 — Analyse auto trader performance */
async function handleCommand2(): Promise<string> {
  const closedTrades = paperTradingService.getClosedTrades();
  const portfolio = paperTradingService.getPortfolio();
  const status = autoTraderService.getStatus();

  const wins = closedTrades.filter((t) => t.pnlSol !== undefined && t.pnlSol > 0);
  const losses = closedTrades.filter((t) => t.pnlSol !== undefined && t.pnlSol <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnlSol ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnlSol ?? 0), 0) / losses.length : 0;
  const bestTrade = closedTrades.reduce((best, t) => (t.pnlSol ?? 0) > (best.pnlSol ?? 0) ? t : best, closedTrades[0]);
  const worstTrade = closedTrades.reduce((worst, t) => (t.pnlSol ?? 0) < (worst.pnlSol ?? 0) ? t : worst, closedTrades[0]);

  const avgHoldMs = closedTrades.length > 0
    ? closedTrades.reduce((s, t) => s + (t.holdTimeMs ?? 0), 0) / closedTrades.length
    : 0;
  const avgHoldMin = Math.round(avgHoldMs / 60_000);

  // Today's stats
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayTrades = closedTrades.filter((t) => t.closedAt && new Date(t.closedAt).getTime() >= todayStart.getTime());
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);

  const sign = totalPnl >= 0 ? "+" : "";
  const todaySign = todayPnl >= 0 ? "+" : "";

  return (
    `📊 <b>Auto-Trader Performance Report</b>\n` +
    `──────────────────────\n` +
    `🤖 Status: <b>${status.paused ? "⏸️ PAUSED" : "✅ RUNNING"}</b>\n` +
    `🔵 Scanner Pool: <b>${status.scannerPoolSize} tokens</b>\n` +
    `🔄 Trader Cycles: <b>${status.totalTradesOpened > 0 ? status.totalTradesOpened : 0} trades opened</b>\n` +
    `\n` +
    `📈 <b>Trade Stats</b>\n` +
    `├ Total Closed: <b>${closedTrades.length}</b>\n` +
    `├ Wins: <b>${wins.length}</b> | Losses: <b>${losses.length}</b>\n` +
    `├ Win Rate: <b>${winRate.toFixed(1)}%</b>\n` +
    `├ Avg Win: <b>+${avgWin.toFixed(4)} SOL</b>\n` +
    `├ Avg Loss: <b>${avgLoss.toFixed(4)} SOL</b>\n` +
    `└ Avg Hold: <b>${avgHoldMin}m</b>\n` +
    `\n` +
    `💰 <b>PNL Summary</b>\n` +
    `├ Today: <b>${todaySign}${todayPnl.toFixed(4)} SOL</b> (${todayTrades.length} trades)\n` +
    `├ All-Time: <b>${sign}${totalPnl.toFixed(4)} SOL</b>\n` +
    `└ Balance: <b>${portfolio.solBalance.toFixed(4)} SOL</b>\n` +
    (bestTrade ? `\n🏆 Best Trade: <b>$${bestTrade.symbol} +${bestTrade.pnlSol?.toFixed(4)} SOL</b>\n` : "") +
    (worstTrade ? `💀 Worst Trade: <b>$${worstTrade.symbol} ${worstTrade.pnlSol?.toFixed(4)} SOL</b>\n` : "") +
    `\n` +
    `⚙️ <b>Active Config</b>\n` +
    `├ Min AI Score: <b>${status.config.minAiScore}</b>\n` +
    `├ Min Liquidity: <b>$${(status.config.minLiquidityUsd / 1000).toFixed(0)}K</b>\n` +
    `├ MCap Range: <b>$${(status.config.minMcapUsd / 1000).toFixed(0)}K–$${(status.config.maxMcapUsd / 1_000_000).toFixed(0)}M</b>\n` +
    `└ Trade Size: <b>${status.config.solPerTrade} SOL</b>\n` +
    `\n🕐 ${toIST(new Date())}`
  );
}

/** /command3 — Check if bot is alive */
async function handleCommand3(): Promise<string> {
  const status = autoTraderService.getStatus();
  const portfolio = paperTradingService.getPortfolio();
  const positions = paperTradingService.getOpenPositions();
  const scannerPool = scannerService.getTokenCount();
  const scanCycles = scannerService.getScanCount();
  const lastRunAgo = status.lastRunAt
    ? Math.round((Date.now() - status.lastRunAt) / 1000)
    : null;

  const isHealthy = !status.paused && scannerPool > 0;

  return (
    `${isHealthy ? "✅" : "⚠️"} <b>Bot Health Check</b>\n` +
    `──────────────────────\n` +
    `🤖 Auto-Trader: <b>${status.paused ? "⏸️ PAUSED" : "✅ RUNNING"}</b>\n` +
    `🔍 Scanner: <b>${scannerPool > 0 ? "✅ ACTIVE" : "❌ IDLE"}</b>\n` +
    `🔵 Tokens in Pool: <b>${scannerPool}</b>\n` +
    `🔄 Scanner Cycles: <b>${scanCycles}</b>\n` +
    `⏱️ Last Trade Cycle: <b>${lastRunAgo !== null ? `${lastRunAgo}s ago` : "Never"}</b>\n` +
    `\n` +
    `💼 Open Positions: <b>${positions.length}/${status.config.maxConcurrentTrades}</b>\n` +
    `💰 Balance: <b>${portfolio.solBalance.toFixed(4)} SOL</b>\n` +
    `📊 Total PNL: <b>${portfolio.totalPnlSol >= 0 ? "+" : ""}${portfolio.totalPnlSol.toFixed(4)} SOL</b>\n` +
    `\n` +
    `🕐 ${toIST(new Date())}`
  );
}

// Register all command handlers
registerCommandHandler(async (command: string) => {
  switch (command) {
    case "/command1": return handleCommand1();
    case "/command2": return handleCommand2();
    case "/command3": return handleCommand3();
    case "/start":
      return (
        `👋 <b>Apex Meme Trader AI — Command Menu</b>\n` +
        `──────────────────────\n` +
        `/command1 — 💼 Check positions & live P&L\n` +
        `/command2 — 📊 Analyse auto-trader performance\n` +
        `/command3 — 🔍 Check if bot is working\n`
      );
    default:
      return (
        `❓ Unknown command: <b>${command}</b>\n` +
        `Available: /command1, /command2, /command3`
      );
  }
});

const server = http.createServer(app);
initWebSocketServer(server);

// ── Auto-migrate DB tables on every startup ──────────────────────────────────
// Runs CREATE TABLE IF NOT EXISTS so it's safe to run repeatedly.
// This ensures Render (and any fresh deployment) always has the schema ready.
if (process.env["DATABASE_URL"]) {
  try {
    const { pool: dbPool } = await import("./lib/db.js");
    const migClient = await dbPool.connect();
    try {
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS positions (
          id TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL,
          pair_address TEXT NOT NULL, contract_address TEXT, dex_id TEXT,
          entry_price DOUBLE PRECISION NOT NULL, current_price DOUBLE PRECISION NOT NULL,
          size_sol DOUBLE PRECISION NOT NULL, size_usd DOUBLE PRECISION NOT NULL,
          pnl_usd DOUBLE PRECISION NOT NULL DEFAULT 0, pnl_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open', opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          closed_at TIMESTAMPTZ, close_reason TEXT, tp1_hit BOOLEAN DEFAULT FALSE,
          tp2_hit BOOLEAN DEFAULT FALSE, peak_price DOUBLE PRECISION,
          ai_score INTEGER, confidence INTEGER, llm_verdict TEXT, llm_provider TEXT,
          llm_confidence INTEGER, llm_score INTEGER, llm_risk_level TEXT,
          llm_reasoning TEXT, llm_risks JSONB, llm_strengths JSONB, llm_duration_ms INTEGER,
          pair_age_minutes DOUBLE PRECISION, liquidity_usd DOUBLE PRECISION,
          market_cap_usd DOUBLE PRECISION, volume_24h_usd DOUBLE PRECISION,
          volume_1h_usd DOUBLE PRECISION, price_change_1h DOUBLE PRECISION,
          buy_ratio_1h DOUBLE PRECISION, txns_24h INTEGER,
          recommended_size_sol DOUBLE PRECISION, secondary_verdict TEXT, secondary_provider TEXT
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS loss_journal (
          id TEXT PRIMARY KEY, symbol TEXT NOT NULL, pair_address TEXT NOT NULL,
          entry_price DOUBLE PRECISION NOT NULL, exit_price DOUBLE PRECISION NOT NULL,
          size_sol DOUBLE PRECISION NOT NULL, pnl_usd DOUBLE PRECISION NOT NULL,
          pnl_pct DOUBLE PRECISION NOT NULL, close_reason TEXT NOT NULL,
          opened_at TIMESTAMPTZ NOT NULL, closed_at TIMESTAMPTZ NOT NULL,
          ai_score INTEGER, llm_verdict TEXT, llm_provider TEXT, llm_reasoning TEXT,
          lesson TEXT, tags JSONB
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS alerts (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
          message TEXT NOT NULL, data JSONB, read BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await migClient.query(`
        CREATE TABLE IF NOT EXISTS watchlist (
          id TEXT PRIMARY KEY, symbol TEXT NOT NULL, pair_address TEXT NOT NULL,
          contract_address TEXT, name TEXT, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), notes TEXT
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

// Initialise DB-backed services before accepting traffic
await lossJournalService.init();
await paperTradingService.init();

server.listen(port, () => {
  logger.info({ port }, "Apex Meme Trader AI — server listening");

  scannerService.start();
  paperTradingService.startStopChecker();
  autoTraderService.start();
  autoTraderService.startHeartbeat();
  startCommandPolling();

  logger.info("All services started");

  // Send a startup confirmation to Telegram so you can verify the new bot token is working
  if (isTelegramConfigured()) {
    const env = process.env["RENDER"] ? "🌐 Render (Production)" : "💻 Replit (Dev)";
    const polling = process.env["TELEGRAM_POLLING_DISABLED"] === "true"
      ? "⏸️ Polling disabled on this instance"
      : "✅ Polling active on this instance";
    sendTelegram(
      `🚀 <b>Apex Meme Trader — Bot Online</b>\n` +
      `──────────────────────\n` +
      `🌍 Environment: <b>${env}</b>\n` +
      `📡 ${polling}\n` +
      `🕐 ${toIST(new Date())}\n` +
      `\n` +
      `If you see this message, the new bot token is working correctly.\n` +
      `Commands: /command1 /command2 /command3`,
    ).catch(() => {/* already logged inside sendTelegram */});
  }
});

server.on("error", (err) => {
  logger.error({ err }, "Server error");
  process.exit(1);
});
