import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { graduationSniperService } from "./graduation-sniper.service.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";

// ── Constants (mirror live sniper) ───────────────────────────────────────────
const DEXSCREENER_BASE    = "https://api.dexscreener.com";
const PRICE_LOOP_MS       = 3_000;
const STALE_PRICE_MS      = 5_000;
const BATCH_MAX           = 30;
const STARTING_BALANCE    = 0.1;        // virtual SOL
const MAX_EVENTS          = 100;

const STAGED_SL_PHASE1_MS   = 2 * 60_000;
const STAGED_SL_PHASE2_MS   = 10 * 60_000;
const STAGED_SL_PHASE1_PCT  = 20;
const STAGED_SL_PHASE2_PCT  = 25;
const STAGED_SL_PHASE3_PCT  = 30;
const STAGED_SL_AFTER_TP1   = 35;

const KV_BALANCE_KEY = "paper_sniper_balance";
const KV_STATS_KEY   = "paper_sniper_stats";

function uid(): string {
  return `pap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaperPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  currentPrice: number;
  sizeSol: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  remainingFraction: number;
  effectiveSlPrice: number;
  trailingHigh: number;
  status: "open" | "closed";
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  pnlPct: number;
  closeReason?: string;
  closedAt?: number;
  exitPrice?: number;
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
  detectionPrice?: number;
  entryDriftPct?: number;
  lastPriceAt?: number;
}

export interface PaperSniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "closed";
  skipReason?: string;
  closeReason?: string;
  pnlSol?: number;
}

export interface PaperSniperStatus {
  enabled: boolean;
  virtualBalance: number;
  startingBalance: number;
  openCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  capitalInOpen: number;
  config: ReturnType<typeof graduationSniperService.getConfig>;
}

// ── Service ───────────────────────────────────────────────────────────────────

class PaperSniperService {
  private openPositions = new Map<string, PaperPosition>();
  private closedPositions: PaperPosition[] = [];
  private seenMints = new Set<string>();
  private events: PaperSniperEvent[] = [];
  private broadcaster: (() => void) | null = null;
  private priceIntervalId: ReturnType<typeof setInterval> | null = null;

  private virtualBalance = STARTING_BALANCE;
  private startingBalance = STARTING_BALANCE;
  private wins    = 0;
  private losses  = 0;
  private allTimeRealizedSol = 0;

  setBroadcaster(fn: () => void): void {
    this.broadcaster = fn;
  }

  private broadcast(): void {
    this.broadcaster?.();
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadBalance();
    await this.loadStats();
    await this.loadPositions();
    this.startPriceLoop();
    logger.info(
      { virtualBalance: this.virtualBalance, openPositions: this.openPositions.size },
      "Paper sniper: initialised",
    );
  }

  private async loadBalance(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM kv_store WHERE key = $1`,
        [KV_BALANCE_KEY],
      );
      if (rows.length > 0) {
        this.virtualBalance = parseFloat(rows[0]!.value) || STARTING_BALANCE;
        this.startingBalance = STARTING_BALANCE;
      }
    } catch { /* table may not exist yet */ }
  }

  private async loadStats(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM kv_store WHERE key = $1`,
        [KV_STATS_KEY],
      );
      if (rows.length > 0) {
        const s = JSON.parse(rows[0]!.value) as { wins?: number; losses?: number; realized?: number };
        this.wins               = s.wins    ?? 0;
        this.losses             = s.losses  ?? 0;
        this.allTimeRealizedSol = s.realized ?? 0;
      }
    } catch { /* ignore */ }
  }

  private async persistBalance(): Promise<void> {
    try {
      await execute(
        `INSERT INTO kv_store (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [KV_BALANCE_KEY, this.virtualBalance.toString()],
      );
    } catch { /* non-fatal */ }
  }

  private async persistStats(): Promise<void> {
    try {
      const s = JSON.stringify({ wins: this.wins, losses: this.losses, realized: this.allTimeRealizedSol });
      await execute(
        `INSERT INTO kv_store (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [KV_STATS_KEY, s],
      );
    } catch { /* non-fatal */ }
  }

  private async loadPositions(): Promise<void> {
    try {
      const rows = await query<Record<string, unknown>>(
        `SELECT * FROM paper_sniper_positions ORDER BY entry_at DESC`,
        [],
      );
      const open:   PaperPosition[] = [];
      const closed: PaperPosition[] = [];

      for (const row of rows) {
        const pos = this.rowToPosition(row);
        if (pos.status === "open") {
          open.push(pos);
          this.seenMints.add(pos.mint);
        } else {
          closed.push(pos);
          this.seenMints.add(pos.mint);
        }
      }
      for (const pos of open) this.openPositions.set(pos.mint, pos);
      this.closedPositions = closed.slice(0, 200);
    } catch { /* table may not exist yet */ }
  }

  private rowToPosition(row: Record<string, unknown>): PaperPosition {
    return {
      id:                row["id"]                  as string,
      mint:              row["mint"]                as string,
      symbol:            (row["symbol"]             as string | null) ?? "",
      name:              (row["name"]               as string | null) ?? "",
      detectedAt:        Number(row["detected_at"]  ?? 0),
      entryAt:           Number(row["entry_at"]     ?? 0),
      entryPrice:        Number(row["entry_price"]  ?? 0),
      currentPrice:      Number(row["current_price"] ?? 0),
      sizeSol:           Number(row["size_sol"]     ?? 0),
      tp1Hit:            Boolean(row["tp1_hit"]),
      tp2Hit:            Boolean(row["tp2_hit"]),
      remainingFraction: Number(row["remaining_fraction"] ?? 1),
      effectiveSlPrice:  Number(row["effective_sl_price"] ?? 0),
      trailingHigh:      Number(row["trailing_high"] ?? 0),
      status:            (row["status"] as "open" | "closed") ?? "open",
      realizedPnlSol:    Number(row["realized_pnl_sol"] ?? 0),
      unrealizedPnlSol:  0,
      totalPnlSol:       Number(row["realized_pnl_sol"] ?? 0),
      pnlPct:            0,
      closeReason:       (row["close_reason"] as string | undefined) ?? undefined,
      closedAt:          row["closed_at"] ? Number(row["closed_at"]) : undefined,
      exitPrice:         row["exit_price"] ? Number(row["exit_price"]) : undefined,
      tp1RealizedSol:    Number(row["tp1_realized_sol"] ?? 0),
      tp2RealizedSol:    Number(row["tp2_realized_sol"] ?? 0),
      runnerRealizedSol: Number(row["runner_realized_sol"] ?? 0),
      detectionPrice:    row["detection_price"] ? Number(row["detection_price"]) : undefined,
      entryDriftPct:     row["entry_drift_pct"] ? Number(row["entry_drift_pct"]) : undefined,
    };
  }

  // ── Entry point — called by live sniper after all filters pass ────────────

  onGraduation(
    mint: string,
    entryPrice: number,
    symbol: string,
    name: string,
    detectedAt: number,
    detectionPrice: number,
  ): void {
    const cfg = graduationSniperService.getConfig();

    if (this.seenMints.has(mint)) {
      logger.debug({ mint }, "Paper sniper: mint already seen — skip");
      return;
    }

    const openCount = this.openPositions.size;
    if (openCount >= cfg.maxOpenPositions) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Max positions reached (${openCount}/${cfg.maxOpenPositions})` });
      return;
    }

    const sizeSol = cfg.positionSizeSol;
    if (this.virtualBalance < sizeSol) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Insufficient paper balance (${this.virtualBalance.toFixed(4)} SOL < ${sizeSol} SOL)` });
      return;
    }

    this.seenMints.add(mint);

    const driftPct = detectionPrice > 0
      ? ((entryPrice / detectionPrice) - 1) * 100
      : 0;

    const slPct    = cfg.slPct;
    const pos: PaperPosition = {
      id:                uid(),
      mint,
      symbol,
      name,
      detectedAt,
      entryAt:           Date.now(),
      entryPrice,
      currentPrice:      entryPrice,
      sizeSol,
      tp1Hit:            false,
      tp2Hit:            false,
      remainingFraction: 1.0,
      effectiveSlPrice:  entryPrice * (1 - slPct / 100),
      trailingHigh:      entryPrice,
      status:            "open",
      realizedPnlSol:    0,
      unrealizedPnlSol:  0,
      totalPnlSol:       0,
      pnlPct:            0,
      tp1RealizedSol:    0,
      tp2RealizedSol:    0,
      runnerRealizedSol: 0,
      detectionPrice,
      entryDriftPct:     driftPct,
    };

    this.virtualBalance -= sizeSol;
    this.openPositions.set(mint, pos);

    void this.persistPosition(pos);
    void this.persistBalance();

    this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "entered" });

    logger.info(
      { mint, symbol, entryPrice, sizeSol, virtualBalance: this.virtualBalance },
      "Paper sniper: PAPER position entered 📄",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `📄 <b>PAPER ENTRY</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${symbol}</b>\n` +
        `📋 CA: <code>${mint}</code>\n` +
        `💵 Entry: <b>$${entryPrice < 0.0001 ? entryPrice.toExponential(3) : entryPrice.toFixed(8)}</b>\n` +
        `💰 Size: <b>${sizeSol.toFixed(4)} SOL</b> (virtual)\n` +
        `📊 Balance after: <b>${this.virtualBalance.toFixed(4)} SOL</b>\n` +
        `🛡️ Staged SL: -20% (2m) → -25% peak → -30% peak\n` +
        `🎯 TP1: +${cfg.tp1Pct}% (sell ${cfg.tp1ClosePct}%)\n` +
        `🎯 TP2: +${cfg.tp2Pct}% (sell ${cfg.tp2ClosePct}%)\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }

    this.broadcast();
  }

  // ── Price loop ────────────────────────────────────────────────────────────

  private startPriceLoop(): void {
    if (this.priceIntervalId) clearInterval(this.priceIntervalId);
    this.priceIntervalId = setInterval(() => {
      void this.runPriceTick();
    }, PRICE_LOOP_MS);
  }

  private async runPriceTick(): Promise<void> {
    const positions = [...this.openPositions.values()];
    if (positions.length === 0) return;

    const cfg = graduationSniperService.getConfig();

    // Batch DexScreener calls
    for (let i = 0; i < positions.length; i += BATCH_MAX) {
      const batch = positions.slice(i, i + BATCH_MAX);
      const mints = batch.map((p) => p.mint).join(",");
      try {
        type DexPair = {
          baseToken: { address: string };
          priceUsd:  string;
        };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${mints}`,
          { timeout: 6_000 },
        );
        const pairs = res.data ?? [];
        const priceMap = new Map<string, number>();
        for (const pair of pairs) {
          const p = parseFloat(pair.priceUsd);
          if (p > 0) priceMap.set(pair.baseToken.address, p);
        }

        for (const pos of batch) {
          const price = priceMap.get(pos.mint);
          if (!price || price <= 0) continue;
          pos.currentPrice = price;
          pos.lastPriceAt  = Date.now();
          if (price > pos.trailingHigh) pos.trailingHigh = price;
          this.checkTpSl(pos, cfg);
        }
      } catch { /* non-fatal — skip this tick */ }
    }

    this.updateUnrealizedPnl();
    this.broadcast();
  }

  private checkTpSl(pos: PaperPosition, cfg: ReturnType<typeof graduationSniperService.getConfig>): void {
    if (pos.status !== "open") return;
    if (!pos.lastPriceAt || Date.now() - pos.lastPriceAt > STALE_PRICE_MS) return;

    const price = pos.currentPrice;
    const pct   = ((price / pos.entryPrice) - 1) * 100;
    const now   = Date.now();
    const ageMs = now - pos.entryAt;

    // ── TP1 ────────────────────────────────────────────────────────────────
    if (!pos.tp1Hit && pct >= cfg.tp1Pct) {
      const closeFrac = cfg.tp1ClosePct / 100;
      const solGained = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl       = solGained - pos.sizeSol * closeFrac;
      pos.tp1Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp1RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac;
      pos.effectiveSlPrice  = price * (1 - STAGED_SL_AFTER_TP1 / 100);
      logger.info({ mint: pos.mint, symbol: pos.symbol, pct: pct.toFixed(1), pnl },
        "Paper sniper: TP1 hit 🎯");
      void this.persistPosition(pos);
      return;
    }

    // ── TP2 ────────────────────────────────────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit && pct >= cfg.tp2Pct) {
      const closeFrac = cfg.tp2ClosePct / 100 * pos.remainingFraction;
      const solGained = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl       = solGained - pos.sizeSol * closeFrac;
      pos.tp2Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp2RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac / pos.remainingFraction;
      pos.effectiveSlPrice  = price * (1 - cfg.trailingStopPct / 100);
      logger.info({ mint: pos.mint, symbol: pos.symbol, pct: pct.toFixed(1), pnl },
        "Paper sniper: TP2 hit 🎯🎯");
      void this.persistPosition(pos);
      return;
    }

    // ── Runner trailing stop (after TP1) ──────────────────────────────────
    if (pos.tp1Hit) {
      const trailingSlPrice = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      pos.effectiveSlPrice = Math.max(pos.effectiveSlPrice, trailingSlPrice);
    }

    // ── Staged SL ─────────────────────────────────────────────────────────
    let slDropPct: number;
    if (pos.tp1Hit) {
      slDropPct = STAGED_SL_AFTER_TP1;
    } else if (ageMs < STAGED_SL_PHASE1_MS) {
      slDropPct = STAGED_SL_PHASE1_PCT;
    } else if (ageMs < STAGED_SL_PHASE2_MS) {
      slDropPct = STAGED_SL_PHASE2_PCT;
    } else {
      slDropPct = STAGED_SL_PHASE3_PCT;
    }

    const slThreshold = pos.tp1Hit
      ? pos.effectiveSlPrice
      : pos.trailingHigh * (1 - slDropPct / 100);

    if (price <= slThreshold) {
      const reason = pos.tp1Hit
        ? `Trailing SL (runner -${cfg.trailingStopPct}% from peak)`
        : ageMs < STAGED_SL_PHASE1_MS
          ? `Staged SL Ph1 — -${STAGED_SL_PHASE1_PCT}% (${(ageMs / 60_000).toFixed(1)}m)`
          : ageMs < STAGED_SL_PHASE2_MS
            ? `Staged SL Ph2 — -${STAGED_SL_PHASE2_PCT}% from peak`
            : `Staged SL Ph3 — -${STAGED_SL_PHASE3_PCT}% from peak`;
      this.closePaperPosition(pos, reason, price);
    }
  }

  private closePaperPosition(pos: PaperPosition, reason: string, exitPrice: number): void {
    const solReturned = pos.sizeSol * pos.remainingFraction * (exitPrice / pos.entryPrice);
    const runnerPnl   = solReturned - pos.sizeSol * pos.remainingFraction;
    pos.runnerRealizedSol = runnerPnl;
    pos.realizedPnlSol   += runnerPnl;
    pos.status      = "closed";
    pos.closeReason = reason;
    pos.exitPrice   = exitPrice;
    pos.closedAt    = Date.now();
    pos.pnlPct      = ((exitPrice / pos.entryPrice) - 1) * 100;
    pos.totalPnlSol = pos.realizedPnlSol;

    this.openPositions.delete(pos.mint);
    this.closedPositions.unshift(pos);
    if (this.closedPositions.length > 200) this.closedPositions.pop();

    // Return remaining capital + P&L to virtual balance
    this.virtualBalance += solReturned;
    this.allTimeRealizedSol += pos.realizedPnlSol;

    if (pos.realizedPnlSol >= 0) {
      this.wins++;
    } else {
      this.losses++;
    }

    void this.persistPosition(pos);
    void this.persistBalance();
    void this.persistStats();

    this.addEvent({
      id: uid(), detectedAt: pos.detectedAt, mint: pos.mint, symbol: pos.symbol,
      action: "closed", closeReason: reason, pnlSol: pos.realizedPnlSol,
    });

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, pnlSol: pos.realizedPnlSol.toFixed(4), exitPrice },
      "Paper sniper: position closed 📄",
    );

    if (isTelegramConfigured()) {
      const isWin     = pos.realizedPnlSol >= 0;
      const pnlSign   = isWin ? "+" : "";
      const emoji     = isWin ? "✅" : "❌";
      const pnlPctStr = ((exitPrice / pos.entryPrice - 1) * 100).toFixed(1);
      const holdMs    = (pos.closedAt ?? Date.now()) - pos.entryAt;
      const holdStr   = holdMs < 60_000
        ? `${Math.floor(holdMs / 1000)}s`
        : holdMs < 3_600_000
          ? `${Math.floor(holdMs / 60_000)}m`
          : `${Math.floor(holdMs / 3_600_000)}h`;
      void sendTelegram(
        `${emoji} <b>PAPER CLOSE</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${pos.symbol}</b>\n` +
        `📋 CA: <code>${pos.mint}</code>\n` +
        `💵 Exit: <b>$${exitPrice < 0.0001 ? exitPrice.toExponential(3) : exitPrice.toFixed(8)}</b>\n` +
        `📊 P&L: <b>${pnlSign}${pos.realizedPnlSol.toFixed(4)} SOL (${pnlSign}${pnlPctStr}%)</b>\n` +
        `🏷️ Reason: ${reason}\n` +
        `⏱️ Hold: ${holdStr}\n` +
        `💰 Balance: <b>${this.virtualBalance.toFixed(4)} SOL</b>\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }

    this.broadcast();
  }

  private updateUnrealizedPnl(): void {
    for (const pos of this.openPositions.values()) {
      const price = pos.currentPrice;
      if (!price || !pos.entryPrice) continue;
      const fraction          = pos.remainingFraction;
      const solAtEntry        = pos.sizeSol * fraction;
      const solAtCurrent      = solAtEntry * (price / pos.entryPrice);
      pos.unrealizedPnlSol    = solAtCurrent - solAtEntry;
      pos.totalPnlSol         = pos.realizedPnlSol + pos.unrealizedPnlSol;
      pos.pnlPct              = ((price / pos.entryPrice) - 1) * 100;
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private addEvent(e: PaperSniperEvent): void {
    this.events.unshift(e);
    if (this.events.length > MAX_EVENTS) this.events.pop();
  }

  // ── DB persistence ────────────────────────────────────────────────────────

  private async persistPosition(pos: PaperPosition): Promise<void> {
    try {
      await execute(
        `INSERT INTO paper_sniper_positions
           (id, mint, symbol, name, detected_at, entry_at, entry_price, current_price,
            size_sol, tp1_hit, tp2_hit, remaining_fraction, effective_sl_price, trailing_high,
            status, realized_pnl_sol, close_reason, closed_at, exit_price,
            tp1_realized_sol, tp2_realized_sol, runner_realized_sol,
            detection_price, entry_drift_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (id) DO UPDATE SET
           current_price      = EXCLUDED.current_price,
           tp1_hit            = EXCLUDED.tp1_hit,
           tp2_hit            = EXCLUDED.tp2_hit,
           remaining_fraction = EXCLUDED.remaining_fraction,
           effective_sl_price = EXCLUDED.effective_sl_price,
           trailing_high      = EXCLUDED.trailing_high,
           status             = EXCLUDED.status,
           realized_pnl_sol   = EXCLUDED.realized_pnl_sol,
           close_reason       = EXCLUDED.close_reason,
           closed_at          = EXCLUDED.closed_at,
           exit_price         = EXCLUDED.exit_price,
           tp1_realized_sol   = EXCLUDED.tp1_realized_sol,
           tp2_realized_sol   = EXCLUDED.tp2_realized_sol,
           runner_realized_sol= EXCLUDED.runner_realized_sol`,
        [
          pos.id, pos.mint, pos.symbol, pos.name,
          pos.detectedAt, pos.entryAt, pos.entryPrice, pos.currentPrice,
          pos.sizeSol, pos.tp1Hit, pos.tp2Hit, pos.remainingFraction,
          pos.effectiveSlPrice, pos.trailingHigh,
          pos.status, pos.realizedPnlSol, pos.closeReason ?? null,
          pos.closedAt ?? null, pos.exitPrice ?? null,
          pos.tp1RealizedSol, pos.tp2RealizedSol, pos.runnerRealizedSol,
          pos.detectionPrice ?? null, pos.entryDriftPct ?? null,
        ],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message, mint: pos.mint }, "Paper sniper: failed to persist position");
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  getStatus(): PaperSniperStatus {
    this.updateUnrealizedPnl();
    const open = [...this.openPositions.values()];
    const totalUnrealized = open.reduce((s, p) => s + p.unrealizedPnlSol, 0);
    const capitalInOpen   = open.reduce((s, p) => s + p.sizeSol * p.remainingFraction, 0);

    return {
      enabled:              true,
      virtualBalance:       this.virtualBalance,
      startingBalance:      this.startingBalance,
      openCount:            this.openPositions.size,
      tradesTotal:          this.wins + this.losses,
      wins:                 this.wins,
      losses:               this.losses,
      totalRealizedPnlSol:  this.allTimeRealizedSol,
      totalUnrealizedPnlSol: totalUnrealized,
      totalCombinedPnlSol:  this.allTimeRealizedSol + totalUnrealized,
      capitalInOpen,
      config:               graduationSniperService.getConfig(),
    };
  }

  getOpenPositions(): PaperPosition[] {
    this.updateUnrealizedPnl();
    return [...this.openPositions.values()].sort((a, b) => b.entryAt - a.entryAt);
  }

  getHistory(): PaperPosition[] {
    return this.closedPositions.slice(0, 100);
  }

  getEvents(): PaperSniperEvent[] {
    return this.events.slice(0, 50);
  }

  async reset(): Promise<void> {
    // Close all open positions at current price (or entry if no price)
    for (const pos of this.openPositions.values()) {
      pos.status    = "closed";
      pos.closeReason = "Paper account reset";
      pos.closedAt  = Date.now();
      pos.exitPrice = pos.currentPrice || pos.entryPrice;
      void this.persistPosition(pos);
    }
    this.openPositions.clear();
    this.closedPositions = [];
    this.seenMints.clear();
    this.events = [];
    this.virtualBalance     = STARTING_BALANCE;
    this.startingBalance    = STARTING_BALANCE;
    this.wins               = 0;
    this.losses             = 0;
    this.allTimeRealizedSol = 0;

    try {
      await execute(`DELETE FROM paper_sniper_positions`, []);
    } catch { /* non-fatal */ }

    await this.persistBalance();
    await this.persistStats();
    this.broadcast();
    logger.info("Paper sniper: account reset ✅");
  }
}

export const paperSniperService = new PaperSniperService();
