import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";
import type { GraduationQualityMeta } from "./graduation-sniper.service.js";

// ── Paper-specific config ──────────────────────────────────────────────────────

export interface PaperConfig {
  positionSizeSol:    number;
  maxOpenPositions:   number;
  tp1Pct:             number;
  tp1ClosePct:        number;
  tp2Pct:             number;
  tp2ClosePct:        number;
  tp3Pct:             number;  // TP3 at +600%
  tp3ClosePct:        number;  // % of remaining position to close at TP3 (e.g. 100 = close all)
  trailingStopPct:    number;
  slPhase1Pct:        number;  // SL % during first 2 min
  slPhase2Pct:        number;  // SL % from peak during 2–10 min
  slPhase3Pct:        number;  // SL % from peak after 10 min
  slAfterTp1Pct:      number;  // trailing SL % from peak after TP1
  deadCoinWindowMs:     number;  // ms to wait before dead-coin check (default 2h)
  deadCoinMinMovePct:   number;  // min peak move % required — if not reached, close as dead
  maxFillDriftPct:      number;  // skip entry if price already moved > this % from detection baseline
  simulatedExecDelayMs: number;  // ms to wait after graduation before entering (simulates real exec latency)
  // ── Quality pre-entry filters ──────────────────────────────────────────────
  enableLiquidityFilter:    boolean; // require minimum pool liquidity at graduation
  minLiquidityUsd:          number;  // min pool liquidity in USD (e.g. 5000)
  enableBondingCurveFilter: boolean; // require bonding curve completed within time limit
  maxBondingCurveMinutes:   number;  // skip if bonding curve took > N minutes (e.g. 30)
  enableHolderFilter:       boolean; // require minimum holder count at graduation
  minHolderCount:           number;  // min holder count (e.g. 150)
  // ── New strategy filters (mirrors live sniper behaviour) ───────────────────
  enableCreatorFilter:      boolean; // skip if creator holds > maxCreatorHoldingsPct
  maxCreatorHoldingsPct:    number;  // creator holdings % threshold (default 5%)
  enableSellPressureExit:   boolean; // emergency exit when sells > buys×1.5 for ≥60s (pre-TP1)
  enableWhaleDumpExit:      boolean; // emergency exit when liquidity drops 20–39% in 30s AND ≥5 SOL (pre-TP1)
  // ── Quality scoring thresholds (independent from live sniper) ─────────────
  minUniqueBuyers:     number;  // skip if unique buyers < this (default 20)
  minBuyPressureRatio: number;  // skip if buy pressure < this multiple (default 1.3)
  maxTopHolderPct:     number;  // skip if top holder > this % (default 25)
  minLiquiditySolQuality: number; // skip if on-chain SOL liquidity < this (default 25)
}

const DEFAULT_PAPER_CONFIG: PaperConfig = {
  positionSizeSol:    0.001,  // spec: match live sniper base position size
  maxOpenPositions:   8,
  tp1Pct:             150,  // TP1 at +150%
  tp1ClosePct:        40,   // sell 40% at TP1
  tp2Pct:             400,  // TP2 at +400%
  tp2ClosePct:        40,   // sell 40% at TP2 → 20% runner remains
  tp3Pct:             600,  // TP3 at +600%
  tp3ClosePct:        100,  // sell 100% of remaining at TP3 (exits position fully)
  trailingStopPct:    30,   // trailing SL -30% from peak (runner after TP1/TP2)
  slPhase1Pct:        20,   // 0-2m: hard SL -20% from entry (spec: Phase 1)
  slPhase2Pct:        25,   // 2-10m: trailing -25% from peak (spec: Phase 2)
  slPhase3Pct:        30,   // >10m: trailing -30% from peak (spec: Phase 3)
  slAfterTp1Pct:      35,   // trailing SL -35% from peak after TP1
  deadCoinWindowMs:     2 * 60 * 60_000,  // 2 hours
  deadCoinMinMovePct:   5,                // must move >5% from entry
  maxFillDriftPct:      15,               // spec: skip if exec price > 15% above detection baseline
  simulatedExecDelayMs: 5_500,           // 5.5s delay — simulates realistic 5-6th candle entry
  // Quality filters — enabled by default with calibrated thresholds
  enableLiquidityFilter:    true,
  minLiquidityUsd:          5_000,  // skip if pool < $5,000 at graduation
  enableBondingCurveFilter: true,
  maxBondingCurveMinutes:   30,     // skip if bonding curve took > 30 min
  enableHolderFilter:       true,
  minHolderCount:           150,    // skip if < 150 holders at graduation
  // Strategy exit filters — mirrors live sniper
  enableCreatorFilter:      true,   // skip if creator holds > 5%
  maxCreatorHoldingsPct:    5,      // creator rug-risk threshold
  enableSellPressureExit:   true,   // emergency exit on sustained sell pressure (≥60s)
  enableWhaleDumpExit:      true,   // emergency exit on whale liquidity pull (pre-TP1)
  // Quality scoring thresholds (paper-configurable, defaults match live sniper)
  minUniqueBuyers:          20,     // unique buyers minimum
  minBuyPressureRatio:      1.3,    // buy pressure minimum (buys/sells ratio)
  maxTopHolderPct:          25,     // top holder concentration maximum %
  minLiquiditySolQuality:   25,     // min SOL liquidity for quality gate
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
  tp3Hit: boolean;
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
  tp3RealizedSol: number;
  runnerRealizedSol: number;
  detectionPrice?: number;
  entryDriftPct?: number;
  msDetectionToFill?: number;
  lastPriceAt?: number;
  // Quality snapshot
  qualityScore?: number;
  liquiditySol?: number;
  buyPressureRatio?: number;
  uniqueBuyers?: number;
  topHolderPct?: number;
  whaleDetected?: boolean;
  // Dip-retrace entry context (set when position was entered via dip-watch)
  dipPeakHigh?: number;
  dipDipLow?: number;
  dipDumpPct?: number;
  dipRetracePct?: number;
  phase1PumpPct?: number;
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
  // Phase 3 dip-retrace entry context (populated when action === "entered")
  phase1PumpPct?: number;
  phase2DumpPct?: number;
  phase3RetracePct?: number;
  entryPrice?: number;
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
  // Sell pressure tracking — per-mint timestamp when sustained sell pressure started
  private sellPressureStartAt = new Map<string, number>();
  // Whale dump detection — per-mint last-seen liquidity USD
  private lastPositionLiquidityUsd = new Map<string, number>();

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
      tp3RealizedSol:    Number(row["tp3_realized_sol"] ?? 0),
      runnerRealizedSol: Number(row["runner_realized_sol"] ?? 0),
      tp3Hit:            Boolean(row["tp3_hit"]),
      detectionPrice:    row["detection_price"] ? Number(row["detection_price"]) : undefined,
      entryDriftPct:     row["entry_drift_pct"] ? Number(row["entry_drift_pct"]) : undefined,
    };
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  onGraduation(
    _mint: string,
    _entryPrice: number,
    _symbol: string,
    _name: string,
    _detectedAt: number,
    _detectionPrice: number,
    _qualityMeta?: GraduationQualityMeta,
  ): void {
    // Paper mode only executes Phase 3 dip-retrace trades.
    // Graduation-based entry is disabled — use enterPhase3Trade() instead.
  }

  private async scheduleDelayedEntry(
    mint: string,
    entryPrice: number,
    symbol: string,
    name: string,
    detectedAt: number,
    detectionPrice: number,
    qualityMeta?: GraduationQualityMeta,
  ): Promise<void> {
    const cfg = this.paperConfig;

    // ── Fast path: on-chain price already confirmed by graduation sniper ──────
    // When the graduation sniper validated pool reserves on-chain and passed
    // a real price, we can skip:
    //   1. The artificial exec delay (simulatedExecDelayMs)
    //   2. The pool existence gate (pool already confirmed via vault reserves)
    //   3. The DexScreener/Jupiter price re-poll (price already validated)
    // This cuts entry time from up to 118s down to ~2-8s from graduation TX.
    if (qualityMeta?.onChainPriceConfirmed && entryPrice > 0) {
      logger.info({ mint, symbol, entryPrice, detectionPrice },
        "Paper sniper: ⚡ FAST PATH — on-chain price confirmed, skipping gate + price poll");
      // Re-check capacity after quality-filter pipeline
      const cfgFast = this.paperConfig;
      if (this.virtualBalance < cfgFast.positionSizeSol) {
        this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
          skipReason: `Insufficient balance (${this.virtualBalance.toFixed(4)} SOL < ${cfgFast.positionSizeSol} SOL)` });
        this.seenMints.delete(mint);
        this.broadcast();
        return;
      }
      if (this.openPositions.size >= cfgFast.maxOpenPositions) {
        this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
          skipReason: `Max positions reached (${this.openPositions.size}/${cfgFast.maxOpenPositions})` });
        this.seenMints.delete(mint);
        this.broadcast();
        return;
      }
      // Drift guard still applies on the fast path (no DexScreener re-check, use on-chain price directly)
      const fastDriftPct = detectionPrice > 0 ? ((entryPrice / detectionPrice) - 1) * 100 : 0;
      if (detectionPrice > 0 && fastDriftPct > cfgFast.maxFillDriftPct) {
        const reason = `Drift abort — price +${fastDriftPct.toFixed(1)}% above baseline (>${cfgFast.maxFillDriftPct}% threshold)`;
        this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
        this.seenMints.delete(mint);
        this.broadcast();
        return;
      }
      // ── Negative drift guard: on-chain vault price >> actual AMM price ────
      const NEG_FAST_DRIFT_ABORT = -20;
      if (detectionPrice > 0 && fastDriftPct < NEG_FAST_DRIFT_ABORT) {
        const reason = `Dead pool abort — on-chain price ${fastDriftPct.toFixed(1)}% below detection baseline — pool likely crashed`;
        this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
        this.seenMints.delete(mint);
        this.broadcast();
        return;
      }
      // ── Open position immediately (no pool gate, no price re-poll) ────────
      const fastSizeSol = cfgFast.positionSizeSol;
      const fastPos: PaperPosition = {
        id:                uid(),
        mint,
        symbol,
        name,
        detectedAt,
        entryAt:           detectedAt + 5_500, // simulate realistic 5-6th candle entry (~5.5s after graduation)
        entryPrice,
        currentPrice:      entryPrice,
        sizeSol:           fastSizeSol,
        tp1Hit:            false,
        tp2Hit:            false,
        remainingFraction: 1.0,
        effectiveSlPrice:  entryPrice * (1 - cfgFast.slPhase1Pct / 100),
        trailingHigh:      entryPrice,
        status:            "open",
        realizedPnlSol:    0,
        unrealizedPnlSol:  0,
        totalPnlSol:       0,
        pnlPct:            0,
        tp1RealizedSol:    0,
        tp2RealizedSol:    0,
        tp3Hit:            false,
        tp3RealizedSol:    0,
        runnerRealizedSol: 0,
        detectionPrice,
        entryDriftPct:     fastDriftPct,
        qualityScore:      qualityMeta?.qualityScore,
        liquiditySol:      qualityMeta?.liquiditySol,
        buyPressureRatio:  qualityMeta?.buyPressureRatio,
        uniqueBuyers:      qualityMeta?.uniqueBuyers,
        topHolderPct:      qualityMeta?.topHolderPct,
        whaleDetected:     qualityMeta?.whaleDetected,
        dipPeakHigh:       qualityMeta?.dipPeakHigh,
        dipDipLow:         qualityMeta?.dipDipLow,
        dipDumpPct:        qualityMeta?.dipDumpPct,
        dipRetracePct:     qualityMeta?.dipRetracePct,
      };
      this.virtualBalance -= fastSizeSol;
      this.openPositions.set(mint, fastPos);
      void this.persistPosition(fastPos);
      void this.persistBalance();
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "entered" });
      logger.info(
        { mint, symbol, entryPrice, fastDriftPct: fastDriftPct.toFixed(1) + "%", fastSizeSol, virtualBalance: this.virtualBalance },
        "Paper sniper: ⚡ FAST PAPER position entered (on-chain price, zero gate delay) 📄",
      );
      if (isTelegramConfigured()) {
        void sendTelegram(
          `📄⚡ <b>PAPER ENTRY (instant)</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${symbol}</b>\n` +
          `📋 CA: <code>${mint}</code>\n` +
          `💵 Entry: <b>$${entryPrice < 0.0001 ? entryPrice.toExponential(3) : entryPrice.toFixed(8)}</b>\n` +
          `📈 Drift: ${fastDriftPct >= 0 ? "+" : ""}${fastDriftPct.toFixed(1)}% (on-chain, instant)\n` +
          `💰 Size: <b>${fastSizeSol.toFixed(4)} SOL</b> (virtual)\n` +
          `📊 Balance after: <b>${this.virtualBalance.toFixed(4)} SOL</b>\n` +
          `🛡️ SL: -${cfgFast.slPhase1Pct}% (2m) → -${cfgFast.slPhase2Pct}% → -${cfgFast.slPhase3Pct}%\n` +
          `🎯 TP1: +${cfgFast.tp1Pct}% · TP2: +${cfgFast.tp2Pct}%\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
      this.broadcast();
      return;
    }

    const delayMs = cfg.simulatedExecDelayMs ?? 0;

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

    // ── Step 1: Pool existence gate (Promise.any — first source wins) ───────────
    // Sources fired in parallel on each attempt:
    //  A. PumpSwap pool PDA on-chain check — pool is created IN the migration TX
    //     so it exists on-chain immediately. getAccountInfo via Helius RPC.
    //     Three seed patterns cover all PumpSwap versions.
    //  B. DexScreener AMM pair (pumpswap/raydium) — ~15-60s indexing lag.
    //  C+D. Jupiter lite + full APIs — ~5-30s indexing lag.
    // Using Promise.any: as soon as ONE source confirms, we exit immediately.
    // No waiting for slow sources to time out (unlike allSettled).
    const JUPE_LITE        = "https://lite-api.jup.ag/swap/v1/quote";
    const JUPE_FULL        = "https://quote-api.jup.ag/v6/quote";
    const WSOL_MINT        = "So11111111111111111111111111111111111111112";
    const PUMPSWAP_PROG    = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
    // DexScreener uses "pump-amm" (not "pumpswap") for PumpSwap-graduated tokens.
    // Include all known variants so the gate doesn't miss tokens that are clearly
    // live on DexScreener. The ANY-price fallback below catches unknown future dexIds.
    const AMM_DEXES        = new Set(["raydium", "pumpswap", "pump-amm", "pump_amm", "orca", "meteora"]);
    const GATE_DEADLINE    = 45_000; // extended: Jupiter can take 30-40s to index new pools
    const GATE_POLL        = 1_000;
    const heliusKey        = process.env["HELIUS_API_KEY"];

    // Derive PumpSwap pool PDAs (three seed patterns)
    const pdaAddresses: string[] = [];
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const mPK = new PublicKey(mint);
      const pPK = new PublicKey(PUMPSWAP_PROG);
      const wPK = new PublicKey(WSOL_MINT);
      const idx = Buffer.from([0, 0]);
      const [a] = PublicKey.findProgramAddressSync([Buffer.from("pool"), mPK.toBuffer()], pPK);
      const [b] = PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, mPK.toBuffer(), wPK.toBuffer()], pPK);
      const [c] = PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, wPK.toBuffer(), mPK.toBuffer()], pPK);
      pdaAddresses.push(a.toBase58(), b.toBase58(), c.toBase58());
    } catch { /* non-fatal */ }

    let gateConfirmed  = false;
    let gateSource     = "";
    let jupiterOutAmount = 0;

    const deadline = Date.now() + GATE_DEADLINE;
    let attempt = 0;

    while (Date.now() < deadline && !gateConfirmed) {
      if (attempt > 0) await new Promise<void>(r => setTimeout(r, GATE_POLL));
      attempt++;

      type QuoteResp = { outAmount?: string; error?: string };
      type AcctResp  = { result?: { value?: { lamports?: number } | null } };
      type Win       = { source: string; jupOut?: number; dexPrice?: number };
      const jp  = { inputMint: WSOL_MINT, outputMint: mint, amount: 10_000_000, slippageBps: 5000 };
      const rpc = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null;

      const checks: Promise<Win>[] = [];

      // A: DexScreener AMM pair ONLY — never bonding-curve pair.
      // The bonding-curve pair (dexId: "pump.fun" or similar) is ALWAYS present
      // on DexScreener even before migration completes and shows the pre-pump price.
      // Using it as a price source is the root cause of fake-cheap paper entries.
      // We must wait for the actual AMM pair (pumpswap/pump-amm/raydium) to appear.
      checks.push(
        (async () => {
          type DexPair = { priceUsd: string; dexId?: string };
          const res = await axios.get<DexPair[]>(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, { timeout: 4_000 });
          const pairs = Array.isArray(res.data) ? res.data : [];
          // STRICT: only AMM pairs — no bonding-curve fallback
          const ammPair = pairs.find(p => AMM_DEXES.has(p.dexId ?? "") && (parseFloat(p.priceUsd) || 0) > 0);
          if (ammPair) return { source: `dex:${ammPair.dexId ?? "unknown"}`, dexPrice: parseFloat(ammPair.priceUsd) };
          throw new Error("dex: no AMM pair indexed yet");
        })()
      );

      // B: PumpSwap pool PDA(s) on-chain
      if (rpc && pdaAddresses.length > 0) {
        for (const pda of pdaAddresses) {
          checks.push(
            axios.post<AcctResp>(rpc,
              { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] },
              { timeout: 3_000 }
            ).then(r => {
              if ((r.data?.result?.value?.lamports ?? 0) > 0) return { source: `pda:${pda.slice(0, 8)}` };
              throw new Error(`pda: no account`);
            })
          );
        }
      }

      // C: Jupiter lite-api
      checks.push(
        axios.get<QuoteResp>(JUPE_LITE, { params: jp, timeout: 4_000 }).then(r => {
          const out = parseInt(r.data?.outAmount ?? "0", 10);
          if (out > 0) return { source: "jup-lite", jupOut: out };
          throw new Error("jup-lite: no route");
        })
      );

      // D: Jupiter full quote-api/v6
      checks.push(
        axios.get<QuoteResp>(JUPE_FULL, { params: jp, timeout: 4_000 }).then(r => {
          const out = parseInt(r.data?.outAmount ?? "0", 10);
          if (out > 0) return { source: "jup-full", jupOut: out };
          throw new Error("jup-full: no route");
        })
      );

      try {
        const winner = await Promise.any(checks);
        gateConfirmed    = true;
        gateSource       = winner.source;
        jupiterOutAmount = winner.jupOut ?? 0;
        if (winner.dexPrice && winner.dexPrice > 0) {
          // DexScreener confirmed — use its price for execution
        }
        logger.info({ mint, symbol, gateSource, attempt }, `Paper sniper: gate confirmed via ${gateSource} ✅`);
      } catch {
        logger.info({ mint, symbol, attempt, msRemaining: Math.max(0, deadline - Date.now()) },
          "Paper sniper: gate pending — all sources unconfirmed, retrying");
      }
    }

    if (!gateConfirmed) {
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped",
        skipReason: `Pool not confirmed after 30s (no PDA / DexScreener AMM / Jupiter route)` });
      logger.warn({ mint, symbol }, "Paper sniper: skipped — gate timed out (false trigger guard)");
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }

    // ── Step 2: Get accurate AMM execution price ─────────────────────────────
    //
    // DESIGN PRINCIPLES (hard lessons from fake paper entries):
    //
    // 1. NEVER use the bonding-curve DexScreener pair.  pump.fun tokens always have
    //    a DexScreener pair with dexId "pump.fun" that exists BEFORE migration and
    //    shows the pre-pump pool-seed price.  Only AMM pairs (pumpswap/pump-amm/
    //    raydium) reflect real post-graduation trading.
    //
    // 2. NEVER use the stale `jupiterOutAmount` from the gate check.  The gate
    //    fires ~0-5s after graduation; Jupiter routes may not yet reflect the new
    //    pool.  Always fetch a FRESH Jupiter quote here.
    //
    // 3. NEVER apply an artificial price floor from the detection baseline.
    //    If no real AMM price is available, SKIP the trade — a fake entry is worse
    //    than no entry.
    //
    // 4. Jupiter formula requires decimal adjustment: outAmount is in raw token
    //    units.  pump.fun tokens have 6 decimals, so divide by 1_000_000 to get
    //    UI tokens before computing USD price.
    //
    // Source priority:
    //   A. DexScreener AMM pair — poll up to 60s (12 × 5s)
    //   B. Jupiter fresh quote — correct formula: (0.01 SOL × SOL/USD) / (rawOut / 1e6)
    //   C. No real price → SKIP (no entry)
    //
    const AMM_DEX_IDS       = new Set(["raydium", "pumpswap", "pump-amm", "pump_amm", "orca", "meteora"]);
    const DEX_MAX_ATTEMPTS  = 12;   // 12 × 5s = 60s total
    const DEX_POLL_MS       = 5_000;
    let execPrice       = 0;
    let execPriceSource = "";

    // A: Poll DexScreener for AMM pair (up to 60s)
    for (let attempt = 0; attempt < DEX_MAX_ATTEMPTS && execPrice <= 0; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, DEX_POLL_MS));
      try {
        type DexPair = { priceUsd: string; dexId?: string };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
          { timeout: 5_000 },
        );
        const pairs = (res.data ?? []) as DexPair[];
        const ammPair = pairs.find((p) => AMM_DEX_IDS.has(p.dexId ?? "") && (parseFloat(p.priceUsd) || 0) > 0);
        if (ammPair) {
          execPrice       = parseFloat(ammPair.priceUsd);
          execPriceSource = `dex:${ammPair.dexId ?? "amm"}`;
          logger.info({ mint, symbol, execPrice, dexId: ammPair.dexId, attempt },
            "Paper sniper: exec price from DexScreener AMM pair ✅");
        } else {
          logger.debug({ mint, symbol, attempt, maxAttempts: DEX_MAX_ATTEMPTS },
            "Paper sniper: DexScreener AMM pair not indexed yet — retrying");
        }
      } catch {
        logger.debug({ mint, symbol, attempt }, "Paper sniper: DexScreener fetch failed — retrying");
      }
    }

    // B: Jupiter fresh quote fallback (correct decimal math)
    // outAmount is raw token units; pump.fun = 6 decimals → divide by 1e6 for UI tokens.
    // Price = (SOL spent in USD) / (UI tokens received)
    //       = (0.01 × solUsd) / (outAmount / 1_000_000)
    if (execPrice <= 0) {
      try {
        const WSOL_MINT = "So11111111111111111111111111111111111111112";
        const JUPE_FULL = "https://quote-api.jup.ag/v6/quote";
        type QuoteResp  = { outAmount?: string };
        type SolPair    = { priceUsd: string };

        const [jupRes, solRes] = await Promise.allSettled([
          axios.get<QuoteResp>(JUPE_FULL, {
            params: { inputMint: WSOL_MINT, outputMint: mint, amount: 10_000_000, slippageBps: 5000 },
            timeout: 6_000,
          }),
          axios.get<SolPair[]>(
            `${DEXSCREENER_BASE}/tokens/v1/solana/${WSOL_MINT}`,
            { timeout: 4_000 },
          ),
        ]);

        if (jupRes.status === "fulfilled" && solRes.status === "fulfilled") {
          const rawOut = parseInt(jupRes.value.data?.outAmount ?? "0", 10);
          const solUsd = parseFloat((solRes.value.data as SolPair[])[0]?.priceUsd ?? "0");
          if (rawOut > 0 && solUsd > 0) {
            const uiOut   = rawOut / 1_000_000;          // 6 decimals (pump.fun standard)
            const jupPrice = (0.01 * solUsd) / uiOut;    // USD per UI token
            if (jupPrice > 0) {
              execPrice       = jupPrice;
              execPriceSource = "jup-fresh";
              logger.info({ mint, symbol, execPrice, rawOut, uiOut, solUsd },
                "Paper sniper: exec price from Jupiter fresh quote ✅");
            }
          }
        }
      } catch {
        logger.warn({ mint, symbol }, "Paper sniper: Jupiter fresh quote fallback failed");
      }
    }

    // C: No real AMM price — refuse to enter with fake/stale price
    if (execPrice <= 0) {
      const skipReason = `No real AMM price after 60s — DexScreener AMM not indexed + Jupiter fallback failed. Refusing fake entry.`;
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason });
      logger.warn({ mint, symbol }, "Paper sniper: SKIPPED — no real AMM price available, not entering ⛔");
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }

    logger.info(
      { mint, symbol, execPrice, execPriceSource, detectionPrice,
        drift: detectionPrice > 0 ? (((execPrice / detectionPrice) - 1) * 100).toFixed(1) + "%" : "n/a" },
      "Paper sniper: execution price confirmed ✅",
    );

    // Check drift with the real execution price
    const execDriftPct = detectionPrice > 0
      ? ((execPrice / detectionPrice) - 1) * 100
      : 0;

    // Abort if price pumped too much (chasing the pump)
    if (detectionPrice > 0 && execDriftPct > cfgNow.maxFillDriftPct) {
      const reason = `Exec delay drift abort — price +${execDriftPct.toFixed(1)}% above baseline after ${(delayMs / 1000).toFixed(0)}s (>${cfgNow.maxFillDriftPct}% threshold)`;
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
      logger.info({ mint, symbol, execDriftPct: execDriftPct.toFixed(1), delayMs }, "Paper sniper: skipped — exec delay drift exceeded threshold");
      this.seenMints.delete(mint);
      this.broadcast();
      return;
    }

    // ── CRITICAL: abort if price CRASHED vs detection baseline ────────────────
    // A large negative execDriftPct means the real AMM pool price is far below
    // what the on-chain vault read returned at detection time (bonding-curve
    // vault price vs actual AMM pool price mismatch, or instant post-graduation
    // rug).  Examples that reach here: STRIKE -89.4%, LAZY -99.7%.
    // Threshold: -20% — a fresh legitimate graduation should not dump >20%
    // within the first 5 seconds of pool existence.
    const NEG_EXEC_DRIFT_ABORT = -20;
    if (detectionPrice > 0 && execDriftPct < NEG_EXEC_DRIFT_ABORT) {
      const reason = `Dead pool abort — exec price ${execDriftPct.toFixed(1)}% below detection baseline (<${NEG_EXEC_DRIFT_ABORT}% threshold) — pool already crashed`;
      this.addEvent({ id: uid(), detectedAt, mint, symbol, action: "skipped", skipReason: reason });
      logger.warn(
        { mint, symbol, detectionPrice, execPrice, execDriftPct: execDriftPct.toFixed(1), limit: NEG_EXEC_DRIFT_ABORT },
        "Paper sniper: DEAD POOL — exec price crashed vs detection baseline, entry aborted ⛔",
      );
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
      tp3Hit:            false,
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
      tp3RealizedSol:    0,
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
    const now = Date.now();

    for (let i = 0; i < positions.length; i += BATCH_MAX) {
      const batch = positions.slice(i, i + BATCH_MAX);
      const mints = batch.map((p) => p.mint).join(",");
      try {
        type DexPair = {
          baseToken: { address: string };
          priceUsd: string;
          liquidity?: { usd?: number };
          txns?: { m5?: { buys?: number; sells?: number } };
        };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${mints}`,
          { timeout: 6_000 },
        );
        const pairs = res.data ?? [];
        const priceMap = new Map<string, number>();
        const liqMap   = new Map<string, number>();
        const buysMap  = new Map<string, number>();
        const sellsMap = new Map<string, number>();
        for (const pair of pairs) {
          const addr = pair.baseToken.address;
          const p = parseFloat(pair.priceUsd);
          if (p > 0) priceMap.set(addr, p);
          if (pair.liquidity?.usd != null) liqMap.set(addr, pair.liquidity.usd);
          if (pair.txns?.m5) {
            buysMap.set(addr,  pair.txns.m5.buys  ?? 0);
            sellsMap.set(addr, pair.txns.m5.sells ?? 0);
          }
        }

        for (const pos of batch) {
          const price = priceMap.get(pos.mint);
          if (!price || price <= 0) continue;
          pos.currentPrice = price;
          pos.lastPriceAt  = now;
          if (price > pos.trailingHigh) pos.trailingHigh = price;

          // ── Whale dump detection (pre-TP1, enabled toggle) ──────────────────
          if (cfg.enableWhaleDumpExit && !pos.tp1Hit) {
            const liqUsd = liqMap.get(pos.mint);
            if (liqUsd != null && liqUsd > 0) {
              const prev = this.lastPositionLiquidityUsd.get(pos.mint);
              this.lastPositionLiquidityUsd.set(pos.mint, liqUsd);
              if (prev != null && prev > 0) {
                const dropPct = (1 - liqUsd / prev) * 100;
                const prevSolEst = prev / (price > 0 ? price * 150 : 1);
                const solDropEst = prevSolEst * (dropPct / 100);
                if (dropPct >= 20 && dropPct < 40 && solDropEst >= 5) {
                  logger.warn({ mint: pos.mint, symbol: pos.symbol, dropPct: dropPct.toFixed(1), solDropEst: solDropEst.toFixed(1) },
                    "Paper sniper: WHALE DUMP detected — emergency exit 🐋");
                  this.closePaperPosition(pos, `Whale dump: -${dropPct.toFixed(0)}% liquidity (~${solDropEst.toFixed(1)} SOL)`, price);
                  continue;
                }
              }
            }
          }

          const buysM5  = buysMap.get(pos.mint)  ?? 0;
          const sellsM5 = sellsMap.get(pos.mint) ?? 0;
          this.checkTpSl(pos, cfg, buysM5, sellsM5);
        }
      } catch { /* non-fatal */ }
    }

    this.updateUnrealizedPnl();
    this.broadcast();
  }

  private checkTpSl(pos: PaperPosition, cfg: PaperConfig, buysM5 = 0, sellsM5 = 0): void {
    if (pos.status !== "open") return;
    if (!pos.lastPriceAt || Date.now() - pos.lastPriceAt > STALE_PRICE_MS) return;

    const price = pos.currentPrice;
    const pct   = ((price / pos.entryPrice) - 1) * 100;
    const ageMs = Date.now() - pos.entryAt;
    const now   = Date.now();

    // ── TP1 ───────────────────────────────────────────────────────────────
    if (!pos.tp1Hit && pct >= cfg.tp1Pct) {
      const closeFrac   = cfg.tp1ClosePct / 100;
      const solReturned = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl         = solReturned - pos.sizeSol * closeFrac;
      pos.tp1Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp1RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac;
      pos.effectiveSlPrice  = pos.entryPrice; // breakeven SL immediately on TP1
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

    // ── TP3 — full close of remaining runner ──────────────────────────────
    if (pos.tp1Hit && pos.tp2Hit && !pos.tp3Hit && pct >= cfg.tp3Pct) {
      const closeFrac   = Math.min(cfg.tp3ClosePct / 100, 1) * pos.remainingFraction;
      const solReturned = pos.sizeSol * closeFrac * (price / pos.entryPrice);
      const pnl         = solReturned - pos.sizeSol * closeFrac;
      pos.tp3Hit            = true;
      pos.realizedPnlSol   += pnl;
      pos.tp3RealizedSol    = pnl;
      pos.remainingFraction -= closeFrac;
      this.virtualBalance  += solReturned;
      logger.info({ mint: pos.mint, symbol: pos.symbol, pct: pct.toFixed(1), pnl, solReturned, remainingFraction: pos.remainingFraction },
        "Paper sniper: TP3 hit 🎯🎯🎯");
      void this.persistPosition(pos);
      void this.persistBalance();
      if (isTelegramConfigured()) {
        void sendTelegram(
          `🎯🎯🎯 <b>PAPER TP3 HIT</b>\n` +
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
      // If tp3ClosePct = 100, the position is fully closed — close it now
      if (pos.remainingFraction <= 0.01) {
        this.closePaperPosition(pos, `TP3 hit — full exit at +${pct.toFixed(0)}%`, price);
      }
      return;
    }

    // ── Trailing stop (after TP1) ─────────────────────────────────────────
    if (pos.tp1Hit) {
      const trailPrice = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      pos.effectiveSlPrice = Math.max(pos.effectiveSlPrice, trailPrice);
    }

    // ── Sell pressure emergency exit (pre-TP1 only, enabled toggle) ──────────
    if (cfg.enableSellPressureExit && !pos.tp1Hit && !pos.tp2Hit && !pos.tp3Hit) {
      const hasSellPressure = sellsM5 > 0 && sellsM5 > buysM5 * 1.5;
      if (hasSellPressure) {
        if (!this.sellPressureStartAt.has(pos.mint)) {
          this.sellPressureStartAt.set(pos.mint, now);
        }
        const pressureMs = now - (this.sellPressureStartAt.get(pos.mint) ?? now);
        if (pressureMs >= 60_000) {
          logger.warn({ mint: pos.mint, symbol: pos.symbol, sellsM5, buysM5, pressureSec: (pressureMs / 1000).toFixed(0) },
            "Paper sniper: SELL PRESSURE >60s — emergency exit 🚨");
          this.sellPressureStartAt.delete(pos.mint);
          this.closePaperPosition(pos, `Sell pressure >60s (${sellsM5} sells vs ${buysM5} buys in 5m)`, price);
          return;
        }
      } else {
        if (this.sellPressureStartAt.has(pos.mint)) this.sellPressureStartAt.delete(pos.mint);
      }
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
    this.sellPressureStartAt.delete(pos.mint);
    this.lastPositionLiquidityUsd.delete(pos.mint);
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

  // Fetches the best live price for a token from DexScreener (highest-liquidity
  // AMM pair) with Jupiter as fallback. Used by enterPhase3Trade to guarantee
  // a realistic entry price at the moment Phase 3 fires.
  private async fetchLivePriceForPhase3(mint: string, fallbackPrice: number): Promise<number> {
    try {
      type DexPair = { baseToken?: { address: string }; priceUsd: string; liquidity?: { usd?: number }; dexId?: string };
      const res = await axios.get<DexPair[]>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
        { timeout: 5_000 },
      );
      const pairs = Array.isArray(res.data) ? res.data : [];
      let bestPrice = 0;
      let bestLiq = -1;
      for (const pair of pairs) {
        const p = parseFloat(pair.priceUsd);
        const liq = pair.liquidity?.usd ?? 0;
        if (p > 0 && liq > bestLiq) { bestPrice = p; bestLiq = liq; }
      }
      if (bestPrice > 0) {
        logger.info({ mint, price: bestPrice, source: "dexscreener" }, "Paper sniper [phase3]: live price fetched");
        return bestPrice;
      }
    } catch { /* fall through to Jupiter */ }

    try {
      type JupResp = { data: Record<string, { price: number }> };
      const res = await axios.get<JupResp>(
        `https://lite-api.jup.ag/price/v2?ids=${mint}`,
        { timeout: 4_000 },
      );
      const p = res.data?.data?.[mint]?.price;
      if (p && p > 0) {
        logger.info({ mint, price: p, source: "jupiter" }, "Paper sniper [phase3]: live price fetched (Jupiter fallback)");
        return p;
      }
    } catch { /* fall through to fallback */ }

    logger.warn({ mint, fallbackPrice }, "Paper sniper [phase3]: live price fetch failed — using signal price as fallback");
    return fallbackPrice;
  }

  // Called by the graduation sniper when Phase 3 triggers but the live wallet
  // is unavailable (or the live buy fails). Bypasses all graduation quality
  // checks — the 3-phase state machine already validated the setup.
  async enterPhase3Trade(
    mint: string,
    symbol: string,
    price: number,
    phase1PumpPct: number,
    phase2DumpPct: number,
    phase3RetracePct: number,
  ): Promise<void> {
    const cfg = this.paperConfig;

    if (this.openPositions.has(mint)) {
      logger.info({ mint, symbol }, "Paper sniper [phase3]: position already open, skipping");
      return;
    }

    const sizeSol = cfg.positionSizeSol;
    if (this.virtualBalance < sizeSol) {
      logger.warn({ mint, symbol, virtualBalance: this.virtualBalance, sizeSol },
        "Paper sniper [phase3]: insufficient paper balance, skipping");
      return;
    }

    // Fetch a fresh live price at the moment of entry for realistic execution
    const entryPrice = await this.fetchLivePriceForPhase3(mint, price);

    const now = Date.now();
    const pos: PaperPosition = {
      id:                `p3-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      mint,
      symbol,
      name:              symbol,
      detectedAt:        now,
      entryAt:           now,
      entryPrice:        entryPrice,
      currentPrice:      entryPrice,
      sizeSol,
      tp1Hit:            false,
      tp2Hit:            false,
      tp3Hit:            false,
      remainingFraction: 1.0,
      effectiveSlPrice:  entryPrice * (1 - cfg.slPhase1Pct / 100),
      trailingHigh:      entryPrice,
      status:            "open",
      realizedPnlSol:    0,
      unrealizedPnlSol:  0,
      totalPnlSol:       0,
      pnlPct:            0,
      tp1RealizedSol:    0,
      tp2RealizedSol:    0,
      tp3RealizedSol:    0,
      runnerRealizedSol: 0,
      detectionPrice:    entryPrice,
      entryDriftPct:     0,
      // Phase 3 dip-retrace entry context
      phase1PumpPct,
      dipDumpPct:        phase2DumpPct,
      dipRetracePct:     phase3RetracePct,
    };

    this.virtualBalance -= sizeSol;
    this.openPositions.set(mint, pos);
    this.seenMints.add(mint);

    void this.persistPosition(pos);
    void this.persistBalance();
    this.addEvent({ id: uid(), detectedAt: now, mint, symbol, action: "entered",
      phase1PumpPct, phase2DumpPct, phase3RetracePct, entryPrice });
    this.broadcast();

    logger.info(
      { mint, symbol, signalPrice: price, entryPrice, phase1PumpPct, phase2DumpPct, phase3RetracePct, sizeSol, virtualBalance: this.virtualBalance },
      "Paper sniper: PHASE 3 paper position entered 📄🎯",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `📄 <b>PAPER TRADE — PHASE 3 BUY</b>\n` +
        `🪙 <b>${symbol}</b>\n` +
        `📋 <code>${mint}</code>\n\n` +
        `📈 P1 pump:    <b>+${phase1PumpPct.toFixed(1)}%</b>\n` +
        `📉 P2 dump:    <b>-${phase2DumpPct.toFixed(1)}%</b>\n` +
        `🔄 P3 retrace: <b>+${phase3RetracePct.toFixed(1)}%</b>\n` +
        `💰 Entry: <b>${entryPrice.toFixed(8)}</b> · Size: <b>${sizeSol} SOL (paper)</b>\n` +
        `🔗 <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`
      );
    }
  }

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

  async updateHistoryPosition(id: string, updates: Partial<Pick<PaperPosition,
    "entryPrice" | "exitPrice" | "sizeSol" | "realizedPnlSol" | "closeReason" | "trailingHigh" | "detectionPrice"
  >>): Promise<PaperPosition | null> {
    const idx = this.closedPositions.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const pos = this.closedPositions[idx];
    const oldPnl = pos.realizedPnlSol;

    Object.assign(pos, updates);

    // Recalculate derived fields if prices changed
    if (updates.exitPrice !== undefined || updates.entryPrice !== undefined) {
      if (pos.exitPrice && pos.entryPrice) {
        pos.pnlPct      = ((pos.exitPrice / pos.entryPrice) - 1) * 100;
        pos.totalPnlSol = pos.realizedPnlSol;
      }
    }

    // Adjust live balance if realized PnL changed
    if (updates.realizedPnlSol !== undefined) {
      const delta = pos.realizedPnlSol - oldPnl;
      this.virtualBalance     += delta;
      this.allTimeRealizedSol += delta;
    }

    void this.persistPosition(pos);
    void this.persistBalance();
    this.broadcast();
    return { ...pos };
  }

  async deleteHistoryPosition(id: string): Promise<boolean> {
    const idx = this.closedPositions.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const pos = this.closedPositions.splice(idx, 1)[0];

    // Reverse the net balance impact of this closed trade
    this.virtualBalance     -= pos.realizedPnlSol;
    this.allTimeRealizedSol -= pos.realizedPnlSol;
    if (pos.realizedPnlSol >= 0) this.wins   = Math.max(0, this.wins   - 1);
    else                         this.losses  = Math.max(0, this.losses - 1);

    try {
      await execute(`DELETE FROM paper_sniper_positions WHERE id = $1`, [id]);
    } catch (err) {
      logger.warn({ err: (err as Error).message, id }, "Paper sniper: failed to delete position from DB");
    }

    void this.persistBalance();
    void this.persistStats();
    this.broadcast();
    return true;
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
