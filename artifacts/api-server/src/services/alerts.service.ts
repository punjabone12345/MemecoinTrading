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
    if (this.alerts.length > this.MAX_ALERTS) this.alerts = this.alerts.slice(0, this.MAX_ALERTS);
    this.broadcaster?.(alert);
    return alert;
  }

  tradeOpened(positionId: string, symbol: string, sizeSol: number, pairAddress: string) {
    return this.push("trade_opened", `🟢 Trade Opened — ${symbol}`, `Bought ${sizeSol.toFixed(4)} SOL of ${symbol}`, { positionId, tokenSymbol: symbol, pairAddress });
  }

  tradeClosed(positionId: string, symbol: string, pnlSol: number, pnlPercent: number, pairAddress: string, reason: string) {
    const sign = pnlSol >= 0 ? "+" : "";
    return this.push("trade_closed", `⚪ Trade Closed — ${symbol}`, `${reason} | PNL: ${sign}${pnlSol.toFixed(4)} SOL (${sign}${pnlPercent.toFixed(2)}%)`, { positionId, tokenSymbol: symbol, pairAddress });
  }

  stopLossHit(positionId: string, symbol: string, pnlSol: number, pairAddress: string) {
    return this.push("stop_loss_hit", `🔴 Stop Loss Hit — ${symbol}`, `Loss: ${pnlSol.toFixed(4)} SOL`, { positionId, tokenSymbol: symbol, pairAddress });
  }

  takeProfitHit(positionId: string, symbol: string, pnlSol: number, pairAddress: string) {
    return this.push("take_profit_hit", `✅ Take Profit Hit — ${symbol}`, `Profit: +${pnlSol.toFixed(4)} SOL`, { positionId, tokenSymbol: symbol, pairAddress });
  }

  highAiScore(symbol: string, aiScore: number, pairAddress: string) {
    return this.push("high_ai_score", `🤖 High AI Score — ${symbol}`, `${symbol} reached AI score of ${aiScore}/100`, { tokenSymbol: symbol, pairAddress, aiScore });
  }

  getAll(): Alert[] { return this.alerts; }
  getUnread(): Alert[] { return this.alerts.filter((a) => !a.read); }

  markRead(id: string): boolean {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return false;
    a.read = true;
    return true;
  }

  markAllRead(): void { this.alerts.forEach((a) => { a.read = true; }); }
  clear(): void { this.alerts = []; }
}

export const alertsService = new AlertsService();
