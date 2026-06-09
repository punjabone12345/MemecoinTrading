import WebSocket from "ws";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM_ID    = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT              = "So11111111111111111111111111111111111111112";
const GRADUATION_MCAP_USD   = 69_000;   // pump.fun graduation threshold (~$69k)
const DEXSCREENER_BASE      = "https://api.dexscreener.com";
const CONFIG_KEY            = "pumpfun_config";
const RECONNECT_DELAY_MS    = 3_000;
const MAX_TRACKED_TOKENS    = 300;
const TOKEN_TTL_MS          = 2 * 60 * 60_000; // 2 hours
const MARKET_DATA_INTERVAL  = 30_000;           // refresh DexScreener every 30s
const SCORE_INTERVAL        = 15_000;           // score check every 15s
const PRICE_CHECK_INTERVAL  = 10_000;           // position TP/SL every 10s
const TX_QUEUE_DELAY        = 600;              // ms between getTransaction calls (rate-limit)
const MAX_TX_QUEUE          = 50;              // max queued signatures
const MAX_EVENTS            = 100;
const MAX_CLOSED            = 200;

// ── Pre-graduation TP structure (different from post-grad sniper) ─────────────
const SL_PCT         = 40;    // -40% SL
const TP1_PCT        = 300;   // +300% TP1
const TP1_CLOSE_PCT  = 25;    // sell 25% at TP1
const TP2_PCT        = 1000;  // +1000% TP2
const TP2_CLOSE_PCT  = 25;    // sell 25% at TP2
const TRAILING_PCT   = 40;    // 40% trail from peak (moonbag after TP2)
const FIRST_MIN_MS   = 60_000;
const FIRST_MIN_DROP = 30;    // 60s early exit at -30%

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PumpfunConfig {
  enabled: boolean;
  minAiScore: number;
  positionSizeSol: number;
  maxOpenPositions: number;
  graduationMinPct: number;
  graduationMaxPct: number;
  virtualBalanceSol: number;
  scoreWeights: {
    graduationSpeed: number;
    volumeAcceleration: number;
    uniqueBuyerGrowth: number;
    txVelocity: number;
    mcapAcceleration: number;
    holderDistribution: number;
    whaleAccumulation: number;
    creatorRisk: number;
    momentumStrength: number;
  };
}

export interface ScoreBreakdown {
  graduationSpeed: number;
  volumeAcceleration: number;
  uniqueBuyerGrowth: number;
  txVelocity: number;
  mcapAcceleration: number;
  holderDistribution: number;
  whaleAccumulation: number;
  creatorRisk: number;
  momentumStrength: number;
  total: number;
}

export type TokenStatus =
  | "watching"
  | "candidate"
  | "buySignal"
  | "bought"
  | "graduated"
  | "exited"
  | "rejected";

export interface TrackedToken {
  mint: string;
  symbol: string;
  name: string;
  firstSeen: number;
  lastUpdated: number;
  // Market data
  priceUsd: number;
  mcap: number;
  graduationPct: number;
  pairAddress: string;
  // Activity (rolling windows)
  txHistory: { ts: number; isBuy: boolean; wallet: string; solAmount: number }[];
  uniqueBuyers: string[];
  // Snapshots for acceleration
  mcapSnapshots: { ts: number; val: number }[];
  volumeSnapshots: { ts: number; vol: number }[];
  buyerSnapshots: { ts: number; count: number }[];
  // Creator tracking
  creatorWallet: string;
  creatorSold: boolean;
  // Score
  score: number;
  scoreBreakdown: ScoreBreakdown;
  // Status
  status: TokenStatus;
  rejectionReason?: string;
  positionId?: string;
}

export interface PumpfunPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  entryMcap: number;
  entryGraduationPct: number;
  entryScore: number;
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
}

export interface PumpfunEvent {
  id: string;
  ts: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "rejected";
  skipReason?: string;
  score?: number;
  graduationPct?: number;
}

export interface PumpfunStatus {
  wsConnected: boolean;
  wsReconnects: number;
  enabled: boolean;
  trackedCount: number;
  candidateCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  virtualBalance: number;
  openCount: number;
  config: PumpfunConfig;
}

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: PumpfunConfig = {
  enabled: true,
  minAiScore: 80,
  positionSizeSol: 0.1,
  maxOpenPositions: 3,
  graduationMinPct: 85,
  graduationMaxPct: 99.5,
  virtualBalanceSol: 10.0,
  scoreWeights: {
    graduationSpeed:    0.15,
    volumeAcceleration: 0.20,
    uniqueBuyerGrowth:  0.15,
    txVelocity:         0.10,
    mcapAcceleration:   0.10,
    holderDistribution: 0.10,
    whaleAccumulation:  0.10,
    creatorRisk:        0.05,
    momentumStrength:   0.05,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function uid(): string {
  return `pfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function fmt4(p: number): string {
  if (p <= 0) return "0";
  if (p < 0.000001) return p.toExponential(3);
  if (p < 0.001) return p.toFixed(8);
  if (p < 1) return p.toFixed(6);
  return p.toFixed(4);
}

function fmtMcap(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function nowSec(): number { return Date.now(); }

function txsInWindow(history: { ts: number }[], windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return history.filter((h) => h.ts >= cutoff).length;
}

function volInWindow(history: { ts: number; solAmount: number; isBuy: boolean }[], windowMs: number, buyOnly = true): number {
  const cutoff = Date.now() - windowMs;
  return history.filter((h) => h.ts >= cutoff && (!buyOnly || h.isBuy)).reduce((s, h) => s + h.solAmount, 0);
}

// ── Service ───────────────────────────────────────────────────────────────────

class PumpfunTraderService {
  private trackedTokens = new Map<string, TrackedToken>();
  private openPositions  = new Map<string, PumpfunPosition>();
  private closedPositions: PumpfunPosition[] = [];
  private events: PumpfunEvent[] = [];

  private config: PumpfunConfig = { ...DEFAULT_CONFIG };
  private virtualBalance = DEFAULT_CONFIG.virtualBalanceSol;

  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private txQueue: string[] = [];
  private processingTxQueue = false;

  private marketDataTimer: ReturnType<typeof setInterval> | null = null;
  private scoreTimer:      ReturnType<typeof setInterval> | null = null;
  private priceCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.restorePositions();
    logger.info({
      openPositions: this.openPositions.size,
      closedTrades:  this.closedPositions.length,
      virtualBalance: this.virtualBalance.toFixed(4),
      enabled: this.config.enabled,
    }, "Pump.fun pre-graduation trader: initialised");
  }

  start(): void {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (apiKey) {
      this.connectWebSocket(apiKey);
    } else {
      logger.warn("Pump.fun trader: HELIUS_API_KEY not set — WebSocket disabled, using DexScreener polling only");
    }

    this.marketDataTimer = setInterval(() => void this.refreshMarketData(), MARKET_DATA_INTERVAL);
    this.scoreTimer      = setInterval(() => void this.runScoringCycle(), SCORE_INTERVAL);
    this.priceCheckTimer = setInterval(() => void this.checkPositionPrices(), PRICE_CHECK_INTERVAL);

    // Initial market data fetch after a short delay
    setTimeout(() => void this.refreshMarketData(), 5_000);
    logger.info("Pump.fun pre-graduation trader: started");
  }

  // ── Helius WebSocket ────────────────────────────────────────────────────────

  private connectWebSocket(apiKey: string): void {
    try {
      const url = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
      const ws  = new WebSocket(url);

      ws.on("open", () => {
        this.wsConnected = true;
        logger.info("Pump.fun trader: Helius WebSocket connected");
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id:      1,
          method:  "logsSubscribe",
          params:  [
            { mentions: [PUMPFUN_PROGRAM_ID] },
            { commitment: "processed" },
          ],
        }));
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as {
            method?: string;
            result?: number;
            params?: {
              result?: {
                value?: {
                  signature?: string;
                  err?: unknown;
                  logs?: string[];
                };
              };
            };
          };

          if (msg.method === "logsNotification") {
            const value = msg.params?.result?.value;
            if (!value?.err && value?.signature && value.logs) {
              this.handleLogNotification(value.signature, value.logs);
            }
          }
        } catch { /* ignore parse errors */ }
      });

      ws.on("close", () => {
        this.wsConnected = false;
        this.wsReconnects++;
        logger.warn({ reconnects: this.wsReconnects }, "Pump.fun trader: WebSocket closed, reconnecting…");
        setTimeout(() => this.connectWebSocket(apiKey), RECONNECT_DELAY_MS);
      });

      ws.on("error", (err) => {
        logger.warn({ err: (err as Error).message }, "Pump.fun trader: WebSocket error");
      });

      this.ws = ws;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Pump.fun trader: failed to connect WebSocket");
      setTimeout(() => this.connectWebSocket(apiKey), RECONNECT_DELAY_MS);
    }
  }

  private handleLogNotification(signature: string, logs: string[]): void {
    const isCreate = logs.some((l) => l.includes("Instruction: Create"));
    const isBuy    = logs.some((l) => l.includes("Instruction: Buy"));
    const isSell   = logs.some((l) => l.includes("Instruction: Sell"));

    if (!isCreate && !isBuy && !isSell) return;

    // For creates and buys, queue the tx for detail fetching (rate-limited)
    if (this.txQueue.length < MAX_TX_QUEUE) {
      this.txQueue.push(signature);
      if (!this.processingTxQueue) {
        void this.processTxQueue();
      }
    }
  }

  private async processTxQueue(): Promise<void> {
    if (this.processingTxQueue) return;
    this.processingTxQueue = true;

    while (this.txQueue.length > 0) {
      const sig = this.txQueue.shift()!;
      try {
        await this.fetchAndParseTransaction(sig);
      } catch (err) {
        logger.debug({ sig, err: (err as Error).message }, "Pump.fun trader: tx parse error");
      }
      await new Promise((r) => setTimeout(r, TX_QUEUE_DELAY));
    }

    this.processingTxQueue = false;
  }

  private async fetchAndParseTransaction(signature: string): Promise<void> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return;

    type TxResult = {
      result?: {
        transaction?: {
          message?: {
            accountKeys?: { pubkey: string }[];
          };
        };
        meta?: {
          err?: unknown;
          preBalances?: number[];
          postBalances?: number[];
          preTokenBalances?:  { mint: string; accountIndex: number; uiTokenAmount?: { uiAmount?: number | null } }[];
          postTokenBalances?: { mint: string; accountIndex: number; uiTokenAmount?: { uiAmount?: number | null } }[];
          logMessages?: string[];
        };
      } | null;
    };

    const res = await axios.post<TxResult>(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        jsonrpc: "2.0", id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
      },
      { timeout: 10_000 },
    );

    const tx = res.data?.result;
    if (!tx || tx.meta?.err) return;

    const accountKeys   = tx.transaction?.message?.accountKeys ?? [];
    const postBalances  = tx.meta?.postTokenBalances ?? [];
    const preBalances   = tx.meta?.preTokenBalances  ?? [];
    const allBalances   = [...preBalances, ...postBalances];
    const solPre        = tx.meta?.preBalances  ?? [];
    const solPost       = tx.meta?.postBalances ?? [];

    const logs = tx.meta?.logMessages ?? [];
    const isCreate = logs.some((l) => l.includes("Instruction: Create"));
    const isBuy    = logs.some((l) => l.includes("Instruction: Buy"));
    const isSell   = logs.some((l) => l.includes("Instruction: Sell"));

    // Find the non-SOL token mint
    const mint = allBalances.map((b) => b.mint).find((m) => m && m !== SOL_MINT);
    if (!mint) return;

    // Fee payer / buyer wallet = accountKeys[0]
    const buyerWallet = accountKeys[0]?.pubkey ?? "unknown";

    // Approximate SOL amount from balance change of first account
    const solSpent = solPre[0] !== undefined && solPost[0] !== undefined
      ? Math.abs(solPre[0] - solPost[0]) / 1e9
      : 0;

    if (isCreate) {
      // New token launch — add to tracking with creator info
      this.initToken(mint, buyerWallet);
    } else if (isBuy) {
      this.recordActivity(mint, buyerWallet, true,  solSpent);
    } else if (isSell) {
      this.recordActivity(mint, buyerWallet, false, solSpent);
    }
  }

  // ── Token tracking ──────────────────────────────────────────────────────────

  private initToken(mint: string, creatorWallet: string): void {
    if (this.trackedTokens.has(mint)) return;

    // Enforce max tracked tokens by evicting oldest
    if (this.trackedTokens.size >= MAX_TRACKED_TOKENS) {
      let oldest = 0, oldestMint = "";
      for (const [m, t] of this.trackedTokens) {
        if (t.status !== "bought" && t.firstSeen > oldest) { oldest = t.firstSeen; oldestMint = m; }
      }
      if (oldestMint) this.trackedTokens.delete(oldestMint);
    }

    const now = nowSec();
    this.trackedTokens.set(mint, {
      mint, symbol: mint.slice(0, 6), name: mint.slice(0, 8),
      firstSeen: now, lastUpdated: now,
      priceUsd: 0, mcap: 0, graduationPct: 0, pairAddress: "",
      txHistory: [],
      uniqueBuyers: [],
      mcapSnapshots:   [{ ts: now, val: 0 }],
      volumeSnapshots: [{ ts: now, vol: 0 }],
      buyerSnapshots:  [{ ts: now, count: 0 }],
      creatorWallet, creatorSold: false,
      score: 0, scoreBreakdown: this.emptyBreakdown(),
      status: "watching",
    });
  }

  private recordActivity(mint: string, wallet: string, isBuy: boolean, solAmount: number): void {
    let token = this.trackedTokens.get(mint);
    if (!token) {
      // Token not yet tracked — init it
      this.initToken(mint, wallet);
      token = this.trackedTokens.get(mint)!;
    }

    const now = nowSec();
    token.txHistory.push({ ts: now, isBuy, wallet, solAmount });
    token.lastUpdated = now;

    // Prune old history (keep last 30 min)
    const cutoff = now - 30 * 60_000;
    token.txHistory = token.txHistory.filter((h) => h.ts >= cutoff);

    // Track unique buyers
    if (isBuy && !token.uniqueBuyers.includes(wallet)) {
      token.uniqueBuyers.push(wallet);
    }

    // Track creator sells
    if (!isBuy && wallet === token.creatorWallet) {
      token.creatorSold = true;
    }

    // Update buyer snapshot (every 5 min)
    const lastSnap = token.buyerSnapshots[token.buyerSnapshots.length - 1];
    if (!lastSnap || now - lastSnap.ts > 5 * 60_000) {
      token.buyerSnapshots.push({ ts: now, count: token.uniqueBuyers.length });
      if (token.buyerSnapshots.length > 12) token.buyerSnapshots.shift();
    }
  }

  // ── DexScreener market data refresh ────────────────────────────────────────

  private async refreshMarketData(): Promise<void> {
    const mints = Array.from(this.trackedTokens.keys()).slice(0, 30);
    if (mints.length === 0) return;

    // Batch into groups of 30 (DexScreener limit)
    const batches: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) batches.push(mints.slice(i, i + 30));

    for (const batch of batches) {
      try {
        type DexPair = {
          pairAddress: string;
          baseToken: { address: string; symbol: string; name: string };
          priceUsd: string;
          marketCap: number;
          fdv: number;
          volume?: { h1?: number; m5?: number };
          dexId?: string;
        };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${batch.join(",")}`,
          { timeout: 10_000 },
        );

        const pairs = Array.isArray(res.data) ? res.data : [];
        const now   = nowSec();

        for (const pair of pairs) {
          const addr = pair.baseToken?.address;
          if (!addr) continue;
          const token = this.trackedTokens.get(addr);
          if (!token) continue;

          const price = parseFloat(pair.priceUsd) || 0;
          const mcap  = pair.marketCap ?? pair.fdv ?? 0;
          const gradPct = Math.min((mcap / GRADUATION_MCAP_USD) * 100, 100);

          token.priceUsd     = price;
          token.mcap         = mcap;
          token.graduationPct = gradPct;
          token.pairAddress  = pair.pairAddress ?? "";
          token.symbol       = pair.baseToken.symbol ?? token.symbol;
          token.name         = pair.baseToken.name   ?? token.name;
          token.lastUpdated  = now;

          // Update mcap snapshot for acceleration calc
          const lastMcap = token.mcapSnapshots[token.mcapSnapshots.length - 1];
          if (!lastMcap || now - lastMcap.ts > 60_000) {
            token.mcapSnapshots.push({ ts: now, val: mcap });
            if (token.mcapSnapshots.length > 20) token.mcapSnapshots.shift();
          }

          // Mark graduated tokens
          if (gradPct >= 100 && token.status !== "bought") {
            token.status = "graduated";
          }

          // Clean up very old tokens that haven't graduated
          if (now - token.firstSeen > TOKEN_TTL_MS && token.status === "watching") {
            this.trackedTokens.delete(addr);
          }
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, "Pump.fun trader: DexScreener refresh error");
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Also update open position prices
    for (const pos of this.openPositions.values()) {
      const token = this.trackedTokens.get(pos.mint);
      if (token && token.priceUsd > 0) {
        pos.currentPrice = token.priceUsd;
      }
    }
  }

  // ── AI Scoring ──────────────────────────────────────────────────────────────

  private emptyBreakdown(): ScoreBreakdown {
    return {
      graduationSpeed: 0, volumeAcceleration: 0, uniqueBuyerGrowth: 0,
      txVelocity: 0, mcapAcceleration: 0, holderDistribution: 0,
      whaleAccumulation: 0, creatorRisk: 0, momentumStrength: 0, total: 0,
    };
  }

  private scoreToken(token: TrackedToken): ScoreBreakdown {
    const w  = this.config.scoreWeights;
    const now = nowSec();
    const scores = this.emptyBreakdown();

    // 1. Graduation Speed (15%) — how fast graduation % is increasing
    {
      const snaps = token.mcapSnapshots;
      if (snaps.length >= 2) {
        const oldest = snaps[0]!;
        const newest = snaps[snaps.length - 1]!;
        const dtMin  = (newest.ts - oldest.ts) / 60_000;
        const dMcap  = newest.val - oldest.val;
        const mcapPerMin = dtMin > 0 ? dMcap / dtMin : 0;
        // Scale: >$5k/min = 100, $1k/min = 60, $500/min = 40
        const raw = Math.min(mcapPerMin / 50, 100);
        scores.graduationSpeed = Math.max(0, raw);
      }
    }

    // 2. Volume Acceleration (20%) — buy volume in last 5m vs prior 5m
    {
      const vol5m  = volInWindow(token.txHistory, 5 * 60_000);
      const vol10m = volInWindow(token.txHistory, 10 * 60_000) - vol5m;
      if (vol10m > 0.01) {
        const ratio = vol5m / vol10m;
        scores.volumeAcceleration = Math.min(ratio * 50, 100);
      } else if (vol5m > 0.05) {
        scores.volumeAcceleration = 70; // active with no prior comparison
      }
    }

    // 3. Unique Buyer Growth (15%) — new unique buyers in last 5m
    {
      const recent5m = token.txHistory.filter((h) => h.ts >= now - 5 * 60_000 && h.isBuy);
      const recentBuyers = new Set(recent5m.map((h) => h.wallet)).size;
      // Scale: >20 unique buyers in 5m = 100, 10 = 60, 5 = 30
      scores.uniqueBuyerGrowth = Math.min(recentBuyers * 5, 100);
    }

    // 4. Transaction Velocity (10%) — txns per minute in last 5m
    {
      const txs5m  = txsInWindow(token.txHistory, 5 * 60_000);
      const txPerMin = txs5m / 5;
      // Scale: >10 tx/min = 100, 5 = 60, 2 = 30
      scores.txVelocity = Math.min(txPerMin * 10, 100);
    }

    // 5. Market Cap Acceleration (10%) — recent mcap growth rate
    {
      const snaps = token.mcapSnapshots;
      if (snaps.length >= 3) {
        const mid   = snaps[Math.floor(snaps.length / 2)]!;
        const last  = snaps[snaps.length - 1]!;
        const early = snaps[0]!;
        const growth1 = mid.val > 0 ? (last.val - mid.val) / mid.val : 0;
        const growth2 = early.val > 0 ? (mid.val - early.val) / early.val : 0;
        const accel   = growth1 - growth2;
        scores.mcapAcceleration = Math.max(0, Math.min(accel * 100 + 50, 100));
      }
    }

    // 6. Holder Distribution (10%) — buy diversity (no single wallet dominates)
    {
      const recent = token.txHistory.filter((h) => h.isBuy && h.ts >= now - 10 * 60_000);
      if (recent.length > 0) {
        const walletVol = new Map<string, number>();
        for (const h of recent) walletVol.set(h.wallet, (walletVol.get(h.wallet) ?? 0) + h.solAmount);
        const totalVol = Array.from(walletVol.values()).reduce((s, v) => s + v, 0);
        const maxPct   = totalVol > 0 ? Math.max(...Array.from(walletVol.values())) / totalVol * 100 : 100;
        // Low concentration = high score: 100% = 0, 50% = 50, 20% = 90
        scores.holderDistribution = Math.max(0, 100 - maxPct);
      } else {
        scores.holderDistribution = 50; // neutral if no data
      }
    }

    // 7. Whale Accumulation (10%) — large buy sizes indicate conviction
    {
      const recent = token.txHistory.filter((h) => h.isBuy && h.ts >= now - 5 * 60_000);
      if (recent.length > 0) {
        const maxBuy = Math.max(...recent.map((h) => h.solAmount));
        // Scale: >1 SOL = 100, 0.5 SOL = 70, 0.1 SOL = 30
        scores.whaleAccumulation = Math.min(maxBuy * 80, 100);
      }
    }

    // 8. Creator Risk (5%) — penalise if creator sold
    {
      scores.creatorRisk = token.creatorSold ? 0 : 100;
    }

    // 9. Momentum Strength (5%) — buy/sell ratio in last 5m
    {
      const recent5m = token.txHistory.filter((h) => h.ts >= now - 5 * 60_000);
      const buys  = recent5m.filter((h) => h.isBuy).length;
      const sells = recent5m.filter((h) => !h.isBuy).length;
      const total = buys + sells;
      if (total > 0) {
        const buyRatio = buys / total;
        scores.momentumStrength = Math.min(buyRatio * 120, 100);
      }
    }

    // Weighted total
    scores.total = Math.round(
      scores.graduationSpeed    * w.graduationSpeed    +
      scores.volumeAcceleration * w.volumeAcceleration +
      scores.uniqueBuyerGrowth  * w.uniqueBuyerGrowth  +
      scores.txVelocity         * w.txVelocity         +
      scores.mcapAcceleration   * w.mcapAcceleration   +
      scores.holderDistribution * w.holderDistribution +
      scores.whaleAccumulation  * w.whaleAccumulation  +
      scores.creatorRisk        * w.creatorRisk        +
      scores.momentumStrength   * w.momentumStrength,
    );
    scores.total = Math.min(100, Math.max(0, scores.total));

    return scores;
  }

  // ── Anti-rug filter ─────────────────────────────────────────────────────────

  private checkAntiRug(token: TrackedToken): string | null {
    // 1. Creator sold before entry
    if (token.creatorSold) return "Creator sold before entry";

    const now    = nowSec();
    const recent = token.txHistory.filter((h) => h.ts >= now - 10 * 60_000);
    const buys   = recent.filter((h) => h.isBuy);
    const sells  = recent.filter((h) => !h.isBuy);

    // 2. Volume collapse — sell volume >> buy volume
    const buyVol  = buys.reduce((s, h) => s + h.solAmount, 0);
    const sellVol = sells.reduce((s, h) => s + h.solAmount, 0);
    if (buyVol > 0.01 && sellVol > buyVol * 2.5) return "Volume collapse — sells dominating";

    // 3. Single wallet dominates volume (>40% of buy volume)
    if (buys.length > 0) {
      const walletVol = new Map<string, number>();
      for (const h of buys) walletVol.set(h.wallet, (walletVol.get(h.wallet) ?? 0) + h.solAmount);
      const totalBuyVol = Array.from(walletVol.values()).reduce((s, v) => s + v, 0);
      for (const [, vol] of walletVol) {
        if (totalBuyVol > 0 && vol / totalBuyVol > 0.55) return "Single wallet dominates volume (>55%)";
      }
    }

    // 4. Wash trading — same wallet buying repeatedly
    const walletBuyCounts = new Map<string, number>();
    for (const h of buys) walletBuyCounts.set(h.wallet, (walletBuyCounts.get(h.wallet) ?? 0) + 1);
    for (const [, count] of walletBuyCounts) {
      if (count >= 8) return "Suspected wash trading (same wallet 8+ buys)";
    }

    // 5. Holder growth stagnation — no new unique buyers in last 5m (only check if token is 10m+ old)
    const ageMs = now - token.firstSeen;
    if (ageMs > 10 * 60_000 && token.graduationPct >= 80) {
      const recent5m = token.txHistory.filter((h) => h.ts >= now - 5 * 60_000 && h.isBuy);
      const recentBuyers = new Set(recent5m.map((h) => h.wallet)).size;
      if (recentBuyers === 0) return "Holder growth stagnated — no new buyers in 5m";
    }

    return null;
  }

  // ── Scoring cycle ───────────────────────────────────────────────────────────

  private async runScoringCycle(): Promise<void> {
    if (!this.config.enabled) return;

    for (const [mint, token] of this.trackedTokens) {
      if (token.status === "bought" || token.status === "graduated" || token.status === "exited") continue;

      // Calculate score
      const breakdown = this.scoreToken(token);
      token.score          = breakdown.total;
      token.scoreBreakdown = breakdown;

      const gradPct = token.graduationPct;
      const cfg     = this.config;

      // Update status
      if (gradPct >= cfg.graduationMinPct && gradPct <= cfg.graduationMaxPct) {
        token.status = token.score >= cfg.minAiScore ? "buySignal" : "candidate";
      } else if (gradPct > 0 && gradPct < cfg.graduationMinPct) {
        token.status = "watching";
      }

      // Anti-rug check before entry
      if (token.status === "buySignal" && token.priceUsd > 0) {
        const rugReason = this.checkAntiRug(token);
        if (rugReason) {
          token.status          = "rejected";
          token.rejectionReason = rugReason;

          this.addEvent({ id: uid(), ts: Date.now(), mint, symbol: token.symbol, action: "rejected", skipReason: rugReason, score: token.score, graduationPct: gradPct });
          logger.info({ mint, symbol: token.symbol, reason: rugReason }, "Pump.fun trader: token rejected by anti-rug filter");

          if (isTelegramConfigured()) {
            void sendTelegram(
              `⚫ <b>TOKEN REJECTED</b>\n──────────────────────\n` +
              `🪙 Token: <b>${token.symbol}</b> / ${token.name}\n` +
              `📋 CA: <code>${mint}</code>\n` +
              `❌ Reason: ${rugReason}\n` +
              `🎓 Graduation: ${gradPct.toFixed(1)}%\n` +
              `🏆 Score: ${token.score}/100\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          continue;
        }

        // All checks passed — enter position
        this.enterPosition(token);
      }

      // Clean up rejected/graduated old tokens
      if ((token.status === "rejected" || token.status === "graduated") &&
          Date.now() - token.lastUpdated > 30 * 60_000) {
        this.trackedTokens.delete(mint);
      }
    }
  }

  // ── Position management ─────────────────────────────────────────────────────

  private enterPosition(token: TrackedToken): void {
    if (this.openPositions.has(token.mint)) return;
    if (this.openPositions.size >= this.config.maxOpenPositions) return;
    if (this.virtualBalance < this.config.positionSizeSol) return;

    const cfg      = this.config;
    const id       = uid();
    const price    = token.priceUsd;
    const sizeSol  = cfg.positionSizeSol;
    const slPrice  = price * (1 - SL_PCT / 100);

    const pos: PumpfunPosition = {
      id, mint: token.mint, symbol: token.symbol, name: token.name,
      detectedAt: token.firstSeen, entryAt: Date.now(),
      entryPrice: price, entryMcap: token.mcap,
      entryGraduationPct: token.graduationPct, entryScore: token.score,
      currentPrice: price, sizeSol,
      tp1Hit: false, tp2Hit: false, remainingFraction: 1.0,
      effectiveSlPrice: slPrice, trailingHigh: price,
      status: "open", realizedPnlSol: 0, unrealizedPnlSol: 0, totalPnlSol: 0, pnlPct: 0,
    };

    this.openPositions.set(token.mint, pos);
    this.virtualBalance -= sizeSol;
    token.status     = "bought";
    token.positionId = id;

    this.addEvent({ id: uid(), ts: Date.now(), mint: token.mint, symbol: token.symbol, action: "entered", score: token.score, graduationPct: token.graduationPct });
    void this.savePosition(pos);

    logger.info({ mint: token.mint, symbol: token.symbol, price, sizeSol, score: token.score, gradPct: token.graduationPct.toFixed(1) }, "Pump.fun trader: position entered ✅");

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🟣 <b>PRE-GRADUATION ENTRY</b>\n──────────────────────\n` +
        `🪙 Token: <b>${token.symbol}</b> / ${token.name}\n` +
        `📋 CA: <code>${token.mint}</code>\n` +
        `🏆 AI Score: <b>${token.score}/100</b>\n` +
        `🎓 Graduation: <b>${token.graduationPct.toFixed(1)}%</b>\n` +
        `💰 Market Cap: ${fmtMcap(token.mcap)}\n` +
        `📊 Volume (5m): ${volInWindow(token.txHistory, 5 * 60_000).toFixed(3)} SOL\n` +
        `👥 Unique Buyers: ${token.uniqueBuyers.length}\n` +
        `💵 Entry: $${fmt4(price)}\n` +
        `🛑 SL: $${fmt4(slPrice)} (-${SL_PCT}%)\n` +
        `✅ Position Opened (${sizeSol} SOL)\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  private closePosition(pos: PumpfunPosition, reason: string, price: number): void {
    const fraction    = pos.remainingFraction;
    const pnlSol      = (price / pos.entryPrice - 1) * pos.sizeSol * fraction + pos.realizedPnlSol;
    const pnlPct      = (price / pos.entryPrice - 1) * 100;

    pos.status         = "closed";
    pos.closeReason    = reason;
    pos.exitPrice      = price;
    pos.closedAt       = Date.now();
    pos.realizedPnlSol = pnlSol;
    pos.unrealizedPnlSol = 0;
    pos.totalPnlSol    = pnlSol;
    pos.pnlPct         = pnlPct;

    this.virtualBalance += pos.sizeSol * fraction + pnlSol - pos.realizedPnlSol;
    this.openPositions.delete(pos.mint);
    this.closedPositions.unshift(pos);
    if (this.closedPositions.length > MAX_CLOSED) this.closedPositions.pop();

    // Update tracked token status
    const token = this.trackedTokens.get(pos.mint);
    if (token) token.status = "exited";

    void this.savePosition(pos);

    const isWin = pnlSol > 0;
    logger.info({ mint: pos.mint, symbol: pos.symbol, reason, pnlSol: pnlSol.toFixed(4), pnlPct: pnlPct.toFixed(1) }, "Pump.fun trader: position closed");

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🔴 <b>PRE-GRADUATION EXIT</b>\n──────────────────────\n` +
        `🪙 Token: <b>${pos.symbol}</b>\n` +
        `📋 CA: <code>${pos.mint}</code>\n` +
        `${isWin ? "📈" : "📉"} Final PnL: <b>${isWin ? "+" : ""}${pnlSol.toFixed(4)} SOL (${isWin ? "+" : ""}${pnlPct.toFixed(1)}%)</b>\n` +
        `❌ Reason: ${reason}\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  private partialClose(pos: PumpfunPosition, closeFraction: number, price: number, reason: string): void {
    const closeSize  = pos.sizeSol * pos.remainingFraction * closeFraction;
    const closePnl   = (price / pos.entryPrice - 1) * closeSize;

    pos.realizedPnlSol     += closePnl;
    pos.remainingFraction  *= (1 - closeFraction);
    // Move SL to breakeven after TP1
    pos.effectiveSlPrice    = pos.tp1Hit ? pos.entryPrice : pos.effectiveSlPrice;

    logger.info({ mint: pos.mint, symbol: pos.symbol, reason, closeSize: closeSize.toFixed(4), closePnl: closePnl.toFixed(4), remaining: pos.remainingFraction.toFixed(2) }, "Pump.fun trader: partial close");
  }

  // ── Price check loop ────────────────────────────────────────────────────────

  private async checkPositionPrices(): Promise<void> {
    if (this.openPositions.size === 0) return;

    for (const pos of Array.from(this.openPositions.values())) {
      const token = this.trackedTokens.get(pos.mint);
      const price = token?.priceUsd ?? pos.currentPrice;
      if (!price || price <= 0) continue;

      pos.currentPrice = price;
      const now       = Date.now();
      const ageMs     = now - pos.entryAt;
      const tp1Price  = pos.entryPrice * (1 + TP1_PCT / 100);
      const tp2Price  = pos.entryPrice * (1 + TP2_PCT / 100);

      // Update P&L
      const unrealized = (price / pos.entryPrice - 1) * pos.sizeSol * pos.remainingFraction;
      pos.unrealizedPnlSol = unrealized;
      pos.totalPnlSol      = pos.realizedPnlSol + unrealized;
      pos.pnlPct           = (price / pos.entryPrice - 1) * 100;

      if (pos.tp2Hit && price > pos.trailingHigh) pos.trailingHigh = price;

      // 60-second early exit
      if (!pos.tp1Hit && ageMs <= FIRST_MIN_MS) {
        const dropPct = (1 - price / pos.entryPrice) * 100;
        if (dropPct >= FIRST_MIN_DROP) {
          this.closePosition(pos, `60s Early Exit (-${dropPct.toFixed(0)}%)`, price);
          continue;
        }
      }

      // SL
      if (price <= pos.effectiveSlPrice) {
        this.closePosition(pos, pos.tp1Hit ? "Breakeven SL" : `Stop Loss (-${SL_PCT}%)`, price);
        continue;
      }

      // TP2 trailing stop (moonbag)
      if (pos.tp2Hit && pos.trailingHigh > 0) {
        const trailTrigger = pos.trailingHigh * (1 - TRAILING_PCT / 100);
        if (price <= trailTrigger) {
          this.closePosition(pos, "Trailing Stop (moonbag)", price);
          continue;
        }
      }

      // TP1 — +300%, sell 25%
      if (!pos.tp1Hit && price >= tp1Price) {
        pos.tp1Hit = true;
        this.partialClose(pos, TP1_CLOSE_PCT / 100, price, `TP1 (+${TP1_PCT}%)`);
        pos.effectiveSlPrice = pos.entryPrice; // move SL to breakeven

        if (isTelegramConfigured()) {
          void sendTelegram(
            `🟢 <b>PRE-GRADUATION TP1</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `📈 PnL: <b>+${TP1_PCT}%</b>\n` +
            `💰 ${TP1_CLOSE_PCT}% Position Closed\n` +
            `🛑 SL moved to breakeven\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
        void this.savePosition(pos);
      }

      // TP2 — +1000%, sell 25%
      if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
        pos.tp2Hit    = true;
        pos.trailingHigh = price;
        this.partialClose(pos, TP2_CLOSE_PCT / 100, price, `TP2 (+${TP2_PCT}%)`);

        if (isTelegramConfigured()) {
          void sendTelegram(
            `🚀 <b>PRE-GRADUATION TP2</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `🌙 PnL: <b>+${TP2_PCT}%</b>\n` +
            `💰 ${TP2_CLOSE_PCT}% Position Closed\n` +
            `🎯 Moonbag Active (${pos.remainingFraction * 100 | 0}% remaining)\n` +
            `📈 Trailing Stop: ${TRAILING_PCT}% below peak\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
        void this.savePosition(pos);
      }
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private addEvent(event: PumpfunEvent): void {
    this.events.unshift(event);
    if (this.events.length > MAX_EVENTS) this.events.pop();
  }

  // ── DB persistence ──────────────────────────────────────────────────────────

  private async loadConfig(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        `SELECT value FROM kv_store WHERE key = $1 LIMIT 1`, [CONFIG_KEY],
      );
      if (rows.length > 0) {
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(rows[0]!.value) };
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    this.virtualBalance = this.config.virtualBalanceSol;
  }

  private async restorePositions(): Promise<void> {
    try {
      const rows = await query<{
        id: string; mint: string; symbol: string; name: string;
        detected_at: string; entry_at: string;
        entry_price: string; entry_mcap: string; entry_graduation_pct: string; entry_score: string;
        current_price: string; size_sol: string;
        tp1_hit: boolean; tp2_hit: boolean; remaining_fraction: string;
        effective_sl_price: string; trailing_high: string;
        status: string; realized_pnl_sol: string;
        close_reason: string | null; closed_at: string | null; exit_price: string | null;
      }>(`SELECT * FROM pumpfun_positions ORDER BY entry_at DESC`);

      for (const row of rows) {
        const pos: PumpfunPosition = {
          id: row.id, mint: row.mint, symbol: row.symbol, name: row.name,
          detectedAt: Number(row.detected_at), entryAt: Number(row.entry_at),
          entryPrice: Number(row.entry_price), entryMcap: Number(row.entry_mcap),
          entryGraduationPct: Number(row.entry_graduation_pct), entryScore: Number(row.entry_score),
          currentPrice: Number(row.current_price), sizeSol: Number(row.size_sol),
          tp1Hit: Boolean(row.tp1_hit), tp2Hit: Boolean(row.tp2_hit),
          remainingFraction: Number(row.remaining_fraction),
          effectiveSlPrice: Number(row.effective_sl_price), trailingHigh: Number(row.trailing_high),
          status: row.status as "open" | "closed",
          realizedPnlSol: Number(row.realized_pnl_sol),
          unrealizedPnlSol: 0, totalPnlSol: Number(row.realized_pnl_sol), pnlPct: 0,
          closeReason: row.close_reason ?? undefined,
          closedAt: row.closed_at ? Number(row.closed_at) : undefined,
          exitPrice: row.exit_price ? Number(row.exit_price) : undefined,
        };

        if (pos.status === "open") {
          this.openPositions.set(pos.mint, pos);
          this.virtualBalance -= pos.sizeSol * pos.remainingFraction;
        } else {
          this.closedPositions.push(pos);
        }
      }

      // Restore realized PNL effect on balance
      const closedPnl = this.closedPositions.reduce((s, p) => s + p.realizedPnlSol, 0);
      this.virtualBalance = this.config.virtualBalanceSol - 
        Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol * p.remainingFraction, 0) +
        closedPnl;
    } catch {
      // Table not yet created — fine
    }
  }

  private async savePosition(pos: PumpfunPosition): Promise<void> {
    try {
      await execute(
        `INSERT INTO pumpfun_positions
          (id, mint, symbol, name, detected_at, entry_at, entry_price, entry_mcap,
           entry_graduation_pct, entry_score, current_price, size_sol,
           tp1_hit, tp2_hit, remaining_fraction, effective_sl_price, trailing_high,
           status, realized_pnl_sol, close_reason, closed_at, exit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           current_price = EXCLUDED.current_price,
           tp1_hit = EXCLUDED.tp1_hit, tp2_hit = EXCLUDED.tp2_hit,
           remaining_fraction = EXCLUDED.remaining_fraction,
           effective_sl_price = EXCLUDED.effective_sl_price,
           trailing_high = EXCLUDED.trailing_high,
           status = EXCLUDED.status,
           realized_pnl_sol = EXCLUDED.realized_pnl_sol,
           close_reason = EXCLUDED.close_reason,
           closed_at = EXCLUDED.closed_at,
           exit_price = EXCLUDED.exit_price`,
        [
          pos.id, pos.mint, pos.symbol, pos.name, pos.detectedAt, pos.entryAt,
          pos.entryPrice, pos.entryMcap, pos.entryGraduationPct, pos.entryScore,
          pos.currentPrice, pos.sizeSol,
          pos.tp1Hit, pos.tp2Hit, pos.remainingFraction,
          pos.effectiveSlPrice, pos.trailingHigh,
          pos.status, pos.realizedPnlSol,
          pos.closeReason ?? null, pos.closedAt ?? null, pos.exitPrice ?? null,
        ],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Pump.fun trader: savePosition failed");
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getStatus(): PumpfunStatus {
    const closed    = this.closedPositions;
    const wins      = closed.filter((p) => p.realizedPnlSol > 0).length;
    const losses    = closed.filter((p) => p.realizedPnlSol <= 0).length;
    const realized  = closed.reduce((s, p) => s + p.realizedPnlSol, 0) +
                      Array.from(this.openPositions.values()).reduce((s, p) => s + p.realizedPnlSol, 0);
    const unrealized = Array.from(this.openPositions.values()).reduce((s, p) => s + p.unrealizedPnlSol, 0);

    return {
      wsConnected: this.wsConnected,
      wsReconnects: this.wsReconnects,
      enabled: this.config.enabled,
      trackedCount: this.trackedTokens.size,
      candidateCount: Array.from(this.trackedTokens.values()).filter((t) => t.status === "candidate" || t.status === "buySignal").length,
      tradesTotal: closed.length,
      wins, losses,
      totalRealizedPnlSol:  realized,
      totalUnrealizedPnlSol: unrealized,
      totalCombinedPnlSol:  realized + unrealized,
      virtualBalance: this.virtualBalance,
      openCount: this.openPositions.size,
      config: this.config,
    };
  }

  getTrackedTokens(): TrackedToken[] {
    return Array.from(this.trackedTokens.values())
      .sort((a, b) => b.graduationPct - a.graduationPct)
      .slice(0, 100);
  }

  getOpenPositions(): PumpfunPosition[] {
    return Array.from(this.openPositions.values());
  }

  getClosedPositions(): PumpfunPosition[] {
    return this.closedPositions.slice(0, 100);
  }

  getEvents(): PumpfunEvent[] {
    return this.events;
  }

  getConfig(): PumpfunConfig {
    return { ...this.config };
  }

  async updateConfig(patch: Partial<PumpfunConfig>): Promise<PumpfunConfig> {
    this.config = { ...this.config, ...patch };
    if (patch.virtualBalanceSol !== undefined && this.openPositions.size === 0) {
      this.virtualBalance = patch.virtualBalanceSol;
    }
    try {
      await execute(
        `INSERT INTO kv_store (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [CONFIG_KEY, JSON.stringify(this.config)],
      );
    } catch { /* ignore */ }
    return { ...this.config };
  }

  // Allow external injection of discovered tokens (e.g., from DexScreener polling)
  injectToken(mint: string, symbol: string, name: string, mcap: number, priceUsd: number, pairAddress: string): void {
    let token = this.trackedTokens.get(mint);
    const gradPct = Math.min((mcap / GRADUATION_MCAP_USD) * 100, 100);

    if (!token) {
      this.initToken(mint, "unknown");
      token = this.trackedTokens.get(mint)!;
    }

    const now = nowSec();
    token.symbol      = symbol;
    token.name        = name;
    token.mcap        = mcap;
    token.priceUsd    = priceUsd;
    token.pairAddress = pairAddress;
    token.graduationPct = gradPct;
    token.lastUpdated = now;

    if (token.mcapSnapshots.length === 0 ||
        now - token.mcapSnapshots[token.mcapSnapshots.length - 1]!.ts > 30_000) {
      token.mcapSnapshots.push({ ts: now, val: mcap });
      if (token.mcapSnapshots.length > 20) token.mcapSnapshots.shift();
    }
  }
}

export const pumpfunTraderService = new PumpfunTraderService();
