import { randomUUID } from "crypto";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { scannerService } from "./scanner.service.js";
import { alertsService } from "./alerts.service.js";
import { lossJournalService } from "./loss-journal.service.js";
import { sendTelegram, toIST } from "../lib/telegram.js";
import type { Position, Portfolio, CloseReason, ScannedToken } from "../types/index.js";
import type { LlmAnalysis } from "./ai-analysis.service.js";

const INITIAL_BALANCE_SOL = 100;
const FEE_RATE = 0.003;
const SLIPPAGE_RATE = 0.005;

const MAX_HOLD_MS = 24 * 60 * 60 * 1_000;

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
    imageUrl: r.image_url as string ?? "",
    tp1Price: r.tp1_price != null ? Number(r.tp1_price) : undefined,
    tp2Price: r.tp2_price != null ? Number(r.tp2_price) : undefined,
    tp1SellPct: r.tp1_sell_pct != null ? Number(r.tp1_sell_pct) : undefined,
    tp2SellPct: r.tp2_sell_pct != null ? Number(r.tp2_sell_pct) : undefined,
    tp1Hit: Boolean(r.tp1_hit),
    tp2Hit: Boolean(r.tp2_hit),
    remainingSizeSol: r.remaining_size_sol != null ? Number(r.remaining_size_sol) : undefined,
    partialPnlSol: r.partial_pnl_sol != null ? Number(r.partial_pnl_sol) : undefined,
    pairAgeMinutes: r.pair_age_minutes != null ? Number(r.pair_age_minutes) : undefined,
    llmScore: r.llm_score != null ? Number(r.llm_score) : undefined,
    llmRiskLevel: r.llm_risk_level as string | undefined,
    llmSecondaryVerdict: r.llm_secondary_verdict as string | undefined,
    llmSecondaryProvider: r.llm_secondary_provider as string | undefined,
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
          llm_risks, llm_strengths, llm_duration_ms,
          tp1_price, tp2_price, tp1_sell_pct, tp2_sell_pct,
          tp1_hit, tp2_hit, remaining_size_sol, partial_pnl_sol,
          pair_age_minutes, llm_score, llm_risk_level,
          llm_secondary_verdict, llm_secondary_provider,
          updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
          $29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,
          $42,$43,$44,$45,$46,NOW()
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
          tp1_hit = EXCLUDED.tp1_hit,
          tp2_hit = EXCLUDED.tp2_hit,
          remaining_size_sol = EXCLUDED.remaining_size_sol,
          partial_pnl_sol = EXCLUDED.partial_pnl_sol,
          llm_score = EXCLUDED.llm_score,
          llm_risk_level = EXCLUDED.llm_risk_level,
          llm_secondary_verdict = EXCLUDED.llm_secondary_verdict,
          llm_secondary_provider = EXCLUDED.llm_secondary_provider,
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
          pos.tp1Price ?? null, pos.tp2Price ?? null,
          pos.tp1SellPct ?? null, pos.tp2SellPct ?? null,
          pos.tp1Hit ?? false, pos.tp2Hit ?? false,
          pos.remainingSizeSol ?? null, pos.partialPnlSol ?? null,
          pos.pairAgeMinutes ?? null,
          pos.llmScore ?? null, pos.llmRiskLevel ?? null,
          pos.llmSecondaryVerdict ?? null, pos.llmSecondaryProvider ?? null,
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
    return Array.from(this.openPositions.values()).reduce((s, p) => s + (p.remainingSizeSol ?? p.sizeSol), 0);
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
    let pairAgeMinutes = 30; // default: 30m if pair age unknown
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
      if (dexPair?.pairCreatedAt) {
        pairAgeMinutes = (Date.now() - dexPair.pairCreatedAt) / 60_000;
      }
    } catch (err) {
      logger.warn({ err, symbol: token.symbol }, "DexScreener price verification failed at entry — using scanner price");
    }

    // Age-based SL/TP tiers — fresher pairs get wider TP targets (more room to run)
    // and wider SL (more volatile). Each tier has TP1 + TP2 partial-close levels.
    let slPercent: number;
    let tpPercent: number;
    let tp1Pct: number;
    let tp1SellPct: number;
    let tp2Pct: number;
    let tp2SellPct: number;

    if (pairAgeMinutes < 60) {
      // < 1h — aggressive targets, high volatility window
      slPercent = 25;  tp1Pct = 100; tp1SellPct = 40;
      tp2Pct = 300;    tp2SellPct = 40;  tpPercent = 300;
    } else if (pairAgeMinutes < 360) {
      // 1–6h — momentum established, moderate risk
      slPercent = 20;  tp1Pct = 80;  tp1SellPct = 50;
      tp2Pct = 200;    tp2SellPct = 40;  tpPercent = 200;
    } else {
      // 6–24h — conservative, price more predictable
      slPercent = 15;  tp1Pct = 60;  tp1SellPct = 60;
      tp2Pct = 150;    tp2SellPct = 30;  tpPercent = 150;
    }

    if (slOverridePct !== undefined) slPercent = slOverridePct;

    const slPrice  = verifiedPriceUsd * (1 - slPercent / 100);
    const tp1Price = verifiedPriceUsd * (1 + tp1Pct / 100);
    const tp2Price = verifiedPriceUsd * (1 + tp2Pct / 100);
    const tpPrice  = tp2Price; // TP2 = main recorded TP; runner after TP2 uses trailing SL

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
      tp1Price,
      tp2Price,
      tp1SellPct,
      tp2SellPct,
      tp1Hit: false,
      tp2Hit: false,
      remainingSizeSol: sizeSol,
      partialPnlSol: 0,
      pairAgeMinutes,
      ...(llmAnalysis ? {
        llmVerdict: llmAnalysis.verdict,
        llmProvider: llmAnalysis.provider,
        llmConfidence: llmAnalysis.confidence,
        llmReasoning: llmAnalysis.reasoning,
        llmRisks: llmAnalysis.risks,
        llmStrengths: llmAnalysis.strengths,
        llmDurationMs: llmAnalysis.durationMs,
        llmScore: llmAnalysis.llmScore,
        llmRiskLevel: llmAnalysis.llmRiskLevel,
        llmSecondaryVerdict: llmAnalysis.secondaryVerdict,
        llmSecondaryProvider: llmAnalysis.secondaryProvider,
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
      `📦 Size: ${sizeSol} SOL | Age: ${pairAgeMinutes < 60 ? `${Math.round(pairAgeMinutes)}m` : `${(pairAgeMinutes / 60).toFixed(1)}h`}\n` +
      `🤖 AI Score: ${token.aiScore} | Confidence: ${token.confidence}%\n` +
      `🎯 <b>TP1:</b> $${formatPrice(tp1Price)} (+${tp1Pct}%, sell ${tp1SellPct}%) | <b>TP2:</b> $${formatPrice(tp2Price)} (+${tp2Pct}%, sell ${tp2SellPct}%)\n` +
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

  private computePnl(pos: Position, exitPrice: number, sizeOverrideSol?: number): { pnlSol: number; pnlPercent: number; netReturn: number } {
    const effectiveSize = sizeOverrideSol ?? pos.sizeSol;
    const grossReturn = effectiveSize * (exitPrice / pos.entryPrice);
    const exitFee = grossReturn * FEE_RATE;
    const slippage = effectiveSize * SLIPPAGE_RATE;
    const entryFee = effectiveSize * FEE_RATE;
    const netReturn = grossReturn - exitFee - slippage;
    const pnlSol = netReturn - effectiveSize - entryFee;
    const pnlPercent = (pnlSol / effectiveSize) * 100;
    return { pnlSol, pnlPercent, netReturn };
  }

  // Sell a partial tranche at tp1/tp2. Fully synchronous except for fire-and-forget
  // DB/Telegram side effects. Sets tp1Hit/tp2Hit immediately to prevent double-triggers
  // on the 1s cache-check interval.
  private partialClose(positionId: string, tpLabel: "tp1" | "tp2", currentPrice: number): void {
    const pos = this.openPositions.get(positionId);
    if (!pos) return;

    const isTP1 = tpLabel === "tp1";
    if (isTP1 && pos.tp1Hit) return;
    if (!isTP1 && pos.tp2Hit) return;

    const sellPct       = isTP1 ? (pos.tp1SellPct ?? 40) : (pos.tp2SellPct ?? 40);
    const remainingSize = pos.remainingSizeSol ?? pos.sizeSol;
    const soldSizeSol   = remainingSize * (sellPct / 100);
    const grossReturn   = soldSizeSol * (currentPrice / pos.entryPrice);
    const exitFee       = grossReturn * FEE_RATE;
    const slippage      = soldSizeSol * SLIPPAGE_RATE;
    const netReturn     = grossReturn - exitFee - slippage;
    const pnlSol        = netReturn - soldSizeSol;
    const sign          = pnlSol >= 0 ? "+" : "";

    this.solBalance += netReturn;

    const newRemaining  = remainingSize - soldSizeSol;
    const newPartialPnl = (pos.partialPnlSol ?? 0) + pnlSol;

    const updatedPos: Position = {
      ...pos,
      tp1Hit: isTP1 ? true : pos.tp1Hit,
      tp2Hit: !isTP1 ? true : pos.tp2Hit,
      remainingSizeSol: newRemaining,
      partialPnlSol: newPartialPnl,
      // After TP2: move SL to break-even; set tpPrice unreachably high so the
      // trailing-SL mechanism (not the TP check) handles the runner exit.
      ...(!isTP1 ? { slPrice: pos.entryPrice, tpPrice: pos.entryPrice * 51 } : {}),
    };

    this.openPositions.set(positionId, updatedPos);
    void this.upsertPosition(updatedPos);
    this.broadcastPositions();

    logger.info(
      {
        symbol: pos.symbol, tpLabel, sellPct, soldSizeSol: soldSizeSol.toFixed(4),
        pnlSol: pnlSol.toFixed(4), newRemaining: newRemaining.toFixed(4),
        price: formatPrice(currentPrice),
      },
      `Partial close (${tpLabel.toUpperCase()}) executed — profit locked`,
    );

    void sendTelegram(
      `🎯 <b>${tpLabel.toUpperCase()} HIT — $${pos.symbol}</b>\n` +
      `──────────────────────\n` +
      `💰 Sold ${sellPct}% at $${formatPrice(currentPrice)}\n` +
      `📈 Chunk P&L: <b>${sign}${pnlSol.toFixed(4)} SOL</b>\n` +
      `📦 Remaining: ${newRemaining.toFixed(4)} SOL\n` +
      `${!isTP1 ? "🛡️ SL moved to break-even — runner protected\n" : ""}` +
      `🕐 ${toIST(new Date())}`,
    );
  }

  async close(positionId: string, reason: CloseReason): Promise<Position> {
    const pos = this.openPositions.get(positionId);
    if (!pos) throw new Error(`Position not found: ${positionId}`);

    // Remove from open map IMMEDIATELY — before any async work.
    // This means a concurrent 1s-interval close call gets `undefined`
    // here and throws safely, preventing double-PnL accounting.
    this.openPositions.delete(positionId);
    this.openContracts.delete(pos.contractAddress);

    // Stop-loss in paper trading always fills at the stated SL price.
    // Rug detected = LP fully drained → exit at ~2% of entry (98% loss).
    // For all other reasons, use latest real price from DexScreener.
    let exitPrice: number;
    if (reason === "stop_loss") {
      exitPrice = pos.slPrice;
    } else if (reason === "rug_detected") {
      // LP drained to near-zero — real exit value is essentially zero.
      // We use 2% of entry price to reflect slippage into a drained pool.
      exitPrice = pos.entryPrice * 0.02;
      logger.warn(
        { symbol: pos.symbol, entryPrice: pos.entryPrice, rugExitPrice: exitPrice },
        "Rug exit: LP drained — recording ~98% loss"
      );
    } else {
      const latestEntry = this.latestPrices.get(pos.pairAddress);
      if (latestEntry && latestEntry.price > 0 && Date.now() - latestEntry.ts < 60_000) {
        exitPrice = latestEntry.price;
      } else {
        const dexPair = await scannerService.getPairFromDex(pos.pairAddress);
        const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
        if (dexPrice > 0) {
          exitPrice = dexPrice;
          this.latestPrices.set(pos.pairAddress, { price: dexPrice, ts: Date.now() });
        } else {
          exitPrice = pos.entryPrice;
        }
      }
    }

    // Use remaining size (after any partial closes) for final P&L computation.
    // Add accumulated partial-close P&L to get the total position P&L.
    const remainingSize = pos.remainingSizeSol ?? pos.sizeSol;
    const { pnlSol: closePnl, netReturn } = this.computePnl(pos, exitPrice, remainingSize);
    const pnlSol = closePnl + (pos.partialPnlSol ?? 0);
    const pnlPercent = pos.sizeSol > 0 ? (pnlSol / pos.sizeSol) * 100 : closePnl;

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
    } else if (reason === "rug_detected") {
      alertsService.stopLossHit(positionId, pos.symbol, pnlSol, pos.pairAddress);
      void sendTelegram(
        `☠️ <b>RUG DETECTED — $${pos.symbol}</b>\n` +
        `──────────────────────\n` +
        `📍 CA: <code>${pos.contractAddress}</code>\n` +
        `💀 Liquidity drained to near-zero after entry\n` +
        `💰 Entry: $${formatPrice(pos.entryPrice)} → Rug exit: $${formatPrice(exitPrice)}\n` +
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

  // Fetch all open position prices in PARALLEL — prevents the sequential
  // await-per-position delay that caused 3-6s gaps on 3 open positions.
  private async refreshPositionPrices(): Promise<void> {
    const positions = Array.from(this.openPositions.values());
    if (positions.length === 0) return;
    await Promise.allSettled(
      positions.map(async (pos) => {
        try {
          const dexPair = await scannerService.getPairFromDex(pos.pairAddress);
          const dexPrice = parseFloat(dexPair?.priceUsd ?? "0");
          if (dexPrice > 0) {
            this.latestPrices.set(pos.pairAddress, { price: dexPrice, ts: Date.now() });
          } else {
            const cached = scannerService.getByPairAddress(pos.pairAddress);
            if (cached && cached.priceUsd > 0)
              this.latestPrices.set(pos.pairAddress, { price: cached.priceUsd, ts: Date.now() });
          }
        } catch { /* best-effort */ }
      }),
    );
  }

  async checkStopsForAll(): Promise<void> {
    const positions = Array.from(this.openPositions.values());
    if (positions.length === 0) return;

    // Fetch ALL positions' DexScreener data in parallel (was sequential → caused 3–6s lag)
    const pairFetches = await Promise.allSettled(
      positions.map(pos => scannerService.getPairFromDex(pos.pairAddress)),
    );

    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      // Skip if already closed by a concurrent check while we were fetching
      if (!this.openPositions.has(pos.positionId)) continue;

      try {
        const dexPair = pairFetches[i].status === "fulfilled" ? pairFetches[i].value : null;
        let price: number | null = null;
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

        // Absolute rug floor: if live liquidity is below $500 regardless of entry,
        // the pool is effectively dead — record as a near-total loss immediately.
        if (currentLiqMidHold > 0 && currentLiqMidHold < 500 && holdMsCheck > 60_000) {
          logger.warn(
            { symbol: pos.symbol, currentLiq: currentLiqMidHold },
            "Stop checker: absolute liquidity <$500 — pool drained to near-zero, recording rug loss"
          );
          await this.close(pos.positionId, "rug_detected");
          continue;
        }

        // Relative rug: liquidity drained >90% vs entry after 2+ minutes
        if (
          pos.entryLiquidityUsd > 0 &&
          currentLiqMidHold > 0 &&
          holdMsCheck > 2 * 60_000 &&
          currentLiqMidHold < pos.entryLiquidityUsd * 0.1
        ) {
          logger.warn(
            { symbol: pos.symbol, entryLiq: pos.entryLiquidityUsd, currentLiq: currentLiqMidHold },
            "Stop checker: liquidity drained >90% since entry — rug detected"
          );
          await this.close(pos.positionId, "rug_detected");
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

        // ── Trailing stop: ratchet SL up as price climbs ──────────────────
        // Tiers lock in profit so a reversal after a big pump never turns into
        // a full loss. SL only ever moves UP — never down.
        //
        //  Price gain from entry  │  SL moves to
        //  ───────────────────────┼──────────────────────────────
        //  ≥ +50%                 │  entry price (break-even)
        //  ≥ +100%                │  entry × 1.40  (lock +40%)
        //  ≥ +150%                │  entry × 1.80  (lock +80%)
        //  ≥ +200%                │  entry × 2.20  (lock +120%)
        {
          const pnlPctRaw = pos.entryPrice > 0 ? (price - pos.entryPrice) / pos.entryPrice * 100 : 0;
          let newSlPrice: number | null = null;
          let trailLabel = "";

          if (pnlPctRaw >= 200 && pos.slPrice < pos.entryPrice * 2.20) {
            newSlPrice = pos.entryPrice * 2.20;
            trailLabel = "lock +120% (price ≥ +200%)";
          } else if (pnlPctRaw >= 150 && pos.slPrice < pos.entryPrice * 1.80) {
            newSlPrice = pos.entryPrice * 1.80;
            trailLabel = "lock +80% (price ≥ +150%)";
          } else if (pnlPctRaw >= 100 && pos.slPrice < pos.entryPrice * 1.40) {
            newSlPrice = pos.entryPrice * 1.40;
            trailLabel = "lock +40% (price ≥ +100%)";
          } else if (pnlPctRaw >= 50 && pos.slPrice < pos.entryPrice) {
            newSlPrice = pos.entryPrice;
            trailLabel = "break-even (price ≥ +50%)";
          }

          if (newSlPrice !== null) {
            const updatedPos: Position = { ...pos, slPrice: newSlPrice };
            this.openPositions.set(pos.positionId, updatedPos);
            void this.upsertPosition(updatedPos);
            this.broadcastPositions();
            logger.info(
              { symbol: pos.symbol, pnlPct: pnlPctRaw.toFixed(0), newSlPrice: formatPrice(newSlPrice), was: formatPrice(pos.slPrice), tier: trailLabel },
              "Trailing SL ratcheted up — profit locked",
            );
            void sendTelegram(
              `🔒 <b>TRAILING SL LOCKED — $${pos.symbol}</b>\n` +
              `──────────────────────\n` +
              `📈 Current gain: <b>+${pnlPctRaw.toFixed(0)}%</b>\n` +
              `🛡️ New SL: <b>$${formatPrice(newSlPrice)}</b> (${trailLabel})\n` +
              `🎯 TP still at: $${formatPrice(pos.tpPrice)} (+${pos.tpPercent}%)\n` +
              `🕐 ${toIST(new Date())}`,
            );
            // Use updated pos for subsequent SL/TP checks this cycle
            // (re-read from map to get fresh slPrice)
            const refreshed = this.openPositions.get(pos.positionId);
            if (refreshed) Object.assign(pos, refreshed);
          }
        }

        if (price <= pos.slPrice) {
          logger.info({ symbol: pos.symbol, price, slPrice: pos.slPrice }, "Stop loss triggered");
          await this.close(pos.positionId, "stop_loss");
          continue;
        }

        // TP1 partial close — sell first tranche, keep running
        if (!pos.tp1Hit && pos.tp1Price && price >= pos.tp1Price) {
          this.partialClose(pos.positionId, "tp1", price);
          continue;
        }

        // TP2 partial close — sell second tranche, move SL to break-even
        if (pos.tp1Hit && !pos.tp2Hit && pos.tp2Price && price >= pos.tp2Price) {
          this.partialClose(pos.positionId, "tp2", price);
          continue;
        }

        // Final TP: close remaining runner (tpPrice is set very high after TP2;
        // this also handles legacy positions without tiered TP fields)
        if (price >= pos.tpPrice) {
          const currentLiq = dexPair?.liquidity?.usd ?? 0;
          const currentVol5m = dexPair?.volume?.m5 ?? 0;
          const priceMultiplier = pos.entryPrice > 0 ? price / pos.entryPrice : 1;

          const MAX_PRICE_MULTIPLIER = 50;
          const MIN_VOL_FOR_LARGE_MOVE = 100;

          // Any TP trigger with near-zero liquidity = price is fake/stale.
          // The token is rugged — record as rug loss, not a profit.
          if (currentLiq > 0 && currentLiq < 500) {
            logger.warn(
              { symbol: pos.symbol, price, currentLiq, priceMultiplier: priceMultiplier.toFixed(1) },
              "TP rejected: liquidity <$500 — pool drained, recording rug loss"
            );
            await this.close(pos.positionId, "rug_detected");
            continue;
          }

          if (currentLiq > 0 && currentLiq < 5_000 && priceMultiplier > 3) {
            logger.warn(
              { symbol: pos.symbol, price, currentLiq, priceMultiplier: priceMultiplier.toFixed(1) },
              "TP rejected: liquidity <$5K with price >3x — likely manipulated, recording rug loss"
            );
            await this.close(pos.positionId, "rug_detected");
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

        // 24h max hold — close stale positions to free capital
        const holdMs = Date.now() - new Date(pos.openedAt).getTime();
        if (holdMs > MAX_HOLD_MS) {
          logger.warn({ symbol: pos.symbol, holdHours: (holdMs / 3_600_000).toFixed(1) }, "Auto-closing stale position (>24h)");
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

        // TP1 partial close (fast path)
        if (!pos.tp1Hit && pos.tp1Price && price >= pos.tp1Price) {
          this.partialClose(pos.positionId, "tp1", price);
          continue;
        }

        // TP2 partial close (fast path)
        if (pos.tp1Hit && !pos.tp2Hit && pos.tp2Price && price >= pos.tp2Price) {
          this.partialClose(pos.positionId, "tp2", price);
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
    // 500ms — ultra-fast cache check using latest prices already in memory
    setInterval(() => this.checkStopsFromCache(), 500);
    // 2s  — parallel refresh of ALL open positions from DexScreener simultaneously
    //        (replaces the old sequential loop that took 3-6s per 3 positions)
    setInterval(() => void this.refreshPositionPrices(), 2_000);
    // 5s  — full trailing SL + liquidity drain check with fresh parallel pair data
    setInterval(() => void this.checkStopsForAll(), 5_000);
    logger.info("Stop/TP checker started — 500ms cache + 2s parallel price refresh + 5s full check");
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
