import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { scannerService } from "./scanner.service.js";
import { alertsService } from "./alerts.service.js";
import { getDynamicRisk } from "./ai-scoring.service.js";
import { sendTelegram, toIST } from "../lib/telegram.js";
import type { Position, Portfolio, CloseReason, ScannedToken } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");
const HISTORY_FILE = path.join(DATA_DIR, "trades_history.json");

const INITIAL_BALANCE_SOL = 100;
const FEE_RATE = 0.003;
const SLIPPAGE_RATE = 0.005;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  try {
    ensureDataDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error({ err, file }, "Failed to persist data");
  }
}

function formatHoldTime(ms: number): string {
  const totalMins = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatPrice(price: number): string {
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

function formatMcap(mcap: number): string {
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(2)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(2)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

class PaperTradingService {
  private openPositions: Map<string, Position> = new Map();
  private closedTrades: Position[] = [];
  private solBalance = INITIAL_BALANCE_SOL;
  private openSymbols: Set<string> = new Set();
  private positionBroadcaster: (() => void) | null = null;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk() {
    ensureDataDir();
    const open = readJson<Position[]>(POSITIONS_FILE, []);
    const history = readJson<Position[]>(HISTORY_FILE, []);

    this.closedTrades = history;

    for (const pos of open) {
      if (pos.status === "open") {
        this.openPositions.set(pos.positionId, pos);
        this.openSymbols.add(pos.symbol.toUpperCase());
        this.solBalance -= pos.sizeSol;
      }
    }

    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

    logger.info(
      { openPositions: this.openPositions.size, closedTrades: this.closedTrades.length, solBalance: this.solBalance.toFixed(4) },
      "Paper trading state restored from disk",
    );
  }

  private totalOpenSol(): number {
    return Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol, 0);
  }

  private persistOpen() {
    writeJson(POSITIONS_FILE, Array.from(this.openPositions.values()));
  }

  private persistHistory() {
    writeJson(HISTORY_FILE, this.closedTrades);
  }

  setPositionBroadcaster(fn: () => void) {
    this.positionBroadcaster = fn;
  }

  private broadcastPositions() {
    this.positionBroadcaster?.();
  }

  hasOpenPositionForSymbol(symbol: string): boolean {
    return this.openSymbols.has(symbol.toUpperCase());
  }

  async buyDirect(token: ScannedToken, sizeSol: number): Promise<Position> {
    if (sizeSol <= 0) throw new Error("sizeSol must be positive");
    if (sizeSol > this.solBalance) {
      throw new Error(`Insufficient balance. Available: ${this.solBalance.toFixed(4)} SOL`);
    }
    if (token.priceUsd <= 0) throw new Error("Invalid token price");
    if (this.hasOpenPositionForSymbol(token.symbol)) {
      throw new Error(`Already have an open position for ${token.symbol}`);
    }

    const { slPercent, tpPercent } = getDynamicRisk(token.aiScore);
    const slPrice = token.priceUsd * (1 - slPercent / 100);
    const tpPrice = token.priceUsd * (1 + tpPercent / 100);

    // Market cap projections
    const entryMarketCap = token.marketCap;
    const tpMarketCap = entryMarketCap > 0 ? entryMarketCap * (1 + tpPercent / 100) : 0;
    const slMarketCap = entryMarketCap > 0 ? entryMarketCap * (1 - slPercent / 100) : 0;

    this.solBalance -= sizeSol;

    const position: Position = {
      positionId: randomUUID(),
      symbol: token.symbol,
      tokenName: token.name,
      pairAddress: token.pairAddress,
      contractAddress: token.address,
      imageUrl: token.imageUrl,
      entryPrice: token.priceUsd,
      sizeSol,
      slPercent,
      tpPercent,
      slPrice,
      tpPrice,
      entryMarketCap,
      tpMarketCap,
      slMarketCap,
      aiScore: token.aiScore,
      confidence: token.confidence,
      openedAt: new Date().toISOString(),
      status: "open",
    };

    this.openPositions.set(position.positionId, position);
    this.openSymbols.add(token.symbol.toUpperCase());
    this.persistOpen();

    logger.info({ positionId: position.positionId, symbol: token.symbol, aiScore: token.aiScore, slPercent, tpPercent }, "Position opened");

    alertsService.tradeOpened(position.positionId, token.symbol, sizeSol, token.pairAddress);

    void sendTelegram(
      `🟢 <b>TRADE OPENED — $${token.symbol}</b>\n` +
      `──────────────────────\n` +
      `🏷️ Token: <b>${token.name}</b>\n` +
      `📍 CA: <code>${token.address}</code>\n` +
      `\n` +
      `💰 <b>Entry Price:</b> $${formatPrice(token.priceUsd)}\n` +
      `🎯 <b>Take Profit:</b> $${formatPrice(tpPrice)} (+${tpPercent}%)\n` +
      `🛑 <b>Stop Loss:</b> $${formatPrice(slPrice)} (-${slPercent}%)\n` +
      `\n` +
      `📊 <b>Market Cap at Entry:</b> ${formatMcap(entryMarketCap)}\n` +
      `🎯 <b>Target MCap (TP):</b> ${tpMarketCap > 0 ? formatMcap(tpMarketCap) : "N/A"}\n` +
      `🛑 <b>MCap at SL:</b> ${slMarketCap > 0 ? formatMcap(slMarketCap) : "N/A"}\n` +
      `\n` +
      `📦 Size: ${sizeSol} SOL\n` +
      `🤖 AI Score: ${token.aiScore} | Confidence: ${token.confidence}%\n` +
      `🕐 Time: ${toIST(new Date())}\n` +
      `🔗 <a href="https://dexscreener.com/solana/${token.address}">View on DexScreener</a>`,
    );

    this.broadcastPositions();
    return position;
  }

  async buy(pairAddress: string, sizeSol = 0.5): Promise<Position> {
    const token = await scannerService.getOrFetchToken(pairAddress);
    if (!token) throw new Error(`Token not found for pair: ${pairAddress}`);
    return this.buyDirect(token, sizeSol);
  }

  private computePnl(pos: Position, exitPrice: number): { pnlSol: number; pnlPercent: number; netReturn: number } {
    const grossReturn = pos.sizeSol * (exitPrice / pos.entryPrice);
    const exitFee = grossReturn * FEE_RATE;
    const slippage = pos.sizeSol * SLIPPAGE_RATE;
    const entryFee = pos.sizeSol * FEE_RATE;
    const netReturn = grossReturn - exitFee - slippage;
    const pnlSol = netReturn - pos.sizeSol - entryFee;
    const pnlPercent = (pnlSol / pos.sizeSol) * 100;
    return { pnlSol, pnlPercent, netReturn };
  }

  async close(positionId: string, reason: CloseReason): Promise<Position> {
    const pos = this.openPositions.get(positionId);
    if (!pos) throw new Error(`Position not found: ${positionId}`);

    const token = await scannerService.getOrFetchToken(pos.pairAddress);
    const exitPrice = token?.priceUsd ?? pos.entryPrice;

    const { pnlSol, pnlPercent, netReturn } = this.computePnl(pos, exitPrice);

    this.solBalance += netReturn;

    const closedAt = new Date().toISOString();
    const holdTimeMs = Date.now() - new Date(pos.openedAt).getTime();

    const closed: Position = {
      ...pos,
      exitPrice,
      closedAt,
      status: "closed",
      closeReason: reason,
      pnlSol,
      pnlPercent,
      holdTimeMs,
    };

    this.openPositions.delete(positionId);
    this.openSymbols.delete(pos.symbol.toUpperCase());
    this.closedTrades.unshift(closed);
    this.persistOpen();
    this.persistHistory();

    logger.info({ positionId, symbol: pos.symbol, reason, pnlSol: pnlSol.toFixed(4) }, "Position closed");

    const holdLabel = formatHoldTime(holdTimeMs);
    const sign = pnlSol >= 0 ? "+" : "";
    const portfolio = this.getPortfolio();

    if (reason === "take_profit") {
      alertsService.takeProfitHit(positionId, pos.symbol, pnlSol, pos.pairAddress);
      void sendTelegram(
        `✅ <b>TAKE PROFIT HIT — $${pos.symbol}</b>\n` +
        `──────────────────────\n` +
        `📍 CA: <code>${pos.contractAddress}</code>\n` +
        `💰 Entry: $${formatPrice(pos.entryPrice)} → Exit: $${formatPrice(exitPrice)}\n` +
        `📈 P&L: <b>${sign}${pnlPercent.toFixed(1)}% | ${sign}${pnlSol.toFixed(4)} SOL</b>\n` +
        `⏱️ Hold Time: ${holdLabel}\n` +
        `💼 Balance Now: ${portfolio.solBalance.toFixed(4)} SOL\n` +
        `🕐 Time: ${toIST(new Date())}\n` +
        `🔗 <a href="https://dexscreener.com/solana/${pos.contractAddress}">View on DexScreener</a>`,
      );
    } else if (reason === "stop_loss") {
      alertsService.stopLossHit(positionId, pos.symbol, pnlSol, pos.pairAddress);
      void sendTelegram(
        `🔴 <b>STOP LOSS HIT — $${pos.symbol}</b>\n` +
        `──────────────────────\n` +
        `📍 CA: <code>${pos.contractAddress}</code>\n` +
        `💰 Entry: $${formatPrice(pos.entryPrice)} → Exit: $${formatPrice(exitPrice)}\n` +
        `📉 P&L: <b>${sign}${pnlPercent.toFixed(1)}% | ${sign}${pnlSol.toFixed(4)} SOL</b>\n` +
        `⏱️ Hold Time: ${holdLabel}\n` +
        `💼 Balance Now: ${portfolio.solBalance.toFixed(4)} SOL\n` +
        `🕐 Time: ${toIST(new Date())}\n` +
        `🔗 <a href="https://dexscreener.com/solana/${pos.contractAddress}">View on DexScreener</a>`,
      );
    } else {
      alertsService.tradeClosed(positionId, pos.symbol, pnlSol, pnlPercent, pos.pairAddress, "Manual Close");
      void sendTelegram(
        `⚪ <b>TRADE CLOSED (Manual) — $${pos.symbol}</b>\n` +
        `──────────────────────\n` +
        `📍 CA: <code>${pos.contractAddress}</code>\n` +
        `💰 Entry: $${formatPrice(pos.entryPrice)} → Exit: $${formatPrice(exitPrice)}\n` +
        `📊 P&L: <b>${sign}${pnlPercent.toFixed(1)}% | ${sign}${pnlSol.toFixed(4)} SOL</b>\n` +
        `⏱️ Hold Time: ${holdLabel}\n` +
        `💼 Balance Now: ${portfolio.solBalance.toFixed(4)} SOL\n` +
        `🕐 Time: ${toIST(new Date())}\n` +
        `🔗 <a href="https://dexscreener.com/solana/${pos.contractAddress}">View on DexScreener</a>`,
      );
    }

    this.broadcastPositions();
    return closed;
  }

  async checkStopsForAll(): Promise<void> {
    const MAX_HOLD_MS = 48 * 60 * 60 * 1_000; // auto-close after 48h (stuck/illiquid)

    for (const pos of Array.from(this.openPositions.values())) {
      try {
        // Try scanner cache first; if expired, fetch directly from DexScreener
        // Critical: SL/TP must fire even if token aged out of the 15-min scanner TTL
        let price: number | null = null;
        const cached = scannerService.getByPairAddress(pos.pairAddress);
        if (cached && cached.priceUsd > 0) {
          price = cached.priceUsd;
        } else {
          logger.debug({ symbol: pos.symbol }, "Stop checker: token not in cache, fetching from DexScreener");
          const fetched = await scannerService.getOrFetchToken(pos.pairAddress);
          price = fetched?.priceUsd ?? null;
        }

        if (!price || price <= 0) {
          logger.warn({ symbol: pos.symbol, pairAddress: pos.pairAddress }, "Stop checker: could not get price — skipping");
          continue;
        }

        if (price <= pos.slPrice) {
          logger.info({ symbol: pos.symbol, price, slPrice: pos.slPrice }, "Stop loss triggered");
          await this.close(pos.positionId, "stop_loss");
          continue;
        }

        if (price >= pos.tpPrice) {
          logger.info({ symbol: pos.symbol, price, tpPrice: pos.tpPrice }, "Take profit triggered");
          await this.close(pos.positionId, "take_profit");
          continue;
        }

        // Auto-close stuck / illiquid positions after 48 hours
        const holdMs = Date.now() - new Date(pos.openedAt).getTime();
        if (holdMs > MAX_HOLD_MS) {
          logger.warn({ symbol: pos.symbol, holdHours: (holdMs / 3_600_000).toFixed(1) }, "Auto-closing stale position (>48h)");
          await this.close(pos.positionId, "manual");
        }
      } catch (err) {
        logger.error({ err, symbol: pos.symbol }, "Stop checker error for position");
      }
    }
  }

  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values()).sort(
      (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
    );
  }

  getOpenPositionsWithLivePnl(): (Position & { livePnlSol: number; livePnlPercent: number; currentPrice: number })[] {
    return this.getOpenPositions().map((pos) => {
      const token = scannerService.getByPairAddress(pos.pairAddress);
      const currentPrice = token?.priceUsd ?? pos.entryPrice;
      const { pnlSol, pnlPercent } = this.computePnl(pos, currentPrice);
      return { ...pos, livePnlSol: pnlSol, livePnlPercent: pnlPercent, currentPrice };
    });
  }

  getClosedTrades(): Position[] {
    return this.closedTrades;
  }

  getAllTrades(): Position[] {
    return [...this.getOpenPositions(), ...this.closedTrades];
  }

  getPositionById(positionId: string): Position | undefined {
    return this.openPositions.get(positionId) ?? this.closedTrades.find((t) => t.positionId === positionId);
  }

  getPortfolio(): Portfolio {
    const openWithPnl = this.getOpenPositionsWithLivePnl();
    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    const openValue = openWithPnl.reduce((s, p) => s + p.sizeSol + p.livePnlSol, 0);
    const totalPnlSol = closedPnl;

    return {
      solBalance: this.solBalance,
      initialBalance: INITIAL_BALANCE_SOL,
      totalPnlSol,
      totalPnlPercent: (totalPnlSol / INITIAL_BALANCE_SOL) * 100,
      openPositionsCount: this.openPositions.size,
      openPositionsValueSol: openValue,
    };
  }

  reset(): void {
    this.openPositions.clear();
    this.openSymbols.clear();
    this.closedTrades = [];
    this.solBalance = INITIAL_BALANCE_SOL;
    this.persistOpen();
    this.persistHistory();
    logger.info("Paper trading account reset to 100 SOL");
    this.broadcastPositions();
  }

  startStopChecker() {
    setInterval(() => void this.checkStopsForAll(), 30_000);
    logger.info("Stop/TP checker started — checking every 30s");
  }
}

export const paperTradingService = new PaperTradingService();
