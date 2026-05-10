import { randomUUID } from "crypto";
import type { Alert } from "../types/index.js";

class AlertsService {
  private alerts: Alert[] = [];
  private readonly MAX_ALERTS = 500;
  private broadcaster: ((alert: Alert) => void) | null = null;

  setBroadcaster(fn: (alert: Alert) => void) {
    this.broadcaster = fn;
  }

  private push(
    type: Alert["type"],
    title: string,
    message: string,
    extras: Partial<Alert> = {},
  ): Alert {
    const alert: Alert = {
      id: randomUUID(),
      type,
      title,
      message,
      createdAt: Date.now(),
      read: false,
      ...extras,
    };

    this.alerts.unshift(alert);

    if (this.alerts.length > this.MAX_ALERTS) {
      this.alerts = this.alerts.slice(0, this.MAX_ALERTS);
    }

    if (this.broadcaster) {
      this.broadcaster(alert);
    }

    return alert;
  }

  tradeOpened(
    tradeId: string,
    tokenSymbol: string,
    solAmount: number,
    pairAddress: string,
  ) {
    return this.push(
      "trade_opened",
      `🟢 Trade Opened — ${tokenSymbol}`,
      `Bought ${solAmount.toFixed(4)} SOL of ${tokenSymbol}`,
      { tradeId, tokenSymbol, pairAddress },
    );
  }

  tradeClosed(
    tradeId: string,
    tokenSymbol: string,
    pnlSol: number,
    pnlPercent: number,
    pairAddress: string,
    reason: string,
  ) {
    const sign = pnlSol >= 0 ? "+" : "";
    return this.push(
      "trade_closed",
      `⚪ Trade Closed — ${tokenSymbol}`,
      `${reason} | PNL: ${sign}${pnlSol.toFixed(4)} SOL (${sign}${pnlPercent.toFixed(2)}%)`,
      { tradeId, tokenSymbol, pairAddress },
    );
  }

  stopLossHit(
    tradeId: string,
    tokenSymbol: string,
    pnlSol: number,
    pairAddress: string,
  ) {
    return this.push(
      "stop_loss_hit",
      `🔴 Stop Loss Hit — ${tokenSymbol}`,
      `Stop loss triggered. Loss: ${pnlSol.toFixed(4)} SOL`,
      { tradeId, tokenSymbol, pairAddress },
    );
  }

  takeProfitHit(
    tradeId: string,
    tokenSymbol: string,
    pnlSol: number,
    pairAddress: string,
  ) {
    return this.push(
      "take_profit_hit",
      `🟢 Take Profit Hit — ${tokenSymbol}`,
      `Take profit triggered. Profit: +${pnlSol.toFixed(4)} SOL`,
      { tradeId, tokenSymbol, pairAddress },
    );
  }

  trailingStopHit(
    tradeId: string,
    tokenSymbol: string,
    pnlSol: number,
    pairAddress: string,
  ) {
    return this.push(
      "trailing_stop_hit",
      `🟡 Trailing Stop Hit — ${tokenSymbol}`,
      `Trailing stop triggered. PNL: ${pnlSol.toFixed(4)} SOL`,
      { tradeId, tokenSymbol, pairAddress },
    );
  }

  highAiScore(
    tokenSymbol: string,
    aiScore: number,
    pairAddress: string,
  ) {
    return this.push(
      "high_ai_score",
      `🤖 High AI Score — ${tokenSymbol}`,
      `${tokenSymbol} reached AI score of ${aiScore}/100`,
      { tokenSymbol, pairAddress, aiScore },
    );
  }

  getAll(): Alert[] {
    return this.alerts;
  }

  getUnread(): Alert[] {
    return this.alerts.filter((a) => !a.read);
  }

  markRead(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return false;
    alert.read = true;
    return true;
  }

  markAllRead(): void {
    this.alerts.forEach((a) => {
      a.read = true;
    });
  }

  clear(): void {
    this.alerts = [];
  }
}

export const alertsService = new AlertsService();
