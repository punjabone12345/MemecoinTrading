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

// ── Adaptive price-check intervals (FIX 3) ───────────────────────────────────
const PRICE_LOOP_MS         = 10_000;         // main loop tick — 10 s
const FAST_WINDOW_MS        = 30 * 60_000;    // first 30 min  → check every 10 s
const MED_WINDOW_MS         = 2 * 60 * 60_000;// 30 min–2 h    → check every 30 s
const FAST_INTERVAL_MS      = 10_000;
const MED_INTERVAL_MS       = 30_000;
const SLOW_INTERVAL_MS      = 60_000;

// ── Hard-stop / dead-position thresholds (FIX 1 & 2) ─────────────────────────
const HARD_STOP_PCT         = 50;             // -50 % absolute floor (FIX 1)
const DEAD_POSITION_MS      = 2 * 60 * 60_000;// 2 h open with no movement (FIX 2)
const DEAD_MOVE_PCT         = 5;              // < 5 % move = "dead"

// ── Instant-rug detection constants ──────────────────────────────────────────
const RUG_CHECK_WAIT_MS     = 8_000;          // monitor for 8 s after baseline price
const RUG_DROP_ABORT_PCT    = 20;             // abort if price drops ≥ 20 % in that window (FIX 3 — tightened from 25)

// ── Type-A rug filters ────────────────────────────────────────────────────────
const MIN_ENTRY_PRICE_USD   = 0.00001;        // FIX 1: skip tokens priced below $0.00001 (pre-rug micro-caps)
const MIN_POOL_SOL          = 10;             // FIX 2: skip if Raydium pool holds < 10 SOL on-chain (drained)

// ── Night-session sizing (IST 23:00–04:00 = highest rug period) ───────────────
const NIGHT_SESSION_SOL     = 0.05;           // half-size during night window
const NIGHT_START_IST_HOUR  = 23;             // 11 pm IST
const NIGHT_END_IST_HOUR    = 4;              // 4 am IST (exclusive)

/** Returns true when the current clock time falls inside the high-rug night window (IST). */
function isNightSession(): boolean {
  const nowUtc   = new Date();
  const istMin   = (nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() + 330) % 1440; // UTC+5:30
  const istHour  = Math.floor(istMin / 60);
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

  // Tracks when each position was last price-checked (adaptive interval, FIX 3)
  private lastPositionCheckAt: Map<string, number> = new Map();

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
    // Adaptive loop ticks every 10 s; per-position rate-limiting is inside checkAllPrices
    this.priceIntervalId = setInterval(() => void this.checkAllPrices(), PRICE_LOOP_MS);
    logger.info("Graduation sniper: started — WebSocket connecting");
  }

  stop(): void {
    this.started = false;
    if (this.priceIntervalId) { clearInterval(this.priceIntervalId); this.priceIntervalId = null; }
    if (this.reconnectTimer)  { clearTimeout(this.reconnectTimer);   this.reconnectTimer  = null; }
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

    // ── Night-session position sizing (Change 2) ──────────────────────────────
    // 11 pm – 4 am IST is the highest-rug window; use half-size to limit exposure.
    const night   = isNightSession();
    const sizeSol = night ? Math.min(NIGHT_SESSION_SOL, cfg.positionSizeSol) : cfg.positionSizeSol;

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
    };

    this.openPositions.set(mint, pos);
    this.seenMints.add(mint);
    this.virtualBalance -= sizeSol;

    void this.persistPosition(pos);

    const nightTag = night ? " 🌙 (night session — reduced size)" : "";
    logger.info(
      { mint, symbol, entryPrice: price, sizeSol, sl: pos.effectiveSlPrice, night },
      "Graduation sniper: paper position entered",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🎯 <b>SNIPER ENTRY (PAPER)</b>${night ? " 🌙" : ""}\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${symbol}</b> — ${name}\n` +
        `📋 CA: <code>${mint}</code>\n` +
        `💵 Entry: <b>$${fmtTgPrice(price)}</b>\n` +
        `💰 Size: <b>${sizeSol} SOL</b> (paper)${nightTag}\n` +
        `🛡️ SL: $${fmtTgPrice(pos.effectiveSlPrice)} (−${cfg.slPct}%)\n` +
        `🎯 TP1: $${fmtTgPrice(price * (1 + cfg.tp1Pct / 100))} (+${cfg.tp1Pct}%)\n` +
        `🎯 TP2: $${fmtTgPrice(price * (1 + cfg.tp2Pct / 100))} (+${cfg.tp2Pct}%)\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  private closePosition(pos: SniperPosition, reason: string, exitPrice: number): void {
    const remaining = pos.sizeSol * pos.remainingFraction;
    const closePnl  = (exitPrice / pos.entryPrice - 1) * remaining;

    pos.realizedPnlSol += closePnl;
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

  private partialClose(pos: SniperPosition, closeOriginalFraction: number, reason: string, currentPrice: number): void {
    const closeSize = pos.sizeSol * closeOriginalFraction;
    const closePnl  = (currentPrice / pos.entryPrice - 1) * closeSize;
    pos.realizedPnlSol += closePnl;
    pos.remainingFraction -= closeOriginalFraction;
    this.virtualBalance   += closeSize + closePnl;
    pos.currentPrice = currentPrice;

    void this.persistPosition(pos);

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, closeSize, closePnl, remaining: pos.remainingFraction },
      "Graduation sniper: partial close",
    );
  }

  // ── Price checking loop (adaptive intervals — FIX 3) ─────────────────────

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
    const pos = this.openPositions.get(mint);
    if (!pos) return;

    const priceData = await this.fetchPrice(mint);
    if (!priceData) return;

    const { price } = priceData;
    pos.currentPrice = price;

    const now        = Date.now();
    const cfg        = this.config;
    const tp1Price   = pos.entryPrice * (1 + cfg.tp1Pct / 100);
    const tp2Price   = pos.entryPrice * (1 + cfg.tp2Pct / 100);
    const tp1Frac    = cfg.tp1ClosePct / 100;
    const tp2Frac    = cfg.tp2ClosePct / 100;

    // Update trailing high
    if (pos.tp2Hit && price > pos.trailingHigh) pos.trailingHigh = price;

    // ── FIX 1: Hard stop at -50% — absolute floor, no exceptions ─────────────
    const hardStopPrice = pos.entryPrice * (1 - HARD_STOP_PCT / 100);
    if (price <= hardStopPrice) {
      const lossPct = ((price / pos.entryPrice) - 1) * 100;
      logger.warn(
        { mint, symbol: pos.symbol, price, entryPrice: pos.entryPrice, lossPct: lossPct.toFixed(1) },
        "Graduation sniper: HARD STOP triggered",
      );
      if (isTelegramConfigured()) {
        void sendTelegram(
          `🚨 <b>SNIPER HARD STOP (PAPER)</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n` +
          `📋 CA: <code>${pos.mint}</code>\n` +
          `📉 Drop: <b>${lossPct.toFixed(1)}%</b> — hard floor hit\n` +
          `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(price)}\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
      this.closePosition(pos, `Hard Stop (${lossPct.toFixed(0)}%)`, price);
      return;
    }

    // ── Standard SL (fixed -40% or breakeven after TP1) ──────────────────────
    if (price <= pos.effectiveSlPrice) {
      this.closePosition(pos, pos.tp1Hit ? "Trailing/Breakeven SL" : "Stop Loss (-40%)", price);
      return;
    }

    // ── FIX 2: Dead position exit — open >2 h with <5% movement ──────────────
    if (!pos.tp1Hit) {
      const ageMs   = now - pos.entryAt;
      const movePct = Math.abs((price / pos.entryPrice - 1) * 100);
      if (ageMs >= DEAD_POSITION_MS && movePct < DEAD_MOVE_PCT) {
        logger.info(
          { mint, symbol: pos.symbol, ageH: (ageMs / 3_600_000).toFixed(1), movePct: movePct.toFixed(2) },
          "Graduation sniper: dead position exit — no momentum",
        );
        if (isTelegramConfigured()) {
          void sendTelegram(
            `💤 <b>SNIPER DEAD EXIT (PAPER)</b>\n` +
            `──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `📋 CA: <code>${pos.mint}</code>\n` +
            `⏱️ Held: ${(ageMs / 3_600_000).toFixed(1)}h with only ${movePct.toFixed(1)}% movement\n` +
            `🔄 Freeing slot for fresh opportunities\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
        this.closePosition(pos, "Dead — No Momentum", price);
        return;
      }
    }

    // Trailing stop for runner (after TP2)
    if (pos.tp2Hit && pos.trailingHigh > 0) {
      const trailTrigger = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      if (price <= trailTrigger) {
        this.closePosition(pos, "Trailing Stop (runner)", price);
        return;
      }
    }

    // TP1
    if (!pos.tp1Hit && price >= tp1Price) {
      pos.tp1Hit = true;
      this.partialClose(pos, tp1Frac, `TP1 +${cfg.tp1Pct}% — sell ${cfg.tp1ClosePct}%`, price);
      pos.effectiveSlPrice = pos.entryPrice;
      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP1 hit — SL moved to breakeven");
      if (isTelegramConfigured()) {
        const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp1Frac;
        void sendTelegram(
          `🟢 <b>SNIPER TP1 HIT (PAPER)</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n` +
          `📋 CA: <code>${pos.mint}</code>\n` +
          `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${cfg.tp1Pct}%)\n` +
          `💰 Sold ${cfg.tp1ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>\n` +
          `🛡️ SL moved to breakeven ($${fmtTgPrice(pos.entryPrice)})\n` +
          `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
    }

    // TP2
    if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
      pos.tp2Hit        = true;
      pos.trailingHigh  = price;
      this.partialClose(pos, tp2Frac, `TP2 +${cfg.tp2Pct}% — sell ${cfg.tp2ClosePct}%`, price);
      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP2 hit — runner active");
      if (isTelegramConfigured()) {
        const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp2Frac;
        void sendTelegram(
          `🚀 <b>SNIPER TP2 HIT (PAPER)</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${pos.symbol}</b>\n` +
          `📋 CA: <code>${pos.mint}</code>\n` +
          `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${cfg.tp2Pct}%)\n` +
          `💰 Sold ${cfg.tp2ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>\n` +
          `🎯 Runner active — trailing stop ${cfg.trailingStopPct}% below peak\n` +
          `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position\n` +
          `🕐 ${toIST(new Date())}`,
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
          trailing_high, status, realized_pnl_sol, close_reason, closed_at, exit_price, tx_signature
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (id) DO UPDATE SET
          current_price     = EXCLUDED.current_price,
          tp1_hit           = EXCLUDED.tp1_hit,
          tp2_hit           = EXCLUDED.tp2_hit,
          remaining_fraction= EXCLUDED.remaining_fraction,
          effective_sl_price= EXCLUDED.effective_sl_price,
          trailing_high     = EXCLUDED.trailing_high,
          status            = EXCLUDED.status,
          realized_pnl_sol  = EXCLUDED.realized_pnl_sol,
          close_reason      = EXCLUDED.close_reason,
          closed_at         = EXCLUDED.closed_at,
          exit_price        = EXCLUDED.exit_price
      `, [
        pos.id, pos.mint, pos.symbol, pos.name, pos.detectedAt, pos.entryAt,
        pos.entryPrice, pos.currentPrice, pos.sizeSol, pos.tp1Hit, pos.tp2Hit,
        pos.remainingFraction, pos.effectiveSlPrice, pos.trailingHigh, pos.status,
        pos.realizedPnlSol, pos.closeReason ?? null, pos.closedAt ?? null,
        pos.exitPrice ?? null, pos.txSignature,
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
