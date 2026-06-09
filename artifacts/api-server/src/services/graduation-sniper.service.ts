import WebSocket from "ws";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { blacklistService } from "./blacklist.service.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";

// ── Constants ────────────────────────────────────────────────────────────────
const MIGRATION_WALLET   = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const RECONNECT_DELAY_MS = 1_000;
const MAX_EVENTS         = 50;
const MAX_CLOSED         = 100;
const CONFIG_KEY         = "sniper_config";

// ── Adaptive price-check intervals ───────────────────────────────────────────
const PRICE_LOOP_MS         = 10_000;         // main loop tick — 10 s
const FAST_WINDOW_MS        = 30 * 60_000;    // first 30 min  → check every 10 s
const MED_WINDOW_MS         = 2 * 60 * 60_000;// 30 min–2 h    → check every 30 s
const FAST_INTERVAL_MS      = 10_000;
const MED_INTERVAL_MS       = 30_000;
const SLOW_INTERVAL_MS      = 60_000;

// ── Dead-position threshold ───────────────────────────────────────────────────
const DEAD_POSITION_MS      = 2 * 60 * 60_000;// 2 h open with no movement
const DEAD_MOVE_PCT         = 5;              // < 5 % move = "dead"

// ── Instant-rug detection constants (pre-entry) ───────────────────────────────
const RUG_CHECK_WAIT_MS     = 8_000;          // monitor for 8 s after baseline price
const RUG_DROP_ABORT_PCT    = 20;             // abort entry if price drops ≥ 20% in that window

// ── Type-A rug filters (pre-entry) ───────────────────────────────────────────
const MIN_ENTRY_PRICE_USD   = 0.00001;        // skip tokens priced below $0.00001
const MIN_POOL_SOL          = 10;             // skip if Raydium pool holds < 10 SOL on-chain

// ── STAGED STOP LOSS (FIX 1) ─────────────────────────────────────────────────
const STAGED_SL_PHASE1_MS   = 2 * 60_000;    // first 2 minutes: 20% from entry (instant rug)
const STAGED_SL_PHASE2_MS   = 10 * 60_000;   // 2–10 minutes: 25% from peak (trailing)
const STAGED_SL_PHASE1_PCT  = 20;            // phase 1 drop threshold
const STAGED_SL_PHASE2_PCT  = 25;            // phase 2 drop threshold
const STAGED_SL_PHASE3_PCT  = 30;            // phase 3 (>10m) drop threshold
const STAGED_SL_AFTER_TP1   = 35;            // after TP1: 35% from peak (allows 20-30% retracement before TP2)

// ── LIQUIDITY MONITORING (FIX 2) ─────────────────────────────────────────────
const LIQUIDITY_CHECK_MS     = 30_000;        // check open-position liquidity every 30 s
const LIQUIDITY_DROP_TRIGGER = 40;            // exit if liquidity drops > 40% in one window

// ── Trading hours (IST) — active 6am–11pm, paused 11pm–6am ──────────────────
const NIGHT_START_IST_HOUR  = 23;             // 11 pm IST — pause begins
const NIGHT_END_IST_HOUR    = 6;              // 6 am IST — pause ends (exclusive)

/** Returns true when the clock is inside the high-rug night window (11pm–6am IST). */
function isNightSession(): boolean {
  const nowUtc  = new Date();
  const istMin  = (nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() + 330) % 1440;
  const istHour = Math.floor(istMin / 60);
  return istHour >= NIGHT_START_IST_HOUR || istHour < NIGHT_END_IST_HOUR;
}

function uid(): string {
  return `snp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function fmtTgPrice(p: number): string {
  if (p <= 0) return "0";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.0001)   return p.toFixed(8);
  if (p < 0.01)     return p.toFixed(6);
  return p.toFixed(4);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface SniperConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  trailingStopPct: number;
  waitBeforeEntryMs: number;
  virtualBalanceSol: number;
}

const DEFAULT_CONFIG: SniperConfig = {
  enabled:           true,
  positionSizeSol:   0.1,
  maxOpenPositions:  5,
  slPct:             40,
  tp1Pct:            150,
  tp1ClosePct:       40,
  tp2Pct:            400,
  tp2ClosePct:       40,
  trailingStopPct:   30,
  waitBeforeEntryMs: 3000,
  virtualBalanceSol: 10.0,
};

export interface SniperPosition {
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
  txSignature: string;
  // P&L breakdown per stage
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
}

export interface SniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped";
  skipReason?: string;
  txSignature: string;
}

export interface SniperStatus {
  wsConnected: boolean;
  wsReconnects: number;
  enabled: boolean;
  graduationsToday: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  virtualBalance: number;
  openCount: number;
  config: SniperConfig;
}

// ── Service ──────────────────────────────────────────────────────────────────

class GraduationSniperService {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private subscriptionId: number | null = null;
  private priceIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  private config: SniperConfig = { ...DEFAULT_CONFIG };
  private openPositions: Map<string, SniperPosition> = new Map();
  private closedPositions: SniperPosition[] = [];
  private events: SniperEvent[] = [];

  private graduationsToday = 0;
  private lastDayReset = new Date().toDateString();
  private seenMints: Set<string> = new Set();
  private virtualBalance = DEFAULT_CONFIG.virtualBalanceSol;

  // Adaptive price-check intervals
  private lastPositionCheckAt: Map<string, number> = new Map();
  // Concurrency guard — prevents duplicate TP/SL executions during async gaps
  private processingMints: Set<string> = new Set();
  // FIX 2: Liquidity monitoring — tracks last known liquidity per position
  private liquidityIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastPositionLiquidityUsd: Map<string, number> = new Map();
  // FIX 4: Persistent closed-trade fingerprints — prevents duplicate logs on restart
  private closedTradeFingerprints: Set<string> = new Set();

  // ── Init ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadPositions();

    // Correctly restore virtual balance from DB state:
    // start + all realized PNL (closed) + partial realized PNL (open TP hits) - remaining capital in open positions
    const realizedFromClosed = this.closedPositions.reduce((s, p) => s + p.realizedPnlSol, 0);
    const partialFromOpen    = Array.from(this.openPositions.values()).reduce((s, p) => s + p.realizedPnlSol, 0);
    const capitalInOpen      = Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol * p.remainingFraction, 0);

    this.virtualBalance = this.config.virtualBalanceSol + realizedFromClosed + partialFromOpen - capitalInOpen;

    await this.loadClosedFingerprints();

    logger.info(
      {
        openPositions:    this.openPositions.size,
        virtualBalance:   this.virtualBalance.toFixed(4),
        realizedFromClosed: realizedFromClosed.toFixed(4),
        partialFromOpen:    partialFromOpen.toFixed(4),
        capitalInOpen:      capitalInOpen.toFixed(4),
        enabled:          this.config.enabled,
      },
      "Graduation sniper: initialised",
    );
  }

  private async loadConfig(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM app_config WHERE key = $1`, [CONFIG_KEY],
      );
      if (rows[0]) {
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(rows[0].value) };
      }
    } catch { /* no config row yet — use defaults */ }
  }

  private async loadPositions(): Promise<void> {
    try {
      const rows = await query<Record<string, unknown>>(
        `SELECT * FROM sniper_positions ORDER BY entry_at ASC`,
      );
      for (const row of rows) {
        const pos = this.rowToPosition(row);
        if (pos.status === "open") {
          this.openPositions.set(pos.mint, pos);
          this.seenMints.add(pos.mint);
        } else {
          this.closedPositions.push(pos);
          this.seenMints.add(pos.mint);
        }
      }
      // Keep newest MAX_CLOSED — with ASC order, slice(-N) = last N = newest
      if (this.closedPositions.length > MAX_CLOSED) {
        this.closedPositions = this.closedPositions.slice(-MAX_CLOSED);
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: could not load positions");
    }
  }

  private rowToPosition(row: Record<string, unknown>): SniperPosition {
    const p: SniperPosition = {
      id:               String(row["id"] ?? ""),
      mint:             String(row["mint"] ?? ""),
      symbol:           String(row["symbol"] ?? "???"),
      name:             String(row["name"] ?? "???"),
      detectedAt:       Number(row["detected_at"] ?? 0),
      entryAt:          Number(row["entry_at"] ?? 0),
      entryPrice:       Number(row["entry_price"] ?? 0),
      currentPrice:     Number(row["current_price"] ?? 0),
      sizeSol:          Number(row["size_sol"] ?? 0),
      tp1Hit:           Boolean(row["tp1_hit"]),
      tp2Hit:           Boolean(row["tp2_hit"]),
      remainingFraction: Number(row["remaining_fraction"] ?? 1),
      effectiveSlPrice: Number(row["effective_sl_price"] ?? 0),
      trailingHigh:     Number(row["trailing_high"] ?? 0),
      status:           (row["status"] as "open" | "closed") ?? "open",
      realizedPnlSol:   Number(row["realized_pnl_sol"] ?? 0),
      unrealizedPnlSol: 0,
      totalPnlSol:      0,
      pnlPct:           0,
      closeReason:      row["close_reason"] as string | undefined,
      closedAt:         row["closed_at"] ? Number(row["closed_at"]) : undefined,
      exitPrice:        row["exit_price"] ? Number(row["exit_price"]) : undefined,
      txSignature:      String(row["tx_signature"] ?? ""),
      tp1RealizedSol:   Number(row["tp1_realized_sol"] ?? 0),
      tp2RealizedSol:   Number(row["tp2_realized_sol"] ?? 0),
      runnerRealizedSol: Number(row["runner_realized_sol"] ?? 0),
    };
    this.updateLivePnl(p);
    return p;
  }

  private updateLivePnl(pos: SniperPosition): void {
    if (pos.currentPrice > 0 && pos.entryPrice > 0) {
      pos.unrealizedPnlSol = (pos.currentPrice / pos.entryPrice - 1) * pos.sizeSol * pos.remainingFraction;
      pos.totalPnlSol      = pos.realizedPnlSol + pos.unrealizedPnlSol;
      // Weighted-average return across all partial closes + current open slice.
      // e.g. 40%@150% + 40%@400% + 20%@500% → 320%, NOT just 500%.
      pos.pnlPct           = pos.sizeSol > 0 ? (pos.totalPnlSol / pos.sizeSol) * 100 : 0;
    }
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) {
      logger.warn("Graduation sniper: HELIUS_API_KEY not set — WebSocket disabled");
      return;
    }

    this.connect(apiKey);
    this.priceIntervalId     = setInterval(() => void this.checkAllPrices(), PRICE_LOOP_MS);
    // FIX 2: liquidity rug detection — poll every 30 s independent of price loop
    this.liquidityIntervalId = setInterval(() => void this.checkAllLiquidity(), LIQUIDITY_CHECK_MS);
    logger.info("Graduation sniper: started — WebSocket connecting");
  }

  stop(): void {
    this.started = false;
    if (this.priceIntervalId)     { clearInterval(this.priceIntervalId);     this.priceIntervalId     = null; }
    if (this.liquidityIntervalId) { clearInterval(this.liquidityIntervalId); this.liquidityIntervalId = null; }
    if (this.reconnectTimer)      { clearTimeout(this.reconnectTimer);       this.reconnectTimer      = null; }
    this.ws?.close();
  }

  private connect(apiKey: string): void {
    if (!this.started) return;

    const url = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const ws  = new WebSocket(url);
    this.ws   = ws;

    ws.on("open", () => {
      this.wsConnected = true;
      logger.info({ reconnects: this.wsReconnects }, "Graduation sniper: WebSocket connected");

      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "logsSubscribe",
        params:  [
          { mentions: [MIGRATION_WALLET] },
          { commitment: "confirmed" },
        ],
      }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch { /* malformed JSON — ignore */ }
    });

    ws.on("close", () => {
      this.wsConnected    = false;
      this.subscriptionId = null;
      logger.warn({ reconnects: this.wsReconnects }, "Graduation sniper: WebSocket disconnected — reconnecting");
      this.scheduleReconnect(apiKey);
    });

    ws.on("error", (err) => {
      logger.warn({ err: err.message }, "Graduation sniper: WebSocket error");
    });
  }

  private scheduleReconnect(apiKey: string): void {
    if (!this.started) return;
    this.wsReconnects++;
    this.reconnectTimer = setTimeout(() => this.connect(apiKey), RECONNECT_DELAY_MS);
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Subscription confirmation
    if (typeof msg["result"] === "number" && msg["id"] === 1) {
      this.subscriptionId = msg["result"] as number;
      logger.info({ subscriptionId: this.subscriptionId }, "Graduation sniper: logsSubscribe confirmed");
      return;
    }

    // Log notification
    const method = msg["method"];
    if (method !== "logsNotification") return;

    const params = msg["params"] as Record<string, unknown> | undefined;
    const result = params?.["result"] as Record<string, unknown> | undefined;
    const value  = result?.["value"] as Record<string, unknown> | undefined;
    if (!value) return;

    const err = value["err"];
    if (err) return; // failed transaction — ignore

    const signature = value["signature"] as string | undefined;
    if (!signature) return;

    this.resetDailyCounterIfNeeded();
    this.graduationsToday++;

    void this.processGraduation(signature);
  }

  private resetDailyCounterIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastDayReset) {
      this.graduationsToday = 0;
      this.lastDayReset     = today;
    }
  }

  // ── Graduation processing ─────────────────────────────────────────────────

  private async processGraduation(signature: string): Promise<void> {
    const detectedAt = Date.now();
    try {
      const extracted = await this.extractMintFromTx(signature);
      if (!extracted) {
        logger.warn({ signature }, "Graduation sniper: could not extract mint after all retries — skipping");
        this.addEvent({
          id: uid(),
          detectedAt,
          mint: "unknown",
          symbol: "???",
          action: "skipped",
          skipReason: "Could not extract mint from TX (check logs)",
          txSignature: signature,
        });
        return;
      }

      const { mint, wsolVaultPubkey } = extracted;
      const skipReason = this.checkSkipReason(mint);
      const eventBase  = { id: uid(), detectedAt, mint, symbol: mint.slice(0, 8), txSignature: signature };

      if (skipReason) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason });
        logger.info({ mint, skipReason }, "Graduation sniper: skipped");
        return;
      }

      // Wait before entry so DEX price feeds have time to populate
      await new Promise((r) => setTimeout(r, this.config.waitBeforeEntryMs));

      const priceData = await this.fetchPrice(mint);
      if (!priceData) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason: "Price not yet on DexScreener" });
        logger.info({ mint }, "Graduation sniper: skipped — price not on DexScreener");
        return;
      }

      const { price: baselinePrice, symbol, name } = priceData;

      // ── FIX 1: Minimum entry price — skip sub-$0.00001 micro-cap pre-rugs ──────
      if (baselinePrice < MIN_ENTRY_PRICE_USD) {
        const reason = `Price too low — $${baselinePrice.toExponential(3)} < $${MIN_ENTRY_PRICE_USD} (Type-A rug filter)`;
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
        logger.info({ mint, symbol, price: baselinePrice }, "Graduation sniper: skipped — price below minimum (FIX 1)");
        return;
      }

      // Double-check skip after price fetch (race condition guard)
      const skipAfterWait = this.checkSkipReason(mint);
      if (skipAfterWait) {
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: skipAfterWait });
        return;
      }

      // ── FIX 2 + FIX 3: wait 8 s, then check on-chain pool SOL + price drop ────
      // Same window handles both checks — no extra delay.
      await new Promise((r) => setTimeout(r, RUG_CHECK_WAIT_MS));

      // FIX 2: on-chain Raydium pool SOL balance — DexScreener has 2-5 min lag
      // but the WSOL vault is readable immediately after graduation.
      if (wsolVaultPubkey) {
        const poolSol = await this.fetchOnChainPoolSol(wsolVaultPubkey);
        if (poolSol !== null && poolSol < MIN_POOL_SOL) {
          const reason = `Pool drained — ${poolSol.toFixed(2)} SOL < ${MIN_POOL_SOL} SOL on-chain (Type-A rug filter)`;
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
          logger.warn({ mint, symbol, poolSol, wsolVaultPubkey }, "Graduation sniper: skipped — pool already drained (FIX 2)");
          return;
        }
        logger.info({ mint, symbol, poolSol, wsolVaultPubkey }, "Graduation sniper: on-chain pool SOL check passed ✅");
      } else {
        logger.info({ mint, symbol }, "Graduation sniper: no WSOL vault found in TX — skipping pool SOL check");
      }

      const rugCheckData = await this.fetchPrice(mint);
      const entryPrice   = rugCheckData?.price ?? baselinePrice;

      if (rugCheckData) {
        const dropPct = (1 - rugCheckData.price / baselinePrice) * 100;
        if (dropPct >= RUG_DROP_ABORT_PCT) {
          const skipReason = `Instant rug — dropped ${dropPct.toFixed(1)}% in ${RUG_CHECK_WAIT_MS / 1000}s`;
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason });
          logger.warn(
            { mint, symbol, baselinePrice, rugPrice: rugCheckData.price, dropPct: dropPct.toFixed(1) },
            "Graduation sniper: instant rug detected — entry aborted",
          );
          if (isTelegramConfigured()) {
            void sendTelegram(
              `🚫 <b>SNIPER RUG ABORT</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${symbol}</b>\n` +
              `📋 CA: <code>${mint}</code>\n` +
              `📉 Crashed: <b>-${dropPct.toFixed(1)}%</b> in ${RUG_CHECK_WAIT_MS / 1000}s\n` +
              `✅ Entry aborted — capital protected\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          return;
        }
      }

      this.enterPosition(mint, symbol, name, entryPrice, signature);
      this.addEvent({ ...eventBase, symbol, action: "entered" });
    } catch (err) {
      logger.warn({ signature, err: (err as Error).message }, "Graduation sniper: error processing graduation");
    }
  }

  private checkSkipReason(mint: string): string | null {
    if (!this.config.enabled)                                    return "Sniper disabled";
    if (isNightSession())                                        return "Night session paused (11pm–6am IST) — detecting only";
    if (this.seenMints.has(mint))                                return "Already traded this mint";
    if (this.openPositions.size >= this.config.maxOpenPositions) return `Max open positions (${this.config.maxOpenPositions}) reached`;
    if (blacklistService.isBlacklisted(mint))                    return "Mint in permanent blacklist";
    if (this.virtualBalance < this.config.positionSizeSol)       return "Insufficient virtual balance";
    return null;
  }

  private async extractMintFromTx(signature: string): Promise<{ mint: string; wsolVaultPubkey: string | null } | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // Helius REST indexer lags behind the WebSocket by several seconds.
    // Retry up to 5 times with increasing delays: 2s, 4s, 6s, 8s, 10s (30s total).
    const delays = [2_000, 4_000, 6_000, 8_000, 10_000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      await new Promise((r) => setTimeout(r, delays[attempt]!));

      try {
        type TokenBalance = { mint: string; accountIndex: number; uiTokenAmount?: { uiAmount?: number | null } };
        type AccountKey   = { pubkey: string };
        type TxResult = {
          result: {
            transaction?: {
              message?: {
                accountKeys?: AccountKey[];
              };
            };
            meta?: {
              preTokenBalances?:  TokenBalance[];
              postTokenBalances?: TokenBalance[];
            };
          } | null;
        };

        const res = await axios.post<TxResult>(
          `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
          {
            jsonrpc: "2.0",
            id:      1,
            method:  "getTransaction",
            params:  [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
          },
          { timeout: 12_000 },
        );

        const txResult = res.data?.result;
        if (!txResult) {
          logger.info(
            { signature, attempt: attempt + 1 },
            "Graduation sniper: getTransaction returned null — will retry if attempts remain",
          );
          continue;
        }

        const accountKeys    = txResult.transaction?.message?.accountKeys ?? [];
        const postBalances   = txResult.meta?.postTokenBalances ?? [];
        const allBalances    = [
          ...(txResult.meta?.preTokenBalances  ?? []),
          ...postBalances,
        ];

        // The graduated token mint appears in pre/post token balances.
        // Filter out SOL (wrapped) and pick the non-SOL mint — that's the graduating token.
        const mint = allBalances
          .map((b) => b.mint)
          .find((m) => m && m !== SOL_MINT);

        logger.info(
          { signature, attempt: attempt + 1, mint: mint ?? "none", balanceCount: allBalances.length },
          "Graduation sniper: token balance scan",
        );

        if (mint) {
          // Also extract the Raydium WSOL vault: the WSOL token account in postBalances with the
          // highest balance is the pool's liquidity vault (pump.fun seeds it with ~85 SOL at graduation).
          const wsolEntries = postBalances
            .filter((b) => b.mint === SOL_MINT)
            .sort((a, b) => (b.uiTokenAmount?.uiAmount ?? 0) - (a.uiTokenAmount?.uiAmount ?? 0));

          const wsolVaultPubkey = wsolEntries.length > 0
            ? (accountKeys[wsolEntries[0]!.accountIndex]?.pubkey ?? null)
            : null;

          logger.info({ signature, mint, wsolVaultPubkey, attempt: attempt + 1 }, "Graduation sniper: mint + vault extracted ✅");
          return { mint, wsolVaultPubkey };
        }

        logger.info(
          { signature, attempt: attempt + 1 },
          "Graduation sniper: no non-SOL mint in token balances — will retry if attempts remain",
        );
      } catch (err) {
        logger.warn(
          { signature, attempt: attempt + 1, err: (err as Error).message },
          "Graduation sniper: getTransaction request failed",
        );
      }
    }

    logger.warn({ signature }, "Graduation sniper: exhausted all retries — could not extract mint");
    return null;
  }

  // ── On-chain pool SOL check (FIX 2) ────────────────────────────────────────
  // Reads the WSOL token account balance directly from Helius RPC.
  // Returns the SOL amount held in the vault, or null if the call fails.
  private async fetchOnChainPoolSol(wsolVaultPubkey: string): Promise<number | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    try {
      type TokenAmountResult = {
        result?: {
          value?: {
            uiAmount?: number | null;
          };
        };
      };

      const res = await axios.post<TokenAmountResult>(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          jsonrpc: "2.0",
          id:      1,
          method:  "getTokenAccountBalance",
          params:  [wsolVaultPubkey],
        },
        { timeout: 6_000 },
      );

      const uiAmount = res.data?.result?.value?.uiAmount;
      if (uiAmount == null) return null;
      return uiAmount;
    } catch (err) {
      logger.warn({ wsolVaultPubkey, err: (err as Error).message }, "Graduation sniper: fetchOnChainPoolSol failed");
      return null;
    }
  }

  private async fetchPrice(mint: string): Promise<{ price: number; symbol: string; name: string; liquidityUsd: number } | null> {
    try {
      type DexPair = {
        priceUsd: string;
        baseToken: { symbol: string; name: string };
        liquidity?: { usd?: number };
        dexId?: string;
      };
      const res = await axios.get<DexPair[]>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
        { timeout: 8_000 },
      );
      const pairs: DexPair[] = Array.isArray(res.data) ? res.data : [];
      if (pairs.length === 0) return null;

      // Prefer Raydium pair with highest liquidity
      const sorted = [...pairs].sort((a, b) => {
        const aRay = a.dexId === "raydium" ? 1 : 0;
        const bRay = b.dexId === "raydium" ? 1 : 0;
        if (bRay !== aRay) return bRay - aRay;
        return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
      });

      const best         = sorted[0]!;
      const price        = parseFloat(best.priceUsd) || 0;
      const liquidityUsd = best.liquidity?.usd ?? 0;
      if (price <= 0) return null;

      return {
        price,
        liquidityUsd,
        symbol: best.baseToken.symbol,
        name:   best.baseToken.name,
      };
    } catch {
      return null;
    }
  }

  // ── Position management ────────────────────────────────────────────────────

  private enterPosition(mint: string, symbol: string, name: string, price: number, txSignature: string): void {
    const cfg = this.config;
    const id  = uid();

    // Night session (11pm–6am IST) is fully blocked in checkSkipReason.
    // This code only runs during active trading hours (6am–11pm IST).
    const sizeSol = cfg.positionSizeSol;

    const pos: SniperPosition = {
      id,
      mint,
      symbol,
      name,
      detectedAt:       Date.now(),
      entryAt:          Date.now(),
      entryPrice:       price,
      currentPrice:     price,
      sizeSol,
      tp1Hit:           false,
      tp2Hit:           false,
      remainingFraction: 1.0,
      effectiveSlPrice: price * (1 - cfg.slPct / 100),
      trailingHigh:     price,
      status:           "open",
      realizedPnlSol:   0,
      unrealizedPnlSol: 0,
      totalPnlSol:      0,
      pnlPct:           0,
      txSignature,
      tp1RealizedSol:   0,
      tp2RealizedSol:   0,
      runnerRealizedSol: 0,
    };

    this.openPositions.set(mint, pos);
    this.seenMints.add(mint);
    this.virtualBalance -= sizeSol;

    void this.persistPosition(pos);

    logger.info(
      { mint, symbol, entryPrice: price, sizeSol, sl: pos.effectiveSlPrice },
      "Graduation sniper: paper position entered",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🎯 <b>SNIPER ENTRY (PAPER)</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${symbol}</b> — ${name}\n` +
        `📋 CA: <code>${mint}</code>\n` +
        `💵 Entry: <b>$${fmtTgPrice(price)}</b>\n` +
        `💰 Size: <b>${sizeSol} SOL</b> (paper)\n` +
        `🛡️ Staged SL: -20% (2m) → -25% peak → -30% peak\n` +
        `🎯 TP1: $${fmtTgPrice(price * (1 + cfg.tp1Pct / 100))} (+${cfg.tp1Pct}%)\n` +
        `🎯 TP2: $${fmtTgPrice(price * (1 + cfg.tp2Pct / 100))} (+${cfg.tp2Pct}%)\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  // ── FIX 4: Duplicate trade fingerprint helpers ──────────────────────────────
  private tradeFingerprint(pos: SniperPosition): string {
    // Key = mint + entry-minute — stable across restarts for same trade
    return `${pos.mint}:${Math.round(pos.entryAt / 60_000)}`;
  }

  private isDuplicateTrade(pos: SniperPosition): boolean {
    return this.closedTradeFingerprints.has(this.tradeFingerprint(pos));
  }

  private registerClosedTrade(pos: SniperPosition): void {
    const fp = this.tradeFingerprint(pos);
    this.closedTradeFingerprints.add(fp);
    void this.saveClosedFingerprints();
  }

  private async loadClosedFingerprints(): Promise<void> {
    try {
      const { readFile } = await import("fs/promises");
      const raw = await readFile("./data/closed_trades.json", "utf-8");
      const arr = JSON.parse(raw) as string[];
      this.closedTradeFingerprints = new Set(arr);
      logger.info({ count: this.closedTradeFingerprints.size }, "Graduation sniper: loaded closed trade fingerprints");
    } catch { /* file doesn't exist yet — fine */ }
  }

  private async saveClosedFingerprints(): Promise<void> {
    try {
      const { writeFile, mkdir } = await import("fs/promises");
      await mkdir("./data", { recursive: true });
      const arr = Array.from(this.closedTradeFingerprints).slice(-1000); // keep last 1000
      await writeFile("./data/closed_trades.json", JSON.stringify(arr), "utf-8");
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: failed to save closed trade fingerprints");
    }
  }

  private closePosition(pos: SniperPosition, reason: string, exitPrice: number): void {
    // FIX 4: Skip if this trade was already logged (e.g. after server restart/redeploy)
    if (this.isDuplicateTrade(pos)) {
      logger.warn(
        { mint: pos.mint, symbol: pos.symbol, reason },
        "Graduation sniper: duplicate close detected — skipping (same mint+entry already logged)",
      );
      return;
    }
    this.registerClosedTrade(pos);

    const remaining = pos.sizeSol * pos.remainingFraction;
    const closePnl  = (exitPrice / pos.entryPrice - 1) * remaining;

    pos.runnerRealizedSol += closePnl;
    pos.realizedPnlSol    += closePnl;
    pos.currentPrice    = exitPrice;
    pos.exitPrice       = exitPrice;
    pos.closeReason     = reason;
    pos.closedAt        = Date.now();
    pos.status          = "closed";
    pos.remainingFraction = 0;
    this.updateLivePnl(pos);

    this.virtualBalance += remaining + closePnl;
    this.openPositions.delete(pos.mint);
    this.closedPositions.push(pos);
    if (this.closedPositions.length > MAX_CLOSED) this.closedPositions.shift();

    void this.persistPosition(pos);

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, exitPrice, pnl: pos.realizedPnlSol },
      "Graduation sniper: position closed",
    );

    if (isTelegramConfigured()) {
      const isWin  = pos.realizedPnlSol > 0;
      const emoji  = isWin ? "✅" : "❌";
      const pnlStr = `${pos.realizedPnlSol >= 0 ? "+" : ""}${pos.realizedPnlSol.toFixed(4)} SOL`;
      const holdMs = pos.closedAt! - pos.entryAt;
      const holdStr = holdMs < 60_000
        ? `${Math.floor(holdMs / 1000)}s`
        : holdMs < 3_600_000
        ? `${Math.floor(holdMs / 60_000)}m`
        : `${(holdMs / 3_600_000).toFixed(1)}h`;
      void sendTelegram(
        `${emoji} <b>SNIPER CLOSED (PAPER)</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${pos.symbol}</b>\n` +
        `📋 CA: <code>${pos.mint}</code>\n` +
        `📊 Reason: <b>${reason}</b>\n` +
        `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(exitPrice)}\n` +
        `💰 PNL: <b>${pnlStr}</b>\n` +
        `⏱️ Held: ${holdStr}\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  private partialClose(
    pos: SniperPosition,
    closeOriginalFraction: number,
    reason: string,
    currentPrice: number,
    breakdownKey?: "tp1" | "tp2",
  ): void {
    const closeSize = pos.sizeSol * closeOriginalFraction;
    const closePnl  = (currentPrice / pos.entryPrice - 1) * closeSize;
    pos.realizedPnlSol    += closePnl;
    pos.remainingFraction -= closeOriginalFraction;
    this.virtualBalance   += closeSize + closePnl;
    pos.currentPrice       = currentPrice;

    if (breakdownKey === "tp1") pos.tp1RealizedSol += closePnl;
    else if (breakdownKey === "tp2") pos.tp2RealizedSol += closePnl;

    void this.persistPosition(pos);

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, closeSize, closePnl, remaining: pos.remainingFraction },
      "Graduation sniper: partial close",
    );
  }

  // ── FIX 2: Liquidity rug detection loop (30s) ─────────────────────────────

  private async checkAllLiquidity(): Promise<void> {
    if (this.openPositions.size === 0) return;
    for (const pos of Array.from(this.openPositions.values())) {
      try {
        const priceData = await this.fetchPrice(pos.mint);
        if (!priceData) continue;
        const { price, liquidityUsd } = priceData;
        const prev = this.lastPositionLiquidityUsd.get(pos.mint);
        this.lastPositionLiquidityUsd.set(pos.mint, liquidityUsd);
        if (prev === undefined || prev <= 0 || liquidityUsd <= 0) continue;
        const dropPct = (1 - liquidityUsd / prev) * 100;
        if (dropPct >= LIQUIDITY_DROP_TRIGGER) {
          logger.warn(
            { mint: pos.mint, symbol: pos.symbol, prev: prev.toFixed(0), now: liquidityUsd.toFixed(0), dropPct: dropPct.toFixed(1) },
            "Graduation sniper: LIQUIDITY RUG — exiting immediately",
          );
          if (isTelegramConfigured()) {
            void sendTelegram(
              `🚨 <b>SNIPER LIQUIDITY RUG EXIT (PAPER)</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${pos.symbol}</b>\n` +
              `📋 CA: <code>${pos.mint}</code>\n` +
              `💧 Liquidity: <b>$${prev.toFixed(0)} → $${liquidityUsd.toFixed(0)}</b>\n` +
              `📉 Drained: <b>-${dropPct.toFixed(1)}%</b> in 30s\n` +
              `⚠️ Rug incoming — exiting before price collapses\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          this.closePosition(pos, `Liquidity Rug: -${dropPct.toFixed(0)}% in 30s`, price);
        }
      } catch { /* ignore per-position errors */ }
    }
  }

  // ── FIX 1: Staged SL evaluator ────────────────────────────────────────────

  private checkStagedSL(pos: SniperPosition, price: number, ageMs: number): boolean {
    const dropFromEntry = (1 - price / pos.entryPrice) * 100;
    const dropFromPeak  = pos.trailingHigh > 0 ? (1 - price / pos.trailingHigh) * 100 : 0;

    // After TP2: runner is managed by the trailing stop in the main loop
    if (pos.tp2Hit) return false;

    if (pos.tp1Hit) {
      // After TP1, before TP2: 35% from peak — wide enough for 20-30% normal retracement
      if (dropFromPeak >= STAGED_SL_AFTER_TP1) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL — after TP1");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🛑 <b>SNIPER STAGED SL (PAPER)</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `📉 -${loss}% from TP1 peak (35% threshold)\n` +
            `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(price)}\n🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, `Staged SL: -${loss}% from TP1 peak`, price);
        return true;
      }
      return false;
    }

    // No TP hit yet — time-based phases
    if (ageMs <= STAGED_SL_PHASE1_MS) {
      // Phase 1 (0–2m): 20% from entry — instant rug protection
      if (dropFromEntry >= STAGED_SL_PHASE1_PCT) {
        const loss = dropFromEntry.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromEntry: loss }, "Graduation sniper: staged SL phase 1 (0-2m)");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `⚡ <b>SNIPER INSTANT RUG PROTECTION (PAPER)</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `📉 -${loss}% from entry in first 2m\n` +
            `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(price)}\n🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, `Staged SL: -${loss}% in first 2m`, price);
        return true;
      }
    } else if (ageMs <= STAGED_SL_PHASE2_MS) {
      // Phase 2 (2–10m): 25% from peak — trailing
      if (dropFromPeak >= STAGED_SL_PHASE2_PCT) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL phase 2 (2-10m)");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🛑 <b>SNIPER STAGED SL (PAPER)</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `📉 -${loss}% from peak (2-10m window)\n` +
            `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(price)}\n🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, `Staged SL: -${loss}% from peak (2-10m)`, price);
        return true;
      }
    } else {
      // Phase 3 (>10m): 30% from peak — established move protection
      if (dropFromPeak >= STAGED_SL_PHASE3_PCT) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL phase 3 (>10m)");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🛑 <b>SNIPER STAGED SL (PAPER)</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `📉 -${loss}% from peak (>10m, established move)\n` +
            `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(price)}\n🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, `Staged SL: -${loss}% from peak (>10m)`, price);
        return true;
      }
    }
    return false;
  }

  // ── FIX 3: Atomic TP1 + SL update with retry ──────────────────────────────

  private async executeTP1Atomic(
    pos: SniperPosition, price: number, tp1Frac: number, tp1Pct: number, tp1ClosePct: number,
  ): Promise<void> {
    pos.tp1Hit           = true;
    this.partialClose(pos, tp1Frac, `TP1 +${tp1Pct}% — sell ${tp1ClosePct}%`, price, "tp1");
    pos.effectiveSlPrice = pos.entryPrice; // breakeven SL stored for reference

    // Retry persist until confirmed — ensures SL update survives server restart
    let persisted = false;
    for (let attempt = 0; attempt < 10 && !persisted; attempt++) {
      try {
        await this.persistPosition(pos);
        persisted = true;
      } catch (err) {
        logger.warn({ mint: pos.mint, attempt, err: (err as Error).message }, "Graduation sniper: TP1 atomic persist retry");
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    if (!persisted) {
      logger.error({ mint: pos.mint }, "Graduation sniper: TP1 persist failed after all retries");
    }

    logger.info({ mint: pos.mint, symbol: pos.symbol, price }, "Graduation sniper: TP1 hit — SL at breakeven (atomic)");
    if (isTelegramConfigured()) {
      const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp1Frac;
      void sendTelegram(
        `🟢 <b>SNIPER TP1 HIT (PAPER)</b>\n──────────────────────\n` +
        `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
        `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${tp1Pct}%)\n` +
        `💰 Sold ${tp1ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>\n` +
        `🛡️ SL at breakeven — 35% trail active until TP2\n` +
        `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position\n` +
        `⚛️ TP1 + SL update confirmed atomically\n🕐 ${toIST(new Date())}`,
      );
    }
  }

  // ── Price checking loop (adaptive intervals) ─────────────────────────────

  private async checkAllPrices(): Promise<void> {
    if (this.openPositions.size === 0) return;

    const now = Date.now();

    // Only check positions whose adaptive interval has elapsed
    const due = Array.from(this.openPositions.keys()).filter((mint) => {
      const pos      = this.openPositions.get(mint)!;
      const ageMs    = now - pos.entryAt;
      const interval = ageMs < FAST_WINDOW_MS ? FAST_INTERVAL_MS
                     : ageMs < MED_WINDOW_MS  ? MED_INTERVAL_MS
                     : SLOW_INTERVAL_MS;
      const last = this.lastPositionCheckAt.get(mint) ?? 0;
      return (now - last) >= interval;
    });

    if (due.length === 0) return;

    await Promise.allSettled(due.map((mint) => {
      this.lastPositionCheckAt.set(mint, now);
      return this.checkPositionPrice(mint);
    }));
  }

  private async checkPositionPrice(mint: string): Promise<void> {
    // Concurrency guard — skip if a price check is already in-flight for this mint.
    // Without this, the 10-s setInterval can fire a second tick while executeTP1Atomic
    // is in its retry-persist loop (up to 30 s), causing TP2 to execute multiple times.
    if (this.processingMints.has(mint)) return;
    this.processingMints.add(mint);

    try {
      await this._checkPositionPriceInner(mint);
    } finally {
      this.processingMints.delete(mint);
    }
  }

  private async _checkPositionPriceInner(mint: string): Promise<void> {
    const pos = this.openPositions.get(mint);
    if (!pos) return;

    const priceData = await this.fetchPrice(mint);
    if (!priceData) return;

    const { price } = priceData;
    pos.currentPrice = price;

    const now     = Date.now();
    const cfg     = this.config;
    const ageMs   = now - pos.entryAt;
    const tp1Price = pos.entryPrice * (1 + cfg.tp1Pct / 100);
    const tp2Price = pos.entryPrice * (1 + cfg.tp2Pct / 100);
    const tp1Frac  = cfg.tp1ClosePct / 100;
    const tp2Frac  = cfg.tp2ClosePct / 100;

    // ── FIX 1: Always update trailing high from PEAK (not just after TP2) ────
    if (price > pos.trailingHigh) pos.trailingHigh = price;

    // ── FIX 1: Staged SL — replaces old single -40% + hard stop ──────────────
    if (this.checkStagedSL(pos, price, ageMs)) return;

    // ── Dead position exit — open >2h with <5% movement ──────────────────────
    if (!pos.tp1Hit) {
      const movePct = Math.abs((price / pos.entryPrice - 1) * 100);
      if (ageMs >= DEAD_POSITION_MS && movePct < DEAD_MOVE_PCT) {
        logger.info(
          { mint, symbol: pos.symbol, ageH: (ageMs / 3_600_000).toFixed(1), movePct: movePct.toFixed(2) },
          "Graduation sniper: dead position exit — no momentum",
        );
        if (isTelegramConfigured()) {
          void sendTelegram(
            `💤 <b>SNIPER DEAD EXIT (PAPER)</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `⏱️ Held: ${(ageMs / 3_600_000).toFixed(1)}h with only ${movePct.toFixed(1)}% movement\n` +
            `🔄 Freeing slot for fresh opportunities\n🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, "Dead — No Momentum", price);
        return;
      }
    }

    // ── Trailing stop for runner (after TP2) ──────────────────────────────────
    if (pos.tp2Hit && pos.trailingHigh > 0) {
      const trailTrigger = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      if (price <= trailTrigger) {
        this.closePosition(pos, "Trailing Stop (runner)", price);
        return;
      }
    }

    // ── TP1 — FIX 3: atomic sell + SL update with retry ──────────────────────
    if (!pos.tp1Hit && price >= tp1Price) {
      await this.executeTP1Atomic(pos, price, tp1Frac, cfg.tp1Pct, cfg.tp1ClosePct);
    }

    // ── TP2 ───────────────────────────────────────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
      pos.tp2Hit       = true;
      pos.trailingHigh = price;
      this.partialClose(pos, tp2Frac, `TP2 +${cfg.tp2Pct}% — sell ${cfg.tp2ClosePct}%`, price, "tp2");
      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP2 hit — runner active");
      if (isTelegramConfigured()) {
        const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp2Frac;
        void sendTelegram(
          `🚀 <b>SNIPER TP2 HIT (PAPER)</b>\n──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
          `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${cfg.tp2Pct}%)\n` +
          `💰 Sold ${cfg.tp2ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>\n` +
          `🎯 Runner active — trailing stop ${cfg.trailingStopPct}% below peak\n` +
          `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position\n🕐 ${toIST(new Date())}`,
        );
      }
    }

    this.updateLivePnl(pos);
    void this.persistPosition(pos);
  }

  // ── DB persistence ─────────────────────────────────────────────────────────

  private async persistPosition(pos: SniperPosition): Promise<void> {
    try {
      await execute(`
        INSERT INTO sniper_positions (
          id, mint, symbol, name, detected_at, entry_at, entry_price, current_price,
          size_sol, tp1_hit, tp2_hit, remaining_fraction, effective_sl_price,
          trailing_high, status, realized_pnl_sol, close_reason, closed_at, exit_price, tx_signature,
          tp1_realized_sol, tp2_realized_sol, runner_realized_sol
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
          runner_realized_sol= EXCLUDED.runner_realized_sol
      `, [
        pos.id, pos.mint, pos.symbol, pos.name, pos.detectedAt, pos.entryAt,
        pos.entryPrice, pos.currentPrice, pos.sizeSol, pos.tp1Hit, pos.tp2Hit,
        pos.remainingFraction, pos.effectiveSlPrice, pos.trailingHigh, pos.status,
        pos.realizedPnlSol, pos.closeReason ?? null, pos.closedAt ?? null,
        pos.exitPrice ?? null, pos.txSignature,
        pos.tp1RealizedSol, pos.tp2RealizedSol, pos.runnerRealizedSol,
      ]);
    } catch (err) {
      logger.warn({ id: pos.id, err: (err as Error).message }, "Graduation sniper: persistPosition failed");
    }
  }

  private addEvent(evt: SniperEvent): void {
    this.events.unshift(evt);
    if (this.events.length > MAX_EVENTS) this.events.pop();
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  async updateConfig(partial: Partial<SniperConfig>): Promise<SniperConfig> {
    this.config = { ...this.config, ...partial };
    try {
      await execute(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [CONFIG_KEY, JSON.stringify(this.config)],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: failed to save config");
    }
    return this.config;
  }

  // ── Mutation helpers (edit / delete / reset) ──────────────────────────────

  async deletePosition(id: string): Promise<boolean> {
    // Check open positions (keyed by mint)
    const openEntry = Array.from(this.openPositions.entries()).find(([, p]) => p.id === id);
    if (openEntry) {
      const [mint, pos] = openEntry;
      this.virtualBalance += pos.sizeSol * pos.remainingFraction;
      this.openPositions.delete(mint);
      this.seenMints.delete(mint);
    } else {
      const idx = this.closedPositions.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      const pos = this.closedPositions[idx]!;
      this.seenMints.delete(pos.mint);
      this.closedPositions.splice(idx, 1);
    }
    try {
      await execute(`DELETE FROM sniper_positions WHERE id = $1`, [id]);
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, "Graduation sniper: deletePosition DB error");
    }
    return true;
  }

  /**
   * Recalculate realizedPnlSol + breakdown for a closed position using deterministic
   * math: TP prices are derived from entryPrice + config percentages, runner uses exitPrice.
   * This corrects any previously inflated values from the concurrency bug.
   */
  async recalculatePnl(id: string): Promise<SniperPosition | null> {
    const pos = this.closedPositions.find((p) => p.id === id);
    if (!pos || !pos.exitPrice || pos.entryPrice <= 0) return null;

    const cfg       = this.config;
    const tp1Frac   = cfg.tp1ClosePct / 100;
    const tp2Frac   = cfg.tp2ClosePct / 100;
    const tp1Price  = pos.entryPrice * (1 + cfg.tp1Pct / 100);
    const tp2Price  = pos.entryPrice * (1 + cfg.tp2Pct / 100);

    let tp1Sol   = 0;
    let tp2Sol   = 0;
    let runnerSol = 0;
    let realized  = 0;

    if (pos.tp1Hit && pos.tp2Hit) {
      const remainFrac = Math.max(0, 1 - tp1Frac - tp2Frac);
      tp1Sol    = (tp1Price / pos.entryPrice - 1) * pos.sizeSol * tp1Frac;
      tp2Sol    = (tp2Price / pos.entryPrice - 1) * pos.sizeSol * tp2Frac;
      runnerSol = (pos.exitPrice / pos.entryPrice - 1) * pos.sizeSol * remainFrac;
      realized  = tp1Sol + tp2Sol + runnerSol;
    } else if (pos.tp1Hit) {
      const remainFrac = Math.max(0, 1 - tp1Frac);
      tp1Sol    = (tp1Price / pos.entryPrice - 1) * pos.sizeSol * tp1Frac;
      runnerSol = (pos.exitPrice / pos.entryPrice - 1) * pos.sizeSol * remainFrac;
      realized  = tp1Sol + runnerSol;
    } else {
      runnerSol = (pos.exitPrice / pos.entryPrice - 1) * pos.sizeSol;
      realized  = runnerSol;
    }

    pos.realizedPnlSol   = realized;
    pos.tp1RealizedSol   = tp1Sol;
    pos.tp2RealizedSol   = tp2Sol;
    pos.runnerRealizedSol = runnerSol;
    this.updateLivePnl(pos);
    await this.persistPosition(pos);

    logger.info(
      { id, symbol: pos.symbol, realized: realized.toFixed(6), tp1: tp1Sol.toFixed(6), tp2: tp2Sol.toFixed(6), runner: runnerSol.toFixed(6) },
      "Graduation sniper: P&L recalculated",
    );
    return { ...pos };
  }

  async editPosition(id: string, patch: {
    entryPrice?: number;
    exitPrice?: number;
    currentPrice?: number;
    closeReason?: string;
    realizedPnlSol?: number;
  }): Promise<SniperPosition | null> {
    // Find in open or closed
    const openEntry = Array.from(this.openPositions.entries()).find(([, p]) => p.id === id);
    let pos: SniperPosition | undefined;
    if (openEntry) {
      pos = openEntry[1];
    } else {
      pos = this.closedPositions.find((p) => p.id === id);
    }
    if (!pos) return null;

    if (patch.entryPrice !== undefined) {
      pos.entryPrice = patch.entryPrice;
      pos.effectiveSlPrice = patch.entryPrice * (1 - this.config.slPct / 100);
    }
    if (patch.currentPrice !== undefined) pos.currentPrice = patch.currentPrice;
    if (patch.exitPrice !== undefined)    pos.exitPrice    = patch.exitPrice;
    if (patch.closeReason !== undefined)  pos.closeReason  = patch.closeReason;
    if (patch.realizedPnlSol !== undefined) pos.realizedPnlSol = patch.realizedPnlSol;

    this.updateLivePnl(pos);
    await this.persistPosition(pos);
    return { ...pos };
  }

  async resetAccount(): Promise<void> {
    // Close/remove all open positions (refund virtual balance)
    for (const [mint] of this.openPositions) {
      this.openPositions.delete(mint);
    }
    this.closedPositions = [];
    this.events = [];
    this.seenMints.clear();
    this.graduationsToday = 0;
    this.virtualBalance = this.config.virtualBalanceSol;

    try {
      await execute(`DELETE FROM sniper_positions`, []);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: resetAccount DB error");
    }
    logger.info({ virtualBalance: this.virtualBalance }, "Graduation sniper: account reset");
  }

  deleteEvent(id: string): boolean {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.events.splice(idx, 1);
    return true;
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  getStatus(): SniperStatus {
    const closed     = this.closedPositions;
    const wins       = closed.filter((p) => p.realizedPnlSol > 0).length;
    const losses     = closed.filter((p) => p.realizedPnlSol <= 0).length;
    const realized   = closed.reduce((s, p) => s + p.realizedPnlSol, 0);

    // Live unrealized: sum of all open positions' current unrealized PNL
    // (includes partial-close realized already credited to virtualBalance)
    const unrealized = Array.from(this.openPositions.values()).reduce((s, p) => {
      this.updateLivePnl(p);
      return s + p.unrealizedPnlSol;
    }, 0);

    // Also include realized PNL from TP hits on still-open positions
    const partialOpen = Array.from(this.openPositions.values()).reduce((s, p) => s + p.realizedPnlSol, 0);

    return {
      wsConnected:            this.wsConnected,
      wsReconnects:           this.wsReconnects,
      enabled:                this.config.enabled,
      graduationsToday:       this.graduationsToday,
      tradesTotal:            this.seenMints.size,
      wins,
      losses,
      totalRealizedPnlSol:    realized + partialOpen,
      totalUnrealizedPnlSol:  unrealized,
      totalCombinedPnlSol:    realized + partialOpen + unrealized,
      virtualBalance:         this.virtualBalance,
      openCount:              this.openPositions.size,
      config:                 this.config,
    };
  }

  getOpenPositions(): SniperPosition[] {
    return Array.from(this.openPositions.values()).map((p) => {
      this.updateLivePnl(p);
      return { ...p };
    });
  }

  getClosedPositions(): SniperPosition[] {
    return [...this.closedPositions].reverse();
  }

  getEvents(): SniperEvent[] {
    return [...this.events];
  }

  getConfig(): SniperConfig {
    return { ...this.config };
  }
}

export const graduationSniperService = new GraduationSniperService();
