import WebSocket from "ws";
import axios from "axios";
import { createHash } from "crypto";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM_ID    = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const SOL_MINT              = "So11111111111111111111111111111111111111112";
const GRADUATION_MCAP_USD   = 69_000;   // pump.fun graduation threshold (~$69k)
const GRADUATION_REAL_SOL   = 85_000_000_000n; // 85 SOL in lamports = on-chain graduation target
const DEXSCREENER_BASE      = "https://api.dexscreener.com";
const PUMPPORTAL_WS_URL     = "wss://pumpportal.fun/api/data";
// Solana RPC — public mainnet (falls back to Helius if HELIUS_API_KEY set)
const SOLANA_PUBLIC_RPC     = "https://api.mainnet-beta.solana.com";
const ON_CHAIN_BATCH_SIZE   = 100;    // getMultipleAccounts limit
const ON_CHAIN_INTERVAL     = 20_000; // refresh on-chain bonding curves every 20s
const CONFIG_KEY            = "pumpfun_config";
const RECONNECT_DELAY_MS    = 3_000;
const MAX_TRACKED_TOKENS    = 500;
const TOKEN_TTL_MS          = 2 * 60 * 60_000; // 2 hours
const MARKET_DATA_INTERVAL  = 30_000;           // refresh DexScreener every 30s
const PUMPFUN_REFRESH_INTERVAL = 15_000;        // refresh pump.fun bonding curve data every 15s
const NEAR_GRAD_SCAN_INTERVAL  = 10_000;        // FIX 5: scan pump.fun for near-graduation tokens every 10s
const SCORE_INTERVAL        = 15_000;           // score check every 15s
const PRICE_CHECK_INTERVAL  = 10_000;           // position TP/SL every 10s
const SOL_PRICE_INTERVAL    = 2 * 60_000;       // refresh SOL/USD price every 2 min
const TX_QUEUE_DELAY        = 600;              // ms between getTransaction calls (rate-limit)
const MAX_TX_QUEUE          = 50;              // max queued signatures
const MAX_EVENTS            = 100;
const MAX_CLOSED            = 200;
// Grad% threshold above which we subscribe to individual token trades via PumpPortal
const PP_TRADE_SUB_GRAD_PCT = 55;

// ── Pre-graduation TP/SL structure ────────────────────────────────────────────
// FIX 5: updated TP targets (200%/500%) + FIX 6: staged SL mirrors sniper
const SL_PCT         = 40;    // kept for legacy SL price calculation on entry
const TP1_PCT        = 200;   // +200% TP1 (was 300 — higher upside from earlier entry)
const TP1_CLOSE_PCT  = 25;    // sell 25% at TP1
const TP2_PCT        = 500;   // +500% TP2 (was 1000)
const TP2_CLOSE_PCT  = 25;    // sell 25% at TP2
const TRAILING_PCT   = 40;    // 40% trail from peak (moonbag after TP2)
// FIX 5 staged SL — mirrors graduation-sniper.service.ts FIX 1
const PF_STAGED_PHASE1_MS  = 2 * 60_000;   // first 2 min: 20% from entry
const PF_STAGED_PHASE2_MS  = 10 * 60_000;  // 2-10 min: 25% from peak
const PF_STAGED_PHASE1_PCT = 20;
const PF_STAGED_PHASE2_PCT = 25;
const PF_STAGED_PHASE3_PCT = 30;
const PF_STAGED_AFTER_TP1  = 35;
// FIX 6: trading hours (6am–11pm IST) — same as sniper
const PF_NIGHT_START_HOUR  = 23;
const PF_NIGHT_END_HOUR    = 6;
// Entry requirements — relaxed for near-graduation tokens
const PF_MIN_TX_COUNT         = 5;            // only 5 txs required in normal zone (was 50 — too strict)
const PF_MIN_TX_NEAR_GRAD     = 0;            // 0 txs required for 85%+ graduation tokens (they're already near graduating)
const PF_MAX_AGE_MS           = 90 * 60_000;  // token age < 90 min (was 30 — blocked slow-climbing tokens)
const PF_MAX_AGE_NEAR_GRAD_MS = 4 * 60 * 60_000; // 4 hours allowed for 85%+ grad tokens
const PF_GRAD_MIN_AFTER_ENTRY = 80;           // exit if graduation drops below 80% after entry
// Near-graduation tiers for fast-track entry
const PF_NEAR_GRAD_PCT   = 85;  // fast-track tier 1: relaxed checks
const PF_CLOSE_GRAD_PCT  = 92;  // fast-track tier 2: minimal checks, auto-pass score

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
  minAiScore: 35,           // lowered from 55 — scoring penalises late-discovered tokens unfairly
  positionSizeSol: 0.05,   // 0.05 SOL (smaller — higher risk pre-grad plays)
  maxOpenPositions: 3,
  graduationMinPct: 80,    // lowered from 85 — discover tokens earlier for more tx history build-up
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

// ── FIX 6: Trading hours helper (6am–11pm IST) ────────────────────────────────
function isPfNightSession(): boolean {
  const nowUtc  = new Date();
  const istMin  = (nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes() + 330) % 1440;
  const istHour = Math.floor(istMin / 60);
  return istHour >= PF_NIGHT_START_HOUR || istHour < PF_NIGHT_END_HOUR;
}

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

  // PumpPortal WebSocket (free, no key — primary discovery source)
  private ppWs: WebSocket | null = null;
  private ppConnected = false;
  private ppReconnects = 0;
  private ppSubscribedMints = new Set<string>();

  // SOL/USD price (refreshed every 5 min, used to convert PumpPortal SOL mcap → USD)
  private solPriceUsd = 150;

  // On-chain bonding curve PDA cache (mint → PDA base58 address)
  private pdaCache = new Map<string, string>();

  private marketDataTimer:  ReturnType<typeof setInterval> | null = null;
  private pumpfunTimer:     ReturnType<typeof setInterval> | null = null;
  private nearGradTimer:    ReturnType<typeof setInterval> | null = null;
  private onChainTimer:     ReturnType<typeof setInterval> | null = null;
  private scoreTimer:       ReturnType<typeof setInterval> | null = null;
  private priceCheckTimer:  ReturnType<typeof setInterval> | null = null;
  private solPriceTimer:    ReturnType<typeof setInterval> | null = null;
  // track which mints we've already fetched from pump.fun API to pace requests
  private pfApiFetchQueue:  string[] = [];
  private pfApiFetching = false;

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
    // PumpPortal — always on (free, no key needed)
    this.connectPumpPortal();

    // Helius — optional enhancement for raw tx-level data
    const apiKey = process.env["HELIUS_API_KEY"];
    if (apiKey) {
      this.connectWebSocket(apiKey);
    } else {
      logger.info("Pump.fun trader: HELIUS_API_KEY not set — running on PumpPortal + DexScreener only");
    }

    // Fetch SOL price immediately, then every 2 min
    void this.fetchSolPrice();
    this.solPriceTimer   = setInterval(() => void this.fetchSolPrice(), SOL_PRICE_INTERVAL);

    this.marketDataTimer = setInterval(() => void this.refreshMarketData(), MARKET_DATA_INTERVAL);
    // Primary graduation% source: on-chain bonding curve accounts via Solana RPC
    this.onChainTimer    = setInterval(() => void this.refreshOnChainBondingCurves(), ON_CHAIN_INTERVAL);
    // Secondary: DexScreener-based bonding curve refresh (covers tokens not yet on-chain readable)
    this.pumpfunTimer    = setInterval(() => void this.refreshPumpfunBondingCurves(), PUMPFUN_REFRESH_INTERVAL);
    // Near-graduation scanner — finds tokens at 80-99.5% that we haven't seen yet
    this.nearGradTimer   = setInterval(() => void this.scanNearGraduationTokens(), NEAR_GRAD_SCAN_INTERVAL);

    this.scoreTimer      = setInterval(() => void this.runScoringCycle(), SCORE_INTERVAL);
    this.priceCheckTimer = setInterval(() => void this.checkPositionPrices(), PRICE_CHECK_INTERVAL);

    // Kick off initial scans after a short delay
    setTimeout(() => void this.refreshMarketData(), 4_000);
    setTimeout(() => void this.scanNearGraduationTokens(), 6_000);
    setTimeout(() => void this.refreshPumpfunBondingCurves(), 8_000);
    setTimeout(() => void this.refreshOnChainBondingCurves(), 10_000);
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

  // ── PumpPortal WebSocket (free, no API key) ─────────────────────────────────

  private connectPumpPortal(): void {
    try {
      const ws = new WebSocket(PUMPPORTAL_WS_URL);

      ws.on("open", () => {
        this.ppConnected = true;
        this.ppSubscribedMints.clear();
        logger.info("Pump.fun trader: PumpPortal WebSocket connected — subscribing to new tokens");

        // Subscribe to all new token creations
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));

        // Re-subscribe to any tokens already in graduation range
        const nearGrad = Array.from(this.trackedTokens.values())
          .filter((t) => t.graduationPct >= PP_TRADE_SUB_GRAD_PCT)
          .map((t) => t.mint);
        if (nearGrad.length > 0) {
          ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: nearGrad }));
          for (const m of nearGrad) this.ppSubscribedMints.add(m);
        }
      });

      ws.on("message", (raw) => {
        try {
          type PPEvent = {
            txType?: string;
            mint?: string;
            traderPublicKey?: string;
            solAmount?: number;
            marketCapSol?: number;
            name?: string;
            symbol?: string;
            bondingCurveKey?: string;
          };
          const msg = JSON.parse(raw.toString()) as PPEvent;
          if (!msg.mint) return;

          const mint        = msg.mint;
          const txType      = msg.txType ?? "";
          const solAmount   = msg.solAmount   ?? 0;
          const mcapSol     = msg.marketCapSol ?? 0;
          const mcapUsd     = mcapSol * this.solPriceUsd;
          const gradPct     = Math.min((mcapUsd / GRADUATION_MCAP_USD) * 100, 100);
          const trader      = msg.traderPublicKey ?? "unknown";

          if (txType === "create") {
            // Brand-new token launched on pump.fun
            this.initToken(mint, trader);
            const token = this.trackedTokens.get(mint);
            if (token) {
              token.symbol = msg.symbol ?? mint.slice(0, 6);
              token.name   = msg.name   ?? mint.slice(0, 8);
              if (mcapUsd > 0) {
                token.mcap          = mcapUsd;
                token.graduationPct = gradPct;
                token.mcapSnapshots.push({ ts: nowSec(), val: mcapUsd });
              }
            }
            logger.debug({ mint, symbol: msg.symbol, mcapUsd: mcapUsd.toFixed(0) }, "Pump.fun trader: new token via PumpPortal");
          } else if (txType === "buy" || txType === "sell") {
            // Trade on a tracked token
            this.recordActivity(mint, trader, txType === "buy", solAmount);

            // Update mcap from real-time trade data
            const token = this.trackedTokens.get(mint);
            if (token && mcapUsd > 0) {
              token.mcap          = mcapUsd;
              token.graduationPct = gradPct;
              if (token.mcapSnapshots.length === 0 ||
                  nowSec() - token.mcapSnapshots[token.mcapSnapshots.length - 1]!.ts > 30_000) {
                token.mcapSnapshots.push({ ts: nowSec(), val: mcapUsd });
                if (token.mcapSnapshots.length > 20) token.mcapSnapshots.shift();
              }
            }
          }

          // Subscribe to trades for tokens that enter the graduation range
          if (gradPct >= PP_TRADE_SUB_GRAD_PCT && !this.ppSubscribedMints.has(mint) && this.ppConnected) {
            ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
            this.ppSubscribedMints.add(mint);
          }
        } catch { /* ignore parse errors */ }
      });

      ws.on("close", () => {
        this.ppConnected = false;
        this.ppReconnects++;
        logger.warn({ reconnects: this.ppReconnects }, "Pump.fun trader: PumpPortal WS closed, reconnecting…");
        setTimeout(() => this.connectPumpPortal(), RECONNECT_DELAY_MS);
      });

      ws.on("error", (err) => {
        logger.warn({ err: (err as Error).message }, "Pump.fun trader: PumpPortal WS error");
      });

      this.ppWs = ws;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Pump.fun trader: failed to connect PumpPortal");
      setTimeout(() => this.connectPumpPortal(), RECONNECT_DELAY_MS);
    }
  }

  // ── SOL price fetch (for PumpPortal mcapSol → USD conversion) ───────────────

  private async fetchSolPrice(): Promise<void> {
    // Use DexScreener Raydium SOL/USDC pair — always accessible, always accurate
    try {
      type DexPair = { priceUsd?: string; priceNative?: string };
      type DexRes  = { pairs?: DexPair[] } | DexPair[];
      // Raydium SOL/USDC pair — verified 2025-06 with $1.85B liquidity
      const res = await axios.get<DexRes>(
        `${DEXSCREENER_BASE}/latest/dex/pairs/solana/FHZfpXSzm1XrgUQQs9JrqDT3o4QS4M6ebV2wX2YLtRZ8`,
        { timeout: 5_000 },
      );
      const pairs: DexPair[] = Array.isArray(res.data)
        ? res.data
        : (res.data as { pairs?: DexPair[] }).pairs ?? [];
      const price = parseFloat(pairs[0]?.priceUsd ?? "0");
      if (price > 10) {
        this.solPriceUsd = price;
        logger.debug({ solPrice: price.toFixed(2) }, "Pump.fun trader: SOL price updated (DexScreener Raydium)");
        return;
      }
    } catch { /* fall through */ }

    // Fallback: search for SOL/USDC on DexScreener
    try {
      type SearchRes = { pairs?: { priceUsd?: string; chainId?: string; baseToken?: { symbol?: string }; quoteToken?: { symbol?: string }; liquidity?: { usd?: number } }[] };
      const res = await axios.get<SearchRes>(
        `${DEXSCREENER_BASE}/latest/dex/search?q=SOL+USDC`,
        { timeout: 5_000 },
      );
      const pairs = res.data?.pairs ?? [];
      const solUsdc = pairs
        .filter((p) => p.chainId === "solana" && p.baseToken?.symbol === "SOL" && (p.liquidity?.usd ?? 0) > 100_000)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const price = parseFloat(solUsdc?.priceUsd ?? "0");
      if (price > 10) {
        this.solPriceUsd = price;
        logger.debug({ solPrice: price.toFixed(2) }, "Pump.fun trader: SOL price updated (DexScreener search)");
      }
    } catch { /* keep previous price */ }
  }

  // ── Pump.fun-specific bonding curve refresh via DexScreener ─────────────────

  /**
   * DexScreener DOES index pre-graduation pump.fun tokens (dexId = "pumpfun").
   * This refreshes graduation% for tracked tokens by querying their mint addresses.
   */
  private async refreshPumpfunBondingCurves(): Promise<void> {
    // Focus on tokens with low or stale graduation data — these most need refreshing
    const mints = Array.from(this.trackedTokens.keys())
      .filter((m) => {
        const t = this.trackedTokens.get(m)!;
        return t.status !== "graduated" && t.status !== "exited";
      })
      .slice(0, 60); // process up to 60 tokens (2 DexScreener batches)

    if (mints.length === 0) return;

    const batches: string[][] = [];
    for (let i = 0; i < mints.length; i += 30) batches.push(mints.slice(i, i + 30));

    for (const batch of batches) {
      try {
        type DexPair = {
          pairAddress: string;
          dexId?: string;
          baseToken: { address: string; symbol: string; name: string };
          priceUsd: string;
          marketCap?: number;
          fdv?: number;
          pairCreatedAt?: number;
        };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${batch.join(",")}`,
          { timeout: 8_000 },
        );
        const pairs = Array.isArray(res.data) ? res.data : [];
        for (const pair of pairs) {
          if (pair.dexId !== "pumpfun") continue; // only pump.fun pre-graduation pairs
          const mint  = pair.baseToken?.address;
          const token = mint ? this.trackedTokens.get(mint) : undefined;
          if (!token) continue;

          const mcap    = pair.marketCap ?? pair.fdv ?? 0;
          const gradPct = Math.min((mcap / GRADUATION_MCAP_USD) * 100, 100);
          const price   = parseFloat(pair.priceUsd) || 0;

          if (gradPct > 0) token.graduationPct = gradPct;
          if (mcap > 0)    token.mcap          = mcap;
          if (price > 0)   token.priceUsd      = price;
          if (pair.pairAddress) token.pairAddress = pair.pairAddress;
          token.symbol = pair.baseToken.symbol ?? token.symbol;
          token.name   = pair.baseToken.name   ?? token.name;
          token.lastUpdated = Date.now();

          // Mark graduated if mcap exceeds threshold
          if (gradPct >= 100 && token.status !== "bought") {
            token.status = "graduated";
          }
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, "Pump.fun trader: bonding curve refresh error");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * Scan DexScreener for pump.fun pairs in the graduation zone ($45k–$68k mcap).
   * DexScreener indexes all pump.fun pairs with accurate market caps.
   * This discovers near-graduation tokens we haven't seen via PumpPortal.
   */
  private async scanNearGraduationTokens(): Promise<void> {
    if (!this.config.enabled) return;

    // Graduation range in USD: from ~65% graduation to just before graduation
    const GRAD_SCAN_MIN = GRADUATION_MCAP_USD * 0.60; // ~$41k (60% grad)
    const GRAD_SCAN_MAX = GRADUATION_MCAP_USD * 0.995; // ~$68.7k (99.5% grad)

    try {
      // Fetch recently active token profiles from DexScreener — covers recent pump.fun launches
      type DexProfile = {
        chainId?: string;
        tokenAddress?: string;
        url?: string;
        header?: string;
        description?: string;
        links?: unknown[];
      };
      const profilesRes = await axios.get<DexProfile[]>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 6_000 },
      ).catch(() => ({ data: [] as DexProfile[] }));
      const profiles = Array.isArray(profilesRes.data) ? profilesRes.data : [];
      const solanaAddrs = profiles
        .filter((p) => p.chainId === "solana" && p.tokenAddress)
        .map((p) => p.tokenAddress!)
        .slice(0, 60);

      // Also look up pairs via DexScreener search using common pump.fun token patterns
      const searchTerms = ["meme", "pump", "based", "moon", "ai", "dog", "cat"];
      const searchResults: string[] = [];
      for (const term of searchTerms.slice(0, 4)) {
        try {
          type SearchRes = { pairs?: { chainId?: string; dexId?: string; baseToken?: { address?: string }; marketCap?: number; pairCreatedAt?: number }[] };
          const sr = await axios.get<SearchRes>(
            `${DEXSCREENER_BASE}/latest/dex/search?q=${term}`,
            { timeout: 5_000 },
          );
          const matching = (sr.data?.pairs ?? [])
            .filter((p) =>
              p.chainId === "solana" &&
              p.dexId === "pumpfun" &&
              (p.marketCap ?? 0) >= GRAD_SCAN_MIN &&
              (p.marketCap ?? 0) <= GRAD_SCAN_MAX
            )
            .map((p) => p.baseToken?.address)
            .filter(Boolean) as string[];
          searchResults.push(...matching);
        } catch { /* ignore individual search errors */ }
        await new Promise((r) => setTimeout(r, 200));
      }

      // Combine and deduplicate all candidate addresses
      const allMints = Array.from(new Set([...solanaAddrs, ...searchResults]))
        .filter((m) => !this.trackedTokens.has(m))
        .slice(0, 60);

      if (allMints.length === 0) return;

      // Look up full data for candidates in batches
      const batches: string[][] = [];
      for (let i = 0; i < allMints.length; i += 30) batches.push(allMints.slice(i, i + 30));

      let discovered = 0;
      for (const batch of batches) {
        try {
          type DexPair = {
            pairAddress: string;
            dexId?: string;
            baseToken: { address: string; symbol: string; name: string };
            priceUsd: string;
            marketCap?: number;
            fdv?: number;
            pairCreatedAt?: number;
          };
          const res = await axios.get<DexPair[]>(
            `${DEXSCREENER_BASE}/tokens/v1/solana/${batch.join(",")}`,
            { timeout: 8_000 },
          );
          const pairs = Array.isArray(res.data) ? res.data : [];

          for (const pair of pairs) {
            if (pair.dexId !== "pumpfun") continue; // only pre-graduation pump.fun pairs
            const mint = pair.baseToken?.address;
            if (!mint || this.trackedTokens.has(mint)) continue;

            const mcap    = pair.marketCap ?? pair.fdv ?? 0;
            const gradPct = Math.min((mcap / GRADUATION_MCAP_USD) * 100, 100);
            if (gradPct < 60) continue; // below our interest threshold

            const price = parseFloat(pair.priceUsd) || 0;

            this.initToken(mint, "unknown");
            const t = this.trackedTokens.get(mint)!;
            t.symbol        = pair.baseToken.symbol ?? mint.slice(0, 6);
            t.name          = pair.baseToken.name   ?? mint.slice(0, 8);
            t.graduationPct = gradPct;
            t.mcap          = mcap;
            t.priceUsd      = price;
            t.pairAddress   = pair.pairAddress ?? "";
            t.lastUpdated   = Date.now();
            discovered++;

            // Immediately subscribe to live trades for this token via PumpPortal
            if (this.ppConnected && this.ppWs && !this.ppSubscribedMints.has(mint)) {
              this.ppWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
              this.ppSubscribedMints.add(mint);
            }

            logger.debug({ mint, symbol: t.symbol, gradPct: gradPct.toFixed(1), mcap: mcap.toFixed(0) },
              "Pump.fun trader: near-graduation token discovered via DexScreener");
          }
        } catch { /* ignore batch errors */ }
        await new Promise((r) => setTimeout(r, 250));
      }

      if (discovered > 0) {
        logger.info({ discovered }, "Pump.fun trader: near-graduation scanner found new tokens ✅");
      }
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "Pump.fun trader: near-grad scan error");
    }
  }

  // ── On-chain bonding curve reader (Solana RPC) ───────────────────────────────

  /**
   * Derive the pump.fun bonding curve PDA for a given mint.
   * Algorithm: SHA256(b"bonding-curve" || mintBytes || nonce || programIdBytes || b"ProgramDerivedAddress")
   * where nonce decrements from 255 until the hash is NOT a valid Ed25519 point.
   * Uses only Node.js built-in crypto — no Solana SDK required.
   */
  private computeBondingCurvePda(mint: string): string {
    if (this.pdaCache.has(mint)) return this.pdaCache.get(mint)!;

    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    // Base58 decode to Buffer
    function b58Dec(s: string): Buffer {
      let n = 0n;
      for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad b58"); n = n * 58n + BigInt(i); }
      const out: number[] = [];
      while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
      const leading = s.match(/^1*/)?.[0]?.length ?? 0;
      return Buffer.concat([Buffer.alloc(leading), Buffer.from(out)]);
    }

    // Base58 encode
    function b58Enc(buf: Buffer): string {
      if (buf.length === 0) return "";
      let n = BigInt("0x" + buf.toString("hex"));
      let s = "";
      while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
      const leading = buf.findIndex((b) => b !== 0);
      return "1".repeat(leading < 0 ? buf.length : leading) + s;
    }

    // Ed25519 off-curve check — a valid PDA hash must NOT be a valid curve point
    // Uses the curve equation: x² = (y²-1) / (d·y²+1) mod p
    const P255 = (1n << 255n) - 19n;
    const D_ED = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

    function mpow(base: bigint, exp: bigint, mod: bigint): bigint {
      let r = 1n; base %= mod;
      for (; exp > 0n; exp >>= 1n) { if (exp & 1n) r = r * base % mod; base = base * base % mod; }
      return r;
    }

    function isOnCurve(bytes: Buffer): boolean {
      // Extract y (little-endian, clear sign bit)
      const y = BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")) & ((1n << 255n) - 1n);
      const y2 = y * y % P255;
      const u  = (y2 - 1n + P255) % P255;
      const v  = (D_ED * y2 + 1n) % P255;
      const x2 = u * mpow(v, P255 - 2n, P255) % P255;
      if (x2 === 0n) return u === 0n; // identity point only if y=±1
      return mpow(x2, (P255 - 1n) / 2n, P255) === 1n; // Legendre symbol
    }

    const mintBytes    = b58Dec(mint);
    const programBytes = b58Dec(PUMPFUN_PROGRAM_ID);
    const marker       = Buffer.from("ProgramDerivedAddress");
    const seed         = Buffer.from("bonding-curve");

    for (let nonce = 255; nonce >= 0; nonce--) {
      const h = createHash("sha256");
      h.update(seed);
      h.update(mintBytes);
      h.update(Buffer.from([nonce]));
      h.update(programBytes);
      h.update(marker);
      const digest = h.digest();
      if (!isOnCurve(digest)) {
        const pda = b58Enc(digest);
        this.pdaCache.set(mint, pda);
        return pda;
      }
    }
    throw new Error(`PDA not found for mint ${mint}`);
  }

  /**
   * Read bonding curve accounts directly from Solana blockchain.
   * Uses getMultipleAccounts (up to 100 per call) for efficiency.
   * Bonding curve account layout (after 8-byte discriminator):
   *   [8]  virtualTokenReserves  u64
   *   [16] virtualSolReserves    u64
   *   [24] realTokenReserves     u64
   *   [32] realSolReserves       u64  ← graduation progress source
   *   [40] tokenTotalSupply      u64
   *   [48] complete              bool ← instant graduation detection
   */
  private async refreshOnChainBondingCurves(): Promise<void> {
    const mints = Array.from(this.trackedTokens.keys())
      .filter((m) => {
        const t = this.trackedTokens.get(m)!;
        return t.status !== "graduated" && t.status !== "exited";
      });
    if (mints.length === 0) return;

    // Use Helius RPC if key available (better rate limits), else public mainnet
    const apiKey = process.env["HELIUS_API_KEY"];
    const rpcUrl = apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
      : SOLANA_PUBLIC_RPC;

    // Compute PDA addresses for all tracked tokens (cached after first compute)
    const pdaToMint = new Map<string, string>();
    for (const mint of mints) {
      try {
        const pda = this.computeBondingCurvePda(mint);
        pdaToMint.set(pda, mint);
      } catch { /* skip uncomputable PDAs */ }
    }

    const pdas = Array.from(pdaToMint.keys());
    let graduated = 0, updated = 0;

    // Process in batches of 100 (getMultipleAccounts limit)
    for (let i = 0; i < pdas.length; i += ON_CHAIN_BATCH_SIZE) {
      const batch = pdas.slice(i, i + ON_CHAIN_BATCH_SIZE);
      try {
        type RpcResp = {
          result?: {
            value?: (null | {
              data: [string, string]; // [base64, "base64"]
              executable?: boolean;
            })[];
          };
        };
        const res = await axios.post<RpcResp>(
          rpcUrl,
          {
            jsonrpc: "2.0", id: 1,
            method:  "getMultipleAccounts",
            params:  [batch, { encoding: "base64" }],
          },
          { timeout: 10_000 },
        );

        const values = res.data?.result?.value ?? [];
        for (let j = 0; j < batch.length; j++) {
          const pda   = batch[j];
          const acct  = values[j];
          const mint  = pdaToMint.get(pda);
          if (!mint || !acct) continue;

          const token = this.trackedTokens.get(mint);
          if (!token) continue;

          const data = Buffer.from(acct.data[0], "base64");
          if (data.length < 49) continue; // account too small to be a bonding curve

          // Parse the bonding curve account
          const realSolReserves   = data.readBigUInt64LE(32);
          const complete          = data[48] === 1;

          // Calculate graduation% from actual on-chain data
          const gradPct = complete
            ? 100
            : Math.min(Number(realSolReserves * 100n / GRADUATION_REAL_SOL), 99.9);

          // Update token with authoritative on-chain data
          if (gradPct > token.graduationPct || complete) {
            token.graduationPct = gradPct;
            token.lastUpdated   = Date.now();
            updated++;
          }

          // Handle graduation — flip status immediately
          if (complete && token.status !== "bought") {
            token.status = "graduated";
            token.graduationPct = 100;
            graduated++;
            logger.info(
              { mint, symbol: token.symbol, realSolReserves: realSolReserves.toString() },
              "Pump.fun trader: 🎓 TOKEN GRADUATED (on-chain confirmed)",
            );
          }

          // Subscribe to PumpPortal trades for high-grad tokens not yet subscribed
          if (gradPct >= PP_TRADE_SUB_GRAD_PCT && this.ppConnected && this.ppWs && !this.ppSubscribedMints.has(mint)) {
            this.ppWs.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
            this.ppSubscribedMints.add(mint);
          }
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, "Pump.fun trader: on-chain bonding curve read error");
      }
      // Pace RPC calls — respect rate limits
      if (i + ON_CHAIN_BATCH_SIZE < pdas.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (updated > 0 || graduated > 0) {
      logger.info(
        { updated, graduated, rpc: apiKey ? "helius" : "public" },
        "Pump.fun trader: on-chain bonding curves refreshed ⛓️",
      );
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
    // Get ALL tracked tokens (no outer slice — the bug was here!)
    const mints = Array.from(this.trackedTokens.keys());
    if (mints.length === 0) return;

    // Batch into groups of 30 (DexScreener limit per request)
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

    // Whether this token has meaningful live tx history (vs just discovered via DexScreener scan)
    const hasTxHistory = token.txHistory.length >= 5;

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
      } else {
        // No mcap history yet — use graduation % itself as a speed proxy.
        // A token at 90% filled the bonding curve fast; treat it as solid progress.
        scores.graduationSpeed = Math.min(token.graduationPct * 0.8, 80);
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
      } else if (!hasTxHistory) {
        scores.volumeAcceleration = 50; // neutral — no data, don't punish
      }
    }

    // 3. Unique Buyer Growth (15%) — new unique buyers in last 5m
    {
      const recent5m = token.txHistory.filter((h) => h.ts >= now - 5 * 60_000 && h.isBuy);
      const recentBuyers = new Set(recent5m.map((h) => h.wallet)).size;
      if (recentBuyers > 0) {
        // Scale: >20 unique buyers in 5m = 100, 10 = 60, 5 = 30
        scores.uniqueBuyerGrowth = Math.min(recentBuyers * 5, 100);
      } else if (!hasTxHistory) {
        scores.uniqueBuyerGrowth = 50; // neutral — no data, don't punish
      }
    }

    // 4. Transaction Velocity (10%) — txns per minute in last 5m
    {
      const txs5m  = txsInWindow(token.txHistory, 5 * 60_000);
      const txPerMin = txs5m / 5;
      if (txPerMin > 0) {
        // Scale: >10 tx/min = 100, 5 = 60, 2 = 30
        scores.txVelocity = Math.min(txPerMin * 10, 100);
      } else if (!hasTxHistory) {
        scores.txVelocity = 50; // neutral — no data, don't punish
      }
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
      } else if (!hasTxHistory) {
        scores.mcapAcceleration = 50; // neutral — not enough snapshots yet
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
        scores.holderDistribution = 55; // slight positive neutral if no data
      }
    }

    // 7. Whale Accumulation (10%) — large buy sizes indicate conviction
    {
      const recent = token.txHistory.filter((h) => h.isBuy && h.ts >= now - 5 * 60_000);
      if (recent.length > 0) {
        const maxBuy = Math.max(...recent.map((h) => h.solAmount));
        // Scale: >1 SOL = 100, 0.5 SOL = 70, 0.1 SOL = 30
        scores.whaleAccumulation = Math.min(maxBuy * 80, 100);
      } else if (!hasTxHistory) {
        scores.whaleAccumulation = 50; // neutral — no data, don't punish
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
      } else if (!hasTxHistory) {
        scores.momentumStrength = 55; // slight positive neutral if no data
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

    // 5. Holder growth stagnation — only apply if we have enough tx history to make this meaningful
    //    Near-graduation tokens discovered via DexScreener scan arrive with 0 txs — don't penalise them
    const ageMs = now - token.firstSeen;
    if (ageMs > 10 * 60_000 && token.graduationPct >= 80 && token.txHistory.length >= 10) {
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
      if (token.status === "bought" || token.status === "graduated" || token.status === "exited" || token.status === "rejected") continue;

      // Calculate score
      const breakdown = this.scoreToken(token);
      token.score          = breakdown.total;
      token.scoreBreakdown = breakdown;

      const gradPct = token.graduationPct;
      const cfg     = this.config;

      // Graduation-proximity scoring:
      // Near-graduation tokens discovered via DexScreener may have no tx history,
      // so raw scores are near-zero. The bonding curve progress IS the signal here —
      // the more SOL has filled the curve, the higher conviction on graduation.
      let effectiveScore = token.score;

      if (gradPct >= PF_CLOSE_GRAD_PCT) {
        // Tier 2 (92%+): token is extremely close to graduating — auto-qualify it.
        // Bonding curve is 92%+ filled; graduation is imminent. Score is irrelevant.
        effectiveScore = Math.max(effectiveScore, cfg.minAiScore + 5);
      } else if (gradPct >= PF_NEAR_GRAD_PCT) {
        // Tier 1 (80-92%): significant progress — give a large proximity bonus so
        // that tokens with thin tx history can still clear the minAiScore threshold.
        const proximityBonus = Math.min((gradPct - PF_NEAR_GRAD_PCT) * 5, 40); // up to +40 at 88%+
        effectiveScore = Math.min(100, effectiveScore + proximityBonus);
        // Also ensure at least minAiScore-10 so a token at 85%+ with neutral signals can still enter
        effectiveScore = Math.max(effectiveScore, cfg.minAiScore - 10);
      } else if (gradPct >= cfg.graduationMinPct) {
        // Standard zone (graduationMinPct to 80%): smaller bonus
        const proximityBonus = Math.min((gradPct - cfg.graduationMinPct) * 2, 10);
        effectiveScore = Math.min(100, effectiveScore + proximityBonus);
      }

      // Update status using effective score (includes proximity bonus)
      if (gradPct >= cfg.graduationMinPct && gradPct <= cfg.graduationMaxPct) {
        token.status = effectiveScore >= cfg.minAiScore ? "buySignal" : "candidate";
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

    // FIX 6: No new entries during night session (11pm–6am IST)
    if (isPfNightSession()) {
      logger.info({ mint: token.mint, symbol: token.symbol }, "Pump.fun trader: night session (11pm–6am IST) — skipping entry");
      return;
    }

    const tokenAgeMs = Date.now() - token.firstSeen;
    const gradPct    = token.graduationPct;

    // Age check — near-graduation tokens are allowed to be older because they
    // spent time climbing the bonding curve before we discovered them.
    // Tier 2 (92%+): skip age check entirely — imminent graduation overrides everything
    // Tier 1 (85-92%): allow up to 4 hours
    // Normal (graduationMinPct - 85%): allow up to 90 min
    const maxAgeMs = gradPct >= PF_CLOSE_GRAD_PCT
      ? Infinity
      : gradPct >= PF_NEAR_GRAD_PCT
        ? PF_MAX_AGE_NEAR_GRAD_MS
        : PF_MAX_AGE_MS;

    if (tokenAgeMs > maxAgeMs) {
      logger.info(
        { mint: token.mint, symbol: token.symbol, ageMin: (tokenAgeMs / 60_000).toFixed(1), gradPct: gradPct.toFixed(1) },
        "Pump.fun trader: token too old for this graduation tier — skipping",
      );
      return;
    }

    // Tx count check — near-graduation tokens discovered via DexScreener scan arrive
    // with 0 tx history in our system. Their bonding curve progress is sufficient signal.
    // For ANY token in the graduation entry zone (graduationMinPct%+): require 0 txs
    // Below that: require at least PF_MIN_TX_COUNT (5) txs before entry
    const txCount    = token.txHistory.length;
    const minTxCount = gradPct >= this.config.graduationMinPct ? PF_MIN_TX_NEAR_GRAD : PF_MIN_TX_COUNT;
    if (txCount < minTxCount) {
      logger.info(
        { mint: token.mint, symbol: token.symbol, txCount, minTxCount, gradPct: gradPct.toFixed(1) },
        "Pump.fun trader: insufficient transactions — skipping",
      );
      return;
    }

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

    // ── CONFIRMED TRADE LOG ─────────────────────────────────────────────────
    logger.info({
      type:       "TRADE_OPEN",
      tag:        "PRE-GRAD",
      mint:       token.mint,
      symbol:     token.symbol,
      name:       token.name,
      entryPrice: price,
      sizeSol,
      slPrice,
      gradPct:    token.graduationPct.toFixed(1) + "%",
      mcapUsd:    token.mcap.toFixed(0),
      aiScore:    token.score,
      txCount,
      ageMin:     (tokenAgeMs / 60_000).toFixed(1),
      balance:    this.virtualBalance.toFixed(4) + " SOL (after)",
    }, "┌─ PUMP.FUN PRE-GRAD ENTRY ──────────────────────────────────┐");
    logger.info({
      symbol: token.symbol,
      entryUsd: `$${price.toFixed(8)}`,
      stagedSL: `Phase 1: -20% in 2m | Phase 2: -25% from peak | Phase 3: -30% from peak`,
      grad: `${token.graduationPct.toFixed(1)}%`,
    }, "│  Entered PRE-GRAD position — staged SL active             │");

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🟣 <b>PRE-GRAD ENTRY [85%+ BONDING]</b>\n──────────────────────\n` +
        `🪙 Token: <b>${token.symbol}</b> / ${token.name}\n` +
        `📋 CA: <code>${token.mint}</code>\n` +
        `🏆 AI Score: <b>${token.score}/100</b>\n` +
        `🎓 Graduation: <b>${token.graduationPct.toFixed(1)}%</b>\n` +
        `💰 Market Cap: ${fmtMcap(token.mcap)}\n` +
        `📊 Volume (5m): ${volInWindow(token.txHistory, 5 * 60_000).toFixed(3)} SOL\n` +
        `👥 Unique Buyers: ${token.uniqueBuyers.length} | TXs: ${txCount}\n` +
        `⏱️ Token Age: ${(tokenAgeMs / 60_000).toFixed(1)}m\n` +
        `💵 Entry: $${fmt4(price)} | Size: ${sizeSol} SOL\n` +
        `🛡️ Staged SL: -20% (2m) → -25% peak → -30% peak\n` +
        `🎯 TP1: +${TP1_PCT}% | TP2: +${TP2_PCT}%\n` +
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
    // ── CONFIRMED TRADE LOG ─────────────────────────────────────────────────
    logger.info({
      type:       "TRADE_CLOSE",
      mint:       pos.mint,
      symbol:     pos.symbol,
      reason,
      entryPrice: pos.entryPrice,
      exitPrice:  price,
      pnlSol:     (isWin ? "+" : "") + pnlSol.toFixed(4) + " SOL",
      pnlPct:     (isWin ? "+" : "") + pnlPct.toFixed(1) + "%",
      sizeSol:    pos.sizeSol,
      entryGrad:  pos.entryGraduationPct.toFixed(1) + "%",
      balance:    this.virtualBalance.toFixed(4) + " SOL (after)",
    }, isWin
      ? "└─ PUMP.FUN CLOSE ✅ WIN ──────────────────────────────────────┘"
      : "└─ PUMP.FUN CLOSE ❌ LOSS ─────────────────────────────────────┘");

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

      // FIX 5: Always update trailing high (not just after TP2)
      if (price > pos.trailingHigh) pos.trailingHigh = price;

      // FIX 5: Staged SL — replaces 60s early exit + fixed SL
      const dropFromEntry = (1 - price / pos.entryPrice) * 100;
      const dropFromPeak  = pos.trailingHigh > 0 ? (1 - price / pos.trailingHigh) * 100 : 0;
      let stagedSLHit = false;

      if (!pos.tp2Hit) {
        if (pos.tp1Hit) {
          if (dropFromPeak >= PF_STAGED_AFTER_TP1) {
            this.closePosition(pos, `Staged SL: -${dropFromPeak.toFixed(0)}% from TP1 peak`, price);
            stagedSLHit = true;
          }
        } else if (ageMs <= PF_STAGED_PHASE1_MS) {
          if (dropFromEntry >= PF_STAGED_PHASE1_PCT) {
            this.closePosition(pos, `Staged SL: -${dropFromEntry.toFixed(0)}% in first 2m`, price);
            stagedSLHit = true;
          }
        } else if (ageMs <= PF_STAGED_PHASE2_MS) {
          if (dropFromPeak >= PF_STAGED_PHASE2_PCT) {
            this.closePosition(pos, `Staged SL: -${dropFromPeak.toFixed(0)}% from peak (2-10m)`, price);
            stagedSLHit = true;
          }
        } else {
          if (dropFromPeak >= PF_STAGED_PHASE3_PCT) {
            this.closePosition(pos, `Staged SL: -${dropFromPeak.toFixed(0)}% from peak (>10m)`, price);
            stagedSLHit = true;
          }
        }
      }
      if (stagedSLHit) {
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🛑 <b>PRE-GRAD STAGED SL</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
            `📉 Drop from ${pos.tp1Hit ? "TP1 peak" : ageMs <= PF_STAGED_PHASE1_MS ? "entry (2m)" : "peak"}\n` +
            `💵 Entry: $${fmt4(pos.entryPrice)} → Exit: $${fmt4(price)}\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
        continue;
      }

      // FIX 5: Exit if graduation % drops below 80% after entry (rug signal)
      // Guard: bonding curves can NEVER go backward by more than ~30 pp — a larger
      // drop is stale/corrupt on-chain data, NOT a real graduation drop. Skip the
      // exit to avoid false positives (e.g. 88% entry reading 26% = stale RPC node).
      if (token && !pos.tp1Hit && token.graduationPct < PF_GRAD_MIN_AFTER_ENTRY) {
        const dropFromEntry = pos.entryGraduationPct - token.graduationPct;
        if (dropFromEntry > 30) {
          // Impossible real drop — stale/corrupt RPC data, skip exit
          logger.warn(
            { mint: pos.mint, symbol: pos.symbol, entryGrad: pos.entryGraduationPct, currentGrad: token.graduationPct.toFixed(1) },
            "Pump.fun trader: ignoring impossible grad drop (>30pp from entry) — likely stale RPC data",
          );
        } else {
          logger.warn(
            { mint: pos.mint, symbol: pos.symbol, gradPct: token.graduationPct.toFixed(1) },
            "Pump.fun trader: graduation % dropped below 80% after entry — exiting",
          );
          if (isTelegramConfigured()) {
            void sendTelegram(
              `⚠️ <b>PRE-GRAD GRAD DROP EXIT</b>\n──────────────────────\n` +
              `🪙 Token: <b>${pos.symbol}</b>\n📋 CA: <code>${pos.mint}</code>\n` +
              `🎓 Graduation dropped to <b>${token.graduationPct.toFixed(1)}%</b> (below 80%)\n` +
              `⚠️ Possible bonding curve manipulation — exiting\n🕐 ${toIST(new Date())}`,
            );
          }
          this.closePosition(pos, `Grad Drop Below 80% (${token.graduationPct.toFixed(1)}%)`, price);
          continue;
        }
      }

      // TP2 trailing stop (moonbag)
      if (pos.tp2Hit && pos.trailingHigh > 0) {
        const trailTrigger = pos.trailingHigh * (1 - TRAILING_PCT / 100);
        if (price <= trailTrigger) {
          this.closePosition(pos, "Trailing Stop (moonbag)", price);
          continue;
        }
      }

      // TP1 — FIX 5: +200%, sell 25%
      if (!pos.tp1Hit && price >= tp1Price) {
        pos.tp1Hit = true;
        this.partialClose(pos, TP1_CLOSE_PCT / 100, price, `TP1 (+${TP1_PCT}%)`);
        pos.effectiveSlPrice = pos.entryPrice; // kept for reference

        if (isTelegramConfigured()) {
          void sendTelegram(
            `🟢 <b>PRE-GRAD TP1 HIT</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `📈 Price: +${TP1_PCT}% from entry\n` +
            `💰 ${TP1_CLOSE_PCT}% sold — 35% trail now active\n` +
            `🛡️ SL at breakeven | TP2: +${TP2_PCT}%\n🕐 ${toIST(new Date())}`,
          );
        }
        void this.savePosition(pos);
      }

      // TP2 — FIX 5: +500%, sell 25%
      if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
        pos.tp2Hit       = true;
        pos.trailingHigh = price;
        this.partialClose(pos, TP2_CLOSE_PCT / 100, price, `TP2 (+${TP2_PCT}%)`);

        if (isTelegramConfigured()) {
          void sendTelegram(
            `🚀 <b>PRE-GRAD TP2 HIT</b>\n──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `🌙 Price: +${TP2_PCT}% from entry\n` +
            `💰 ${TP2_CLOSE_PCT}% sold — moonbag active\n` +
            `🎯 Trailing Stop: ${TRAILING_PCT}% below peak\n🕐 ${toIST(new Date())}`,
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
      wsConnected:  this.wsConnected,
      wsReconnects: this.wsReconnects,
      ppConnected:  this.ppConnected,
      ppReconnects: this.ppReconnects,
      solPriceUsd:  this.solPriceUsd,
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
