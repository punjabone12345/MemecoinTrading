import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { scannerService } from "./scanner.service.js";
import { alertsService } from "./alerts.service.js";
import type {
  BuyOrderRequest,
  Portfolio,
  ScannedToken,
  TradeEntry,
  CloseReason,
} from "../types/index.js";

const INITIAL_BALANCE_SOL = 100;
const FEE_RATE = 0.003;
const SLIPPAGE_RATE = 0.005;

class PaperTradingService {
  private trades: Map<string, TradeEntry> = new Map();
  private solBalance = INITIAL_BALANCE_SOL;
  private positionBroadcaster: (() => void) | null = null;

  setPositionBroadcaster(fn: () => void) {
    this.positionBroadcaster = fn;
  }

  private broadcastPositions() {
    this.positionBroadcaster?.();
  }

  async buyDirect(
    token: ScannedToken,
    solAmount: number,
    stopLoss: number,
    takeProfit: number,
  ): Promise<TradeEntry> {
    if (solAmount <= 0) throw new Error("solAmount must be positive");
    if (solAmount > this.solBalance) {
      throw new Error(
        `Insufficient balance. Available: ${this.solBalance.toFixed(4)} SOL`,
      );
    }
    if (token.priceUsd <= 0) throw new Error("Invalid token price");

    const entryFee = solAmount * FEE_RATE;
    const slippageCost = solAmount * SLIPPAGE_RATE;
    const effectiveSol = solAmount - entryFee - slippageCost;
    const solPriceUsd =
      token.priceNative > 0 ? token.priceUsd / token.priceNative : 0;
    const effectiveSolUsd = effectiveSol * solPriceUsd;
    const tokenAmount =
      effectiveSolUsd > 0 ? effectiveSolUsd / token.priceUsd : 0;

    this.solBalance -= solAmount;

    const trade: TradeEntry = {
      id: randomUUID(),
      pairAddress: token.pairAddress,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      direction: "buy",
      status: "open",
      entryPrice: token.priceUsd,
      solAmount,
      tokenAmount,
      entryFee,
      slippage: slippageCost,
      stopLoss,
      takeProfit,
      openedAt: Date.now(),
      aiScoreAtEntry: token.aiScore,
    };

    this.trades.set(trade.id, trade);

    logger.info(
      { tradeId: trade.id, token: token.symbol, solAmount, source: "auto" },
      "Auto paper trade opened",
    );

    alertsService.tradeOpened(trade.id, trade.tokenSymbol, solAmount, token.pairAddress);
    this.broadcastPositions();
    return trade;
  }

  async buy(req: BuyOrderRequest): Promise<TradeEntry> {
    const { pairAddress, solAmount, stopLoss, takeProfit, trailingStop } = req;

    if (solAmount <= 0) throw new Error("solAmount must be positive");
    if (solAmount > this.solBalance) {
      throw new Error(
        `Insufficient balance. Available: ${this.solBalance.toFixed(4)} SOL`,
      );
    }

    const token = await scannerService.getOrFetchToken(pairAddress);
    if (!token) throw new Error(`Token not found for pair: ${pairAddress}`);
    if (token.priceUsd <= 0) throw new Error("Invalid token price");

    const entryFee = solAmount * FEE_RATE;
    const slippageCost = solAmount * SLIPPAGE_RATE;
    const effectiveSol = solAmount - entryFee - slippageCost;
    const solPriceUsd = token.priceUsd / token.priceNative;
    const effectiveSolUsd = effectiveSol * solPriceUsd;
    const tokenAmount = effectiveSolUsd / token.priceUsd;

    this.solBalance -= solAmount;

    let trailingStopTriggerPrice: number | undefined;
    if (trailingStop !== undefined) {
      trailingStopTriggerPrice =
        token.priceUsd * (1 - trailingStop / 100);
    }

    const trade: TradeEntry = {
      id: randomUUID(),
      pairAddress,
      tokenName: token.name,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      direction: "buy",
      status: "open",
      entryPrice: token.priceUsd,
      solAmount,
      tokenAmount,
      entryFee,
      slippage: slippageCost,
      stopLoss,
      takeProfit,
      trailingStop,
      trailingStopHighPrice: trailingStop !== undefined ? token.priceUsd : undefined,
      trailingStopTriggerPrice,
      openedAt: Date.now(),
      aiScoreAtEntry: token.aiScore,
    };

    this.trades.set(trade.id, trade);

    logger.info(
      { tradeId: trade.id, token: token.symbol, solAmount },
      "Paper trade opened",
    );

    alertsService.tradeOpened(
      trade.id,
      trade.tokenSymbol,
      solAmount,
      pairAddress,
    );

    this.broadcastPositions();
    return trade;
  }

  private computePnl(
    trade: TradeEntry,
    currentPrice: number,
  ): { pnlSol: number; pnlPercent: number } {
    const solPriceRatio = currentPrice / trade.entryPrice;
    const grossSol = trade.solAmount * solPriceRatio;
    const exitFee = grossSol * FEE_RATE;
    const exitSlippage = grossSol * SLIPPAGE_RATE;
    const netSol = grossSol - exitFee - exitSlippage;
    const pnlSol = netSol - trade.solAmount;
    const pnlPercent = (pnlSol / trade.solAmount) * 100;
    return { pnlSol, pnlPercent };
  }

  async sell(tradeId: string): Promise<TradeEntry> {
    return this._close(tradeId, "manual");
  }

  private async _close(
    tradeId: string,
    reason: CloseReason,
  ): Promise<TradeEntry> {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`Trade not found: ${tradeId}`);
    if (trade.status === "closed") throw new Error("Trade already closed");

    const token = await scannerService.getOrFetchToken(trade.pairAddress);
    const currentPrice = token?.priceUsd ?? trade.entryPrice;

    const { pnlSol, pnlPercent } = this.computePnl(trade, currentPrice);

    const solPriceRatio = currentPrice / trade.entryPrice;
    const grossSol = trade.solAmount * solPriceRatio;
    const exitFee = grossSol * FEE_RATE;
    const exitSlippage = grossSol * SLIPPAGE_RATE;
    const netSol = grossSol - exitFee - exitSlippage;

    trade.status = "closed";
    trade.exitPrice = currentPrice;
    trade.exitFee = exitFee;
    trade.closedAt = Date.now();
    trade.closeReason = reason;
    trade.pnlSol = pnlSol;
    trade.pnlPercent = pnlPercent;

    this.solBalance += netSol;

    const reasonLabel =
      reason === "manual"
        ? "Manual Close"
        : reason === "stop_loss"
          ? "Stop Loss"
          : reason === "take_profit"
            ? "Take Profit"
            : "Trailing Stop";

    if (reason === "stop_loss") {
      alertsService.stopLossHit(tradeId, trade.tokenSymbol, pnlSol, trade.pairAddress);
    } else if (reason === "take_profit") {
      alertsService.takeProfitHit(tradeId, trade.tokenSymbol, pnlSol, trade.pairAddress);
    } else if (reason === "trailing_stop") {
      alertsService.trailingStopHit(tradeId, trade.tokenSymbol, pnlSol, trade.pairAddress);
    } else {
      alertsService.tradeClosed(
        tradeId,
        trade.tokenSymbol,
        pnlSol,
        pnlPercent,
        trade.pairAddress,
        reasonLabel,
      );
    }

    logger.info(
      { tradeId, reason, pnlSol: pnlSol.toFixed(4) },
      "Paper trade closed",
    );

    this.broadcastPositions();
    return trade;
  }

  async checkStopsForAll(): Promise<void> {
    const openTrades = this.getOpenTrades();
    for (const trade of openTrades) {
      const token = scannerService.getByPairAddress(trade.pairAddress);
      if (!token) continue;

      const currentPrice = token.priceUsd;

      if (trade.trailingStop !== undefined && trade.trailingStopHighPrice !== undefined) {
        if (currentPrice > trade.trailingStopHighPrice) {
          trade.trailingStopHighPrice = currentPrice;
          trade.trailingStopTriggerPrice =
            currentPrice * (1 - trade.trailingStop / 100);
        }
        if (
          trade.trailingStopTriggerPrice !== undefined &&
          currentPrice <= trade.trailingStopTriggerPrice
        ) {
          await this._close(trade.id, "trailing_stop");
          continue;
        }
      }

      if (trade.stopLoss !== undefined && currentPrice <= trade.stopLoss) {
        await this._close(trade.id, "stop_loss");
        continue;
      }

      if (trade.takeProfit !== undefined && currentPrice >= trade.takeProfit) {
        await this._close(trade.id, "take_profit");
        continue;
      }
    }
  }

  getOpenTrades(): TradeEntry[] {
    return Array.from(this.trades.values())
      .filter((t) => t.status === "open")
      .sort((a, b) => b.openedAt - a.openedAt);
  }

  getClosedTrades(): TradeEntry[] {
    return Array.from(this.trades.values())
      .filter((t) => t.status === "closed")
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  }

  getAllTrades(): TradeEntry[] {
    return Array.from(this.trades.values()).sort(
      (a, b) => b.openedAt - a.openedAt,
    );
  }

  getOpenTradesWithLivePnl(): (TradeEntry & { livePnlSol: number; livePnlPercent: number; currentPrice: number })[] {
    return this.getOpenTrades().map((trade) => {
      const token = scannerService.getByPairAddress(trade.pairAddress);
      const currentPrice = token?.priceUsd ?? trade.entryPrice;
      const { pnlSol, pnlPercent } = this.computePnl(trade, currentPrice);
      return {
        ...trade,
        livePnlSol: pnlSol,
        livePnlPercent: pnlPercent,
        currentPrice,
      };
    });
  }

  getPortfolio(): Portfolio {
    const openTrades = this.getOpenTradesWithLivePnl();
    const closedTrades = this.getClosedTrades();

    const totalPnlSol = closedTrades.reduce(
      (sum, t) => sum + (t.pnlSol ?? 0),
      0,
    );
    const openValue = openTrades.reduce(
      (sum, t) => sum + t.solAmount + t.livePnlSol,
      0,
    );

    return {
      solBalance: this.solBalance,
      initialBalance: INITIAL_BALANCE_SOL,
      totalPnlSol,
      totalPnlPercent: (totalPnlSol / INITIAL_BALANCE_SOL) * 100,
      openPositionsCount: openTrades.length,
      openPositionsValueSol: openValue,
    };
  }

  reset(): void {
    this.trades.clear();
    this.solBalance = INITIAL_BALANCE_SOL;
    logger.info("Paper trading account reset");
    this.broadcastPositions();
  }

  startStopChecker() {
    setInterval(() => void this.checkStopsForAll(), 1500);
  }
}

export const paperTradingService = new PaperTradingService();
