import WebSocket from "ws";
import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { blacklistService } from "./blacklist.service.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";
import { solanaWalletService } from "./solana-wallet.service.js";
import { jupiterSwapService } from "./jupiter-swap.service.js";

// ── Constants ────────────────────────────────────────────────────────────────
const MIGRATION_WALLET   = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const RECONNECT_DELAY_MS  = 1_000;
// If the WS is "connected" (TCP ping keeps it alive) but no JSON messages
// have arrived in this window, Helius has silently dropped the subscription.
// Force-reconnect to restore it.  Set conservatively vs graduation frequency
// (~1–5 min during active hours) so quiet periods don't cause false triggers.
// 5 min avoids false-reconnects during normal low-activity windows (2 min was
// too aggressive — it caused 9+ reconnects per session during quiet hours).
const SILENT_DEATH_MS     = 5 * 60_000; // 5 minutes (was 2 — too many false reconnects)
const DETECTION_WATCHDOG_MS = 60_000;   // check / log every 60 s
const MAX_EVENTS         = 50;
const MAX_CLOSED         = 100_000; // effectively unlimited — all trades kept in memory
const CONFIG_KEY         = "sniper_config";

// ── Adaptive price-check intervals ───────────────────────────────────────────
const PRICE_LOOP_MS         = 3_000;          // main loop tick — 3 s (was 10s — faster SL/TP)
const FAST_WINDOW_MS        = 30 * 60_000;    // first 30 min  → check every 3 s
const MED_WINDOW_MS         = 2 * 60 * 60_000;// 30 min–2 h    → check every 10 s
const FAST_INTERVAL_MS      = 3_000;          // was 10s — tightened for faster SL/TP execution
const MED_INTERVAL_MS       = 10_000;         // was 30s
const SLOW_INTERVAL_MS      = 30_000;         // was 60s

// ── Dead-position threshold ───────────────────────────────────────────────────
const DEAD_POSITION_MS      = 2 * 60 * 60_000;// 2 h open with no movement
const DEAD_MOVE_PCT         = 5;              // < 5 % move = "dead"

// ── Minimum SOL reserve needed above positionSizeSol ─────────────────────────
// Covers ALL transaction overhead so the bot never attempts a trade it cannot pay for:
//   • Token account rent   ≈ 0.00204 SOL (Solana charges this to create a new
//                                         token account; Jupiter adds it automatically)
//   • Solana base TX fee   ≈ 0.000005 SOL per transaction × 2 (buy + sell)
//   • Small safety buffer  ≈ 0.0005 SOL
// Total conservative reserve = 0.003 SOL (regardless of priority fee — that is
// already included in positionSizeSol-equivalent cost from Jupiter's quote).
const TX_OVERHEAD_SOL = 0.003;

// ── Sell failure give-up threshold ────────────────────────────────────────────
// After this many consecutive cross-tick sell failures for the same position,
// force a virtual close and alert via Telegram so the user can manually sell
// via Phantom. Prevents infinite retry loops draining SOL on fees when the
// Raydium pool is dead/drained (Custom: 6024 / ExceededSlippage errors).
const MAX_SELL_FAILS = 15;

// ── Instant-rug detection constants (pre-entry) ───────────────────────────────
// SPEED: reduced from 8s → 3s.  The rug-check window only needs to be long enough
// to see a post-graduation dump; 3s catches the sharp rugs while saving 5s of
// latency on every valid entry.  Jupiter buy retries cover the smaller waitBeforeEntry
// reduction (5s → 2s) — if the route isn't indexed in 2s the first quote attempt
// will fail and withRetry will reattempt after 800ms, effectively acting as a
// dynamic wait rather than a hard sleep.
const RUG_CHECK_WAIT_MS     = 0;              // 0ms gap — enter as fast as possible; gate handles pool confirmation
const RUG_DROP_ABORT_PCT    = 20;             // abort entry if price drops ≥ 20% in that window

// ── Entry drift / momentum filters ────────────────────────────────────────────
// After the 5s+8s pre-entry wait the token may have already spiked significantly.
// Buying into the tail of a spike is the root cause of instant SL hits (we enter
// at 2× the graduation price, SL is set from there, first pullback kills us).
//
// ENTRY_DRIFT_ABORT_PCT: if price rose > this % from the baseline reading, abort.
//   8% means we'll skip tokens that already ran +8% during our 13s of checks.
//
// MOMENTUM_SKIP_PCT: if price rose > this % we explicitly label it "Missed entry"
//   (separate label helps distinguish "pumping too fast" from "drift + filters").
const ENTRY_DRIFT_ABORT_PCT  = 20;             // abort buy if price rose > 20% from baseline
const MOMENTUM_SKIP_PCT      = 20;             // label as "Missed entry" if > 20% from baseline
// POST-FILL circuit breaker: if the actual Jupiter fill price is > this % above the
// detection baseline, the buy chased the pump too hard. Emergency-sell immediately and
// release seenMints so the token can be reconsidered on the next graduation event.
const MAX_FILL_DRIFT_PCT     = 20;             // emergency-sell if fill > 20% above detection price

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

// ── Low-liquidity hours (11pm–6am IST = 17:30–00:30 UTC) ─────────────────────
// During overnight trading apply stricter entry filters — thinner markets increase rug risk.
const LOW_LIQ_MIN_POOL_SOL      = 20;         // stricter pool SOL (vs 10 during normal hours)
const LOW_LIQ_MIN_LIQUIDITY_USD = 3_000;      // minimum DexScreener liquidity USD in quiet hours
const NORMAL_MIN_LIQUIDITY_USD  = 500;        // minimum DexScreener liquidity USD in active hours

// ── Health heartbeat ──────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS     = 15 * 60_000; // Telegram ping every 15 minutes

// ── Stale price guard ─────────────────────────────────────────────────────────
// If a position's price hasn't updated in >5s, skip TP/SL for that tick to
// avoid acting on stale data (e.g. DexScreener batch call failed for one token).
const STALE_PRICE_MS            = 5_000;

// ── Batch DexScreener ─────────────────────────────────────────────────────────
// DexScreener /tokens/v1/solana/{addr1},{addr2}... allows up to 30 per request.
// Batching all due positions into one request cuts DexScreener calls from
// N (one per position) down to ceil(N/30) — massively reduces rate-limit risk.
const BATCH_DEXSCREENER_MAX     = 30;

// ── Jupiter Price API (fallback for tokens not yet indexed on DexScreener) ────
const JUPITER_PRICE_URL         = "https://lite-api.jup.ag/price/v2";


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
  slippageBps: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
}

const DEFAULT_CONFIG: SniperConfig = {
  enabled:              true,
  positionSizeSol:      0.002,   // small default — safe for wallets starting with 0.06 SOL (needs positionSize + 0.003 overhead)
  maxOpenPositions:     5,
  slPct:                40,
  tp1Pct:               150,
  tp1ClosePct:          40,
  tp2Pct:               400,
  tp2ClosePct:          40,
  trailingStopPct:      30,
  waitBeforeEntryMs:    0,       // 0ms — enter as fast as possible after detection
  slippageBps:          3000,    // quote slippage for route-finding only; swap uses fixed SWAP_SLIPPAGE_BPS (5000 = 50% floor)
  priorityFeeLamports:  500_000, // 0.0005 SOL floor — Helius p75 used at runtime (old 50k was too low)
  jitoTipLamports:      100_000, // 0.0001 SOL Jito tip — bundles land in 1-2 slots (~400-800ms) vs 30-40s standard confirm
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
  tokenAmount: number;       // raw token units received on buy (for selling later)
  // Separate entry/exit tx signatures for on-chain verification
  entrySig: string;          // buy tx — set at entry, never overwritten
  exitSig?: string;          // sell tx — only set after confirmed on-chain sell
  // P&L breakdown per stage
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
  // Entry drift / latency analysis
  detectionPrice?: number;   // first DexScreener price after 5s wait — baseline for drift%
  entryDriftPct?: number;    // (fillPrice - detectionPrice) / detectionPrice × 100
  msDetectionToFill?: number; // ms from graduation detected → buy confirmed on-chain
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
  lastWsMessageAt: number;     // ms epoch; 0 = never received a message this session
  enabled: boolean;
  graduationsToday: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  capitalInOpen: number;
  walletBalance: number;
  walletAddress: string;
  walletReady: boolean;
  openCount: number;
  config: SniperConfig;
}

// ── Service ──────────────────────────────────────────────────────────────────

class GraduationSniperService {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private subscriptionId: number | null = null;
  private programSubscriptionId: number | null = null;
  private paperCallback: ((mint: string, entryPrice: number, symbol: string, name: string, detectedAt: number, detectionPrice: number) => void) | null = null;
  private priceIntervalId: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  // Stored so the silent-death watchdog can trigger reconnects without having
  // the apiKey passed via closure.
  private heliusApiKey: string | null = null;
  // Timestamp of the last JSON message received from Helius (subscription
  // confirmation counts).  0 = never received a message this session.
  private lastWsMessageAt = 0;
  // Watchdog that logs a 60s heartbeat and force-reconnects if the subscription
  // goes silent for > SILENT_DEATH_MS (the TCP layer stays up due to pings, so
  // wsConnected stays true even when Helius has silently dropped the subscription).
  private detectionWatchdogId: ReturnType<typeof setInterval> | null = null;

  // WebSocket broadcaster — set by the WS server after init so the sniper
  // can push real-time updates to all connected frontend clients.
  private broadcaster: (() => void) | null = null;
  // Interval for detecting external sells (e.g. via Phantom wallet)
  private externalSellCheckId: ReturnType<typeof setInterval> | null = null;

  setBroadcaster(fn: () => void): void {
    this.broadcaster = fn;
  }

  private broadcast(): void {
    try { this.broadcaster?.(); } catch { /* ignore */ }
  }

  private config: SniperConfig = { ...DEFAULT_CONFIG };
  private openPositions: Map<string, SniperPosition> = new Map();
  private closedPositions: SniperPosition[] = [];
  private events: SniperEvent[] = [];

  private graduationsToday = 0;
  private lastDayReset = new Date().toDateString();
  private seenMints: Set<string> = new Set();
  private walletBalanceSol = 0; // refreshed from Solana RPC each price loop

  // ALL-time accumulators — NOT limited by MAX_CLOSED so P&L stays accurate
  // even after the in-memory closed-positions list is trimmed.
  private allTimeRealizedSol = 0;
  private allTimeWins = 0;
  private allTimeLosses = 0;

  // Adaptive price-check intervals
  private lastPositionCheckAt: Map<string, number> = new Map();
  // Concurrency guard — prevents duplicate TP/SL executions during async gaps
  private processingMints: Set<string> = new Set();
  // Closing guard — mints whose sell is in-flight; position stays in openPositions
  // so the frontend never sees it disappear, but no second close can start.
  private closingMints: Set<string> = new Set();
  // Concurrency guard — prevents duplicate graduation processing for same mint
  private processingGraduations: Set<string> = new Set();
  // Signature-level dedup — Helius fires multiple logsNotification events for
  // the same TX (one per log entry mentioning the migration wallet).  Without
  // this guard every duplicate fires a separate extractMintFromTx RPC call,
  // burns Helius rate-limit budget, and all but the first show "already in
  // progress" in the UI.  We track at the signature level so only ONE RPC
  // call is ever made per graduation TX.  Capped at 500 entries (FIFO evict)
  // to avoid unbounded memory growth across long-running sessions.
  private seenSignatures: Set<string> = new Set();
  // Cross-tick sell failure counter — incremented each time a close is retried.
  // When it hits MAX_SELL_FAILS the position is force-closed virtually so the
  // infinite fee-draining retry loop is broken (Custom: 6024 dead-pool errors).
  private sellFailCount: Map<string, number> = new Map();
  // FIX 2: Liquidity monitoring — tracks last known liquidity per position
  private liquidityIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastPositionLiquidityUsd: Map<string, number> = new Map();
  // FIX 4: Persistent closed-trade fingerprints — prevents duplicate logs on restart
  private closedTradeFingerprints: Set<string> = new Set();

  // ── Health monitoring & rate counters ──────────────────────────────────────
  private jupiterCallsThisMinute    = 0;
  private dexscreenerCallsThisMinute = 0;
  private jupiterCallsTotal         = 0;
  private dexscreenerCallsTotal     = 0;
  private rateWindowStart           = Date.now();
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private wsPingIntervalId: ReturnType<typeof setInterval> | null = null;  // WS-level ping keepalive
  private startedAt                 = Date.now();

  // ── Stale-price guard ──────────────────────────────────────────────────────
  // Tracks when each position last got a valid price update from DexScreener.
  // If the gap exceeds STALE_PRICE_MS, TP/SL checks are skipped for that tick.
  private lastPriceUpdatedAt: Map<string, number> = new Map();

  // ── Per-position error tracking (for UI badge display) ────────────────────
  private positionLastError: Map<string, string> = new Map();

  // ── Init ───────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadPositions();

    // Correctly restore virtual balance from DB state:
    // start + ALL realized PNL (closed, full history) + partial realized (open TP hits) - remaining capital in open
    // Use allTimeRealizedSol (set by loadPositions from the full DB result) so that
    // trimmed-out positions beyond MAX_CLOSED are still counted.
    const partialFromOpen = Array.from(this.openPositions.values()).reduce((s, p) => s + p.realizedPnlSol, 0);
    const capitalInOpen   = Array.from(this.openPositions.values()).reduce((s, p) => s + p.sizeSol * p.remainingFraction, 0);

    await this.loadClosedFingerprints();

    // Fetch real wallet balance on startup
    this.walletBalanceSol = await solanaWalletService.getBalance();

    // Validate open positions: close any that have no tokens in the actual wallet.
    // These are phantom positions from failed buy TXs that were recorded before on-chain confirmation.
    await this.validateOpenPositions();

    logger.info(
      {
        openPositions:   this.openPositions.size,
        walletBalance:   this.walletBalanceSol.toFixed(4),
        walletAddress:   solanaWalletService.publicKey || "NOT SET",
        walletReady:     solanaWalletService.isReady,
        allTimeRealized: this.allTimeRealizedSol.toFixed(4),
        partialFromOpen: partialFromOpen.toFixed(4),
        capitalInOpen:   capitalInOpen.toFixed(4),
        enabled:         this.config.enabled,
      },
      "Graduation sniper: initialised",
    );
  }

  private async refreshWalletBalance(): Promise<void> {
    this.walletBalanceSol = await solanaWalletService.getBalance();
    this.broadcast(); // push wallet balance to frontend immediately after every refresh
  }

  // ── On-chain actual fill price (most accurate, matches GMGN/Solscan) ─────
  // Parses the confirmed buy TX to get exact SOL spent and exact tokens received.
  // Then computes: entryPriceUSD = (solSpent × SOL/USD) ÷ tokensReceivedUI
  // This is orders-of-magnitude more accurate than DexScreener (which lags 2-5m).
  private async fetchActualBuyAmounts(
    txSignature: string,
    tokenMint: string,
  ): Promise<{ solSpentUi: number; tokensReceivedRaw: number; tokensReceivedUi: number } | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    // Brief pause — Helius indexes confirmed TXs within ~1-2s
    await new Promise((r) => setTimeout(r, 2_000));

    try {
      type TokenBalance = {
        mint: string;
        accountIndex: number;
        uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
      };
      type TxResult = {
        result: {
          transaction?: { message?: { accountKeys?: { pubkey: string }[] } };
          meta?: {
            preBalances?: number[];
            postBalances?: number[];
            preTokenBalances?: TokenBalance[];
            postTokenBalances?: TokenBalance[];
          };
        } | null;
      };

      const res = await axios.post<TxResult>(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [txSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
        },
        { timeout: 15_000 },
      );

      const tx = res.data?.result;
      if (!tx) return null;

      const accountKeys = tx.transaction?.message?.accountKeys ?? [];
      const walletPubkey = solanaWalletService.publicKey;
      const walletIndex  = accountKeys.findIndex((k) => k.pubkey === walletPubkey);
      if (walletIndex === -1) return null;

      // Actual SOL deducted from wallet (lamports → SOL)
      const preSol  = (tx.meta?.preBalances?.[walletIndex]  ?? 0) / 1_000_000_000;
      const postSol = (tx.meta?.postBalances?.[walletIndex] ?? 0) / 1_000_000_000;
      const solSpentUi = Math.max(0, preSol - postSol);

      // Actual tokens received (raw = lamport-equivalent units; ui = human-readable)
      const postBals = tx.meta?.postTokenBalances ?? [];
      const preBals  = tx.meta?.preTokenBalances  ?? [];
      const postEntry = postBals.find((b) => b.mint === tokenMint);
      const preEntry  = preBals.find( (b) => b.mint === tokenMint);
      const tokensReceivedRaw = Number(postEntry?.uiTokenAmount.amount ?? 0) - Number(preEntry?.uiTokenAmount.amount ?? 0);
      // uiAmount can be null for very small balances — compute it from raw + decimals as fallback
      const decimals = postEntry?.uiTokenAmount.decimals ?? 6;
      const postUi   = postEntry?.uiTokenAmount.uiAmount ?? (Number(postEntry?.uiTokenAmount.amount ?? 0) / Math.pow(10, decimals));
      const preUi    = preEntry?.uiTokenAmount.uiAmount  ?? (Number(preEntry?.uiTokenAmount.amount  ?? 0) / Math.pow(10, decimals));
      const tokensReceivedUi = postUi - preUi;

      if (solSpentUi <= 0 || tokensReceivedRaw <= 0 || tokensReceivedUi <= 0) return null;

      logger.info(
        { txSignature: txSignature.slice(0, 20), tokenMint, solSpentUi, tokensReceivedRaw, tokensReceivedUi },
        "Graduation sniper: on-chain buy amounts fetched ✅",
      );
      return { solSpentUi, tokensReceivedRaw, tokensReceivedUi };
    } catch (err) {
      logger.warn({ txSignature: txSignature.slice(0, 20), err: (err as Error).message }, "Graduation sniper: fetchActualBuyAmounts failed");
      return null;
    }
  }

  // Fetches current SOL/USD price from DexScreener (USDC pair, very low lag).
  // Used together with on-chain token amounts to compute true fill price.
  private async fetchSolUsdPrice(): Promise<number | null> {
    try {
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      type DexPair = { priceUsd: string; quoteToken?: { symbol: string } };
      const res = await axios.get<DexPair[]>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${SOL_MINT}`,
        { timeout: 5_000 },
      );
      const pairs = Array.isArray(res.data) ? res.data : [];
      const usdcPair = pairs.find((p) => p.quoteToken?.symbol === "USDC") ?? pairs[0];
      const price = parseFloat(usdcPair?.priceUsd ?? "0");
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  // ── Startup phantom-position cleanup ─────────────────────────────────────
  // Queries on-chain token balance for each open position. Any position with
  // 0 tokens in the wallet is a phantom (buy TX failed but was recorded anyway).
  // These are closed as a loss so the dashboard shows accurate real P&L.
  private async fetchWalletTokenBalance(mint: string): Promise<number | null> {
    if (!solanaWalletService.isReady || !solanaWalletService.publicKey) return null;
    try {
      const walletPubkey = new PublicKey(solanaWalletService.publicKey);
      const mintPubkey   = new PublicKey(mint);
      const accounts     = await solanaWalletService.connection.getParsedTokenAccountsByOwner(
        walletPubkey,
        { mint: mintPubkey },
        "confirmed",
      );
      const total = accounts.value.reduce((sum, acc) => {
        const parsed = acc.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } };
        return sum + (parsed.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      }, 0);
      return total;
    } catch (err) {
      logger.warn({ mint, err: (err as Error).message }, "Graduation sniper: fetchWalletTokenBalance failed");
      return null; // unknown — do not close
    }
  }

  private async validateOpenPositions(): Promise<void> {
    if (!solanaWalletService.isReady) return;
    if (this.openPositions.size === 0) return;

    logger.info({ count: this.openPositions.size }, "Graduation sniper: validating open positions against on-chain balances…");

    for (const [mint, pos] of Array.from(this.openPositions.entries())) {
      const balance = await this.fetchWalletTokenBalance(mint);
      if (balance === null) {
        logger.warn({ mint, symbol: pos.symbol }, "Startup validation: balance query failed — leaving position open");
        continue;
      }

      if (balance === 0) {
        logger.warn(
          { mint, symbol: pos.symbol, recordedTokens: pos.tokenAmount },
          "Startup validation: 0 tokens in wallet — closing as phantom position",
        );
        this.openPositions.delete(mint);
        pos.status        = "closed";
        pos.closeReason   = "Phantom — buy TX failed, no tokens received";
        pos.closedAt      = Date.now();
        pos.exitPrice     = pos.currentPrice > 0 ? pos.currentPrice : pos.entryPrice;
        pos.remainingFraction = 0;
        // Record the full size as a loss (SOL was never actually spent because the TX
        // failed on-chain, but we must zero out the position and mark it clearly).
        pos.realizedPnlSol = -pos.sizeSol;
        this.updateLivePnl(pos);
        this.closedPositions.push(pos);
        this.allTimeRealizedSol += pos.realizedPnlSol;
        this.allTimeLosses++;
        await this.persistPosition(pos);
        this.registerClosedTrade(pos);

        if (isTelegramConfigured()) {
          void sendTelegram(
            `⚠️ <b>PHANTOM POSITION DETECTED</b>\n` +
            `──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `📋 CA: <code>${pos.mint}</code>\n` +
            `❌ No tokens found in wallet — buy TX likely failed on-chain\n` +
            `📝 Position closed. Check your wallet & Solscan for the buy TX:\n` +
            `🔗 <a href="https://solscan.io/tx/${pos.entrySig}">Buy TX on Solscan</a>\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
      } else {
        logger.info({ mint, symbol: pos.symbol, balance }, "Startup validation: position confirmed ✅");
      }
    }
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

      const rawClosed: SniperPosition[] = [];
      for (const row of rows) {
        const pos = this.rowToPosition(row);
        if (pos.status === "open") {
          // ── Auto-correct TP realized breakdown for open positions ────────────
          // Only fill in breakdown cols that are missing (== 0), which means the
          // position was created before those columns existed (legacy records).
          // For records that already have actual trade values, trust the DB —
          // overwriting them with formula estimates corrupts the real P&L.
          let legacyFixed = false;
          if (pos.tp1Hit && pos.tp1RealizedSol === 0) {
            pos.tp1RealizedSol = (this.config.tp1Pct / 100) * pos.sizeSol * (this.config.tp1ClosePct / 100);
            legacyFixed = true;
          }
          if (pos.tp2Hit && pos.tp2RealizedSol === 0) {
            pos.tp2RealizedSol = (this.config.tp2Pct / 100) * pos.sizeSol * (this.config.tp2ClosePct / 100);
            legacyFixed = true;
          }
          // Only sync realizedPnlSol if we had to fill in missing legacy data
          if (legacyFixed) {
            pos.realizedPnlSol = pos.tp1RealizedSol + pos.tp2RealizedSol;
          }
          this.updateLivePnl(pos);
          this.openPositions.set(pos.mint, pos);
          this.seenMints.add(pos.mint);
        } else {
          rawClosed.push(pos);
          this.seenMints.add(pos.mint);
        }
      }

      // ── Deduplicate closed positions ─────────────────────────────────────────
      // Multiple DB rows can exist for the same mint (e.g. from the race-condition
      // bug where two graduation events both passed checkSkipReason before either
      // called enterPosition). Keep only the best record per mint; delete the rest.
      const keepById = new Map<string, SniperPosition>();
      const deleteIds: string[] = [];

      // Group by mint, keep the one with the highest realizedPnlSol
      const byMint = new Map<string, SniperPosition[]>();
      for (const pos of rawClosed) {
        const group = byMint.get(pos.mint) ?? [];
        group.push(pos);
        byMint.set(pos.mint, group);
      }
      for (const group of byMint.values()) {
        // Sort: highest realizedPnlSol first; if tied, latest closedAt wins
        group.sort((a, b) =>
          b.realizedPnlSol - a.realizedPnlSol ||
          (b.closedAt ?? 0) - (a.closedAt ?? 0)
        );
        keepById.set(group[0]!.id, group[0]!);
        for (let i = 1; i < group.length; i++) deleteIds.push(group[i]!.id);
      }

      if (deleteIds.length > 0) {
        logger.warn({ count: deleteIds.length, ids: deleteIds }, "Graduation sniper: deleting duplicate position rows from DB");
        for (const id of deleteIds) {
          try {
            await execute(`DELETE FROM sniper_positions WHERE id = $1`, [id]);
          } catch { /* best-effort */ }
        }
      }

      // Restore sorted closed list (ASC by entry_at)
      const allClosed = Array.from(keepById.values())
        .sort((a, b) => a.entryAt - b.entryAt);

      // Accumulate ALL-time P&L/win/loss BEFORE trimming so the stats survive
      // beyond the MAX_CLOSED in-memory window.
      this.allTimeRealizedSol = allClosed.reduce((s, p) => s + p.realizedPnlSol, 0);
      this.allTimeWins        = allClosed.filter((p) => p.realizedPnlSol > 0).length;
      this.allTimeLosses      = allClosed.filter((p) => p.realizedPnlSol <= 0).length;

      // Keep only the most-recent MAX_CLOSED trades in memory for the history UI
      this.closedPositions = allClosed.length > MAX_CLOSED
        ? allClosed.slice(-MAX_CLOSED)
        : allClosed;

      // ── Runtime trailingHigh correction ──────────────────────────────────────
      // Fix any open position whose trailingHigh was persisted as 0 / NULL, or
      // somehow set below entryPrice (e.g. server crashed before a new high was
      // saved). Without this, phase-2/3 SL measures drop from the crashed price
      // instead of entry, making dropFromPeak = 0% and SL never firing.
      let corrected = 0;
      for (const pos of this.openPositions.values()) {
        if (pos.trailingHigh < pos.entryPrice) {
          pos.trailingHigh = pos.entryPrice;
          corrected++;
        }
      }
      if (corrected > 0) {
        logger.warn({ corrected }, "Graduation sniper: corrected trailingHigh to entryPrice for stale positions");
      }

      logger.info(
        {
          open: this.openPositions.size,
          closed: this.closedPositions.length,
          totalInDb: allClosed.length,
          duplicatesDeleted: deleteIds.length,
        },
        "Graduation sniper: positions loaded",
      );
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
      // If trailing_high was never persisted (0 or NULL), fall back to entryPrice.
      // Without this, the first price tick overwrites trailingHigh with the current
      // (already-crashed) price, making dropFromPeak = 0% and SL never firing.
      trailingHigh:     Number(row["trailing_high"]) || Number(row["entry_price"]) || 0,
      status:           (row["status"] as "open" | "closed") ?? "open",
      realizedPnlSol:   Number(row["realized_pnl_sol"] ?? 0),
      unrealizedPnlSol: 0,
      totalPnlSol:      0,
      pnlPct:           0,
      closeReason:      row["close_reason"] as string | undefined,
      closedAt:         row["closed_at"] ? Number(row["closed_at"]) : undefined,
      exitPrice:        row["exit_price"] ? Number(row["exit_price"]) : undefined,
      txSignature:      String(row["tx_signature"] ?? ""),
      tokenAmount:      Number(row["token_amount"] ?? 0),
      entrySig:         String(row["entry_sig"] ?? ""),
      exitSig:          row["exit_sig"] ? String(row["exit_sig"]) : undefined,
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

    // ── Position monitoring — starts ALWAYS, regardless of Helius ────────────
    // CRITICAL: Price monitoring (SL / TP / trailing stop) must run even without
    // HELIUS_API_KEY. The old code gated ALL intervals behind the Helius check,
    // so without the key, no SL, TP, or external-sell detection ever ran.
    // Helius is only needed for the WebSocket graduation detector (new buys).
    this.priceIntervalId     = setInterval(() => {
      void this.refreshWalletBalance();
      void this.checkAllPrices();
    }, PRICE_LOOP_MS);
    this.liquidityIntervalId = setInterval(() => void this.checkAllLiquidity(), LIQUIDITY_CHECK_MS);
    this.externalSellCheckId = setInterval(() => void this.checkExternalSells(), 60_000);

    // ── WebSocket — only needed for detecting new graduations ────────────────
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) {
      logger.warn("Graduation sniper: HELIUS_API_KEY not set — WebSocket disabled (new graduation detection off). Position monitoring (SL/TP/trailing) is ACTIVE.");
      return;
    }

    this.startHeartbeat();
    this.startDetectionWatchdog();
    this.connect(apiKey);
    logger.info("Graduation sniper: started — WebSocket connecting, all monitoring active");
  }

  stop(): void {
    this.started = false;
    if (this.priceIntervalId)        { clearInterval(this.priceIntervalId);        this.priceIntervalId        = null; }
    if (this.liquidityIntervalId)    { clearInterval(this.liquidityIntervalId);    this.liquidityIntervalId    = null; }
    if (this.externalSellCheckId)    { clearInterval(this.externalSellCheckId);    this.externalSellCheckId    = null; }
    if (this.heartbeatIntervalId)    { clearInterval(this.heartbeatIntervalId);    this.heartbeatIntervalId    = null; }
    if (this.wsPingIntervalId)       { clearInterval(this.wsPingIntervalId);       this.wsPingIntervalId       = null; }
    if (this.detectionWatchdogId)    { clearInterval(this.detectionWatchdogId);    this.detectionWatchdogId    = null; }
    if (this.reconnectTimer)         { clearTimeout(this.reconnectTimer);          this.reconnectTimer         = null; }
    this.ws?.close();
  }

  private connect(apiKey: string): void {
    if (!this.started) return;
    // Store for watchdog-triggered reconnects
    this.heliusApiKey = apiKey;

    const url = `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const ws  = new WebSocket(url);
    this.ws   = ws;

    ws.on("open", () => {
      this.wsConnected = true;
      const isReconnect = this.wsReconnects > 0;
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

      // ── Second subscription: Pump.fun program ID ──────────────────────────
      // Pump.fun introduced "migrate_v2" which may use a different migration
      // wallet than MIGRATION_WALLET.  Subscribing to the program ID catches
      // ALL Pump.fun transactions (including migrate_v2) regardless of which
      // authority wallet is used.  handleMessage filters these aggressively
      // using value.logs so only genuine migration events reach processGraduation.
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id:      2,
        method:  "logsSubscribe",
        params:  [
          { mentions: [PUMPFUN_PROGRAM_ID] },
          { commitment: "confirmed" },
        ],
      }));

      // ── Two-layer keepalive — TCP + application-level JSON ───────────────
      // Layer 1 (TCP): WS ping frame every 20s keeps NAT gateways alive.
      // Layer 2 (JSON): A lightweight getHealth JSON-RPC call every 20s sends
      // real application data through Render's proxy and Helius's load balancer.
      // Render's proxy kills WebSocket connections that have no *application-level*
      // traffic even when TCP pings are flowing — the JSON layer fixes that.
      // Together these two layers prevent all known causes of premature close.
      if (this.wsPingIntervalId) clearInterval(this.wsPingIntervalId);
      this.wsPingIntervalId = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // TCP-level ping (handles NAT/firewall idle timeouts)
        ws.ping();
        // Application-level JSON ping (handles proxy/LB idle timeouts)
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getHealth" }));
      }, 20_000);

      // ── Backfill missed graduations after a reconnect ─────────────────────
      // When the WS drops and reconnects, any graduation events that fired
      // during the gap are permanently lost unless we actively poll for them.
      // On every reconnect, query the last 25 signatures on the migration wallet
      // and process any we haven't seen yet.  This ensures 100% graduation
      // coverage even with 10+ reconnects per session.
      if (isReconnect) {
        void this.backfillMissedGraduations();
      }
    });

    ws.on("message", (data: WebSocket.RawData) => {
      // Track every JSON message (subscription confirm, graduation events, etc.)
      // The watchdog uses this to detect a silently-dead subscription.
      this.lastWsMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch { /* malformed JSON — ignore */ }
    });

    ws.on("close", () => {
      this.wsConnected    = false;
      this.subscriptionId = null;
      if (this.wsPingIntervalId) { clearInterval(this.wsPingIntervalId); this.wsPingIntervalId = null; }
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

  // ── Backfill missed graduations after reconnect ───────────────────────────
  // Each reconnect creates a gap where Helius WS events are not received.
  // This method queries the last 25 confirmed signatures on the migration wallet
  // via REST and processes any that aren't already in seenSignatures.
  // Called on every reconnect (but NOT the first connect) so no graduation ever
  // slips through a reconnect window.
  private async backfillMissedGraduations(): Promise<void> {
    const apiKey = this.heliusApiKey;
    if (!apiKey) return;

    try {
      type SigInfo = { signature: string; err: unknown | null };
      const res = await axios.post<{ result: SigInfo[] }>(
        `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
        {
          jsonrpc: "2.0",
          id:      1,
          method:  "getSignaturesForAddress",
          params:  [MIGRATION_WALLET, { limit: 25, commitment: "confirmed" }],
        },
        { timeout: 10_000 },
      );

      const sigs = res.data?.result ?? [];
      let queued = 0;

      for (const { signature, err } of sigs) {
        if (err) continue;                            // failed TX on-chain — skip
        if (!signature) continue;
        if (this.seenSignatures.has(signature)) continue; // already processed

        // Mark seen BEFORE spawning so parallel backfills don't double-fire
        this.seenSignatures.add(signature);
        if (this.seenSignatures.size > 500) {
          const oldest = this.seenSignatures.values().next().value;
          if (oldest) this.seenSignatures.delete(oldest);
        }

        void this.processGraduation(signature);
        queued++;
      }

      logger.info(
        { checked: sigs.length, queued, reconnects: this.wsReconnects },
        queued > 0
          ? "Graduation sniper: backfill — queued missed graduations ✅"
          : "Graduation sniper: backfill — no missed graduations (all already seen)",
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "Graduation sniper: backfill failed (non-critical — WS will catch new ones)",
      );
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // Subscription confirmation — migration wallet sub (id: 1)
    if (typeof msg["result"] === "number" && msg["id"] === 1) {
      this.subscriptionId = msg["result"] as number;
      logger.info({ subscriptionId: this.subscriptionId }, "Graduation sniper: migration wallet logsSubscribe confirmed");
      return;
    }

    // Subscription confirmation — Pump.fun program sub (id: 2)
    if (typeof msg["result"] === "number" && msg["id"] === 2) {
      this.programSubscriptionId = msg["result"] as number;
      logger.info({ programSubscriptionId: this.programSubscriptionId }, "Graduation sniper: pump.fun program logsSubscribe confirmed");
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

    // ── Log-based migration filter ────────────────────────────────────────────
    // Helius fires logsNotification for EVERY transaction mentioning either the
    // migration wallet or the Pump.fun program ID.  The program subscription is
    // especially noisy (1000+ buy/sell TXes per minute).  Filter immediately
    // using the embedded log strings — only graduation events contain "migrate"
    // (covers Migrate, MigrateV2, migrate_v2 etc.).  If logs are absent (some
    // old RPC nodes omit them) fall through so no event is ever silently lost.
    const txLogs = value["logs"] as string[] | undefined;
    if (txLogs && txLogs.length > 0) {
      // ── Tightened migration filter ────────────────────────────────────────
      // BUGFIX: "migrate" alone is too loose — pump.fun pre-graduation events
      // (bonding-curve completion signals, liquidity-lock confirmations, etc.)
      // include "migrate" in status log lines WITHOUT being an actual migration
      // instruction.  This was the root cause of the ASTROGUY false trigger:
      // a pre-graduation event fired 4+ minutes before the real migrate_v2.
      //
      // Require an EXPLICIT Solana instruction-level log.  Pump.fun graduation
      // emits exactly ONE of these in confirmed TXes:
      //   "Program log: Instruction: Migrate"   (old Raydium CPMM path)
      //   "Program log: Instruction: MigrateV2" (new pump.fun AMM / pumpswap)
      // Also match the underscore form used in some inner-instruction logs.
      const isMigration = txLogs.some((l) => {
        const lower = l.toLowerCase();
        return lower.includes("instruction: migrate") ||   // covers Migrate + MigrateV2
               lower.includes("migrate_v2")             ||  // inner-instruction form
               lower.includes("migratev2");                  // alternate camelCase
      });
      if (!isMigration) {
        logger.debug({ signature }, "Graduation sniper: non-migration TX (no migrate instruction log) — suppressed");
        return;
      }
      logger.info(
        { signature, logCount: txLogs.length },
        "Graduation sniper: migrate_v2 instruction confirmed ⚡",
      );
    }

    // ── Signature-level dedup ─────────────────────────────────────────────────
    // Both subscriptions (migration wallet + program ID) can fire for the same
    // TX.  Without this guard every duplicate triggers a separate extractMintFromTx
    // RPC call and burns rate-limit budget.
    if (this.seenSignatures.has(signature)) {
      logger.debug({ signature }, "Graduation sniper: duplicate WS signature — suppressed");
      return;
    }
    this.seenSignatures.add(signature);
    // FIFO evict — keep set bounded to 500 entries so long sessions don't leak memory
    if (this.seenSignatures.size > 500) {
      const oldest = this.seenSignatures.values().next().value;
      if (oldest) this.seenSignatures.delete(oldest);
    }

    // NOTE: graduationsToday is incremented inside processGraduation (after mint
    // extraction confirms this is a real graduation TX), NOT here.
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
    // Track which mint we reserved in processingGraduations so finally can clean it up
    let reservedMint: string | null = null;
    // Hoisted so the catch block can emit a visible event even when the exception
    // fires after mint extraction but before any addEvent call inside the try.
    let catchEventBase: { id: string; detectedAt: number; mint: string; symbol: string; txSignature: string } | null = null;
    // Set when the live sniper must skip (wallet/balance/positions) but we still
    // want to run the full quality-filter pipeline so paper mode can trade.
    let liveOnlySkip: string | null = null;
    try {
      const extracted = await this.extractMintFromTx(signature);
      if (!extracted) {
        // Not a graduation TX (Pool:Create, AMM:Buy, etc. also mention migration wallet)
        // Don't add to events or count as graduation — just silently discard.
        logger.info({ signature }, "Graduation sniper: no mint extracted — non-graduation TX, ignoring");
        return;
      }

      const { mint, wsolVaultPubkey } = extracted;
      const skipReason = this.checkSkipReason(mint);
      const eventBase  = { id: uid(), detectedAt, mint, symbol: mint.slice(0, 8), txSignature: signature };
      catchEventBase   = eventBase; // expose to catch block

      if (skipReason) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason });
        logger.info({ mint, skipReason }, "Graduation sniper: skipped");
        // Blacklist = hard skip — paper also respects it. Everything else
        // (wallet not configured, insufficient balance, max positions) is
        // live-only: continue the pipeline so paper mode can still trade.
        if (blacklistService.isBlacklisted(mint)) return;
        liveOnlySkip = skipReason;
      }

      // ── Race-condition guard: reserve this mint before any async op ──────────
      // Without this, two simultaneous graduation events for the same mint both
      // pass checkSkipReason (seenMints only gets the mint inside enterPosition,
      // which is AFTER all the awaits below), creating two DB rows.
      //
      // NOTE: do NOT call addEvent here — this is pure internal dedup noise.
      // Helius fires multiple different TX signatures for the same mint (Pool:Create,
      // AMM:Buy, etc. all mention the migration wallet) so several processGraduation
      // calls race through extractMintFromTx in parallel and all arrive here with
      // the same mint.  Showing each as a "skipped" event in the UI is misleading —
      // the first one is already being processed correctly; these are silent discards.
      if (this.processingGraduations.has(mint)) {
        logger.debug({ mint, signature }, "Graduation sniper: duplicate mint in-flight — silently discarded");
        return;
      }
      this.processingGraduations.add(mint);
      reservedMint = mint;

      // Confirmed unique graduation — count it now (after dedup guards so each
      // mint is counted exactly once, not once per TX signature from Helius).
      this.resetDailyCounterIfNeeded();
      this.graduationsToday++;

      // ── Minimum entry delay ────────────────────────────────────────────────────
      // Wait until waitBeforeEntryMs have elapsed since detection.  This gives the
      // AMM pool time to become liquid, price feeds to stabilise, and early sniper
      // bots time to set the real market price before we enter.
      // Extraction above (~1-3 s) is counted against the delay, so we only sleep
      // the remaining gap (e.g. with 5 s target and 2 s extraction → 3 s sleep).
      {
        const elapsed = Date.now() - detectedAt;
        const remaining = Math.max(0, this.config.waitBeforeEntryMs - elapsed);
        if (remaining > 0) {
          logger.info({ mint, elapsed, remaining, target: this.config.waitBeforeEntryMs },
            `Graduation sniper: entry delay — waiting ${remaining}ms (${elapsed}ms already elapsed)`);
          await new Promise<void>((r) => setTimeout(r, remaining));
        }
      }

      // ── T0: fire ALL independent tasks simultaneously ─────────────────────────
      // Pool check, pre-quote, and baseline price have no dependencies on each
      // other — start all three at the exact same instant.  The rug-check price
      // (second read) is the only task that must wait: we need (a) a baseline to
      // compare against, and (b) at least RUG_CHECK_WAIT_MS of elapsed time so a
      // real dump would already be visible in the price API.
      const t0 = detectedAt;
      logger.info({ mint, t0 }, "Sniper timing: T0 — all parallel tasks firing simultaneously ⚡");

      const poolCheckPromise = wsolVaultPubkey
        ? this.fetchOnChainPoolSol(wsolVaultPubkey)
        : Promise.resolve<number | null>(null);

      const preQuotePromise = jupiterSwapService.prefetchBuyQuoteAndFee(
        mint,
        this.config.positionSizeSol,
        this.config.slippageBps,
        this.config.priorityFeeLamports,
      );

      // ── T1: baseline price + enforce minimum rug-gap ─────────────────────────
      // Wait for BOTH: baseline price (for rug comparison) AND the minimum gap
      // (so a real dump is actually visible in the price feed).
      // Using Promise.all means: if Jupiter responds in 0.8s, we still wait the
      // remaining 0.7s of the 1.5s rug gap before fetching the second price.
      let priceData: Awaited<ReturnType<typeof this.fetchPriceFast>> = null;
      await Promise.all([
        (async () => {
          priceData = await this.fetchPriceFast(mint);
          if (!priceData) {
            const MAX_PRICE_RETRIES = 3;
            const PRICE_RETRY_MS    = 1_000;
            for (let attempt = 1; attempt <= MAX_PRICE_RETRIES; attempt++) {
              logger.info({ mint, attempt, elapsedMs: Date.now() - t0 },
                `Graduation sniper: price not found — retry ${attempt}/${MAX_PRICE_RETRIES}`);
              await new Promise(r => setTimeout(r, PRICE_RETRY_MS));
              priceData = await this.fetchPriceFast(mint);
              if (priceData) break;
            }
          }
        })(),
        new Promise<void>((r) => setTimeout(r, RUG_CHECK_WAIT_MS)),
      ]);
      logger.info({ mint, found: !!priceData, elapsedMs: Date.now() - t0 },
        "Sniper timing: T1 — baseline price ready + rug gap enforced");

      if (!priceData) {
        this.addEvent({ ...eventBase, action: "skipped", skipReason: "Price not found (Jupiter + DexScreener, ~5s window)" });
        logger.info({ mint }, "Graduation sniper: skipped — price not found after parallel retries");
        return;
      }

      let { price: baselinePrice, symbol, name, dexId: baselineDexId } = priceData;
      catchEventBase = { ...eventBase, symbol }; // update with known symbol for catch block

      // ── FIX 1: Minimum entry price ────────────────────────────────────────────
      if (baselinePrice < MIN_ENTRY_PRICE_USD) {
        const reason = `Price too low — $${baselinePrice.toExponential(3)} < $${MIN_ENTRY_PRICE_USD} (Type-A rug filter)`;
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
        logger.info({ mint, symbol, price: baselinePrice }, "Graduation sniper: skipped — price below minimum (FIX 1)");
        return;
      }

      // Race-condition guard: re-check wallet/positions state with symbol known
      const skipAfterPrice = this.checkSkipReason(mint);
      if (skipAfterPrice) {
        if (!liveOnlySkip) {
          // Only emit a second event if the first check didn't already log it
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: skipAfterPrice });
        }
        if (blacklistService.isBlacklisted(mint)) return;
        liveOnlySkip = liveOnlySkip ?? skipAfterPrice;
      }

      // ── T2: rug-check price + pool check (pool may already be done) ───────────
      // The 1.5s rug gap was already enforced in T1's Promise.all, so we fire
      // the second price read NOW and wait for it + the pool check together.
      const t2Start = Date.now();
      const [rugCheckData, poolSol] = await Promise.all([
        this.fetchPriceFast(mint),
        poolCheckPromise,
      ]);
      let entryPrice = rugCheckData?.price ?? baselinePrice;
      logger.info({ mint, symbol, poolSol, rugPrice: rugCheckData?.price ?? null,
        parallelMs: Date.now() - t2Start, elapsedMs: Date.now() - t0 },
        "Sniper timing: T2 — rug price + pool check done ⚡ (pre-quote running in background)");

      // FIX 2: on-chain Raydium pool SOL balance check
      if (wsolVaultPubkey && poolSol !== null) {
        const minPoolSol = this.isLowLiquidityHour() ? LOW_LIQ_MIN_POOL_SOL : MIN_POOL_SOL;
        if (poolSol < minPoolSol) {
          const hourLabel = this.isLowLiquidityHour() ? " (low-liq hours)" : "";
          const reason = `Pool drained — ${poolSol.toFixed(2)} SOL < ${minPoolSol} SOL on-chain${hourLabel} (Type-A rug filter)`;
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
          logger.warn({ mint, symbol, poolSol, minPoolSol, wsolVaultPubkey }, "Graduation sniper: skipped — pool below threshold (FIX 2)");
          return;
        }
        logger.info({ mint, symbol, poolSol, wsolVaultPubkey }, "Graduation sniper: on-chain pool SOL check passed ✅");
      } else if (!wsolVaultPubkey) {
        // ── Pool existence gate ─────────────────────────────────────────────────
        // Uses Promise.any — the FIRST source to confirm wins and we exit
        // immediately, without waiting for slower sources to settle.
        //
        // Sources (fired in parallel every attempt):
        //  A. PumpSwap pool PDA — getAccountInfo on Helius RPC. The pool account
        //     is CREATED inside the migration TX itself, so it exists on-chain the
        //     instant Helius fires the WebSocket event. No indexer lag at all.
        //     Three PDA seed patterns tried; whichever has lamports > 0 wins.
        //  B. DexScreener AMM pair — pumpswap/raydium pair appears ~15-60s later.
        //  C+D. Jupiter lite-api + full quote-api — also ~5-30s indexing lag.
        //
        // Fast path: if T1 already returned an AMM price, pool is confirmed.
        // Slow path: attempt 0 fires immediately (no pre-wait) — PDA check alone
        //   typically confirms in < 200ms on attempt 0.

        const GATE_AMM_DEXES  = new Set(["raydium", "pumpswap", "orca", "meteora"]);
        const JUPE_LITE       = "https://lite-api.jup.ag/swap/v1/quote";
        const JUPE_FULL       = "https://quote-api.jup.ag/v6/quote";
        const WSOL_MINT       = "So11111111111111111111111111111111111111112";
        const PUMPSWAP_PROG   = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
        const GATE_DEADLINE   = 30_000;
        const GATE_POLL       = 1_000;
        const heliusKey       = process.env["HELIUS_API_KEY"];

        let gateConfirmed    = false;
        let gateSource       = "";
        let jupiterOutAmount = 0;

        // ── Fast path: T1 DexScreener already returned an AMM pair ─────────────
        if (GATE_AMM_DEXES.has(baselineDexId ?? "")) {
          gateConfirmed = true;
          gateSource    = `T1-${baselineDexId}`;
          logger.info({ mint, symbol, baselineDexId },
            "Graduation sniper: T1 AMM pair confirmed — gate bypassed ✅");
        } else {
          // Derive PumpSwap pool PDA — three seed patterns to cover all versions.
          // Pattern A: ["pool", baseMint]                          (early PumpSwap)
          // Pattern B: ["pool", u16(0), baseMint, quoteMint]       (later version)
          // Pattern C: ["pool", u16(0), quoteMint, baseMint]       (base/quote swapped)
          const pdaAddresses: string[] = [];
          try {
            const mPK  = new PublicKey(mint);
            const pPK  = new PublicKey(PUMPSWAP_PROG);
            const wPK  = new PublicKey(WSOL_MINT);
            const idx  = Buffer.from([0, 0]);
            const [a]  = PublicKey.findProgramAddressSync([Buffer.from("pool"), mPK.toBuffer()], pPK);
            const [b]  = PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, mPK.toBuffer(), wPK.toBuffer()], pPK);
            const [c]  = PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, wPK.toBuffer(), mPK.toBuffer()], pPK);
            pdaAddresses.push(a.toBase58(), b.toBase58(), c.toBase58());
          } catch { /* non-fatal */ }

          logger.info({ mint, symbol, pdaA: pdaAddresses[0]?.slice(0, 12) ?? "n/a" },
            "Graduation sniper: starting pool gate (PDA on-chain + DexScreener + Jupiter)");

          const deadline = Date.now() + GATE_DEADLINE;
          let attempt = 0;

          while (Date.now() < deadline && !gateConfirmed) {
            if (attempt > 0) await new Promise<void>(r => setTimeout(r, GATE_POLL));
            attempt++;

            type QuoteResp = { outAmount?: string; error?: string };
            type AcctResp  = { result?: { value?: { lamports?: number } | null } };
            type Win       = { source: string; dexPrice?: number; jupOut?: number };
            const jp = { inputMint: WSOL_MINT, outputMint: mint, amount: 10_000_000, slippageBps: 5000 };
            const rpc = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null;

            // Each check resolves with Win on success, rejects on failure.
            // Promise.any resolves with the FIRST success — no waiting for others.
            const checks: Promise<Win>[] = [];

            // A: DexScreener AMM pair
            checks.push(
              this.fetchPriceFast(mint).then(d => {
                if (d && GATE_AMM_DEXES.has(d.dexId)) return { source: `dex:${d.dexId}`, dexPrice: d.price };
                throw new Error("dex: no AMM pair");
              })
            );

            // B: PumpSwap pool PDA(s) on-chain — authoritative, zero indexer lag
            if (rpc && pdaAddresses.length > 0) {
              for (const pda of pdaAddresses) {
                checks.push(
                  axios.post<AcctResp>(rpc,
                    { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pda, { encoding: "base64" }] },
                    { timeout: 3_000 }
                  ).then(r => {
                    if ((r.data?.result?.value?.lamports ?? 0) > 0)
                      return { source: `pda:${pda.slice(0, 8)}` };
                    throw new Error(`pda ${pda.slice(0, 8)}: no account`);
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

            // Race — exit as soon as the first source confirms
            try {
              const winner = await Promise.any(checks);
              gateConfirmed    = true;
              gateSource       = winner.source;
              jupiterOutAmount = winner.jupOut ?? 0;
              if (winner.dexPrice && winner.dexPrice > 0) {
                entryPrice    = winner.dexPrice;
                baselinePrice = winner.dexPrice;
              }
              logger.info({ mint, symbol, gateSource, attempt },
                `Graduation sniper: gate confirmed via ${gateSource} ✅`);
              break;
            } catch {
              logger.info({ mint, symbol, attempt, msRemaining: Math.max(0, deadline - Date.now()) },
                "Graduation sniper: gate pending — all sources unconfirmed, retrying");
            }
          }
        }

        if (!gateConfirmed) {
          const reason = "Pool not confirmed after 30s (no PDA account / DexScreener AMM pair / Jupiter route)";
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
          logger.warn({ mint, symbol }, "Graduation sniper: SKIPPED — gate timed out (false trigger guard)");
          if (isTelegramConfigured()) {
            void sendTelegram(
              `⚠️ <b>FALSE TRIGGER BLOCKED</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${symbol}</b>\n` +
              `📋 CA: <code>${mint}</code>\n` +
              `❌ Pool not confirmed after 30s (PDA + DexScreener + Jupiter all failed)\n` +
              `✅ Entry blocked (pre-graduation guard)\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          return;
        }

        // ── Price sync when Jupiter won (DexScreener + PDA already sync above) ───
        if (jupiterOutAmount > 0) {
          const solUsd = await this.fetchSolUsdPrice();
          if (solUsd && solUsd > 0) {
            const jupiterImpliedPrice = (0.01 * solUsd) / (jupiterOutAmount / 1_000_000);
            if (jupiterImpliedPrice > 0) {
              logger.info({ mint, symbol, jupiterImpliedPrice, solUsd, jupiterOutAmount },
                "Graduation sniper: entry price + baseline synced from Jupiter quote ✅");
              entryPrice    = jupiterImpliedPrice;
              baselinePrice = jupiterImpliedPrice;
            }
          }
        }
      }

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

      // ── Low-liquidity hour filter (11pm–6am IST = 17:30–00:30 UTC) ────────────
      // DexScreener liquidityUsd from rugCheckData. Skip tokens with insufficient
      // DEX liquidity — thin pools are where rugs happen most often overnight.
      //
      // IMPORTANT: only apply this filter when liquidityUsd > 0.
      // DexScreener has a 2–5 minute indexing lag after graduation, so for the
      // first few minutes the API returns pairs with liquidity: null / $0 even
      // when the pool actually has $10K+. Checking >= 0 caused valid tokens to
      // be falsely skipped. When liquidityUsd === 0, real liquidity was already
      // validated by the on-chain pool SOL check above — trust that instead.
      if (rugCheckData && rugCheckData.liquidityUsd > 0) {
        const minLiq  = this.isLowLiquidityHour() ? LOW_LIQ_MIN_LIQUIDITY_USD : NORMAL_MIN_LIQUIDITY_USD;
        if (rugCheckData.liquidityUsd < minLiq) {
          const hourLabel = this.isLowLiquidityHour() ? " [quiet hours]" : "";
          const reason = `Insufficient DEX liquidity${hourLabel} — $${rugCheckData.liquidityUsd.toFixed(0)} < $${minLiq} min`;
          this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
          logger.info(
            { mint, symbol, liquidityUsd: rugCheckData.liquidityUsd, minLiq, isLowLiqHour: this.isLowLiquidityHour() },
            "Graduation sniper: skipped — DEX liquidity below threshold",
          );
          return;
        }
      } else if (rugCheckData && rugCheckData.liquidityUsd === 0) {
        // DexScreener returned pairs but liquidity is null/0 — not yet indexed.
        // The on-chain pool SOL check already validated liquidity is real.
        // Log and proceed; do not skip based on stale/missing DexScreener data.
        logger.info(
          { mint, symbol },
          "Graduation sniper: DexScreener liquidity not yet indexed ($0) — skipping DEX liquidity filter, trusting on-chain pool check",
        );
      }

      // ── PRICE DRIFT / MOMENTUM FILTER ─────────────────────────────────────────
      // Compare current pre-buy price (entryPrice) to baseline (baselinePrice).
      // If the token has already run significantly in our ~13s of checks, the buy
      // would enter at a pumped price — SL is then set from that inflated level
      // and the first natural pullback triggers an instant loss.
      const driftPct = baselinePrice > 0 ? ((entryPrice / baselinePrice) - 1) * 100 : 0;
      logger.info({
        mint, symbol,
        baselinePrice,
        entryPrice,
        driftPct: driftPct.toFixed(2) + "%",
        elapsedMs: Date.now() - t0,
        ENTRY_DRIFT_ABORT_PCT,
        MOMENTUM_SKIP_PCT,
      }, "Sniper timing: T6 — pre-buy drift check");

      if (driftPct >= MOMENTUM_SKIP_PCT) {
        // Token pumped ≥15% from baseline — "missed entry" (ran before we got there)
        const reason = `Missed entry — price already +${driftPct.toFixed(1)}% from detection (>${MOMENTUM_SKIP_PCT}% threshold)`;
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
        logger.warn({ mint, symbol, baselinePrice, entryPrice, driftPct: driftPct.toFixed(1), elapsedMs: Date.now() - t0 },
          "Graduation sniper: MISSED ENTRY — token pumped too fast, skipping buy");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `⏩ <b>SNIPER MISSED ENTRY</b>\n` +
            `──────────────────────\n` +
            `🪙 Token: <b>${symbol}</b>\n` +
            `📋 CA: <code>${mint}</code>\n` +
            `📈 Already pumped: <b>+${driftPct.toFixed(1)}%</b> during entry checks\n` +
            `❌ Buy skipped — would be chasing\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
        return;
      }

      if (driftPct >= ENTRY_DRIFT_ABORT_PCT) {
        // Token rose 8–14% from baseline — abort but don't label as "missed"
        const reason = `Entry drift abort — price +${driftPct.toFixed(1)}% from detection (>${ENTRY_DRIFT_ABORT_PCT}% threshold)`;
        this.addEvent({ ...eventBase, symbol, action: "skipped", skipReason: reason });
        logger.warn({ mint, symbol, baselinePrice, entryPrice, driftPct: driftPct.toFixed(1) },
          "Graduation sniper: entry drift too high — buy aborted");
        return;
      }

      logger.info({ mint, symbol, driftPct: driftPct.toFixed(2) + "%", elapsedMs: Date.now() - t0 },
        "Graduation sniper: drift check passed ✅ — proceeding to buy");

      // Grab pre-fetch result opportunistically — it has been running in background
      // for ~3-4s (rug wait + price fetch + drift check).  If it's ready, use it;
      // if still pending/failed, race gives null within 50ms and buy() retries fresh.
      const preQuote = await Promise.race([
        preQuotePromise,
        new Promise<null>((r) => setTimeout(() => r(null), 50)),
      ]);
      logger.info({ mint, symbol, preQuoteReady: !!preQuote, elapsedMs: Date.now() - t0 },
        preQuote ? "Sniper timing: pre-fetch quote ready — skipping getQuote call ⚡" : "Sniper timing: pre-fetch not ready — buy() will fetch fresh quote");

      // ── Paper sniper tap-in ───────────────────────────────────────────────────
      // Always fires when quality filters pass — even if live must skip due to
      // insufficient wallet balance. Paper has its own virtual balance & checks.
      this.paperCallback?.(mint, entryPrice, symbol, name, detectedAt, baselinePrice);

      // Skip live entry if wallet can't support it (balance, not configured, etc.)
      if (liveOnlySkip) {
        logger.info({ mint, symbol, liveOnlySkip }, "Graduation sniper: live entry skipped — paper-only trade");
        return;
      }

      await this.enterPosition(mint, symbol, name, entryPrice, signature, baselinePrice, detectedAt, preQuote);
      this.addEvent({ ...eventBase, symbol, action: "entered" });

    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      logger.warn({ signature, err: errMsg }, "Graduation sniper: error processing graduation");
      // Always emit a visible UI event so no graduation silently disappears.
      // Without this, any exception after graduationsToday++ leaves the counter
      // incremented but the "Recent Graduations Detected" list empty.
      if (catchEventBase) {
        this.addEvent({ ...catchEventBase, action: "skipped", skipReason: `Internal error — ${errMsg}` });
      }
    } finally {
      // Release the mint reservation so future graduation events for the same
      // token aren't permanently blocked. seenMints is the permanent gate;
      // processingGraduations is only the in-flight concurrency gate.
      if (reservedMint) this.processingGraduations.delete(reservedMint);
    }
  }

  private checkSkipReason(mint: string): string | null {
    if (!this.config.enabled)                                    return "Sniper disabled";
    if (!solanaWalletService.isReady)                            return "Wallet not configured — set SOLANA_PRIVATE_KEY";
    if (this.seenMints.has(mint))                                return "Already traded this mint";
    if (this.openPositions.size >= this.config.maxOpenPositions) return `Max open positions (${this.config.maxOpenPositions}) reached`;
    if (blacklistService.isBlacklisted(mint))                    return "Mint in permanent blacklist";
    // Must have enough for the trade PLUS fees/rent so the TX never fails on-chain.
    // TX_OVERHEAD_SOL = 0.003 covers: token account rent (~0.00204) + base TX fees + buffer.
    const minRequired = this.config.positionSizeSol + TX_OVERHEAD_SOL;
    if (this.walletBalanceSol < minRequired)
      return `Insufficient balance — need ${minRequired.toFixed(4)} SOL (${this.config.positionSizeSol} trade + ${TX_OVERHEAD_SOL} fees/rent), have ${this.walletBalanceSol.toFixed(4)} SOL`;
    return null;
  }

  private async extractMintFromTx(signature: string): Promise<{ mint: string; wsolVaultPubkey: string | null } | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // ── Strategy 1: Helius Enhanced Transactions API ──────────────────────────
    // Returns a fully-parsed transaction with explicit `tokenTransfers` array.
    // Handles both old `migrate` (Raydium CPMM) and new `migrate_v2` (Pump.fun
    // AMM / pumpswap) because it parses across inner instructions.  Significantly
    // more reliable than raw getTransaction preTokenBalances/postTokenBalances.
    try {
      type EnhancedTransfer = { mint: string; tokenAmount?: number };
      type EnhancedTx = {
        signature: string;
        type?: string;
        source?: string;
        tokenTransfers?: EnhancedTransfer[];
      };

      const enhRes = await axios.post<EnhancedTx[]>(
        `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`,
        { transactions: [signature], commitment: "confirmed" },
        { timeout: 5_000 },
      );

      const txData = enhRes.data?.[0];
      if (txData) {
        // ── Type guard: reject known non-graduation TX types ─────────────────
        // The Helius Enhanced API classifies transactions by type.  Graduation
        // events are NOT SWAP / TRANSFER / STAKE / BURN — those are regular
        // pump.fun interactions that can fire on the program subscription.
        // Rejecting them here prevents the Enhanced API from returning a mint
        // from an AMM buy/sell that happens to be a non-SOL transfer.
        // "UNKNOWN" or absent type = fall through (cannot rule out graduation).
        const NON_GRADUATION_TYPES = new Set([
          "SWAP", "TRANSFER", "STAKE", "BURN", "NFT_SALE",
          "COMPRESSED_NFT_MINT", "TOKEN_MINT",
        ]);
        if (txData.type && NON_GRADUATION_TYPES.has(txData.type.toUpperCase())) {
          logger.info(
            { signature, type: txData.type, source: txData.source },
            "Graduation sniper: enhanced API — non-graduation TX type, rejecting",
          );
          return null;
        }

        const transfers = txData.tokenTransfers ?? [];
        const mint = transfers.find((t) => t.mint && t.mint !== SOL_MINT)?.mint;

        logger.info(
          { signature, mint: mint ?? "none", type: txData.type, source: txData.source, transferCount: transfers.length },
          "Graduation sniper: enhanced API scan",
        );

        if (mint) {
          logger.info({ signature, mint, type: txData.type, method: "enhanced-api" }, "Graduation sniper: mint extracted via enhanced API ✅");
          return { mint, wsolVaultPubkey: null };
        }
        // If enhanced API returned data but no non-SOL mint, this is likely
        // not a graduation TX (e.g. pure SOL move).  Fall through to getTransaction
        // which checks token balances and may disagree.
      }
    } catch (enhErr) {
      logger.warn(
        { signature, err: (enhErr as Error).message },
        "Graduation sniper: enhanced API failed — falling back to getTransaction",
      );
    }

    // ── Strategy 2: getTransaction with token balance scan ────────────────────
    // Helius REST indexer lags behind the WebSocket by a short window.
    // Attempt 0 is immediate — fast path for when the TX is already indexed.
    // Retries use tight backoffs: 400ms, 800ms, 1.5s, 2.5s — total budget 5.2s.
    // (Old delays [0,1s,3s,5s,8s] accumulated up to 17s and were the primary
    // source of the 40s pre-execution latency.)
    const delays = [0, 400, 800, 1_500, 2_500];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]! > 0) await new Promise((r) => setTimeout(r, delays[attempt]!));

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

  private async fetchPrice(mint: string): Promise<{ price: number; symbol: string; name: string; liquidityUsd: number; dexId: string } | null> {
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

      // Prefer AMM pairs (pumpswap/raydium/orca/meteora) with highest liquidity.
      // Pump.fun now graduates to PumpSwap, so include it alongside Raydium.
      // Bonding-curve "pumpfun" pairs are deprioritised — their price is the last
      // curve price, which may not reflect the current AMM pool price.
      const AMM_DEXES = new Set(["raydium", "pumpswap", "orca", "meteora"]);
      const sorted = [...pairs].sort((a, b) => {
        const aAmm = AMM_DEXES.has(a.dexId ?? "") ? 1 : 0;
        const bAmm = AMM_DEXES.has(b.dexId ?? "") ? 1 : 0;
        if (bAmm !== aAmm) return bAmm - aAmm;
        return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
      });

      const best         = sorted[0]!;
      const price        = parseFloat(best.priceUsd) || 0;
      const liquidityUsd = best.liquidity?.usd ?? 0;
      if (price <= 0) return null;

      return {
        price,
        liquidityUsd,
        dexId:  best.dexId ?? "unknown",
        symbol: best.baseToken.symbol,
        name:   best.baseToken.name,
      };
    } catch {
      return null;
    }
  }

  // ── AMM pool existence check ──────────────────────────────────────────────────
  // Queries DexScreener for a confirmed AMM pair for this mint.
  // Pump.fun graduates to either Raydium CPMM (old) or PumpSwap (new — their own AMM).
  // Both are valid graduation targets. Only a "pumpfun" bonding-curve pair means
  // the token has NOT yet migrated.
  private async hasRaydiumPool(mint: string): Promise<boolean> {
    const GRAD_DEXES = new Set(["raydium", "pumpswap", "orca", "meteora"]);
    try {
      type DexPair = { dexId?: string; priceUsd: string };
      const res = await axios.get<DexPair[]>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
        { timeout: 6_000 },
      );
      const pairs = Array.isArray(res.data) ? res.data : [];
      return pairs.some((p) => GRAD_DEXES.has(p.dexId ?? "") && (parseFloat(p.priceUsd) || 0) > 0);
    } catch {
      // On network error: allow through — better to miss a rug check than block
      // a valid graduation when DexScreener is briefly down.
      logger.warn({ mint }, "Graduation sniper: hasRaydiumPool DexScreener call failed — allowing through");
      return true;
    }
  }

  // ── Price fetch for position monitoring ───────────────────────────────────
  // Uses DexScreener ONLY — it is a dedicated price-data API with a high rate
  // limit (~300 req/min) and is perfectly accurate for SL/TP monitoring.
  //
  // Jupiter's lite-api.jup.ag is intentionally NOT used here anymore.
  // Root cause of 429 errors: the old code polled Jupiter price/v2 every 3s per
  // position (e.g. 5 positions × 20 ticks/min = 100 req/min) which exceeded
  // Jupiter Lite's 60 req/min limit. Swap requests (buy/sell) then hit the same
  // rate limit bucket, causing 429 on actual trades.
  // Jupiter is now ONLY called for swap transactions (buy/sell) — never for polling.
  private async fetchPositionPrice(mint: string): Promise<{ price: number; symbol: string; name: string; liquidityUsd: number } | null> {
    return this.fetchPrice(mint);
  }

  // ── Position management ────────────────────────────────────────────────────

  private async enterPosition(
    mint: string,
    symbol: string,
    name: string,
    price: number,
    _detectedTxSig: string,
    detectionPrice?: number,     // baselinePrice (first DexScreener fetch ~5s after grad)
    graduationDetectedAt?: number, // Date.now() at graduation WS event
    preQuote?: { quote: unknown; fee: number; fetchedAt: number } | null,
  ): Promise<void> {
    const cfg = this.config;
    const id  = uid();
    const buyStart = Date.now();

    logger.info({
      mint, symbol,
      preBuyPrice: price,
      detectionPrice: detectionPrice ?? null,
      preQuoteAgeMs: preQuote ? buyStart - preQuote.fetchedAt : null,
      msSinceDetection: graduationDetectedAt ? buyStart - graduationDetectedAt : null,
    }, "Sniper timing: T7 — enterPosition called, Jupiter buy starting ⚡");

    // Execute real on-chain buy via Jupiter — confirmed before recording position
    let txSignature: string;
    let tokenAmount: number;
    let sizeSol: number;
    try {
      const result = await jupiterSwapService.buy(mint, cfg.positionSizeSol, cfg.slippageBps, cfg.priorityFeeLamports, preQuote, cfg.jitoTipLamports);
      txSignature = result.txSignature;
      tokenAmount = result.tokenAmount;
      sizeSol     = result.solSpent;
      logger.info({
        mint, symbol,
        buyMs: Date.now() - buyStart,
        msSinceDetection: graduationDetectedAt ? Date.now() - graduationDetectedAt : null,
      }, "Sniper timing: T8 — Jupiter buy confirmed on-chain");
    } catch (err) {
      logger.error({ mint, symbol, err: (err as Error).message }, "Graduation sniper: Jupiter buy FAILED — entry aborted");
      if (isTelegramConfigured()) {
        void sendTelegram(`❌ <b>SNIPER BUY FAILED</b>\n🪙 ${symbol}\n📋 <code>${mint}</code>\n⚠️ ${(err as Error).message}`);
      }
      // Release the seenMints lock so the next graduation event can retry
      this.seenMints.delete(mint);
      return;
    }

    // ── FAST entry price: Priority 2 first (Jupiter quote + SOL/USD) ────────────
    // OLD order: P1 (on-chain parse, 2s sleep) → P2 (Jupiter quote) → P3 (DexScreener retries)
    // NEW order: P2 first (no sleep, ~0.5-1s) → record position → P1 + P3 in background.
    //
    // P2 uses sizeSol + tokenAmount already returned by the confirmed swap — no extra
    // RPC needed. Only fetchSolUsdPrice() is awaited (~0.5-1s). This cuts the blocking
    // post-buy wait from 2-15s down to ~1s, letting the position appear on the dashboard
    // and Telegram immediately. P1 (on-chain parse) and P3 (DexScreener) run in the
    // background and update the position's entryPrice + tokenAmount after they complete.
    let actualEntryPrice = price;
    const actualTokenAmount = tokenAmount; // will be refined in background by P1

    let solUsdForEntry: number | null = null;
    try {
      solUsdForEntry = await this.fetchSolUsdPrice(); // ~0.5-1s — fast SOL/USD from DexScreener
      if (solUsdForEntry && solUsdForEntry > 0 && sizeSol > 0 && tokenAmount > 0) {
        const TOKEN_DECIMALS = 6;
        const tokensUi = tokenAmount / Math.pow(10, TOKEN_DECIMALS);
        const jupiterPrice = (sizeSol * solUsdForEntry) / tokensUi;
        if (jupiterPrice > 0) {
          const delta = ((jupiterPrice / price - 1) * 100).toFixed(1);
          logger.info({ mint, symbol, jupiterPrice, preBuyPrice: price, delta: `${delta}%`, solUsdForEntry, sizeSol, tokensUi },
            "Graduation sniper: fast P2 entry price (Jupiter-quote) ⚡");
          actualEntryPrice = jupiterPrice;
        }
      }
    } catch { /* non-fatal — fall back to pre-buy price */ }

    if (actualEntryPrice === price) {
      logger.warn({ mint, symbol, preBuyPrice: price },
        "Graduation sniper: P2 price failed — using pre-buy price for now; P1 background will refine ⚠️");
    }

    // ── Detection→fill drift analysis ─────────────────────────────────────────
    const nowMs = Date.now();
    const msDetectionToFill = graduationDetectedAt ? nowMs - graduationDetectedAt : undefined;
    const entryDriftPct = (detectionPrice && detectionPrice > 0)
      ? ((actualEntryPrice / detectionPrice) - 1) * 100
      : undefined;
    logger.info({
      mint, symbol,
      detectionPrice:     detectionPrice ?? null,
      preBuyPrice:        price,
      actualFillPrice:    actualEntryPrice,
      entryDriftPct:      entryDriftPct !== undefined ? entryDriftPct.toFixed(2) + "%" : "n/a",
      msDetectionToFill:  msDetectionToFill ?? null,
      msDetectionToFillLabel: msDetectionToFill ? `${(msDetectionToFill / 1000).toFixed(1)}s` : "n/a",
    }, "Sniper timing: T9 — detection→fill drift summary 📊");

    // ── POST-FILL DRIFT CIRCUIT BREAKER ───────────────────────────────────────
    if (entryDriftPct !== undefined && entryDriftPct > MAX_FILL_DRIFT_PCT) {
      logger.warn(
        { mint, symbol, entryDriftPct: entryDriftPct.toFixed(1), MAX_FILL_DRIFT_PCT, actualEntryPrice, detectionPrice },
        "Graduation sniper: FILL DRIFT TOO HIGH — emergency-selling immediately 🚨",
      );
      const fillDriftReason = `Fill drift abort — filled +${entryDriftPct.toFixed(1)}% above detection price (>${MAX_FILL_DRIFT_PCT}% threshold) — emergency sold`;
      this.addEvent({
        id:          uid(),
        detectedAt:  graduationDetectedAt ?? nowMs,
        mint,
        symbol,
        action:      "skipped",
        skipReason:  fillDriftReason,
        txSignature,
      });
      this.broadcast();
      try {
        await jupiterSwapService.emergencySell(mint, actualTokenAmount, cfg.priorityFeeLamports, cfg.jitoTipLamports);
        logger.info({ mint, symbol }, "Graduation sniper: fill-drift emergency sell confirmed — position never opened");
      } catch (sellErr) {
        logger.error({ mint, symbol, err: (sellErr as Error).message }, "Graduation sniper: fill-drift emergency sell FAILED — position left open for manual close");
      }
      if (isTelegramConfigured()) {
        void sendTelegram(
          `🚨 <b>FILL DRIFT ABORT</b>\n` +
          `──────────────────────\n` +
          `🪙 Token: <b>${symbol}</b>\n` +
          `📋 CA: <code>${mint}</code>\n` +
          `📈 Fill drifted: <b>+${entryDriftPct.toFixed(1)}%</b> above detection price\n` +
          `🔄 Emergency sold — position never recorded\n` +
          `🕐 ${toIST(new Date())}`,
        );
      }
      this.seenMints.delete(mint);
      void this.refreshWalletBalance();
      return;
    }

    // ── Record position immediately with best available price ─────────────────
    const pos: SniperPosition = {
      id,
      mint,
      symbol,
      name,
      detectedAt:        graduationDetectedAt ?? nowMs,
      entryAt:           nowMs,
      entryPrice:        actualEntryPrice,
      currentPrice:      actualEntryPrice,
      sizeSol,
      tp1Hit:            false,
      tp2Hit:            false,
      remainingFraction: 1.0,
      effectiveSlPrice:  actualEntryPrice * (1 - cfg.slPct / 100),
      trailingHigh:      actualEntryPrice,
      status:            "open",
      realizedPnlSol:    0,
      unrealizedPnlSol:  0,
      totalPnlSol:       0,
      pnlPct:            0,
      txSignature,
      tokenAmount:       actualTokenAmount,
      entrySig:          txSignature,
      exitSig:           undefined,
      tp1RealizedSol:    0,
      tp2RealizedSol:    0,
      runnerRealizedSol: 0,
      detectionPrice,
      entryDriftPct,
      msDetectionToFill,
    };

    this.openPositions.set(mint, pos);
    this.seenMints.add(mint);
    void this.refreshWalletBalance();
    void this.persistPosition(pos);

    logger.info(
      { mint, symbol, actualEntryPrice, preBuyPrice: price, sizeSol, actualTokenAmount, txSignature, sl: pos.effectiveSlPrice,
        msDetectionToFill: msDetectionToFill ?? null },
      "Graduation sniper: LIVE position entered ✅ — refining entry price in background",
    );

    if (isTelegramConfigured()) {
      void sendTelegram(
        `🎯 <b>SNIPER ENTRY 🔴 LIVE</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${symbol}</b> — ${name}\n` +
        `📋 CA: <code>${mint}</code>\n` +
        `💵 Entry: <b>$${fmtTgPrice(actualEntryPrice)}</b>\n` +
        `💰 Size: <b>${sizeSol.toFixed(4)} SOL</b>\n` +
        `🔗 <a href="https://solscan.io/tx/${txSignature}">View on Solscan</a>\n` +
        `🛡️ Staged SL: -20% (2m) → -25% peak → -30% peak\n` +
        `🎯 TP1: $${fmtTgPrice(actualEntryPrice * (1 + cfg.tp1Pct / 100))} (+${cfg.tp1Pct}%)\n` +
        `🎯 TP2: $${fmtTgPrice(actualEntryPrice * (1 + cfg.tp2Pct / 100))} (+${cfg.tp2Pct}%)\n` +
        `🕐 ${toIST(new Date())}`,
      );
    }

    // ── Background: refine entry price with on-chain TX parse (P1) ───────────
    // fetchActualBuyAmounts waits 2s for Helius to index the TX — running this in
    // the background means the position is visible on the dashboard NOW, and the
    // more accurate on-chain price (matching GMGN/Solscan) updates silently.
    void this.refineEntryPriceInBackground(pos, txSignature, mint, symbol, price, solUsdForEntry, cfg.slPct);
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

  // ── Background entry-price refinement ────────────────────────────────────
  // Called after position is already recorded. Improves entryPrice accuracy:
  //   P1: on-chain TX parse (fetchActualBuyAmounts — needs 2s Helius indexing delay)
  //       → gives exact SOL spent + tokens received = most accurate price
  //   P3: DexScreener polling (up to 5×3s) — only runs if P1 also fails
  // Updates entryPrice, effectiveSlPrice, trailingHigh, tokenAmount in-place.
  // Does NOT block the entry pipeline — runs entirely as a fire-and-forget void.
  private async refineEntryPriceInBackground(
    pos: SniperPosition,
    txSignature: string,
    mint: string,
    symbol: string,
    preBuyPrice: number,
    solUsdPrice: number | null,
    slPct: number,
  ): Promise<void> {
    try {
      // P1: on-chain parse — fetches actual SOL spent + tokens received from Helius
      // fetchActualBuyAmounts() has a 2s internal sleep to let Helius index the TX.
      const txAmounts = await this.fetchActualBuyAmounts(txSignature, mint);

      if (txAmounts) {
        const openPos = this.openPositions.get(mint);
        if (!openPos) return; // position already closed

        // Refine tokenAmount — on-chain value accounts for actual slippage
        if (txAmounts.tokensReceivedRaw > 0) {
          openPos.tokenAmount = txAmounts.tokensReceivedRaw;
        }

        // Compute on-chain fill price from actual amounts
        if (txAmounts.solSpentUi > 0 && txAmounts.tokensReceivedUi > 0) {
          const solUsd = solUsdPrice ?? await this.fetchSolUsdPrice();
          if (solUsd && solUsd > 0) {
            const onChainPrice = (txAmounts.solSpentUi * solUsd) / txAmounts.tokensReceivedUi;
            if (onChainPrice > 0) {
              const delta = ((onChainPrice / openPos.entryPrice - 1) * 100).toFixed(1);
              logger.info(
                { mint, symbol, onChainPrice, prevEntryPrice: openPos.entryPrice, delta: `${delta}%`,
                  solSpent: txAmounts.solSpentUi, tokensUi: txAmounts.tokensReceivedUi },
                "Graduation sniper: on-chain P1 entry price refined in background ✅ (matches GMGN/Solscan)",
              );
              openPos.entryPrice       = onChainPrice;
              openPos.currentPrice     = onChainPrice;
              openPos.effectiveSlPrice = onChainPrice * (1 - slPct / 100);
              openPos.trailingHigh     = Math.max(openPos.trailingHigh, onChainPrice);
              void this.persistPosition(openPos);
              this.broadcast();
            }
          }
        }
        return; // P1 succeeded — no need for P3
      }

      // P3: DexScreener polling — new graduation pairs take ~15s to appear
      // Only runs when P1 returned null (Helius unavailable or TX parse failed)
      for (let attempt = 0; attempt < 5; attempt++) {
        const openPos = this.openPositions.get(mint);
        if (!openPos) return;
        if (openPos.entryPrice !== preBuyPrice) return; // P1 already updated it

        if (attempt > 0) await new Promise(r => setTimeout(r, 3_000));
        const postBuyData = await this.fetchPrice(mint);
        if (postBuyData && postBuyData.price > 0) {
          logger.info({ mint, symbol, dexPrice: postBuyData.price, attempt },
            "Graduation sniper: P3 DexScreener entry price refined in background ✅");
          openPos.entryPrice       = postBuyData.price;
          openPos.effectiveSlPrice = postBuyData.price * (1 - slPct / 100);
          openPos.trailingHigh     = Math.max(openPos.trailingHigh, postBuyData.price);
          void this.persistPosition(openPos);
          this.broadcast();
          return;
        }
      }

      logger.warn({ mint, symbol, preBuyPrice },
        "Graduation sniper: background price refinement exhausted — entryPrice remains at pre-buy value ⚠️");
    } catch { /* fully non-fatal — position is already recorded */ }
  }

  private async closePosition(pos: SniperPosition, reason: string, exitPrice: number): Promise<void> {
    // NOTE: isDuplicateTrade is intentionally NOT checked here.
    // A position in openPositions MUST always be closeable regardless of fingerprint history.
    // The old check caused a permanent silent block: if a previous close attempt registered
    // the fingerprint but the position was still open (e.g. DB write failed or server
    // restarted), every future close — including manual — would silently no-op while the
    // frontend showed a false "Position closed" toast. Fingerprint is only registered
    // AFTER a confirmed sell (registerClosedTrade below) to prevent double-recording in history.

    // Guard: if a close is already in-flight for this mint, skip.
    // Position stays in openPositions so the frontend keeps showing it.
    if (this.closingMints.has(pos.mint)) {
      logger.warn({ mint: pos.mint, symbol: pos.symbol }, "Graduation sniper: close already in-flight — skipping duplicate");
      return;
    }
    // Mark as closing WITHOUT removing from openPositions — prevents frontend flicker
    this.closingMints.add(pos.mint);

    const remaining   = pos.sizeSol * pos.remainingFraction;
    const tokensLeft  = Math.floor(pos.tokenAmount * pos.remainingFraction);

    let solReceived   = remaining;
    let exitTxSig     = "";
    const walletReady = solanaWalletService.isReady;
    try {
      if (tokensLeft > 0 && walletReady) {
        // Escalate slippage across outer retries so persistent 6024 errors get
        // progressively wider tolerance — every 3 outer failures adds 1000 bps.
        // After 6 outer failures switch straight to emergencySell (5000 bps +
        // higher priority fee) instead of burning 9 more retries at low slippage.
        const prevFails = this.sellFailCount.get(pos.mint) ?? 0;
        const escalatedSlippage = Math.min(
          this.config.slippageBps + Math.floor(prevFails / 3) * 1000,
          5000,
        );
        let result;
        if (prevFails >= 3) {
          logger.warn(
            { mint: pos.mint, symbol: pos.symbol, prevFails, escalatedSlippage: 5000 },
            "Graduation sniper: 3+ outer sell failures — switching to emergencySell (9000 bps quote + 70% swap floor + high priority fee)",
          );
          result = await jupiterSwapService.emergencySell(pos.mint, tokensLeft, this.config.priorityFeeLamports, this.config.jitoTipLamports);
        } else {
          logger.info(
            { mint: pos.mint, symbol: pos.symbol, prevFails, escalatedSlippage, baseSlippage: this.config.slippageBps },
            `Graduation sniper: sell with escalated slippage ${this.config.slippageBps} + ${Math.floor(prevFails / 3) * 1000} = ${escalatedSlippage} bps`,
          );
          result = await jupiterSwapService.sell(pos.mint, tokensLeft, escalatedSlippage, this.config.priorityFeeLamports, this.config.jitoTipLamports);
        }
        solReceived   = result.solReceived;
        exitTxSig     = result.txSignature;
      } else if (tokensLeft > 0 && !walletReady) {
        // No wallet configured — paper/virtual close at current price.
        // solReceived stays = remaining (cost basis), so P&L reflects price move correctly.
        const priceRatio = pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 1;
        solReceived = remaining * priceRatio;
        logger.warn(
          { mint: pos.mint, symbol: pos.symbol, reason },
          "Graduation sniper: wallet not configured — recording virtual close (no on-chain tx)",
        );
      }
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);

      // Check if tokens are actually gone from the wallet (sold externally via Phantom).
      // If on-chain balance is 0, the sell already happened — close the position cleanly
      // instead of retrying forever in a fail loop.
      if (walletReady) {
        try {
          const onChainBalance = await this.fetchWalletTokenBalance(pos.mint);
          if (onChainBalance !== null && onChainBalance <= 0) {
            logger.warn(
              { mint: pos.mint, symbol: pos.symbol, reason, errMsg },
              "Graduation sniper: sell failed but on-chain token balance is 0 — position was sold externally (Phantom). Closing cleanly.",
            );
            // Tokens are gone — record close at current price, SOL received is unknown so use price ratio
            const priceRatio = pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 1;
            solReceived = remaining * priceRatio;
            reason = `${reason} (sold externally — tokens not in wallet)`;
            // Fall through to the normal close-recording logic below
          } else {
            // Tokens are still in wallet — track cross-tick failures
            const fails = (this.sellFailCount.get(pos.mint) ?? 0) + 1;
            this.sellFailCount.set(pos.mint, fails);
            // Store last error for UI display (STUCK badge + tooltip on frontend)
            this.positionLastError.set(pos.mint, errMsg.slice(0, 120));

            if (fails < MAX_SELL_FAILS) {
              // Below give-up threshold — release guard and retry next tick
              this.closingMints.delete(pos.mint);
              logger.error(
                { mint: pos.mint, symbol: pos.symbol, reason, errMsg, onChainBalance, sellFailCount: fails, maxSellFails: MAX_SELL_FAILS },
                "Graduation sniper: Jupiter sell (close) FAILED ❌ — tokens still in wallet, will retry next price tick",
              );
              return;
            }

            // Hit MAX_SELL_FAILS — pool is likely dead (Custom: 6024 / ExceededSlippage).
            // Force a virtual close so this retry loop stops draining SOL on fees.
            // Tokens may still be in wallet — user must sell manually via Phantom.
            logger.error(
              { mint: pos.mint, symbol: pos.symbol, reason, errMsg, sellFailCount: fails },
              "Graduation sniper: sell FAILED 15 consecutive times — force-closing virtually. TOKENS MAY STILL BE IN WALLET — manual Phantom sell required.",
            );
            const priceRatio = pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 1;
            solReceived = remaining * priceRatio;
            reason = `${reason} — UNSELLABLE after ${fails} attempts (dead pool). SELL MANUALLY VIA PHANTOM.`;
            if (isTelegramConfigured()) {
              void sendTelegram(
                `🚨 <b>UNSELLABLE POSITION — ACTION REQUIRED</b>\n` +
                `──────────────────────\n` +
                `🪙 Token: <b>${pos.symbol}</b>\n` +
                `📋 CA: <code>${pos.mint}</code>\n` +
                `❌ Sell failed ${fails}x — Raydium pool likely dead/drained\n` +
                `⚠️ Tokens may still be in your wallet\n` +
                `👉 <b>Please sell manually via Phantom or Raydium UI</b>\n` +
                `🔗 <a href="https://raydium.io/swap/?inputMint=${pos.mint}&outputMint=So11111111111111111111111111111111111111112">Sell on Raydium</a>\n` +
                `🕐 ${toIST(new Date())}`,
              );
            }
            // Fall through to close-recording logic below (virtual close at price ratio)
          }
        } catch (balErr) {
          // Balance check failed — track cross-tick failures
          const fails = (this.sellFailCount.get(pos.mint) ?? 0) + 1;
          this.sellFailCount.set(pos.mint, fails);

          if (fails < MAX_SELL_FAILS) {
            this.closingMints.delete(pos.mint);
            logger.error(
              { mint: pos.mint, symbol: pos.symbol, reason, errMsg, balErr: (balErr as Error).message, sellFailCount: fails },
              "Graduation sniper: Jupiter sell FAILED ❌ and balance check also failed — will retry next price tick",
            );
            return;
          }

          // Give up — force virtual close
          logger.error(
            { mint: pos.mint, symbol: pos.symbol, reason, errMsg, sellFailCount: fails },
            "Graduation sniper: sell + balance-check both FAILED 15 consecutive times — force-closing virtually.",
          );
          const priceRatio = pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 1;
          solReceived = remaining * priceRatio;
          reason = `${reason} — UNSELLABLE after ${fails} attempts. SELL MANUALLY VIA PHANTOM.`;
          if (isTelegramConfigured()) {
            void sendTelegram(
              `🚨 <b>UNSELLABLE POSITION — ACTION REQUIRED</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${pos.symbol}</b>\n` +
              `📋 CA: <code>${pos.mint}</code>\n` +
              `❌ Sell failed ${fails}x — Raydium pool likely dead/drained\n` +
              `⚠️ Tokens may still be in your wallet\n` +
              `👉 <b>Please sell manually via Phantom or Raydium UI</b>\n` +
              `🔗 <a href="https://raydium.io/swap/?inputMint=${pos.mint}&outputMint=So11111111111111111111111111111111111111112">Sell on Raydium</a>\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          // Fall through to close-recording logic below
        }
      } else {
        // No wallet — can't check balance, retry next tick
        this.closingMints.delete(pos.mint);
        logger.error(
          { mint: pos.mint, symbol: pos.symbol, reason, errMsg },
          "Graduation sniper: Jupiter sell (close) FAILED ❌ — will retry next price tick",
        );
        return;
      }
    }

    // Sell confirmed — now remove from open positions
    this.openPositions.delete(pos.mint);
    this.closingMints.delete(pos.mint);
    this.sellFailCount.delete(pos.mint); // reset on confirmed close
    // Record the confirmed on-chain sell tx — positions without this are "unverified"
    if (exitTxSig) pos.exitSig = exitTxSig;

    // Only register the fingerprint AFTER a confirmed sell — prevents marking
    // a position as "already closed" when the sell hadn't actually executed.
    this.registerClosedTrade(pos);

    const closePnl = solReceived - remaining;

    pos.runnerRealizedSol += closePnl;
    pos.realizedPnlSol    += closePnl;
    pos.currentPrice       = exitPrice;
    pos.exitPrice          = exitPrice;
    if (exitTxSig) pos.txSignature = exitTxSig;
    pos.closeReason        = reason;
    pos.closedAt           = Date.now();
    pos.status             = "closed";
    pos.remainingFraction  = 0;
    this.updateLivePnl(pos);

    // Update all-time accumulators BEFORE pushing (so they include this trade)
    this.allTimeRealizedSol += pos.realizedPnlSol;
    if (pos.realizedPnlSol > 0) this.allTimeWins++; else this.allTimeLosses++;
    this.closedPositions.push(pos);
    if (this.closedPositions.length > MAX_CLOSED) this.closedPositions.shift();

    void this.persistPosition(pos);
    void this.refreshWalletBalance();
    this.broadcast(); // push real-time update to all frontend clients

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, exitPrice, solReceived, pnl: pos.realizedPnlSol, txSignature: exitTxSig },
      "Graduation sniper: position CLOSED 🔴 LIVE",
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
        `${emoji} <b>SNIPER CLOSED 🔴 LIVE</b>\n` +
        `──────────────────────\n` +
        `🪙 Token: <b>${pos.symbol}</b>\n` +
        `📋 CA: <code>${pos.mint}</code>\n` +
        `📊 Reason: <b>${reason}</b>\n` +
        `💵 Entry: $${fmtTgPrice(pos.entryPrice)} → Exit: $${fmtTgPrice(exitPrice)}\n` +
        `💰 PNL: <b>${pnlStr}</b>\n` +
        `⏱️ Held: ${holdStr}\n` +
        (exitTxSig ? `🔗 <a href="https://solscan.io/tx/${exitTxSig}">View on Solscan</a>\n` : "") +
        `🕐 ${toIST(new Date())}`,
      );
    }
  }

  private async partialClose(
    pos: SniperPosition,
    closeOriginalFraction: number,
    reason: string,
    currentPrice: number,
    breakdownKey?: "tp1" | "tp2",
  ): Promise<void> {
    // Guard: never sell more than what's actually remaining
    const actualFraction = Math.min(closeOriginalFraction, pos.remainingFraction);
    if (actualFraction <= 0) return;

    const tokensToSell = Math.floor(pos.tokenAmount * actualFraction);
    const costBasis    = pos.sizeSol * actualFraction; // SOL cost for this fraction

    let solReceived: number;
    let exitTxSig   = "";

    if (tokensToSell > 0 && solanaWalletService.isReady) {
      // CRITICAL: Do NOT catch sell failures here. If the sell throws, we let it
      // propagate so the caller (TP1/TP2 logic) knows the tokens are still in wallet.
      // Using a price-ratio fallback was the root cause of "sold in app, not on-chain".
      const result  = await jupiterSwapService.sell(pos.mint, tokensToSell, this.config.slippageBps, this.config.priorityFeeLamports, this.config.jitoTipLamports);
      solReceived   = result.solReceived;
      exitTxSig     = result.txSignature;
    } else if (tokensToSell > 0 && !solanaWalletService.isReady) {
      // No wallet — virtual/paper partial close at current price
      const priceRatio = pos.entryPrice > 0 ? currentPrice / pos.entryPrice : 1;
      solReceived = costBasis * priceRatio;
      logger.warn(
        { mint: pos.mint, symbol: pos.symbol, reason },
        "Graduation sniper: wallet not configured — recording virtual partial close (no on-chain tx)",
      );
    } else {
      // tokensToSell is 0 — this should never happen in normal operation.
      // Do NOT use solReceived = costBasis (that was fake P&L — recording breakeven when no sell happened).
      // Just abort — no real trade executed, no P&L to record.
      logger.warn(
        { mint: pos.mint, symbol: pos.symbol, tokenAmount: pos.tokenAmount, fraction: actualFraction },
        "Graduation sniper: partialClose tokensToSell=0 — skipping (no fake P&L)",
      );
      return;
    }

    const closePnl = solReceived - costBasis;
    pos.realizedPnlSol    += closePnl;
    pos.remainingFraction  = Math.max(0, pos.remainingFraction - actualFraction);
    pos.currentPrice       = currentPrice;
    if (exitTxSig) {
      pos.txSignature = exitTxSig;
      pos.exitSig     = exitTxSig;   // mark as verified on-chain sell
    }

    if (breakdownKey === "tp1") pos.tp1RealizedSol += closePnl;
    else if (breakdownKey === "tp2") pos.tp2RealizedSol += closePnl;

    void this.persistPosition(pos);
    void this.refreshWalletBalance();
    this.broadcast(); // push real-time update — TP1/TP2 partial close

    logger.info(
      { mint: pos.mint, symbol: pos.symbol, reason, tokensToSell, solReceived, closePnl: closePnl.toFixed(4), remaining: pos.remainingFraction, txSignature: exitTxSig },
      "Graduation sniper: partial close 🔴 LIVE",
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
              `🚨 <b>SNIPER LIQUIDITY RUG EXIT</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${pos.symbol}</b>\n` +
              `📋 CA: <code>${pos.mint}</code>\n` +
              `💧 Liquidity: <b>$${prev.toFixed(0)} → $${liquidityUsd.toFixed(0)}</b>\n` +
              `📉 Drained: <b>-${dropPct.toFixed(1)}%</b> in 30s\n` +
              `⚠️ Rug incoming — exiting before price collapses\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          void this.closePosition(pos, `Liquidity Rug: -${dropPct.toFixed(0)}% in 30s`, price);
        }
      } catch { /* ignore per-position errors */ }
    }
  }

  // ── FIX 5: External sell detector (Phantom wallet sells) ──────────────────
  // Polls on-chain token balances every 60s. If any open position has 0 tokens
  // in the wallet, it was sold externally (via Phantom or another wallet).
  // We mark it closed at the last known price so it disappears from the bot UI.

  private async checkExternalSells(): Promise<void> {
    if (!solanaWalletService.isReady || this.openPositions.size === 0) return;

    for (const [mint, pos] of Array.from(this.openPositions.entries())) {
      // Skip positions already mid-close
      if (this.closingMints.has(mint)) continue;

      try {
        const balance = await this.fetchWalletTokenBalance(mint);
        if (balance === null) continue; // RPC error — skip, check next tick
        if (balance > 0) continue;     // tokens still present — nothing to do

        // Balance is 0: tokens have been sold externally
        logger.warn(
          { mint, symbol: pos.symbol, recordedTokens: pos.tokenAmount },
          "Graduation sniper: on-chain token balance is 0 — position was sold externally (Phantom). Auto-closing.",
        );

        // Get a fresh price for the record; fall back to last known
        let exitPrice = pos.currentPrice > 0 ? pos.currentPrice : pos.entryPrice;
        try {
          const pd = await this.fetchPositionPrice(mint);
          if (pd && pd.price > 0) exitPrice = pd.price;
        } catch { /* ignore */ }

        // Remove from open positions and record as closed
        this.openPositions.delete(mint);
        this.closingMints.delete(mint);

        const priceRatio   = pos.entryPrice > 0 ? exitPrice / pos.entryPrice : 1;
        const remaining    = pos.sizeSol * pos.remainingFraction;
        const solReceived  = remaining * priceRatio;
        const closePnl     = solReceived - remaining;

        pos.runnerRealizedSol += closePnl;
        pos.realizedPnlSol    += closePnl;
        pos.currentPrice       = exitPrice;
        pos.exitPrice          = exitPrice;
        pos.closeReason        = "Sold externally (Phantom wallet)";
        pos.closedAt           = Date.now();
        pos.status             = "closed";
        pos.remainingFraction  = 0;
        this.updateLivePnl(pos);

        this.allTimeRealizedSol += pos.realizedPnlSol;
        if (pos.realizedPnlSol > 0) this.allTimeWins++; else this.allTimeLosses++;
        this.closedPositions.push(pos);
        if (this.closedPositions.length > MAX_CLOSED) this.closedPositions.shift();

        this.registerClosedTrade(pos);
        void this.persistPosition(pos);
        void this.refreshWalletBalance();
        this.broadcast();

        logger.info(
          { mint, symbol: pos.symbol, exitPrice, closePnl: closePnl.toFixed(4) },
          "Graduation sniper: external-sell position closed ✅",
        );

        if (isTelegramConfigured()) {
          const pnlStr = `${closePnl >= 0 ? "+" : ""}${closePnl.toFixed(4)} SOL`;
          void sendTelegram(
            `⚠️ <b>EXTERNAL SELL DETECTED</b>\n` +
            `──────────────────────\n` +
            `🪙 Token: <b>${pos.symbol}</b>\n` +
            `📋 CA: <code>${pos.mint}</code>\n` +
            `🔍 Tokens no longer in wallet — sold via Phantom or another wallet\n` +
            `💰 Est. PNL: <b>${pnlStr}</b>\n` +
            `📝 Position auto-closed in bot\n` +
            `🕐 ${toIST(new Date())}`,
          );
        }
      } catch (err) {
        logger.warn({ mint, err: (err as Error).message }, "Graduation sniper: external sell check error — skipping");
      }
    }
  }

  // ── FIX 1: Staged SL evaluator ────────────────────────────────────────────

  private async checkStagedSL(pos: SniperPosition, price: number, ageMs: number): Promise<boolean> {
    const dropFromEntry = (1 - price / pos.entryPrice) * 100;
    // Always use entryPrice as the floor for peak — if trailingHigh was loaded as 0
    // from DB (NULL column) the first tick sets it to the crashed price, making
    // dropFromPeak = 0% forever. entryPrice floor ensures SL always has a valid reference.
    const peak         = Math.max(pos.trailingHigh, pos.entryPrice);
    const dropFromPeak = peak > 0 ? (1 - price / peak) * 100 : dropFromEntry;

    // After TP2: runner is managed by the trailing stop in the main loop
    if (pos.tp2Hit) return false;

    // NOTE: Telegram notifications are intentionally sent INSIDE closePosition
    // (after on-chain confirmation) — NOT here. Sending before the sell caused
    // false "SL triggered" messages when Jupiter sell failed.

    if (pos.tp1Hit) {
      if (dropFromPeak >= STAGED_SL_AFTER_TP1) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL — after TP1");
        await this.closePosition(pos, `Staged SL: -${loss}% from TP1 peak`, price);
        return true;
      }
      return false;
    }

    if (ageMs <= STAGED_SL_PHASE1_MS) {
      if (dropFromEntry >= STAGED_SL_PHASE1_PCT) {
        const loss = dropFromEntry.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromEntry: loss }, "Graduation sniper: staged SL phase 1 (0-2m)");
        await this.closePosition(pos, `Staged SL: -${loss}% in first 2m`, price);
        return true;
      }
    } else if (ageMs <= STAGED_SL_PHASE2_MS) {
      if (dropFromPeak >= STAGED_SL_PHASE2_PCT) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL phase 2 (2-10m)");
        await this.closePosition(pos, `Staged SL: -${loss}% from peak (2-10m)`, price);
        return true;
      }
    } else {
      if (dropFromPeak >= STAGED_SL_PHASE3_PCT) {
        const loss = dropFromPeak.toFixed(0);
        logger.warn({ mint: pos.mint, symbol: pos.symbol, dropFromPeak: loss }, "Graduation sniper: staged SL phase 3 (>10m)");
        await this.closePosition(pos, `Staged SL: -${loss}% from peak (>10m)`, price);
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
    try {
      await this.partialClose(pos, tp1Frac, `TP1 +${tp1Pct}% — sell ${tp1ClosePct}%`, price, "tp1");
    } catch (err) {
      // Sell failed on-chain — revert tp1Hit so the next price tick retries.
      // Tokens are still in wallet; do NOT update PnL or remainingFraction.
      pos.tp1Hit = false;
      logger.error({ mint: pos.mint, symbol: pos.symbol, err: (err as Error).message }, "Graduation sniper: TP1 sell FAILED ❌ — reverted, will retry next tick");
      return;
    }
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
        `🟢 <b>SNIPER TP1 HIT 🔴 LIVE</b>\n──────────────────────\n` +
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

  // Prevent concurrent checkAllPrices runs — if a previous cycle is still in-flight
  // (e.g. a Jupiter sell is taking 10s), the setInterval fires again. Without this
  // guard the second run starts processing the same positions concurrently.
  private checkingPrices = false;

  private async checkAllPrices(): Promise<void> {
    if (this.checkingPrices) return;
    this.checkingPrices = true;
    try {
      if (this.openPositions.size === 0) return;

      this.tickRateCounters();

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

      // ── BATCH DexScreener fetch for ALL due positions in one request ──────────
      // This replaces the old per-position sequential loop (N calls in 3s) with a
      // single batch call (1 call for up to 30 mints) — eliminates the root cause
      // of DexScreener rate-limit pressure.
      const batchResult = await this.fetchBatchedPrices(due);

      for (const mint of due) {
        this.lastPositionCheckAt.set(mint, now);

        const preloaded = batchResult.get(mint);

        if (preloaded) {
          // Update stale guard timestamp — we have a fresh price
          this.lastPriceUpdatedAt.set(mint, now);
          await this.checkPositionPrice(mint, preloaded);
        } else {
          // DexScreener didn't return this token (may be too new).
          // Try Jupiter price API as a one-time fallback (very fast, low rate limit usage).
          const jupFallback = await this.fetchJupiterPriceFallback(mint);
          if (jupFallback) {
            this.lastPriceUpdatedAt.set(mint, now);
            await this.checkPositionPrice(mint, { price: jupFallback, liquidityUsd: 0 });
          } else {
            // No price source available — check stale guard
            const lastUpdate = this.lastPriceUpdatedAt.get(mint) ?? 0;
            const staleMs    = now - lastUpdate;
            if (staleMs > STALE_PRICE_MS) {
              logger.warn(
                { mint, staleMs: `${(staleMs / 1000).toFixed(1)}s`, symbol: this.openPositions.get(mint)?.symbol },
                "Graduation sniper: STALE price — skipping TP/SL this tick (DexScreener + Jupiter both failed)",
              );
            }
          }
        }
      }

      logger.debug(
        { due: due.length, dexHits: batchResult.size, dexMisses: due.length - batchResult.size, dexCalls: this.dexscreenerCallsThisMinute, jupCalls: this.jupiterCallsThisMinute },
        "Graduation sniper: price loop ✅",
      );
    } finally {
      this.checkingPrices = false;
    }
  }

  private async checkPositionPrice(
    mint: string,
    preloaded?: { price: number; liquidityUsd: number },
  ): Promise<void> {
    // Concurrency guard — skip if a price check is already in-flight for this mint.
    // Without this, the 10-s setInterval can fire a second tick while executeTP1Atomic
    // is in its retry-persist loop (up to 30 s), causing TP2 to execute multiple times.
    if (this.processingMints.has(mint)) return;
    this.processingMints.add(mint);

    try {
      await this._checkPositionPriceInner(mint, preloaded);
    } finally {
      this.processingMints.delete(mint);
    }
  }

  private async _checkPositionPriceInner(
    mint: string,
    preloaded?: { price: number; liquidityUsd: number },
  ): Promise<void> {
    const pos = this.openPositions.get(mint);
    // Skip positions already mid-close (sell in-flight) to avoid double-close
    if (!pos || this.closingMints.has(mint)) return;

    let priceData: { price: number; liquidityUsd?: number } | null = null;

    if (preloaded && preloaded.price > 0) {
      // Prefer the pre-fetched batch price — no extra API call needed
      priceData = preloaded;
    } else {
      // Fallback to the old per-position fetch (Jupiter first, DexScreener second)
      priceData = await this.fetchPositionPrice(mint);
    }
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
    if (await this.checkStagedSL(pos, price, ageMs)) return;

    // ── Dead position exit — open >2h with <5% movement ──────────────────────
    if (!pos.tp1Hit) {
      const movePct = Math.abs((price / pos.entryPrice - 1) * 100);
      if (ageMs >= DEAD_POSITION_MS && movePct < DEAD_MOVE_PCT) {
        logger.info(
          { mint, symbol: pos.symbol, ageH: (ageMs / 3_600_000).toFixed(1), movePct: movePct.toFixed(2) },
          "Graduation sniper: dead position exit — no momentum",
        );
        // Telegram sent inside closePosition after confirmed sell (not before)
        await this.closePosition(pos, "Dead — No Momentum", price);
        return;
      }
    }

    // ── Trailing stop for runner (after TP2) ──────────────────────────────────
    if (pos.tp2Hit && pos.trailingHigh > 0) {
      const trailTrigger = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      if (price <= trailTrigger) {
        await this.closePosition(pos, "Trailing Stop (runner)", price);
        return;
      }
    }

    // ── TP1 — FIX 3: atomic sell + SL update with retry ──────────────────────
    if (!pos.tp1Hit && price >= tp1Price) {
      await this.executeTP1Atomic(pos, price, tp1Frac, cfg.tp1Pct, cfg.tp1ClosePct);
    }

    // ── TP2 ───────────────────────────────────────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit && price >= tp2Price) {
      pos.tp2Hit = true;
      // Use Math.max — if the token retraced back to TP2 after already being higher,
      // keep the real peak so the trailing stop is measured from the actual high,
      // not the (lower) TP2 trigger price.
      pos.trailingHigh = Math.max(pos.trailingHigh, price);
      try {
        await this.partialClose(pos, tp2Frac, `TP2 +${cfg.tp2Pct}% — sell ${cfg.tp2ClosePct}%`, price, "tp2");
      } catch (err) {
        // Sell failed on-chain — revert tp2Hit so the next price tick retries.
        pos.tp2Hit = false;
        logger.error({ mint, symbol: pos.symbol, err: (err as Error).message }, "Graduation sniper: TP2 sell FAILED ❌ — reverted, will retry next tick");
        return;
      }

      // Atomic persist with retry — matches TP1 pattern. Without this, a crash between
      // TP2 sell confirmation and DB write causes TP2 to double-execute on restart.
      let tp2Persisted = false;
      for (let attempt = 0; attempt < 10 && !tp2Persisted; attempt++) {
        try {
          await this.persistPosition(pos);
          tp2Persisted = true;
        } catch (err) {
          logger.warn({ mint, attempt, err: (err as Error).message }, "Graduation sniper: TP2 atomic persist retry");
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
      if (!tp2Persisted) {
        logger.error({ mint }, "Graduation sniper: TP2 persist failed after all retries ⚠️");
      }

      logger.info({ mint, symbol: pos.symbol, price }, "Graduation sniper: TP2 hit — runner active");
      if (isTelegramConfigured()) {
        const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp2Frac;
        void sendTelegram(
          `🚀 <b>SNIPER TP2 HIT 🔴 LIVE</b>\n──────────────────────\n` +
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

  // ── Rate counter tick ──────────────────────────────────────────────────────
  // Called at the start of each price loop. Resets per-minute counters when a
  // new minute starts so the UI always shows rates for the CURRENT minute.
  private tickRateCounters(): void {
    const now = Date.now();
    if (now - this.rateWindowStart >= 60_000) {
      this.jupiterCallsThisMinute    = 0;
      this.dexscreenerCallsThisMinute = 0;
      this.rateWindowStart           = now;
    }
  }

  // ── Low-liquidity hour check ────────────────────────────────────────────────
  // 11pm–6am IST = 17:30–00:30 UTC. Expressed as UTC minutes since midnight.
  // Returns true when stricter entry filters should apply.
  private isLowLiquidityHour(): boolean {
    const d       = new Date();
    const utcMins = d.getUTCHours() * 60 + d.getUTCMinutes();
    // 17:30 UTC = 1050 min (11pm IST)   00:30 UTC = 30 min (6am IST)
    return utcMins >= 1050 || utcMins <= 30;
  }

  // ── Batched DexScreener price fetch ─────────────────────────────────────────
  // Single HTTP call for up to 30 mints → massive reduction in DexScreener load.
  // Returns a Map<mint, {price, liquidityUsd}> for each mint that DexScreener returned.
  // Missing entries = token not indexed yet (handled by caller with Jupiter fallback).
  private async fetchBatchedPrices(
    mints: string[],
  ): Promise<Map<string, { price: number; liquidityUsd: number }>> {
    const result = new Map<string, { price: number; liquidityUsd: number }>();
    if (mints.length === 0) return result;

    // Split into batches of at most BATCH_DEXSCREENER_MAX
    for (let i = 0; i < mints.length; i += BATCH_DEXSCREENER_MAX) {
      const batch = mints.slice(i, i + BATCH_DEXSCREENER_MAX);
      try {
        type DexPair = {
          baseToken: { address: string };
          priceUsd: string;
          liquidity?: { usd?: number };
          dexId?: string;
        };
        this.dexscreenerCallsThisMinute++;
        this.dexscreenerCallsTotal++;
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${batch.join(",")}`,
          { timeout: 8_000 },
        );
        const pairs = Array.isArray(res.data) ? res.data : [];

        // Group pairs by their base token address; pick highest-liquidity Raydium pair
        const byMint = new Map<string, DexPair[]>();
        for (const pair of pairs) {
          const mint = pair.baseToken?.address;
          if (!mint) continue;
          const group = byMint.get(mint) ?? [];
          group.push(pair);
          byMint.set(mint, group);
        }

        for (const [mint, pairGroup] of byMint) {
          const sorted = [...pairGroup].sort((a, b) => {
            const aRay = a.dexId === "raydium" ? 1 : 0;
            const bRay = b.dexId === "raydium" ? 1 : 0;
            if (bRay !== aRay) return bRay - aRay;
            return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
          });
          const best  = sorted[0]!;
          const price = parseFloat(best.priceUsd) || 0;
          if (price > 0) {
            result.set(mint, { price, liquidityUsd: best.liquidity?.usd ?? 0 });
          }
        }
      } catch (err) {
        logger.warn(
          { batchSize: batch.length, err: (err as Error).message },
          "Graduation sniper: fetchBatchedPrices failed — will use Jupiter fallback",
        );
      }
    }
    return result;
  }

  // ── Fast entry price fetch (Jupiter + DexScreener in parallel) ───────────────
  // For newly-graduated tokens, Jupiter indexes the pool in <5s while DexScreener
  // takes 15–60s.  Firing both in parallel means we get the price as soon as
  // EITHER source responds — cutting entry latency from 35s+ down to ~5s.
  //
  // If Jupiter wins, symbol/name default to the mint prefix (accurate metadata
  // arrives from DexScreener on the first position-monitoring tick).
  // liquidityUsd is set to 0 from Jupiter (it doesn't provide that field) — the
  // on-chain pool SOL check already validated real liquidity at this point.
  private async fetchPriceFast(mint: string): Promise<{ price: number; symbol: string; name: string; liquidityUsd: number } | null> {
    return new Promise((resolve) => {
      let settled = false;
      // Jupiter price (fast, no metadata) — stored as backup; only used if DexScreener
      // doesn't respond within 3 s.  Showing mint.slice(0,8) as symbol in the UI is
      // confusing — we always prefer DexScreener which has the real name/symbol.
      let jupiterPrice: number | null = null;
      let jupiterFallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (result: { price: number; symbol: string; name: string; liquidityUsd: number } | null) => {
        if (result && !settled) {
          settled = true;
          if (jupiterFallbackTimer) clearTimeout(jupiterFallbackTimer);
          resolve(result);
        }
      };

      // Jupiter — fast but returns no symbol/name (mint address used as placeholder).
      // Cache the price and give DexScreener up to 3 s to arrive with real metadata.
      void this.fetchJupiterPriceFallback(mint).then((price) => {
        if (price && !settled) {
          jupiterPrice = price;
          jupiterFallbackTimer = setTimeout(() => {
            if (!settled && jupiterPrice) {
              settled = true;
              resolve({ price: jupiterPrice, liquidityUsd: 0, symbol: mint.slice(0, 8), name: mint.slice(0, 8) });
            }
          }, 3_000);
        }
      }).catch(() => {});

      // DexScreener — correct symbol/name + AMM-preferred price; preferred over Jupiter.
      // After the 5 s entry delay fires T0, the pumpfun bonding-curve pair is already
      // indexed, so DexScreener typically responds in ~1-2 s here.
      void this.fetchPrice(mint).then(settle).catch(() => {});

      // Safety timeout: resolve null if both sources fail within 9 s
      setTimeout(() => {
        if (!settled) { settled = true; resolve(null); }
      }, 9_000);
    });
  }

  // ── Jupiter price API — fallback for tokens not yet indexed on DexScreener ──
  // Faster than DexScreener for very new tokens (graduates appear on Jupiter in <5s).
  // Only called when DexScreener batch missed the token — keeps Jupiter call count minimal.
  private async fetchJupiterPriceFallback(mint: string): Promise<number | null> {
    try {
      this.jupiterCallsThisMinute++;
      this.jupiterCallsTotal++;
      type JupPrice = { data: Record<string, { price: string } | null> };
      const res = await axios.get<JupPrice>(
        `${JUPITER_PRICE_URL}?ids=${mint}`,
        { timeout: 5_000 },
      );
      const entry = res.data?.data?.[mint];
      if (!entry) return null;
      const price = parseFloat(entry.price);
      return price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  // ── Health heartbeat ─────────────────────────────────────────────────────────
  // Sends a Telegram ping every 15 minutes so you know the bot is still alive.
  // ── Detection watchdog — catches silently-dead Helius subscriptions ─────────
  // The WS-level ping keeps the TCP connection open so wsConnected stays true,
  // but Helius can silently drop the logsSubscribe subscription.  This watchdog
  // runs every 60 s and:
  //   1. Logs a "Detection listener" heartbeat line (always useful in Render logs)
  //   2. Forces a full reconnect if we're "connected" but no messages for >2 min
  private startDetectionWatchdog(): void {
    if (this.detectionWatchdogId) clearInterval(this.detectionWatchdogId);
    this.detectionWatchdogId = setInterval(() => {
      const now      = Date.now();
      const sinceMs  = this.lastWsMessageAt > 0 ? now - this.lastWsMessageAt : -1;
      const sinceStr = sinceMs < 0 ? "never" : `${Math.round(sinceMs / 1000)}s ago`;

      logger.info(
        {
          wsConnected:   this.wsConnected,
          subscriptionId: this.subscriptionId,
          lastMsgAt:     this.lastWsMessageAt,
          lastMsg:       sinceStr,
          wsReconnects:  this.wsReconnects,
          graduationsToday: this.graduationsToday,
        },
        `Detection listener: ${this.wsConnected ? "connected" : "DISCONNECTED"}, last message ${sinceStr}`,
      );

      // Silent-death detection: TCP alive but subscription dead
      const isSilent = this.wsConnected && sinceMs > SILENT_DEATH_MS;
      const neverHeard = this.wsConnected && sinceMs < 0 && (now - this.startedAt) > SILENT_DEATH_MS;
      if (isSilent || neverHeard) {
        logger.warn(
          { sinceMs, wsConnected: this.wsConnected },
          "Detection listener: SILENT DEATH detected — WS connected but no messages received; force-reconnecting",
        );
        // Close the current socket — the close handler will scheduleReconnect
        this.lastWsMessageAt = 0;
        this.ws?.terminate();
      }
    }, DETECTION_WATCHDOG_MS);
  }

  private startHeartbeat(): void {
    if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);
    this.heartbeatIntervalId = setInterval(() => {
      // Telegram heartbeat temporarily disabled
      // if (!isTelegramConfigured()) return;
      // const uptimeMins = Math.floor((Date.now() - this.startedAt) / 60_000);
      // const open       = this.openPositions.size;
      // const bal        = this.walletBalanceSol.toFixed(4);
      // const isLowLiq   = this.isLowLiquidityHour();
      // const wsStatus   = this.wsConnected ? "🟢 WS Connected" : "🔴 WS Disconnected";
      // void sendTelegram(
      //   `💓 <b>SNIPER HEARTBEAT</b>\n` +
      //   `──────────────────────\n` +
      //   `${wsStatus}\n` +
      //   `📊 Open positions: <b>${open}</b>\n` +
      //   `💰 Wallet: <b>${bal} SOL</b>\n` +
      //   `⏱ Uptime: <b>${uptimeMins}m</b>\n` +
      //   `${isLowLiq ? "🌙 Low-liquidity hours active (stricter filters)" : "☀️ Active trading hours"}\n` +
      //   `📡 DexScreener: ${this.dexscreenerCallsTotal} calls · Jupiter: ${this.jupiterCallsTotal} calls\n` +
      //   `🕐 ${toIST(new Date())}`,
      // );
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Stuck tokens — tokens in wallet but not tracked as open positions ────────
  // Queries on-chain token accounts and cross-references with openPositions.
  // A token is "stuck" if it's in the wallet but not in any open position.
  // These can result from a failed sell + position manually deleted, or a swap
  // that completed but the bot crashed before recording the position.
  public async getStuckTokens(): Promise<{ mint: string; symbol: string; uiAmount: number; rawAmount: number; raydiumUrl: string }[]> {
    if (!solanaWalletService.isReady) return [];
    try {
      // getTokenAccounts() returns Map<mint, uiAmount>
      const accounts = await solanaWalletService.getTokenAccounts();
      const stuck: { mint: string; symbol: string; uiAmount: number; rawAmount: number; raydiumUrl: string }[] = [];

      for (const [mint, uiAmount] of accounts.entries()) {
        // Skip if this token is already tracked as an open position
        if (this.openPositions.has(mint)) continue;
        // Skip if balance is dust (< 0.01 UI tokens)
        if (uiAmount < 0.01) continue;

        // Try to find a symbol from closed positions history
        const closedPos = this.closedPositions.find((p) => p.mint === mint);
        const symbol    = closedPos?.symbol ?? mint.slice(0, 8);

        stuck.push({
          mint,
          symbol,
          uiAmount,
          rawAmount:   uiAmount, // uiAmount is already normalised; rawAmount not available here
          raydiumUrl:  `https://dexscreener.com/solana/${mint}`,
        });
      }
      return stuck;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: getStuckTokens failed");
      return [];
    }
  }

  // ── Emergency sell — max slippage for stuck tokens ────────────────────────────
  // Looks up position by ID, uses 50% slippage via jupiterSwapService.emergencySell.
  public async emergencySell(id: string): Promise<SniperPosition | null> {
    const openEntry = Array.from(this.openPositions.entries()).find(([, p]) => p.id === id);
    if (!openEntry) return null;
    const [, pos] = openEntry;

    const tokensLeft = Math.floor(pos.tokenAmount * pos.remainingFraction);
    if (tokensLeft <= 0) {
      throw new Error("No tokens remaining to sell");
    }

    // Clear any retry-fail guard so this can proceed immediately
    this.closingMints.delete(pos.mint);

    logger.warn({ mint: pos.mint, symbol: pos.symbol, tokensLeft, id }, "Graduation sniper: EMERGENCY SELL triggered by user");

    let exitPrice = pos.currentPrice;
    try {
      const pd = await this.fetchPrice(pos.mint);
      if (pd && pd.price > 0) exitPrice = pd.price;
    } catch { /* use last known */ }

    await this.closePosition(pos, "Emergency sell (manual)", exitPrice);
    return { ...pos };
  }

  // ── Health metrics ─────────────────────────────────────────────────────────
  public getHealthMetrics(): {
    jupiterCallsThisMinute: number;
    dexscreenerCallsThisMinute: number;
    jupiterCallsTotal: number;
    dexscreenerCallsTotal: number;
    wsConnected: boolean;
    isLowLiquidityHour: boolean;
    openPositions: number;
    walletBalance: number;
    uptimeMs: number;
  } {
    return {
      jupiterCallsThisMinute:    this.jupiterCallsThisMinute,
      dexscreenerCallsThisMinute: this.dexscreenerCallsThisMinute,
      jupiterCallsTotal:         this.jupiterCallsTotal,
      dexscreenerCallsTotal:     this.dexscreenerCallsTotal,
      wsConnected:               this.wsConnected,
      isLowLiquidityHour:        this.isLowLiquidityHour(),
      openPositions:             this.openPositions.size,
      walletBalance:             this.walletBalanceSol,
      uptimeMs:                  Date.now() - this.startedAt,
    };
  }

  // ── DB persistence ─────────────────────────────────────────────────────────

  private async persistPosition(pos: SniperPosition): Promise<void> {
    try {
      await execute(`
        INSERT INTO sniper_positions (
          id, mint, symbol, name, detected_at, entry_at, entry_price, current_price,
          size_sol, tp1_hit, tp2_hit, remaining_fraction, effective_sl_price,
          trailing_high, status, realized_pnl_sol, close_reason, closed_at, exit_price, tx_signature,
          tp1_realized_sol, tp2_realized_sol, runner_realized_sol, token_amount,
          entry_sig, exit_sig
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
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
          runner_realized_sol= EXCLUDED.runner_realized_sol,
          token_amount       = EXCLUDED.token_amount,
          tx_signature       = EXCLUDED.tx_signature,
          entry_sig          = EXCLUDED.entry_sig,
          exit_sig           = EXCLUDED.exit_sig
      `, [
        pos.id, pos.mint, pos.symbol, pos.name, pos.detectedAt, pos.entryAt,
        pos.entryPrice, pos.currentPrice, pos.sizeSol, pos.tp1Hit, pos.tp2Hit,
        pos.remainingFraction, pos.effectiveSlPrice, pos.trailingHigh, pos.status,
        pos.realizedPnlSol, pos.closeReason ?? null, pos.closedAt ?? null,
        pos.exitPrice ?? null, pos.txSignature,
        pos.tp1RealizedSol, pos.tp2RealizedSol, pos.runnerRealizedSol, pos.tokenAmount ?? 0,
        pos.entrySig ?? "", pos.exitSig ?? null,
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

  /**
   * Recompute allTimeRealizedSol / allTimeWins / allTimeLosses from the
   * closedPositions array. Must be called after any mutation that changes
   * realizedPnlSol on a closed position (delete, edit, recalculate).
   */
  private resyncAllTimeAccumulators(): void {
    this.allTimeRealizedSol = this.closedPositions.reduce((s, p) => s + p.realizedPnlSol, 0);
    this.allTimeWins        = this.closedPositions.filter((p) => p.realizedPnlSol > 0).length;
    this.allTimeLosses      = this.closedPositions.filter((p) => p.realizedPnlSol <= 0).length;
  }

  async deletePosition(id: string): Promise<boolean> {
    // Check open positions (keyed by mint)
    const openEntry = Array.from(this.openPositions.entries()).find(([, p]) => p.id === id);
    if (openEntry) {
      const [mint, pos] = openEntry;
      this.openPositions.delete(mint);
      void this.refreshWalletBalance();
      this.seenMints.delete(mint);
    } else {
      const idx = this.closedPositions.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      const pos = this.closedPositions[idx]!;
      this.seenMints.delete(pos.mint);
      this.closedPositions.splice(idx, 1);
      // Resync so header P&L/wins/losses no longer include the deleted trade
      this.resyncAllTimeAccumulators();
    }
    try {
      await execute(`DELETE FROM sniper_positions WHERE id = $1`, [id]);
    } catch (err) {
      logger.warn({ id, err: (err as Error).message }, "Graduation sniper: deletePosition DB error");
    }
    return true;
  }

  /**
   * Manually close an open position at the current market price (fetched from Jupiter).
   * Falls back to the last known currentPrice if the price fetch fails.
   */
  async manualClosePosition(id: string): Promise<SniperPosition | null> {
    const openEntry = Array.from(this.openPositions.entries()).find(([, p]) => p.id === id);
    if (!openEntry) return null;
    const [, pos] = openEntry;

    // Try to get a fresh price; fall back to last known price
    let exitPrice = pos.currentPrice;
    try {
      const priceData = await this.fetchPrice(pos.mint);
      if (priceData && priceData.price > 0) exitPrice = priceData.price;
    } catch { /* ignore — use last known price */ }

    await this.closePosition(pos, "Manual close", exitPrice);
    return { ...pos };
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

    // Resync so header totals immediately reflect the corrected P&L
    this.resyncAllTimeAccumulators();

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

    // Resync all-time accumulators if this is a closed position — realizedPnl may have changed
    if (pos.status === "closed") this.resyncAllTimeAccumulators();

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
    void this.refreshWalletBalance();
    this.allTimeRealizedSol = 0;
    this.allTimeWins = 0;
    this.allTimeLosses = 0;

    try {
      await execute(`DELETE FROM sniper_positions`, []);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Graduation sniper: resetAccount DB error");
    }
    logger.info({ walletBalance: this.walletBalanceSol }, "Graduation sniper: account reset");
  }

  deleteEvent(id: string): boolean {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.events.splice(idx, 1);
    return true;
  }

  /**
   * Delete all closed positions that have no confirmed on-chain sell (exitSig is null/empty).
   * These are positions closed by the old buggy code that never actually executed a real sell.
   * Returns the number of records removed.
   */
  async purgeUnverifiedHistory(): Promise<number> {
    const before = this.closedPositions.length;
    this.closedPositions = this.closedPositions.filter((p) => !!p.exitSig);
    const removed = before - this.closedPositions.length;

    if (removed > 0) {
      this.resyncAllTimeAccumulators();
      this.broadcast();
      try {
        // Remove from DB: closed positions with no exit_sig set
        await execute(
          `DELETE FROM sniper_positions WHERE status = 'closed' AND (exit_sig IS NULL OR exit_sig = '')`,
          [],
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Graduation sniper: purgeUnverifiedHistory DB error");
      }
      logger.info({ removed }, "Graduation sniper: purged unverified history records");
    }
    return removed;
  }

  /**
   * Re-inject a position that was lost due to a server restart or missed entry.
   * No on-chain buy is executed — the tokens are assumed to already be in the wallet.
   * Jupiter price is fetched once to populate currentPrice; entryPrice is user-provided.
   */
  async injectPosition(
    mint: string,
    symbol: string,
    entryPrice: number,
    sizeSol: number,
    entryAtMs?: number,
  ): Promise<SniperPosition> {
    const cfg = this.config;
    const id  = uid();

    // Try to get live price; fall back to entryPrice
    let currentPrice = entryPrice;
    try {
      const pd = await this.fetchPrice(mint);
      if (pd && pd.price > 0) currentPrice = pd.price;
    } catch { /* ignore */ }

    // Estimate token amount from size and entry price (best-effort)
    const estimatedTokens = entryPrice > 0 ? Math.floor(sizeSol / entryPrice) : 0;

    const pos: SniperPosition = {
      id,
      mint,
      symbol,
      name:              symbol,
      detectedAt:        entryAtMs ?? Date.now(),
      entryAt:           entryAtMs ?? Date.now(),
      entryPrice,
      currentPrice,
      sizeSol,
      tp1Hit:            false,
      tp2Hit:            false,
      remainingFraction: 1.0,
      effectiveSlPrice:  entryPrice * (1 - cfg.slPct / 100),
      trailingHigh:      Math.max(entryPrice, currentPrice),
      status:            "open",
      realizedPnlSol:    0,
      unrealizedPnlSol:  0,
      totalPnlSol:       0,
      pnlPct:            0,
      txSignature:       "",
      tokenAmount:       estimatedTokens,
      entrySig:          "",    // injected manually — no buy tx
      exitSig:           undefined,
      tp1RealizedSol:    0,
      tp2RealizedSol:    0,
      runnerRealizedSol: 0,
    };

    this.openPositions.set(mint, pos);
    this.seenMints.add(mint);
    void this.persistPosition(pos);
    void this.refreshWalletBalance();
    this.broadcast();

    logger.info(
      { mint, symbol, entryPrice, currentPrice, sizeSol, tokenAmount: estimatedTokens },
      "Graduation sniper: position INJECTED (manual re-entry, no on-chain buy)",
    );

    return { ...pos };
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  getStatus(): SniperStatus {
    // Use all-time accumulators (not closedPositions which is capped at MAX_CLOSED)
    // so wins/losses/realized are correct even after 100+ trades.
    const wins     = this.allTimeWins;
    const losses   = this.allTimeLosses;

    // Single-pass over open positions so all three figures are computed from
    // the same snapshot — prevents COMBINED ≠ REALIZED + UNREALIZED drift.
    let unrealized  = 0;
    let partialOpen = 0;
    let capitalInOpen = 0;
    for (const pos of this.openPositions.values()) {
      this.updateLivePnl(pos);
      unrealized    += pos.unrealizedPnlSol;
      partialOpen   += pos.realizedPnlSol;
      capitalInOpen += pos.sizeSol * pos.remainingFraction;
    }

    const totalRealized   = this.allTimeRealizedSol + partialOpen;
    const totalUnrealized = unrealized;

    return {
      wsConnected:            this.wsConnected,
      wsReconnects:           this.wsReconnects,
      lastWsMessageAt:        this.lastWsMessageAt,
      enabled:                this.config.enabled,
      graduationsToday:       this.graduationsToday,
      tradesTotal:            this.seenMints.size,
      wins,
      losses,
      totalRealizedPnlSol:    totalRealized,
      totalUnrealizedPnlSol:  totalUnrealized,
      totalCombinedPnlSol:    totalRealized + totalUnrealized,
      capitalInOpen,
      walletBalance:          this.walletBalanceSol,
      walletAddress:          solanaWalletService.publicKey,
      walletReady:            solanaWalletService.isReady,
      openCount:              this.openPositions.size,
      config:                 this.config,
    };
  }

  getOpenPositions(): SniperPosition[] {
    return Array.from(this.openPositions.values()).map((p) => {
      this.updateLivePnl(p);
      const failCount = this.sellFailCount.get(p.mint) ?? 0;
      return {
        ...p,
        // Runtime-only fields populated for the UI
        closingAttempt: this.closingMints.has(p.mint) ? failCount : (failCount > 0 ? failCount : undefined),
        isStuck:        failCount >= MAX_SELL_FAILS,
        lastError:      this.positionLastError.get(p.mint),
        lastPriceAt:    this.lastPriceUpdatedAt.get(p.mint),
      };
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

  setPaperSniperCallback(
    fn: (mint: string, entryPrice: number, symbol: string, name: string, detectedAt: number, detectionPrice: number) => void,
  ): void {
    this.paperCallback = fn;
  }
}

export const graduationSniperService = new GraduationSniperService();
