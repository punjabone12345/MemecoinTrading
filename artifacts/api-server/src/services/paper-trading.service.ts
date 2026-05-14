import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { scannerService } from "./scanner.service.js";
import { alertsService } from "./alerts.service.js";
import { lossJournalService } from "./loss-journal.service.js";
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

// After this many ms with no priceable data from DexScreener, treat as rug
const RUG_TIMEOUT_MS = 8 * 60 * 1_000;

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
  private openContracts: Set<string> = new Set(); // keyed by token contract address, not symbol
  private positionBroadcaster: (() => void) | null = null;
  // Latest verified price from DexScreener per pairAddress — updated by stop checker every 30s
  private latestPrices: Map<string, { price: number; ts: number }> = new Map();

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
        this.openContracts.add(pos.contractAddress);
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

  hasOpenPositionForContract(contractAddress: string): boolean {
    return this.openContracts.has(contractAddress);
  }

  async buyDirect(token: ScannedToken, sizeSol: number, slOverridePct?: number): Promise<Position> {
    if (sizeSol <= 0) throw new Error("sizeSol must be positive");
    if (sizeSol > this.solBalance) {
      throw new Error(`Insufficient balance. Available: ${this.solBalance.toFixed(4)} SOL`);
    }
    if (token.priceUsd <= 0) throw new Error("Invalid token price");
    if (this.hasOpenPositionForContract(token.address)) {
      throw new Error(`Already have an open position for contract ${token.address} (${token.symbol})`);
    }

    // Always verify entry price directly from DexScreener — scanner cache (esp. GeckoTerminal)
    // can have stale or inaccurate prices that don't match what DexScreener actually shows.
    let verifiedPriceUsd = token.priceUsd;
    try {
      const dexPair = await scannerService.getPairFromDex(token.pairAddress);
      const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
      if (dexPrice > 0) {
        if (Math.abs(dexPrice - token.priceUsd) / token.priceUsd > 0.15) {
          logger.warn(
            { symbol: token.symbol, scannerPrice: token.priceUsd, dexPrice },
            "Entry price mismatch >15% between scanner and DexScreener — using DexScreener price"
          );
        }
        verifiedPriceUsd = dexPrice;
        // Also update the latestPrices cache so PnL is immediately correct
        this.latestPrices.set(token.pairAddress, { price: dexPrice, ts: Date.now() });
      } else {
        logger.warn({ symbol: token.symbol }, "DexScreener returned no price at entry — using scanner price");
      }
    } catch (err) {
      logger.warn({ err, symbol: token.symbol }, "DexScreener price verification failed at entry — using scanner price");
    }

    const { slPercent: defaultSlPct, tpPercent } = getDynamicRisk(token.aiScore);
    const slPercent = slOverridePct !== undefined ? slOverridePct : defaultSlPct;
    const slPrice = verifiedPriceUsd * (1 - slPercent / 100);
    const tpPrice = verifiedPriceUsd * (1 + tpPercent / 100);

    // Market cap projections
    const entryMarketCap = token.marketCap;
    const entryLiquidityUsd = token.liquidity;
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
      entryPrice: verifiedPriceUsd,
      sizeSol,
      slPercent,
      tpPercent,
      slPrice,
      tpPrice,
      entryMarketCap,
      entryLiquidityUsd,
      tpMarketCap,
      slMarketCap,
      aiScore: token.aiScore,
      confidence: token.confidence,
      openedAt: new Date().toISOString(),
      status: "open",
    };

    this.openPositions.set(position.positionId, position);
    this.openContracts.add(token.address);
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

    // Resolve exit price — always prefer a DexScreener-verified price:
    // 1. latestPrices cache (fresh from stop checker or entry verification)
    // 2. fresh DexScreener fetch
    // 3. slPrice when closing as stop_loss (rug with no available price)
    // 4. entryPrice as absolute last resort (0% PnL — prefer slPrice for stop_loss)
    let exitPrice: number;
    const latestEntry = this.latestPrices.get(pos.pairAddress);
    if (latestEntry && latestEntry.price > 0 && Date.now() - latestEntry.ts < 60_000) {
      exitPrice = latestEntry.price;
    } else {
      const dexPair = await scannerService.getPairFromDex(pos.pairAddress);
      const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
      if (dexPrice > 0) {
        exitPrice = dexPrice;
        this.latestPrices.set(pos.pairAddress, { price: dexPrice, ts: Date.now() });
      } else if (reason === "stop_loss") {
        // No live price and closing as stop-loss → use slPrice (reflects the actual loss)
        exitPrice = pos.slPrice;
      } else {
        exitPrice = pos.entryPrice;
      }
    }

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
    this.openContracts.delete(pos.contractAddress);
    this.closedTrades.unshift(closed);
    this.persistOpen();
    this.persistHistory();

    // Record losses in the self-learning journal
    if (pnlSol < 0) {
      lossJournalService.record(closed);
    }

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
        // Always fetch fresh from DexScreener — this is the authoritative price source.
        // Scanner cache (especially GeckoTerminal) can lag or be stale.
        let price: number | null = null;
        const dexPair = await scannerService.getPairFromDex(pos.pairAddress);
        const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
        if (dexPrice > 0) {
          price = dexPrice;
          // Keep latestPrices cache fresh for live PnL display
          this.latestPrices.set(pos.pairAddress, { price: dexPrice, ts: Date.now() });
        } else {
          // DexScreener returned 0/null — token may have rugged (liquidity drained)
          // Fall back to scanner cache as last resort
          const cached = scannerService.getByPairAddress(pos.pairAddress);
          if (cached && cached.priceUsd > 0) {
            price = cached.priceUsd;
            this.latestPrices.set(pos.pairAddress, { price: cached.priceUsd, ts: Date.now() });
          }
        }

        // ── MID-HOLD LIQUIDITY DRAIN DETECTION ────────────────────────────
        // If current liquidity has dropped to <10% of entry liquidity and it's
        // been at least 2 minutes (giving time for initial data to settle),
        // the pool is being drained — close immediately at stop loss.
        // This catches rugs where price hasn't fallen yet but LP is being pulled.
        const currentLiqMidHold = dexPair?.liquidity?.usd ?? 0;
        const holdMsCheck = Date.now() - new Date(pos.openedAt).getTime();
        if (
          pos.entryLiquidityUsd > 0 &&
          currentLiqMidHold > 0 &&
          holdMsCheck > 2 * 60_000 &&
          currentLiqMidHold < pos.entryLiquidityUsd * 0.1
        ) {
          logger.warn(
            { symbol: pos.symbol, entryLiq: pos.entryLiquidityUsd, currentLiq: currentLiqMidHold, dropPct: ((1 - currentLiqMidHold / pos.entryLiquidityUsd) * 100).toFixed(0) },
            "Stop checker: liquidity drained >90% since entry — rug detected, closing at SL"
          );
          await this.close(pos.positionId, "stop_loss");
          continue;
        }

        if (!price || price <= 0) {
          // No price from DexScreener or cache — check if this looks like a rug
          const holdMs = Date.now() - new Date(pos.openedAt).getTime();
          const lastKnown = this.latestPrices.get(pos.pairAddress);
          const msWithoutPrice = lastKnown ? Date.now() - lastKnown.ts : holdMs;

          // Reduced from 8 minutes to 3 minutes — don't hold a dead token long
          if (holdMs > 3 * 60_000 && msWithoutPrice > 3 * 60_000) {
            logger.warn(
              { symbol: pos.symbol, holdMs, msWithoutPrice },
              "Stop checker: no price for 3+ minutes — treating as rug, closing at SL"
            );
            await this.close(pos.positionId, "stop_loss");
          } else {
            logger.warn({ symbol: pos.symbol }, "Stop checker: no DexScreener price yet — will retry");
          }
          continue;
        }

        if (price <= pos.slPrice) {
          logger.info({ symbol: pos.symbol, price, slPrice: pos.slPrice }, "Stop loss triggered");
          await this.close(pos.positionId, "stop_loss");
          continue;
        }

        if (price >= pos.tpPrice) {
          // ── FAKE PRICE DETECTION (LESSON LEARNED FROM REAL LOSSES) ────────
          // DexScreener sometimes shows astronomically fake prices on dead tokens:
          // a single dust buy on a $0 pool creates a price of $999999 which
          // falsely triggers TP and records a fake profit while the coin is -100%.
          //
          // Three guards before accepting any TP:
          //   1. Liquidity floor: pool must have >$5K remaining
          //   2. Price sanity cap: exit price can't be >50x entry (5000% gain impossible
          //      on a token we only target up to 80% TP — any reading above that is fake data)
          //   3. Volume sanity: if price moved >500% but 5m volume < $100, it's manipulated
          const currentLiq  = dexPair?.liquidity?.usd ?? 0;
          const currentVol5m = dexPair?.volume?.m5 ?? 0;
          const priceMultiplier = pos.entryPrice > 0 ? price / pos.entryPrice : 1;

          const MIN_TP_LIQUIDITY_USD = 5_000;   // raised from $2K — thin pools are fake
          const MAX_PRICE_MULTIPLIER = 50;       // 5000% gain = fake price, not real
          const MIN_VOL_FOR_LARGE_MOVE = 100;    // must have $100+ volume if price >500% up

          // Guard 1: liquidity drained
          if (currentLiq > 0 && currentLiq < MIN_TP_LIQUIDITY_USD) {
            logger.warn(
              { symbol: pos.symbol, price, tpPrice: pos.tpPrice, currentLiq },
              "TP rejected: liquidity drained (<$5K) — likely rug, closing at SL"
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          // Guard 2: astronomically fake price (the +9999999 SOL bug)
          if (priceMultiplier > MAX_PRICE_MULTIPLIER) {
            logger.warn(
              { symbol: pos.symbol, price, entryPrice: pos.entryPrice, priceMultiplier: priceMultiplier.toFixed(0) },
              `TP rejected: price is ${priceMultiplier.toFixed(0)}x entry — fake/manipulated data, closing at SL`
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          // Guard 3: big price move with no real volume = single dust buy manipulation
          if (priceMultiplier > 5 && currentVol5m < MIN_VOL_FOR_LARGE_MOVE) {
            logger.warn(
              { symbol: pos.symbol, price, priceMultiplier: priceMultiplier.toFixed(1), currentVol5m },
              "TP rejected: >5x price move but <$100 volume in 5m — dust manipulation, closing at SL"
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          logger.info({ symbol: pos.symbol, price, tpPrice: pos.tpPrice, currentLiq, priceMultiplier: priceMultiplier.toFixed(2) }, "Take profit triggered");
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
      // Priority: (1) DexScreener-verified latestPrices cache updated by stop checker every 30s
      //           (2) scanner cache as fallback
      //           (3) slPrice if token has been unresolvable long enough (likely rugged)
      //           (4) entryPrice only for brand-new positions not yet priced by the stop checker
      const latestEntry = this.latestPrices.get(pos.pairAddress);
      const scannerToken = scannerService.getByPairAddress(pos.pairAddress);

      let currentPrice: number;
      if (latestEntry && latestEntry.price > 0) {
        currentPrice = latestEntry.price;
      } else if (scannerToken && scannerToken.priceUsd > 0) {
        currentPrice = scannerToken.priceUsd;
      } else {
        // Token not priceable — check if it's been open long enough to be suspicious
        const holdMs = Date.now() - new Date(pos.openedAt).getTime();
        if (holdMs > RUG_TIMEOUT_MS) {
          // Show stop-loss price so the card reflects the true worst-case loss
          currentPrice = pos.slPrice;
        } else {
          // Brand-new position, stop checker hasn't run yet — use entry price (0% PnL)
          currentPrice = pos.entryPrice;
        }
      }

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

  deleteClosedTrade(positionId: string): void {
    const idx = this.closedTrades.findIndex((t) => t.positionId === positionId);
    if (idx === -1) throw new Error(`Closed trade not found: ${positionId}`);

    const trade = this.closedTrades[idx];
    this.closedTrades.splice(idx, 1);

    // Recompute balance from remaining history (same logic as loadFromDisk)
    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

    this.persistHistory();
    this.broadcastPositions();

    logger.info(
      { positionId, symbol: trade.symbol, pnlSol: trade.pnlSol, newBalance: this.solBalance.toFixed(4) },
      "Closed trade deleted — balance recomputed",
    );
  }

  /**
   * Edit a closed trade's outcome.
   * Use this to correct fake profits caused by manipulated DexScreener prices
   * (e.g. +9999999 SOL from thin-pool price manipulation).
   *
   * Providing closeReason="stop_loss" with pnlOverrideSol=-(slPercent loss)
   * will mark it as a full stop-loss and recompute the account balance.
   */
  editClosedTrade(
    positionId: string,
    patch: {
      pnlSol?: number;
      pnlPercent?: number;
      exitPrice?: number;
      closeReason?: "manual" | "stop_loss" | "take_profit";
      note?: string;
    },
  ): Position {
    const idx = this.closedTrades.findIndex((t) => t.positionId === positionId);
    if (idx === -1) throw new Error(`Closed trade not found: ${positionId}`);

    const old = this.closedTrades[idx];

    const updated: Position = {
      ...old,
      ...(patch.exitPrice !== undefined  ? { exitPrice: patch.exitPrice }   : {}),
      ...(patch.pnlSol !== undefined     ? { pnlSol: patch.pnlSol }         : {}),
      ...(patch.pnlPercent !== undefined ? { pnlPercent: patch.pnlPercent } : {}),
      ...(patch.closeReason !== undefined ? { closeReason: patch.closeReason } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    };

    this.closedTrades[idx] = updated;

    // Recompute balance from all closed trades
    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

    this.persistHistory();
    this.broadcastPositions();

    // Re-record in loss journal if the updated trade is a loss
    if ((updated.pnlSol ?? 0) < 0) {
      lossJournalService.reRecord(updated);
    }

    logger.info(
      { positionId, symbol: old.symbol, oldPnl: old.pnlSol, newPnl: updated.pnlSol, newBalance: this.solBalance.toFixed(4) },
      "Closed trade edited — balance recomputed",
    );

    return updated;
  }

  reset(): void {
    const hadPositions = this.openPositions.size;
    const oldBalance = this.solBalance;
    this.openPositions.clear();
    this.openContracts.clear();
    this.closedTrades = [];
    this.solBalance = INITIAL_BALANCE_SOL;
    this.persistOpen();
    this.persistHistory();
    logger.info("Paper trading account reset to 100 SOL");
    this.broadcastPositions();
    void sendTelegram(
      `🔄 <b>ACCOUNT RESET</b>\n` +
      `──────────────────────\n` +
      `🗑️ Cleared: <b>${hadPositions} open position${hadPositions !== 1 ? "s" : ""}</b> & all trade history\n` +
      `💰 Old Balance: <b>${oldBalance.toFixed(4)} SOL</b>\n` +
      `✅ New Balance: <b>${INITIAL_BALANCE_SOL.toFixed(4)} SOL</b>\n` +
      `🕐 ${toIST(new Date())}`,
    );
  }

  startStopChecker() {
    setInterval(() => void this.checkStopsForAll(), 30_000);
    logger.info("Stop/TP checker started — checking every 30s");
  }
}

export const paperTradingService = new PaperTradingService();
