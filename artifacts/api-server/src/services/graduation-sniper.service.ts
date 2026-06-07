import WebSocket from "ws";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { blacklistService } from "./blacklist.service.js";

// ── Constants ────────────────────────────────────────────────────────────────
const MIGRATION_WALLET   = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const PRICE_CHECK_MS     = 15_000;
const RECONNECT_DELAY_MS = 1_000;
const MAX_EVENTS         = 50;
const MAX_CLOSED         = 100;
const CONFIG_KEY         = "sniper_config";

function uid(): string {
  return `snp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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
  tp1Pct:            100,
  tp1ClosePct:       60,
  tp2Pct:            300,
  tp2ClosePct:       30,
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

  // ── Init ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadPositions();
    this.virtualBalance = this.config.virtualBalanceSol
      - Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol, 0);
    logger.info(
      { openPositions: this.openPositions.size, virtualBalance: this.virtualBalance, enabled: this.config.enabled },
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
        `SELECT * FROM sniper_positions ORDER BY entry_at DESC`,
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
      pos.pnlPct           = pos.entryPrice > 0 ? (pos.currentPrice / pos.entryPrice - 1) * 100 : 0;
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
    this.priceIntervalId = setInterval(() => void this.checkAllPrices(), PRICE_CHECK_MS);
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
    try {
      const mint = await this.extractMintFromTx(signature);
      if (!mint) {
        logger.debug({ signature }, "Graduation sniper: could not extract mint — skipping");
        return;
      }

      const skipReason = this.checkSkipReason(mint);
      const eventBase  = { id: uid(), detectedAt: Date.now(), mint, symbol: mint.slice(0, 8), txSignature: signature };

      if (skipReason) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason });
        logger.debug({ mint, skipReason }, "Graduation sniper: skipped");
        return;
      }

      // Wait before entry so DEX price feeds have time to populate
      await new Promise((r) => setTimeout(r, this.config.waitBeforeEntryMs));

      const priceData = await this.fetchPrice(mint);
      if (!priceData) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason: "Price not yet on DexScreener" });
        return;
      }

      const { price, symbol, name } = priceData;

      // Double-check skip after price fetch (race condition guard)
      const skipAfterWait = this.checkSkipReason(mint);
      if (skipAfterWait) {
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: skipAfterWait });
        return;
      }

      this.enterPosition(mint, symbol, name, price, signature);
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

  private async extractMintFromTx(signature: string): Promise<string | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    try {
      const res = await axios.post<{
        result: {
          transaction: {
            message: {
              accountKeys: Array<{ pubkey: string } | string>;
            };
          } | null;
        } | null;
      }>(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          jsonrpc: "2.0",
          id:      1,
          method:  "getTransaction",
          params:  [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        },
        { timeout: 10_000 },
      );

      const tx = res.data?.result?.transaction;
      if (!tx) return null;

      const accountKeys: string[] = (tx.message.accountKeys ?? []).map((k) =>
        typeof k === "string" ? k : (k as { pubkey: string }).pubkey,
      );

      // Pump.fun token mints end with "pump" and are not the program ID itself
      const mint = accountKeys.find(
        (k) => k.endsWith("pump") && k !== PUMPFUN_PROGRAM_ID && k !== MIGRATION_WALLET && k.length >= 32,
      );

      return mint ?? null;
    } catch (err) {
      logger.warn({ signature, err: (err as Error).message }, "Graduation sniper: getTransaction failed");
      return null;
    }
  }

  private async fetchPrice(mint: string): Promise<{ price: number; symbol: string; name: string } | null> {
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

      const best  = sorted[0]!;
      const price = parseFloat(best.priceUsd) || 0;
      if (price <= 0) return null;

      return {
        price,
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
    const pos: SniperPosition = {
      id,
      mint,
      symbol,
      name,
      detectedAt:       Date.now(),
      entryAt:          Date.now(),
      entryPrice:       price,
      currentPrice:     price,
      sizeSol:          cfg.positionSizeSol,
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
    this.virtualBalance -= cfg.positionSizeSol;

    void this.persistPosition(pos);

    logger.info(
      { mint, symbol, entryPrice: price, sizeSol: cfg.positionSizeSol, sl: pos.effectiveSlPrice },
      "Graduation sniper: paper position entered",
    );
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

  // ── Price checking loop ────────────────────────────────────────────────────

  private async checkAllPrices(): Promise<void> {
    if (this.openPositions.size === 0) return;

    const mints = Array.from(this.openPositions.keys());

    await Promise.allSettled(mints.map((mint) => this.checkPositionPrice(mint)));
  }

  private async checkPositionPrice(mint: string): Promise<void> {
    const pos = this.openPositions.get(mint);
    if (!pos) return;

    const priceData = await this.fetchPrice(mint);
    if (!priceData) return;

    const { price } = priceData;
    pos.currentPrice = price;

    const cfg        = this.config;
    const tp1Price   = pos.entryPrice * (1 + cfg.tp1Pct / 100);
    const tp2Price   = pos.entryPrice * (1 + cfg.tp2Pct / 100);
    const tp1Frac    = cfg.tp1ClosePct / 100;
    const tp2Frac    = cfg.tp2ClosePct / 100;

    // Update trailing high
    if (pos.tp2Hit && price > pos.trailingHigh) pos.trailingHigh = price;

    // SL check (covers both fixed SL and breakeven-moved SL)
    if (price <= pos.effectiveSlPrice) {
      this.closePosition(pos, pos.tp1Hit ? "Trailing/Breakeven SL" : "Stop Loss (-40%)", price);
      return;
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
      // Move SL to breakeven
      pos.effectiveSlPrice = pos.entryPrice;
      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP1 hit — SL moved to breakeven");
    }

    // TP2
    if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
      pos.tp2Hit        = true;
      pos.trailingHigh  = price;
      this.partialClose(pos, tp2Frac, `TP2 +${cfg.tp2Pct}% — sell ${cfg.tp2ClosePct}%`, price);
      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP2 hit — runner active");
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

  // ── Getters ────────────────────────────────────────────────────────────────

  getStatus(): SniperStatus {
    const closed   = this.closedPositions;
    const wins     = closed.filter((p) => p.realizedPnlSol > 0).length;
    const losses   = closed.filter((p) => p.realizedPnlSol <= 0).length;
    const realized = closed.reduce((s, p) => s + p.realizedPnlSol, 0);

    return {
      wsConnected:          this.wsConnected,
      wsReconnects:         this.wsReconnects,
      enabled:              this.config.enabled,
      graduationsToday:     this.graduationsToday,
      tradesTotal:          this.seenMints.size,
      wins,
      losses,
      totalRealizedPnlSol:  realized,
      virtualBalance:       this.virtualBalance,
      openCount:            this.openPositions.size,
      config:               this.config,
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
