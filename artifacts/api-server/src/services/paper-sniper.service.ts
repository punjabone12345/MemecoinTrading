import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";

// ── Paper-specific config ──────────────────────────────────────────────────────

export interface PaperConfig {
  positionSizeSol:    number;
  maxOpenPositions:   number;
  tp1Pct:             number;
  tp1ClosePct:        number;
  tp2Pct:             number;
  tp2ClosePct:        number;
  trailingStopPct:    number;
  slPhase1Pct:        number;  // SL % during first 2 min
  slPhase2Pct:        number;  // SL % from peak during 2–10 min
  slPhase3Pct:        number;  // SL % from peak after 10 min
  slAfterTp1Pct:      number;  // trailing SL % from peak after TP1
  deadCoinWindowMs:     number;  // ms to wait before dead-coin check (default 2h)
  deadCoinMinMovePct:   number;  // min peak move % required — if not reached, close as dead
  maxFillDriftPct:      number;  // skip entry if price already moved > this % from detection baseline
  simulatedExecDelayMs: number;  // ms to wait after graduation before entering (simulates real exec latency)
}

const DEFAULT_PAPER_CONFIG: PaperConfig = {
  positionSizeSol:    0.05,
  maxOpenPositions:   3,
  tp1Pct:             150,
  tp1ClosePct:        40,
  tp2Pct:             400,
  tp2ClosePct:        40,
  trailingStopPct:    30,
  slPhase1Pct:        20,
  slPhase2Pct:        25,
  slPhase3Pct:        30,
  slAfterTp1Pct:      35,
  deadCoinWindowMs:     2 * 60 * 60_000,  // 2 hours
  deadCoinMinMovePct:   5,                // must move >5% from entry
  maxFillDriftPct:      20,               // skip if exec price > 20% above detection baseline
  simulatedExecDelayMs: 5_000,            // 5s to simulate real buy latency
};

// ── Constants ─────────────────────────────────────────────────────────────────
const DEXSCREENER_BASE    = "https://api.dexscreener.com";
const PRICE_LOOP_MS       = 3_000;
const STALE_PRICE_MS      = 5_000;
const BATCH_MAX           = 30;
const STARTING_BALANCE    = 0.1;
const MAX_EVENTS          = 100;
const STAGED_SL_PHASE1_MS = 2 * 60_000;
const STAGED_SL_PHASE2_MS = 10 * 60_000;

const KV_BALANCE_KEY = "paper_sniper_balance";
const KV_STATS_KEY   = "paper_sniper_stats";
const KV_CONFIG_KEY  = "paper_sniper_config";

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
  msDetectionToFill?: number;
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
  config: PaperConfig;
}

// ── Service ───────────────────────────────────────────────────────────────────

class PaperSniperService {
  private openPositions = new Map<string, PaperPosition>();
  private closedPositions: PaperPosition[] = [];
  private seenMints = new Set<string>();
  private events: PaperSniperEvent[] = [];
  private broadcaster: (() => void) | null = null;
  private priceIntervalId: ReturnType<typeof setInterval> | null = null;

  private paperConfig: PaperConfig = { ...DEFAULT_PAPER_CONFIG };
  private virtualBalance = STARTING_BALANCE;
  private startingBalance = STARTING_BALANCE;
  private wins = 0;
  private losses = 0;
  private allTimeRealizedSol = 0;

  setBroadcaster(fn: () => void): void {
    this.broadcaster = fn;
  }

  private broadcast(): void {
    this.broadcaster?.();
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadBalance();
    await this.loadStats();
    await this.loadPositions();
    this.startPriceLoop();
    logger.info(
      { virtualBalance: this.virtualBalance, openPositions: this.openPositions.size },
      "Paper sniper: initialised",
    );
  }

  private async loadConfig(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM kv_store WHERE key = $1`,
        [KV_CONFIG_KEY],
      );
      if (rows.length > 0) {
        const saved = JSON.parse(rows[0]!.value) as Partial<PaperConfig>;
        this.paperConfig = { ...DEFAULT_PAPER_CONFIG, ...saved };
      }
    } catch { /* table may not exist yet */ }
  }

  private async persistConfig(): Promise<void> {
    try {
      await execute(
        `INSERT INTO kv_store (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [KV_CONFIG_KEY, JSON.stringify(this.paperConfig)],
      );
    } catch { /* non-fatal */ }
  }

  private async loadBalance(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM kv_store WHERE key = $1`,
        [KV_BALANCE_KEY],
      );
      if (rows.length > 0) {
        this.virtualBalance = parseFloat(rows[0]!.value) || STARTING_BALANCE;
      }
    } catch { /* table may not exist yet */ }
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

  // ── Entry point ───────────────────────────────────────────────────────────

  onGraduation(
    mint: string,
    entryPrice: number,
    symbol: string,
    name: string,
    detectedAt: number,
    detectionPrice: number,
  ): void {
    const cfg = this.paperConfig;

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

    if (this.virtualBalance < cfg.positionSizeSol) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Insufficient paper balance (${this.virtualBalance.toFixed(4)} SOL < ${cfg.positionSizeSol} SOL)` });
      return;
    }

    // Fast-fail: if price already exceeds drift threshold before the exec delay
    const instantDriftPct = detectionPrice > 0
      ? ((entryPrice / detectionPrice) - 1) * 100
      : 0;
    if (detectionPrice > 0 && instantDriftPct > cfg.maxFillDriftPct) {
      const reason = `Fill drift abort — price +${instantDriftPct.toFixed(1)}% above baseline at detection (>${cfg.maxFillDriftPct}% threshold)`;
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
      logger.info({ mint, symbol, instantDriftPct: instantDriftPct.toFixed(1) }, "Paper sniper: fast-fail — drift already exceeded at detection");
      this.broadcast();
      return;
    }

    // Reserve this mint so no duplicate fires during the exec delay
    this.seenMints.add(mint);

    // Simulate real execution latency: wait simulatedExecDelayMs, then re-fetch
    // price and check drift again before entering — matches live bot's ~5s checks.
    void this.scheduleDelayedEntry(mint, entryPrice, symbol, name, detectedAt, detectionPrice);
  }

  private async scheduleDelayedEntry(
    mint: string,
    entryPrice: number,
    symbol: string,
    name: string,
    detectedAt: number,
    detectionPrice: number,
  ): Promise<void> {
    const cfg = this.paperConfig;
    const delayMs = cfg.simulatedExecDelayMs ?? 5_000;

    if (delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }

    // Re-read config (may have changed during wait)
    const cfgNow = this.paperConfig;
    const sizeSol = cfgNow.positionSizeSol;

    // Re-check capacity after delay
    if (this.virtualBalance < sizeSol) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Insufficient balance after ${(delayMs / 1000).toFixed(0)}s exec delay (${this.virtualBalance.toFixed(4)} SOL < ${sizeSol} SOL)` });
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }
    if (this.openPositions.size >= cfgNow.maxOpenPositions) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Max positions reached after ${(delayMs / 1000).toFixed(0)}s exec delay` });
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }

    // Fetch fresh execution price from DexScreener to simulate real fill price
    let execPrice = entryPrice;
    try {
      type DexPair = { baseToken: { address: string }; priceUsd: string };
      const res = await axios.get<DexPair[]>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
        { timeout: 4_000 },
      );
      const pairs = (res.data ?? []) as DexPair[];
      for (const pair of pairs) {
        const p = parseFloat(pair.priceUsd);
        if (p > 0) { execPrice = p; break; }
      }
    } catch {
      logger.debug({ mint, symbol }, "Paper sniper: exec-delay DexScreener fetch failed — using original price");
    }

    // Check drift with the real execution price
    const execDriftPct = detectionPrice > 0
      ? ((execPrice / detectionPrice) - 1) * 100
      : 0;

    if (detectionPrice > 0 && execDriftPct > cfgNow.maxFillDriftPct) {
      const reason = `Exec delay drift abort — price +${execDriftPct.toFixed(1)}% above baseline after ${(delayMs / 1000).toFixed(0)}s (>${cfgNow.maxFillDriftPct}% threshold)`;
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
      logger.info({ mint, symbol, execDriftPct: execDriftPct.toFixed(1), delayMs }, "Paper sniper: skipped — exec delay drift exceeded threshold");
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }

    const pos: PaperPosition = {
      id:                uid(),
      mint,
      symbol,
      name,
      detectedAt,
      entryAt:           Date.now(),
      entryPrice:        execPrice,
      currentPrice:      execPrice,
      sizeSol,
      tp1Hit:            false,
      tp2Hit:            false,
      remainingFraction: 1.0,
      effectiveSlPrice:  execPrice * (1 - cfgNow.slPhase1Pct / 100),
      trailingHigh:      execPrice,
      status:            "open",
      realizedPnlSol:    0,
      unrealizedPnlSol:  0,
      totalPnlSol:       0,
      pnlPct:            0,
      tp1RealizedSol:    0,
      tp2RealizedSol:    0,
      runnerRealizedSol: 0,
      detectionPrice,
      entryDriftPct:     execDriftPct,
    };

    this.virtualBalance -= sizeSol;
    this.openPositions.set(mint, pos);

    void this.persistPosition(pos);
    void this.persistBalance();

    this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "entered" });

    logger.info(
      { mint, symbol, detectionPrice, execPrice, execDriftPct: execDriftPct.toFixed(1) + "%", delayMs, sizeSol, virtualBalance: this.virtualBalance },
      "Paper sniper: PAPER position entered 📄",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `📄 <b>PAPER ENTRY</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${symbol}</b>\n` +
        `📋 CA: <code>${mint}</code>\n` +
        `💵 Entry: <b>$${execPrice < 0.0001 ? execPrice.toExponential(3) : execPrice.toFixed(8)}</b>\n` +
        `📈 Drift: ${execDriftPct >= 0 ? "+" : ""}${execDriftPct.toFixed(1)}% (after ${(delayMs / 1000).toFixed(0)}s delay)\n` +
        `💰 Size: <b>${sizeSol.toFixed(4)} SOL</b> (virtual)\n` +
        `📊 Balance after: <b>${this.virtualBalance.toFixed(4)} SOL</b>\n` +
        `🛡️ SL: -${cfgNow.slPhase1Pct}% (2m) → -${cfgNow.slPhase2Pct}% → -${cfgNow.slPhase3Pct}%\n` +
        `🎯 TP1: +${cfgNow.tp1Pct}% (sell ${cfgNow.tp1ClosePct}%)\n` +
        `🎯 TP2: +${cfgNow.tp2Pct}% (sell ${cfgNow.tp2ClosePct}%)\n` +
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

    const cfg = this.paperConfig;

    for (let i = 0; i < positions.length; i += BATCH_MAX) {
      const batch = positions.slice(i, i + BATCH_MAX);
      const mints = batch.map((p) => p.mint).join(",");
      try {
        type DexPair = { baseToken: { address: string }; priceUsd: string };
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
      } catch { /* non-fatal */ }
    }

    this.updateUnrealizedPnl();
    this.broadcast();
  }

  private checkTpSl(pos: PaperPosition, cfg: PaperConfig): void {
    if (pos.status !== "open") return;
    if (!pos.lastPriceAt || Date.now() - pos.lastPriceAt > STALE_PRICE_MS) return;

    const price = pos.currentPrice;
    const pct   = ((price / pos.entryPrice) - 1) * 100;
    const ageMs = Date.now() - pos.entryAt;

    // ── TP1 ───────────────────────────────────────────────────────────────
    if (!pos.tp1Hit && pct >= cfg.tp1Pct) {
      const closeFrac   = cfg.tp1ClosePct / 100;
      const solReturned = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl         = solReturned - pos.sizeSol * closeFrac;
      pos.tp1Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp1RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac;
      pos.effectiveSlPrice  = price * (1 - cfg.slAfterTp1Pct / 100);
      this.virtualBalance  += solReturned;
      logger.info({ mint: pos.mint, symbol: pos.symbol, pct: pct.toFixed(1), pnl, solReturned, virtualBalance: this.virtualBalance },
        "Paper sniper: TP1 hit 🎯");
      void this.persistPosition(pos);
      void this.persistBalance();
      if (isTelegramConfigured()) {
        void sendTelegram(
          `🎯 <b>PAPER TP1 HIT</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n` +
          `📋 CA: <code>${pos.mint}</code>\n` +
          `💵 Price: <b>$${price < 0.0001 ? price.toExponential(3) : price.toFixed(8)}</b>\n` +
          `📈 Gain: <b>+${pct.toFixed(1)}%</b>\n` +
          `💰 Banked: <b>+${pnl.toFixed(4)} SOL</b> (${cfg.tp1ClosePct}% of position)\n` +
          `⚡ Runner: ${Math.round(pos.remainingFraction * 100)}% remaining\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
      return;
    }

    // ── TP2 ───────────────────────────────────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit && pct >= cfg.tp2Pct) {
      const closeFrac   = (cfg.tp2ClosePct / 100) * pos.remainingFraction;
      const solReturned = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl         = solReturned - pos.sizeSol * closeFrac;
      pos.tp2Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp2RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac;
      pos.effectiveSlPrice  = price * (1 - cfg.trailingStopPct / 100);
      this.virtualBalance  += solReturned;
      logger.info({ mint: pos.mint, symbol: pos.symbol, pct: pct.toFixed(1), pnl, solReturned, virtualBalance: this.virtualBalance },
        "Paper sniper: TP2 hit 🎯🎯");
      void this.persistPosition(pos);
      void this.persistBalance();
      if (isTelegramConfigured()) {
        void sendTelegram(
          `🎯🎯 <b>PAPER TP2 HIT</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n` +
          `📋 CA: <code>${pos.mint}</code>\n` +
          `💵 Price: <b>$${price < 0.0001 ? price.toExponential(3) : price.toFixed(8)}</b>\n` +
          `📈 Gain: <b>+${pct.toFixed(1)}%</b>\n` +
          `💰 Banked: <b>+${pnl.toFixed(4)} SOL</b>\n` +
          `⚡ Runner: ${Math.round(pos.remainingFraction * 100)}% remaining\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
      return;
    }

    // ── Trailing stop (after TP1) ─────────────────────────────────────────
    if (pos.tp1Hit) {
      const trailPrice = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      pos.effectiveSlPrice = Math.max(pos.effectiveSlPrice, trailPrice);
    }

    // ── Dead-coin filter ──────────────────────────────────────────────────
    if (!pos.tp1Hit) {
      const peakMovePct = pos.trailingHigh > 0
        ? ((pos.trailingHigh / pos.entryPrice) - 1) * 100
        : 0;
      if (ageMs >= cfg.deadCoinWindowMs && peakMovePct < cfg.deadCoinMinMovePct) {
        const windowHrs = (cfg.deadCoinWindowMs / 3_600_000).toFixed(1);
        this.closePaperPosition(
          pos,
          `Dead — No Momentum (peak +${peakMovePct.toFixed(1)}% in ${windowHrs}h)`,
          price,
        );
        return;
      }
    }

    // ── Staged SL ─────────────────────────────────────────────────────────
    const slDropPct = pos.tp1Hit
      ? cfg.slAfterTp1Pct
      : ageMs < STAGED_SL_PHASE1_MS
        ? cfg.slPhase1Pct
        : ageMs < STAGED_SL_PHASE2_MS
          ? cfg.slPhase2Pct
          : cfg.slPhase3Pct;

    const slThreshold = pos.tp1Hit
      ? pos.effectiveSlPrice
      : pos.trailingHigh * (1 - slDropPct / 100);

    if (price <= slThreshold) {
      const reason = pos.tp1Hit
        ? `Trailing SL (runner -${cfg.trailingStopPct}% from peak)`
        : ageMs < STAGED_SL_PHASE1_MS
          ? `Staged SL Ph1 — -${cfg.slPhase1Pct}% (${(ageMs / 60_000).toFixed(1)}m)`
          : ageMs < STAGED_SL_PHASE2_MS
            ? `Staged SL Ph2 — -${cfg.slPhase2Pct}% from peak`
            : `Staged SL Ph3 — -${cfg.slPhase3Pct}% from peak`;
      this.closePaperPosition(pos, reason, price);
    }
  }

  private closePaperPosition(pos: PaperPosition, reason: string, exitPrice: number): void {
    const solReturned     = pos.sizeSol * pos.remainingFraction * (exitPrice / pos.entryPrice);
    const runnerPnl       = solReturned - pos.sizeSol * pos.remainingFraction;
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

    this.virtualBalance       += solReturned;
    this.allTimeRealizedSol   += pos.realizedPnlSol;

    if (pos.realizedPnlSol >= 0) this.wins++;
    else this.losses++;

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
      const fraction       = pos.remainingFraction;
      const solAtEntry     = pos.sizeSol * fraction;
      const solAtCurrent   = solAtEntry * (price / pos.entryPrice);
      pos.unrealizedPnlSol = solAtCurrent - solAtEntry;
      pos.totalPnlSol      = pos.realizedPnlSol + pos.unrealizedPnlSol;
      pos.pnlPct           = ((price / pos.entryPrice) - 1) * 100;
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

  closePositionById(id: string): boolean {
    // openPositions is keyed by mint, not id — search by value
    const pos = [...this.openPositions.values()].find((p) => p.id === id);
    if (!pos || pos.status !== "open") return false;
    this.closePaperPosition(pos, "Manual close", pos.currentPrice);
    return true;
  }

  getConfig(): PaperConfig {
    return { ...this.paperConfig };
  }

  async updateConfig(patch: Partial<PaperConfig>): Promise<PaperConfig> {
    this.paperConfig = { ...this.paperConfig, ...patch };
    await this.persistConfig();
    this.broadcast();
    return this.getConfig();
  }

  getStatus(): PaperSniperStatus {
    this.updateUnrealizedPnl();
    const open = [...this.openPositions.values()];
    const totalUnrealized = open.reduce((s, p) => s + p.unrealizedPnlSol, 0);
    const capitalInOpen   = open.reduce((s, p) => s + p.sizeSol * p.remainingFraction, 0);

    return {
      enabled:               true,
      virtualBalance:        this.virtualBalance,
      startingBalance:       this.startingBalance,
      openCount:             this.openPositions.size,
      tradesTotal:           this.wins + this.losses,
      wins:                  this.wins,
      losses:                this.losses,
      totalRealizedPnlSol:   this.allTimeRealizedSol,
      totalUnrealizedPnlSol: totalUnrealized,
      totalCombinedPnlSol:   this.allTimeRealizedSol + totalUnrealized,
      capitalInOpen,
      config:                this.getConfig(),
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
    for (const pos of this.openPositions.values()) {
      pos.status      = "closed";
      pos.closeReason = "Paper account reset";
      pos.closedAt    = Date.now();
      pos.exitPrice   = pos.currentPrice || pos.entryPrice;
      void this.persistPosition(pos);
    }
    this.openPositions.clear();
    this.closedPositions    = [];
    this.seenMints.clear();
    this.events             = [];
    this.virtualBalance     = STARTING_BALANCE;
    this.startingBalance    = STARTING_BALANCE;
    this.wins               = 0;
    this.losses             = 0;
    this.allTimeRealizedSol = 0;

    try { await execute(`DELETE FROM paper_sniper_positions`, []); } catch { /* non-fatal */ }

    await this.persistBalance();
    await this.persistStats();
    this.broadcast();
    logger.info("Paper sniper: account reset ✅");
  }
}

export const paperSniperService = new PaperSniperService();
