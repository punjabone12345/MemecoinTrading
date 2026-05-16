import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { scannerService } from "./scanner.service.js";
import { alertsService } from "./alerts.service.js";
import { lossJournalService } from "./loss-journal.service.js";
import { getDynamicRisk } from "./ai-scoring.service.js";
import { sendTelegram, toIST } from "../lib/telegram.js";
import type { Position, Portfolio, CloseReason, ScannedToken } from "../types/index.js";
import type { LlmAnalysis } from "./ai-analysis.service.js";

const INITIAL_BALANCE_SOL = 100;
const FEE_RATE = 0.003;
const SLIPPAGE_RATE = 0.005;

const MAX_HOLD_MS = 48 * 60 * 60 * 1_000;

function formatHoldTime(ms: number): string {
  const totalMins = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatPrice(price: number): string {
  if (!price) return "0";
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

// ─── DB row ↔ Position mappers ────────────────────────────────────────────────

type DbRow = Record<string, unknown>;

function rowToPosition(r: DbRow): Position {
  return {
    positionId: r.position_id as string,
    symbol: r.symbol as string,
    tokenName: r.token_name as string | undefined,
    pairAddress: r.pair_address as string,
    contractAddress: r.contract_address as string,
    entryPrice: Number(r.entry_price),
    sizeSol: Number(r.size_sol),
    slPercent: Number(r.sl_percent),
    tpPercent: Number(r.tp_percent),
    slPrice: Number(r.sl_price),
    tpPrice: Number(r.tp_price),
    entryMarketCap: Number(r.entry_market_cap ?? 0),
    entryLiquidityUsd: Number(r.entry_liquidity_usd ?? 0),
    tpMarketCap: Number(r.tp_market_cap ?? 0),
    slMarketCap: Number(r.sl_market_cap ?? 0),
    aiScore: Number(r.ai_score ?? 0),
    confidence: Number(r.confidence ?? 0),
    status: r.status as "open" | "closed",
    openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at as string,
    closedAt: r.closed_at
      ? (r.closed_at instanceof Date ? r.closed_at.toISOString() : r.closed_at as string)
      : undefined,
    exitPrice: r.exit_price !== null ? Number(r.exit_price) : undefined,
    pnlSol: r.pnl_sol !== null ? Number(r.pnl_sol) : undefined,
    pnlPercent: r.pnl_percent !== null ? Number(r.pnl_percent) : undefined,
    holdTimeMs: r.hold_time_ms !== null ? Number(r.hold_time_ms) : undefined,
    closeReason: r.close_reason as CloseReason | undefined,
    note: r.note as string | undefined,
    llmVerdict: r.llm_verdict as string | undefined,
    llmProvider: r.llm_provider as string | undefined,
    llmConfidence: r.llm_confidence !== null ? Number(r.llm_confidence) : undefined,
    llmReasoning: r.llm_reasoning as string | undefined,
    llmRisks: r.llm_risks as string[] | undefined,
    llmStrengths: r.llm_strengths as string[] | undefined,
    llmDurationMs: r.llm_duration_ms !== null ? Number(r.llm_duration_ms) : undefined,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

class PaperTradingService {
  private openPositions: Map<string, Position> = new Map();
  private closedTrades: Position[] = [];
  private solBalance = INITIAL_BALANCE_SOL;
  private openContracts: Set<string> = new Set();
  private positionBroadcaster: (() => void) | null = null;
  private latestPrices: Map<string, { price: number; ts: number }> = new Map();

  // Must be called and awaited before starting the server
  async init(): Promise<void> {
    await this.loadFromDb();
  }

  private async loadFromDb(): Promise<void> {
    try {
      const rows = await query<DbRow>(
        "SELECT * FROM positions ORDER BY opened_at ASC"
      );

      const open: Position[] = [];
      const closed: Position[] = [];

      for (const row of rows) {
        const pos = rowToPosition(row);
        if (pos.status === "open") open.push(pos);
        else closed.push(pos);
      }

      // Most-recent closed trade first
      closed.sort((a, b) =>
        new Date(b.closedAt ?? b.openedAt).getTime() -
        new Date(a.closedAt ?? a.openedAt).getTime()
      );

      this.closedTrades = closed;
      this.openPositions.clear();
      this.openContracts.clear();

      for (const pos of open) {
        this.openPositions.set(pos.positionId, pos);
        this.openContracts.add(pos.contractAddress);
      }

      const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
      this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

      logger.info(
        {
          openPositions: this.openPositions.size,
          closedTrades: this.closedTrades.length,
          solBalance: this.solBalance.toFixed(4),
        },
        "Paper trading state restored from database",
      );
    } catch (err) {
      logger.error({ err }, "Failed to load from database — starting fresh");
    }
  }

  private async upsertPosition(pos: Position): Promise<void> {
    try {
      await execute(
        `INSERT INTO positions (
          position_id, symbol, token_name, pair_address, contract_address,
          size_sol, entry_price, tp_price, sl_price, tp_percent, sl_percent,
          entry_market_cap, entry_liquidity_usd, tp_market_cap, sl_market_cap,
          ai_score, confidence, status, opened_at, closed_at, exit_price,
          pnl_sol, pnl_percent, hold_time_ms, close_reason, note,
          llm_verdict, llm_provider, llm_confidence, llm_reasoning,
          llm_risks, llm_strengths, llm_duration_ms, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
          $29,$30,$31,$32,$33,NOW()
        )
        ON CONFLICT (position_id) DO UPDATE SET
          symbol = EXCLUDED.symbol,
          token_name = EXCLUDED.token_name,
          status = EXCLUDED.status,
          closed_at = EXCLUDED.closed_at,
          exit_price = EXCLUDED.exit_price,
          pnl_sol = EXCLUDED.pnl_sol,
          pnl_percent = EXCLUDED.pnl_percent,
          hold_time_ms = EXCLUDED.hold_time_ms,
          close_reason = EXCLUDED.close_reason,
          note = EXCLUDED.note,
          llm_verdict = EXCLUDED.llm_verdict,
          llm_provider = EXCLUDED.llm_provider,
          llm_confidence = EXCLUDED.llm_confidence,
          llm_reasoning = EXCLUDED.llm_reasoning,
          llm_risks = EXCLUDED.llm_risks,
          llm_strengths = EXCLUDED.llm_strengths,
          llm_duration_ms = EXCLUDED.llm_duration_ms,
          updated_at = NOW()`,
        [
          pos.positionId, pos.symbol, pos.tokenName ?? null, pos.pairAddress,
          pos.contractAddress, pos.sizeSol, pos.entryPrice, pos.tpPrice, pos.slPrice,
          pos.tpPercent, pos.slPercent, pos.entryMarketCap ?? 0, pos.entryLiquidityUsd ?? 0,
          pos.tpMarketCap ?? 0, pos.slMarketCap ?? 0, pos.aiScore ?? 0, pos.confidence ?? 0,
          pos.status, pos.openedAt, pos.closedAt ?? null, pos.exitPrice ?? null,
          pos.pnlSol ?? null, pos.pnlPercent ?? null, pos.holdTimeMs ?? null,
          pos.closeReason ?? null, pos.note ?? null,
          pos.llmVerdict ?? null, pos.llmProvider ?? null, pos.llmConfidence ?? null,
          pos.llmReasoning ?? null,
          pos.llmRisks ? JSON.stringify(pos.llmRisks) : null,
          pos.llmStrengths ? JSON.stringify(pos.llmStrengths) : null,
          pos.llmDurationMs ?? null,
        ],
      );
    } catch (err) {
      logger.error({ err, positionId: pos.positionId }, "Failed to upsert position to DB");
    }
  }

  private async deletePositionFromDb(positionId: string): Promise<void> {
    try {
      await execute("DELETE FROM positions WHERE position_id = $1", [positionId]);
    } catch (err) {
      logger.error({ err, positionId }, "Failed to delete position from DB");
    }
  }

  setPositionBroadcaster(fn: () => void) {
    this.positionBroadcaster = fn;
  }

  private broadcastPositions() {
    this.positionBroadcaster?.();
  }

  private totalOpenSol(): number {
    return Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol, 0);
  }

  hasOpenPositionForContract(contractAddress: string): boolean {
    return this.openContracts.has(contractAddress);
  }

  hasEverTradedContract(contractAddress: string): boolean {
    if (this.openContracts.has(contractAddress)) return true;
    return this.closedTrades.some((t) => t.contractAddress === contractAddress);
  }

  async buyDirect(token: ScannedToken, sizeSol: number, slOverridePct?: number, llmAnalysis?: LlmAnalysis): Promise<Position> {
    if (sizeSol <= 0) throw new Error("sizeSol must be positive");
    if (sizeSol > this.solBalance) {
      throw new Error(`Insufficient balance. Available: ${this.solBalance.toFixed(4)} SOL`);
    }
    if (token.priceUsd <= 0) throw new Error("Invalid token price");
    if (this.hasOpenPositionForContract(token.address)) {
      throw new Error(`Already have an open position for contract ${token.address} (${token.symbol})`);
    }

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
      ...(llmAnalysis ? {
        llmVerdict: llmAnalysis.verdict,
        llmProvider: llmAnalysis.provider,
        llmConfidence: llmAnalysis.confidence,
        llmReasoning: llmAnalysis.reasoning,
        llmRisks: llmAnalysis.risks,
        llmStrengths: llmAnalysis.strengths,
        llmDurationMs: llmAnalysis.durationMs,
      } : {}),
    };

    this.openPositions.set(position.positionId, position);
    this.openContracts.add(token.address);
    void this.upsertPosition(position);

    logger.info({ positionId: position.positionId, symbol: token.symbol, aiScore: token.aiScore, slPercent, tpPercent }, "Position opened");

    void sendTelegram(
      `🟢 <b>NEW TRADE — $${token.symbol}</b>\n` +
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
    void this.upsertPosition(closed);

    lossJournalService.record(closed);

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

  // ── Stop/TP checker ──────────────────────────────────────────────────────────

  async checkStopsForAll(): Promise<void> {
    for (const pos of Array.from(this.openPositions.values())) {
      try {
        let price: number | null = null;
        const dexPair = await scannerService.getPairFromDex(pos.pairAddress);
        const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
        if (dexPrice > 0) {
          price = dexPrice;
          this.latestPrices.set(pos.pairAddress, { price: dexPrice, ts: Date.now() });
        } else {
          const cached = scannerService.getByPairAddress(pos.pairAddress);
          if (cached && cached.priceUsd > 0) {
            price = cached.priceUsd;
            this.latestPrices.set(pos.pairAddress, { price: cached.priceUsd, ts: Date.now() });
          }
        }

        const currentLiqMidHold = dexPair?.liquidity?.usd ?? 0;
        const holdMsCheck = Date.now() - new Date(pos.openedAt).getTime();
        if (
          pos.entryLiquidityUsd > 0 &&
          currentLiqMidHold > 0 &&
          holdMsCheck > 2 * 60_000 &&
          currentLiqMidHold < pos.entryLiquidityUsd * 0.1
        ) {
          logger.warn(
            { symbol: pos.symbol, entryLiq: pos.entryLiquidityUsd, currentLiq: currentLiqMidHold },
            "Stop checker: liquidity drained >90% since entry — rug detected, closing at SL"
          );
          await this.close(pos.positionId, "stop_loss");
          continue;
        }

        if (!price || price <= 0) {
          const holdMs = Date.now() - new Date(pos.openedAt).getTime();
          const lastKnown = this.latestPrices.get(pos.pairAddress);
          const msWithoutPrice = lastKnown ? Date.now() - lastKnown.ts : holdMs;
          if (holdMs > 3 * 60_000 && msWithoutPrice > 3 * 60_000) {
            logger.warn({ symbol: pos.symbol, holdMs, msWithoutPrice }, "Stop checker: no price for 3+ minutes — treating as rug, closing at SL");
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
          const currentLiq = dexPair?.liquidity?.usd ?? 0;
          const currentVol5m = dexPair?.volume?.m5 ?? 0;
          const priceMultiplier = pos.entryPrice > 0 ? price / pos.entryPrice : 1;

          const MIN_TP_LIQUIDITY_USD = 5_000;
          const MAX_PRICE_MULTIPLIER = 50;
          const MIN_VOL_FOR_LARGE_MOVE = 100;

          if (currentLiq > 0 && currentLiq < MIN_TP_LIQUIDITY_USD && priceMultiplier > 5) {
            logger.warn(
              { symbol: pos.symbol, price, currentLiq, priceMultiplier: priceMultiplier.toFixed(1) },
              "TP rejected: liquidity drained (<$5K) AND price >5x — likely rug, closing at SL"
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          if (priceMultiplier > MAX_PRICE_MULTIPLIER) {
            logger.warn(
              { symbol: pos.symbol, price, priceMultiplier: priceMultiplier.toFixed(0) },
              `TP rejected: price is ${priceMultiplier.toFixed(0)}x entry — fake/manipulated data, closing at SL`
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          if (priceMultiplier > 5 && currentVol5m < MIN_VOL_FOR_LARGE_MOVE) {
            logger.warn(
              { symbol: pos.symbol, price, priceMultiplier: priceMultiplier.toFixed(1), currentVol5m },
              "TP rejected: >5x price move but <$100 volume in 5m — dust manipulation, closing at SL"
            );
            await this.close(pos.positionId, "stop_loss");
            continue;
          }

          logger.info({ symbol: pos.symbol, price, tpPrice: pos.tpPrice, priceMultiplier: priceMultiplier.toFixed(2) }, "Take profit triggered");
          await this.close(pos.positionId, "take_profit");
          continue;
        }

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

  private checkStopsFromCache(): void {
    for (const pos of Array.from(this.openPositions.values())) {
      try {
        const scannerCached = scannerService.getByPairAddress(pos.pairAddress);
        if (scannerCached && scannerCached.priceUsd > 0) {
          this.latestPrices.set(pos.pairAddress, { price: scannerCached.priceUsd, ts: Date.now() });
        }

        const cached = this.latestPrices.get(pos.pairAddress);
        if (!cached || cached.price <= 0) continue;

        const price = cached.price;
        const priceMultiplier = pos.entryPrice > 0 ? price / pos.entryPrice : 1;

        if (price <= pos.slPrice) {
          logger.info({ symbol: pos.symbol, price, slPrice: pos.slPrice, source: "cache-fast" }, "Stop loss triggered (fast cache check)");
          void this.close(pos.positionId, "stop_loss");
          continue;
        }

        if (price >= pos.tpPrice) {
          if (priceMultiplier > 50) continue;
          logger.info({ symbol: pos.symbol, price, tpPrice: pos.tpPrice, priceMultiplier: priceMultiplier.toFixed(2), source: "cache-fast" }, "Take profit triggered (fast cache check)");
          void this.close(pos.positionId, "take_profit");
        }
      } catch (_err) {
        // fast check is best-effort
      }
    }
  }

  startStopChecker() {
    setInterval(() => this.checkStopsFromCache(), 5_000);
    setInterval(() => void this.checkStopsForAll(), 10_000);
    logger.info("Stop/TP checker started — checking every 10s (full) + 5s (cache-fast)");
  }

  // ── Read methods ─────────────────────────────────────────────────────────────

  getOpenPositions(): Position[] {
    return Array.from(this.openPositions.values());
  }

  getClosedTrades(): Position[] {
    return [...this.closedTrades];
  }

  getPositionById(positionId: string): Position | undefined {
    return this.openPositions.get(positionId) ?? this.closedTrades.find(t => t.positionId === positionId);
  }

  getOpenPositionsWithLivePnl(): (Position & { livePnlSol: number; livePnlPercent: number; currentPrice: number })[] {
    return this.getOpenPositions().map((pos) => {
      const latestEntry = this.latestPrices.get(pos.pairAddress);
      const scannerToken = scannerService.getByPairAddress(pos.pairAddress);

      let currentPrice: number;
      if (latestEntry && latestEntry.price > 0) {
        currentPrice = latestEntry.price;
      } else if (scannerToken && scannerToken.priceUsd > 0) {
        currentPrice = scannerToken.priceUsd;
      } else if (pos.slPrice > 0 && Date.now() - new Date(pos.openedAt).getTime() > 5 * 60_000) {
        currentPrice = pos.slPrice;
      } else {
        currentPrice = pos.entryPrice;
      }

      const { pnlSol, pnlPercent } = this.computePnl(pos, currentPrice);
      return { ...pos, livePnlSol: pnlSol, livePnlPercent: pnlPercent, currentPrice };
    });
  }

  getPortfolio(): Portfolio {
    const openWithPnl = this.getOpenPositionsWithLivePnl();
    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    const openValue = openWithPnl.reduce((s, p) => s + p.sizeSol + p.livePnlSol, 0);

    return {
      solBalance: this.solBalance,
      initialBalance: INITIAL_BALANCE_SOL,
      totalPnlSol: closedPnl,
      totalPnlPercent: (closedPnl / INITIAL_BALANCE_SOL) * 100,
      openPositionsCount: this.openPositions.size,
      openPositionsValueSol: openValue,
    };
  }

  // ── Mutation methods ──────────────────────────────────────────────────────────

  deleteClosedTrade(positionId: string): void {
    const idx = this.closedTrades.findIndex((t) => t.positionId === positionId);
    if (idx === -1) throw new Error(`Closed trade not found: ${positionId}`);

    const trade = this.closedTrades[idx];
    this.closedTrades.splice(idx, 1);

    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

    void this.deletePositionFromDb(positionId);
    this.broadcastPositions();

    logger.info({ positionId, symbol: trade.symbol, pnlSol: trade.pnlSol, newBalance: this.solBalance.toFixed(4) }, "Closed trade deleted — balance recomputed");
  }

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

    const closedPnl = this.closedTrades.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
    this.solBalance = INITIAL_BALANCE_SOL - this.totalOpenSol() + closedPnl;

    void this.upsertPosition(updated);
    this.broadcastPositions();

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
    const allIds = [
      ...Array.from(this.openPositions.keys()),
      ...this.closedTrades.map(t => t.positionId),
    ];

    this.openPositions.clear();
    this.openContracts.clear();
    this.closedTrades = [];
    this.solBalance = INITIAL_BALANCE_SOL;

    // Delete all positions from DB
    void (async () => {
      for (const id of allIds) {
        await this.deletePositionFromDb(id);
      }
    })();

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
}

export const paperTradingService = new PaperTradingService();
