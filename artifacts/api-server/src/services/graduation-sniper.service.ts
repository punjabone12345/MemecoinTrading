import WebSocket from "ws";
import axios from "axios";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { blacklistService } from "./blacklist.service.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";
import { solanaWalletService } from "./solana-wallet.service.js";
import { jupiterSwapService } from "./jupiter-swap.service.js";
import { tokenQualityService, type QualityMetrics } from "./token-quality.service.js";

// ── Quality meta passed to paper sniper at entry ──────────────────────────────
export interface GraduationQualityMeta {
  /** Pool liquidity in USD at graduation time */
  poolLiquidityUsd?: number;
  /** Minutes it took for the bonding curve to complete */
  bondingCurveMinutes?: number;
  /** Holder count at graduation time */
  holderCount?: number;
  /** Creator holdings % (rug-risk filter) */
  creatorHoldingsPct?: number;
  /** Top-holder concentration % */
  topHolderPct?: number;
  /** Whether whale dump was detected */
  whaleDetected?: boolean;
  /** Whether an on-chain price was confirmed before entry */
  onChainPriceConfirmed?: boolean;
  /** Quality auto-skip reason — when set, the paper sniper should log this as a skipped event */
  autoSkipReason?: string;
  /** Raw quality score (0-100) */
  qualityScore?: number;
  /** Unique buyer count from Helius */
  uniqueBuyers?: number;
  /** Buy pressure ratio (buys/sells) */
  buyPressureRatio?: number;
  /** Liquidity in SOL */
  liquiditySol?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────
const MIGRATION_WALLET   = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const PUMPFUN_PROGRAM_ID  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
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
const ENTRY_DRIFT_ABORT_PCT  = 8;              // abort buy if price rose > 8% from baseline (spec: entry drift >8% → skip)
const MOMENTUM_SKIP_PCT      = 8;              // label as "Missed entry" if > 8% from baseline
// POST-FILL circuit breaker: if the actual Jupiter fill price is > this % above the
// detection baseline, the buy chased the pump too hard. Emergency-sell immediately and
// release seenMints so the token can be reconsidered on the next graduation event.
const MAX_FILL_DRIFT_PCT     = 15;             // emergency-sell if fill > 15% above detection price

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

// ── Dip-Retrace entry strategy ────────────────────────────────────────────────
// After graduation: watch each token for DIP_WATCH_DURATION_MS.
// Enter only when price dumps DIP_MIN_PCT–DIP_MAX_PCT from its post-graduation
// peak HIGH and then retraces at least RETRACE_MIN_PCT of that dump.
// Example: pump 30k→50k, dump 50k→25k (50% dump ✓), retrace to 40k (60% retrace ✓) → BUY
const DIP_WATCH_DURATION_MS = 30 * 60_000;  // 30-minute watch window
const DIP_MIN_PCT            = 40;           // min dump from peak to qualify (%)
const DIP_MAX_PCT            = 60;           // max dump from peak (above = too deep, skip)
const RETRACE_MIN_PCT        = 60;           // min retrace of dump needed to trigger entry (%)


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
  // Stop-loss
  slPct: number;
  // TP1 — sell 30% at +100%
  tp1Pct: number;
  tp1ClosePct: number;
  // TP2 — sell 30% at +300%, trailing SL -15%
  tp2Pct: number;
  tp2ClosePct: number;
  trailingStopAfterTp2Pct: number;
  // TP3 — sell 20% at +600%, tighten trailing to -10%
  tp3Pct: number;
  tp3ClosePct: number;
  trailingStopAfterTp3Pct: number;
  // Runner (after TP3): trailing SL -10% from peak
  trailingStopPct: number;
  // Quality gate
  minQualityScore: number;
  // Candle entry window (ms from graduation detection)
  maxEntryWindowMs: number;
  waitBeforeEntryMs: number;
  slippageBps: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
}

const DEFAULT_CONFIG: SniperConfig = {
  enabled:              true,
  positionSizeSol:      0.001,  // spec: 0.001 SOL base position size
  maxOpenPositions:     5,
  // Staged SL — displayed value matches Phase 1 threshold
  slPct:                20,     // Phase 1: hard SL -20% from entry (pre-TP1, 0-2 min)
  tp1Pct:               100,    // TP1 at +100%
  tp1ClosePct:          30,     // sell 30% at TP1
  tp2Pct:               300,    // TP2 at +300%
  tp2ClosePct:          30,     // sell 30% at TP2
  trailingStopAfterTp2Pct: 15,  // trailing SL -15% after TP2
  tp3Pct:               600,    // TP3 at +600%
  tp3ClosePct:          20,     // sell 20% at TP3
  trailingStopAfterTp3Pct: 10,  // trailing SL -10% after TP3
  trailingStopPct:      10,     // runner trailing SL -10% (same as after TP3)
  // Quality gate
  minQualityScore:      70,     // minimum score out of 100 to enter
  maxEntryWindowMs:     90_000, // 90s from detection to enter
  waitBeforeEntryMs:    0,
  slippageBps:          3000,
  priorityFeeLamports:  500_000,
  jitoTipLamports:      100_000,
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
  txSignature: string;
  tokenAmount: number;
  entrySig: string;
  exitSig?: string;
  // P&L breakdown per stage
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  tp3RealizedSol: number;
  runnerRealizedSol: number;
  // Entry drift / latency analysis
  detectionPrice?: number;
  entryDriftPct?: number;
  msDetectionToFill?: number;
  // Quality metrics at entry
  qualityScore: number;
  liquiditySol: number;
  buyPressureRatio: number;
  uniqueBuyers: number;
  topHolderPct: number;
  whaleDetected: boolean;
  positionMultiplier: number;
}

export interface SniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "watching";
  skipReason?: string;
  txSignature: string;
  // Quality metrics (present for entered + quality-skipped events)
  qualityScore?: number;
  liquiditySol?: number;
  uniqueBuyers?: number;
  buyPressureRatio?: number;
  topHolderPct?: number;
  creatorHoldingsPct?: number;
  whaleDetected?: boolean;
  // Staged re-evaluation fields (present for watching events)
  watchStage?: "T+180s" | "T+600s";   // which checkpoint we are waiting for
  baselineBuyers?: number;             // buyers at T+60s when borderline detected
  baselineLiq?: number;                // liquidity (SOL) at T+60s when borderline detected
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

// ── Dip-watch entry (dip-and-retrace strategy) ──────────────────────────────

export interface DipWatchEntry {
  mint: string;
  symbol: string;
  name: string;
  watchStartedAt: number;   // ms epoch when watcher was created
  expiresAt: number;         // watchStartedAt + DIP_WATCH_DURATION_MS
  graduationPrice: number;   // price at graduation detection (initial price)
  peakHigh: number;          // highest price seen since graduation
  dipLow: number;            // lowest price after peak dump starts
  currentPrice: number;      // latest fetched price
  state: "pumping" | "dumped" | "retracing" | "entered" | "expired";
  dumpPct: number;           // (peakHigh - dipLow) / peakHigh * 100
  retracePct: number;        // (currentPrice - dipLow) / (peakHigh - dipLow) * 100
  qualityScore: number;
}

// Internal-only extension of DipWatchEntry (holds state that should not leave the service)
interface DipWatchInternal extends DipWatchEntry {
  _quality: QualityMetrics;
  _signature: string;
  _positionSizeSol: number;
  _detectedAt: number;
  _initialPrice: number;
  _liveOnlySkip: string | null;
}

// ── Service ──────────────────────────────────────────────────────────────────

class GraduationSniperService {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private subscriptionId: number | null = null;
  private paperCallback: ((mint: string, entryPrice: number, symbol: string, name: string, detectedAt: number, detectionPrice: number, qualityMeta?: GraduationQualityMeta) => void) | null = null;
  private priceIntervalId: ReturnType<typeof setInterval> | null = null;
  private dipWatchIntervalId: ReturnType<typeof setInterval> | null = null;
  private dipWatchMap: Map<string, DipWatchInternal> = new Map();
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
  // Sell pressure tracking — tracks when consecutive sell pressure started per mint
  // Spec: sell pressure > buy pressure for 60 consecutive seconds → emergency exit
  private sellPressureStartAt: Map<string, number> = new Map();

  // ── Health monitoring & rate counters ──────────────────────────────────────
  private jupiterCallsThisMinute    = 0;
  private dexscreenerCallsThisMinute = 0;
  private jupiterCallsTotal         = 0;
  private dexscreenerCallsTotal     = 0;
  private rateWindowStart           = Date.now();
  private heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;
  private wsPingIntervalId: ReturnType<typeof setInterval> | null = null;  // WS-level ping keepalive
  private startedAt                 = Date.now();
  // Unix timestamp (seconds) of when THIS server process started.
  // Used to reject Helius WebSocket replay events (migrations that were
  // confirmed on-chain before this process booted are by definition stale
  // and must never be traded, regardless of how old they are in seconds).
  private readonly serverStartTimeSec = Math.floor(Date.now() / 1000);

  // ── Stale-price guard ──────────────────────────────────────────────────────
  // Tracks when each position last got a valid price update from DexScreener.
  // If the gap exceeds STALE_PRICE_MS, TP/SL checks are skipped for that tick.
  private lastPriceUpdatedAt: Map<string, number> = new Map();

  // ── Per-position error tracking (for UI badge display) ────────────────────
  private positionLastError: Map<string, string> = new Map();

  // ── PumpSwap on-chain liquidity cache ─────────────────────────────────────
  // Caches the WSOL vault pubkey per mint so we only read the pool account once.
  private pumpswapVaultCache: Map<string, string> = new Map();
  // Cached SOL/USD price (refreshed every 30s) to avoid repeated DexScreener calls
  // inside the already-batched price loop.
  private cachedSolUsd     = 0;
  private solUsdCachedAt   = 0;

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

  // ── Cached SOL/USD price (30-second TTL) ─────────────────────────────────
  // Prevents a redundant DexScreener call for every token in the price loop
  // when we need SOL/USD to convert on-chain vault balances to USD liquidity.
  private async fetchCachedSolUsd(): Promise<number> {
    const SOL_USD_CACHE_TTL = 30_000;
    if (this.cachedSolUsd > 0 && Date.now() - this.solUsdCachedAt < SOL_USD_CACHE_TTL) {
      return this.cachedSolUsd;
    }
    const price = await this.fetchSolUsdPrice();
    if (price && price > 0) {
      this.cachedSolUsd   = price;
      this.solUsdCachedAt = Date.now();
    }
    return this.cachedSolUsd;
  }

  // ── PumpSwap on-chain liquidity fallback ──────────────────────────────────
  // DexScreener takes 3–5 minutes to populate liquidity.usd for freshly
  // graduated PumpSwap tokens, so it reports 0 during the critical early window.
  //
  // Proof-tested approach (PDA derivation does NOT work — PumpSwap pool accounts
  // are keypair-based, not PDAs). Instead we use the pool address directly:
  //   1. Caller passes the pool address (pairAddress from DexScreener response).
  //   2. Read pool account (base64) and extract the WSOL vault pubkey at
  //      byte offset 171 (8 discriminator + 1 bump + 2 index + 32 creator +
  //      32 base_mint + 32 quote_mint + 32 lp_mint + 32 pool_base_token_account).
  //   3. getTokenAccountBalance on the WSOL vault → SOL amount.
  //   4. Return SOL × solUsd.
  //
  // The vault pubkey is cached per poolAddress so step 2 hits RPC only once.
  private async fetchPumpSwapLiquidityUsd(poolAddress: string, solUsd: number): Promise<number> {
    if (solUsd <= 0 || !poolAddress) return 0;

    const apiKey  = process.env["HELIUS_API_KEY"];
    const rpcUrls = apiKey
      ? [
          `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
          "https://api.mainnet-beta.solana.com",
        ]
      : ["https://api.mainnet-beta.solana.com"];

    try {
      // ── Step 1: Resolve WSOL vault pubkey (cached per pool address) ───────
      let wsolVault = this.pumpswapVaultCache.get(poolAddress) ?? null;

      if (!wsolVault) {
        for (const rpcUrl of rpcUrls) {
          try {
            type AccInfo = {
              result?: { value?: { data?: [string, string] } | null };
            };
            const res = await axios.post<AccInfo>(
              rpcUrl,
              {
                jsonrpc: "2.0", id: 1,
                method: "getAccountInfo",
                params: [poolAddress, { encoding: "base64" }],
              },
              { timeout: 5_000 },
            );
            const b64 = res.data?.result?.value?.data?.[0];
            if (!b64) continue;
            const buf = Buffer.from(b64, "base64");
            // PumpSwap Pool layout (all pubkeys are 32 bytes):
            // [0-7]   discriminator (8)
            // [8]     pool_bump     (1)
            // [9-10]  index         (2)
            // [11-42] creator       (32)
            // [43-74] base_mint     (32)
            // [75-106] quote_mint   (32)
            // [107-138] lp_mint     (32)
            // [139-170] pool_base_token_account (32)
            // [171-202] pool_quote_token_account = WSOL vault (32) ← here
            if (buf.length < 203) continue;
            wsolVault = new PublicKey(buf.subarray(171, 203)).toBase58();
            this.pumpswapVaultCache.set(poolAddress, wsolVault);
            logger.debug(
              { pool: poolAddress.slice(0, 8), wsolVault: wsolVault.slice(0, 8) },
              "PumpSwap liquidity: WSOL vault resolved from pool account ✅",
            );
            break;
          } catch {
            continue;
          }
        }
      }

      if (!wsolVault) return 0;

      // ── Step 2: Read WSOL vault balance ───────────────────────────────────
      for (const rpcUrl of rpcUrls) {
        try {
          type BalResp = {
            result?: { value?: { uiAmount?: number | null } };
          };
          const res = await axios.post<BalResp>(
            rpcUrl,
            {
              jsonrpc: "2.0", id: 2,
              method: "getTokenAccountBalance",
              params: [wsolVault],
            },
            { timeout: 5_000 },
          );
          const solBalance = res.data?.result?.value?.uiAmount ?? 0;
          if (solBalance > 0) {
            const liquidityUsd = solBalance * solUsd;
            logger.info(
              { pool: poolAddress.slice(0, 8), wsolVault: wsolVault.slice(0, 8), solBalance: solBalance.toFixed(2), liquidityUsd: liquidityUsd.toFixed(0) },
              "PumpSwap liquidity: on-chain WSOL vault → liquidityUsd ✅",
            );
            return liquidityUsd;
          }
        } catch {
          continue;
        }
      }
    } catch (err) {
      logger.debug(
        { pool: poolAddress.slice(0, 8), err: (err as Error).message },
        "PumpSwap liquidity: on-chain fallback failed",
      );
    }

    return 0;
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
      tp3RealizedSol:   Number(row["tp3_realized_sol"] ?? 0),
      runnerRealizedSol: Number(row["runner_realized_sol"] ?? 0),
      tp3Hit:            Boolean(row["tp3_hit"]),
      qualityScore:      Number(row["quality_score"] ?? 0),
      liquiditySol:      Number(row["liquidity_sol"] ?? 0),
      buyPressureRatio:  Number(row["buy_pressure_ratio"] ?? 1),
      uniqueBuyers:      Number(row["unique_buyers"] ?? 0),
      topHolderPct:      Number(row["top_holder_pct"] ?? 0),
      whaleDetected:     Boolean(row["whale_detected"]),
      positionMultiplier: Number(row["position_multiplier"] ?? 1),
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
    // Dip-retrace watcher — runs every 5 s independently of the open-position loop
    this.dipWatchIntervalId  = setInterval(() => void this.checkDipWatchers(), 5_000);

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
    if (this.dipWatchIntervalId)     { clearInterval(this.dipWatchIntervalId);     this.dipWatchIntervalId     = null; }
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

      // ── Subscriptions 2 & 3 REMOVED ─────────────────────────────────────────
      // The pump.fun program sub (mentions PUMPFUN_PROGRAM_ID) fired for every
      // pump.fun buy/sell TX (~1000s/min), producing ~49 false grad events per
      // real one even with log-level "migrate" instruction filtering.
      // The PumpSwap AMM sub (mentions PUMPSWAP_PROGRAM_ID) fired for all
      // PumpSwap TXes including non-pump.fun tokens launched directly on PumpSwap.
      // Both are unnecessary: the migration wallet sub below is authoritative —
      // 39azUY… signs EVERY pump.fun graduation and NOTHING else.
      // The backfill (getSignaturesForAddress on the same wallet) covers reconnect gaps.

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

      // ── Backfill missed graduations (RECONNECTS ONLY) ────────────────────
      // On reconnect: covers graduations that fired during the WS gap.
      // NOT run on initial connect — the live WS catches fresh events going
      // forward, and backfilling on boot was the root cause of re-trading
      // OLD migrations from before the server started.
      if (this.wsReconnects > 0) {
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
  // via REST and processes ONLY those that:
  //   1. Are NOT already in seenSignatures
  //   2. Have blockTime within the last MAX_BACKFILL_AGE_SEC seconds
  //      (getSignaturesForAddress returns blockTime — use it to pre-filter
  //       before making any getTransaction RPC call, saving rate-limit budget)
  //   3. If blockTime is null (very recent, not yet finalized) — allow through;
  //      extractMintFromTx's inner age gate is the final backstop.
  //
  // MAX_BACKFILL_AGE_SEC: same as the TX age gate in extractMintFromTx.
  // Anything older cannot be a tradeable fresh pool anyway.
  private async backfillMissedGraduations(): Promise<void> {
    const apiKey = this.heliusApiKey;
    if (!apiKey) return;

    const MAX_BACKFILL_AGE_SEC = 30; // must match extractMintFromTx MAX_TX_AGE_SEC
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      type SigInfo = { signature: string; err: unknown | null; blockTime?: number | null };
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
      let tooOld  = 0;

      for (const { signature, err, blockTime } of sigs) {
        if (err) continue;       // failed TX on-chain — skip
        if (!signature) continue;

        // ── Pre-filter by blockTime ───────────────────────────────────────────
        // getSignaturesForAddress includes blockTime for confirmed/finalized TXes.
        // If blockTime is present and older than MAX_BACKFILL_AGE_SEC, mark as
        // seen (suppress future re-processing) and skip immediately — no need to
        // call getTransaction. This is the critical guard against re-trading
        // historical migrations on every reconnect.
        if (blockTime != null) {
          const ageSec = nowSec - blockTime;
          if (ageSec > MAX_BACKFILL_AGE_SEC) {
            // Pre-mark as seen so the live WS or future backfills don't re-queue
            this.seenSignatures.add(signature);
            tooOld++;
            continue;
          }
        }

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
        { checked: sigs.length, queued, tooOld, reconnects: this.wsReconnects },
        queued > 0
          ? "Graduation sniper: backfill — queued missed graduations ✅"
          : `Graduation sniper: backfill — no missed graduations (${tooOld} too old, rest already seen)`,
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

    // ── Migration wallet + migrate instruction pre-filter (LAYER 2 gate) ─────
    // The Helius subscription already limits delivery to TXes mentioning 39azUY…
    // but that wallet could theoretically sign non-migration TXes too.
    // We require the TX logs to also contain the pump.fun Anchor instruction name
    // ("Instruction: Migrate" or "MigrateV2") before processing further.
    // The WS logsNotification includes the full logs array — no extra RPC call needed.
    const txLogs = value["logs"] as string[] | undefined;
    const hasMigrateLog = (txLogs ?? []).some((l) => {
      const lower = l.toLowerCase();
      return lower.includes("instruction: migrate")
          || lower.includes("migrate_v2")
          || lower.includes("migratev2");
    });

    if (!hasMigrateLog) {
      logger.debug(
        { signature, logCount: txLogs?.length ?? 0 },
        "Graduation sniper: migration wallet TX skipped — no migrate instruction in logs ⛔",
      );
      return; // not a pump.fun graduation — discard without spawning processGraduation
    }

    logger.info({ signature, logCount: txLogs?.length ?? 0 },
      "Graduation sniper: migration wallet TX + migrate instruction confirmed ⚡");

    // ── Signature-level dedup ─────────────────────────────────────────────────
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

      const { mint, wsolVaultPubkey, tokenVaultPubkey } = extracted;
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

      // ── Entry delay ────────────────────────────────────────────────────────────
      {
        const elapsed = Date.now() - detectedAt;
        const remaining = Math.max(0, this.config.waitBeforeEntryMs - elapsed);
        if (remaining > 0) {
          logger.info({ mint, elapsed, remaining }, 'Graduation sniper: entry delay wait');
          await new Promise<void>((r) => setTimeout(r, remaining));
        }
      }

      // ── T0: on-chain price + SOL/USD (parallel) ────────────────────────────────
      // Pool accounts are created in the graduation TX but may not be readable
      // immediately — retry up to 3× with 1.5s delay to let RPC state settle.
      //
      // IMPORTANT: We no longer require tokenVaultPubkey to be non-null.
      // PumpSwap migration TXes often have the token vault accountIndex in the
      // ALT range that fails to resolve → tokenVaultPubkey = null. But we can
      // still read wsolVaultPubkey alone for liquiditySol (the critical metric).
      // If BOTH vaults are present we get a full price; otherwise SOL-balance only.
      const fetchReservesWithRetry = async () => {
        if (!wsolVaultPubkey) return null;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 1_500));
          if (tokenVaultPubkey) {
            // Full reserves — gives us both solBalance and price
            const r = await this.fetchOnChainPoolReserves(wsolVaultPubkey, tokenVaultPubkey);
            if (r && r.solBalance > 0 && r.tokenBalanceUi > 0) {
              if (attempt > 0) logger.info({ mint, attempt, solBalance: r.solBalance.toFixed(2) }, "Graduation sniper: on-chain reserves settled after retry ✅");
              return r;
            }
          } else {
            // SOL-only read — enough for the liquidity check; price comes from DexScreener later
            const sol = await this.fetchOnChainPoolSol(wsolVaultPubkey);
            if (sol && sol > 0) {
              logger.info({ mint, attempt, solBalance: sol.toFixed(2) }, "Graduation sniper: SOL-only reserve read (no token vault) ✅");
              return { solBalance: sol, tokenBalanceUi: 0, price: 0 };
            }
          }
        }
        logger.warn({ mint, wsolVaultPubkey: wsolVaultPubkey.slice(0, 8), hadTokenVault: !!tokenVaultPubkey }, "Graduation sniper: on-chain reserves still 0 after 3 attempts — falling back to DexScreener");
        return null;
      };

      const [reserves, solUsd] = await Promise.all([
        fetchReservesWithRetry(),
        this.fetchSolUsdPrice(),
      ]);

      const initialPoolSol    = reserves?.solBalance ?? 0;
      const effectiveSolUsd   = solUsd ?? 150;
      const initialPrice      = (reserves && reserves.solBalance > 0 && reserves.tokenBalanceUi > 0 && effectiveSolUsd > 0)
        ? (reserves.solBalance / reserves.tokenBalanceUi) * effectiveSolUsd
        : 0;

      // Pre-quality pool SOL check — fast rejection before 60s quality window
      if (initialPoolSol > 0) {
        const minPoolSol = this.isLowLiquidityHour() ? LOW_LIQ_MIN_POOL_SOL : MIN_POOL_SOL;
        if (initialPoolSol < minPoolSol) {
          const reason = `Pool drained — ${initialPoolSol.toFixed(2)} SOL < ${minPoolSol} SOL (pre-quality rug filter)`;
          this.addEvent({ ...eventBase, action: 'skipped', skipReason: reason });
          logger.warn({ mint, initialPoolSol, minPoolSol }, 'Graduation sniper: pre-quality pool SOL check failed ❌');
          return;
        }
        logger.info({ mint, initialPoolSol }, 'Graduation sniper: pre-quality pool SOL check passed ✅');
      }

      // ── Symbol resolution (3s race with DexScreener) ──────────────────────────
      let symbol = mint.slice(0, 8);
      let name   = mint.slice(0, 8);
      try {
        const dexEarly = await Promise.race([
          this.fetchPriceFast(mint),
          new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
        ]);
        if (dexEarly) {
          symbol = dexEarly.symbol || mint.slice(0, 8);
          name   = dexEarly.name   || mint.slice(0, 8);
        }
      } catch { /* non-fatal */ }

      const fullEventBase = { ...eventBase, symbol };

      // ── Derive PumpSwap pool PDA (for buyer data collection) ──────────────────
      let poolPda: string | null = null;
      try {
        const { PublicKey: PK } = await import('@solana/web3.js');
        const mPK = new PK(mint);
        const pPK = new PK(PUMPSWAP_PROGRAM_ID);
        const idx = Buffer.from([0, 0]);
        const wPK = new PK('So11111111111111111111111111111111111111112');
        const [pda] = PK.findProgramAddressSync([Buffer.from('pool'), idx, mPK.toBuffer(), wPK.toBuffer()], pPK);
        poolPda = pda.toBase58();
      } catch { /* non-fatal */ }

      // ── QUALITY COLLECTION (parallel, ~60s window) ────────────────────────────
      const heliusKey = process.env['HELIUS_API_KEY'] ?? null;
      let quality = await tokenQualityService.collectQualityData(
        mint, symbol, poolPda, initialPoolSol, heliusKey, wsolVaultPubkey,
      );

      // ── Quality gate (staged re-evaluation) ───────────────────────────────────
      // Hard-fail auto-skip (creator >5%, liq <25 SOL, buyers <20, etc.) → permanent skip.
      // Score ≥ minQualityScore (70) → enter immediately.
      // Score 50–69 (borderline, no hard-fail) → staged watching: T+180s then T+600s re-check.
      // Score < 50 → too low, skip permanently.

      const makeQualityFields = (q: typeof quality) => ({
        qualityScore:      q.totalScore,
        liquiditySol:      q.liquiditySol,
        uniqueBuyers:      q.uniqueBuyers,
        buyPressureRatio:  q.buyPressureRatio,
        topHolderPct:      q.topHolderPct,
        creatorHoldingsPct: q.creatorHoldingsPct,
        whaleDetected:     q.whaleDetected,
      });

      const notifyPaperSkip = (q: typeof quality, reason: string) => {
        this.paperCallback?.(mint, 0, symbol, name, detectedAt, initialPrice, {
          autoSkipReason: reason,
          qualityScore:      q.totalScore,
          liquiditySol:      q.liquiditySol,
          uniqueBuyers:      q.uniqueBuyers,
          buyPressureRatio:  q.buyPressureRatio,
          topHolderPct:      q.topHolderPct,
          creatorHoldingsPct: q.creatorHoldingsPct,
          whaleDetected:     q.whaleDetected,
        });
      };

      // ── Quality gate: split hard-fails from soft-fails ───────────────────────
      // TRUE hard-fails (irreversible — skip immediately, no watching):
      //   • Creator holdings > 5%  — rug setup, never recovers
      //   • Liquidity < 25 SOL     — pool too thin to trade safely
      // SOFT fails (can recover within 3-10 mins — go through staged watching):
      //   • Unique buyers < 20     — buyers arrive slowly post-graduation
      //   • Buy pressure < 1.3x    — can flip as accumulation continues
      //   • Top holder > 25%       — distribution can improve
      const isHardFail = quality.creatorHoldingsPct > 5 || quality.liquiditySol < 25;

      if (isHardFail && quality.autoSkipReason) {
        const reason = `Quality: ${quality.autoSkipReason}`;
        this.addEvent({ ...fullEventBase, action: 'skipped', skipReason: reason, ...makeQualityFields(quality) });
        logger.info({ mint, symbol, reason: quality.autoSkipReason }, 'Graduation sniper: hard-fail quality skip ❌');
        notifyPaperSkip(quality, reason);
        return;
      }

      // Score too low even to watch — soft fail + low score
      const BORDERLINE_MIN = 50;
      if (quality.totalScore < BORDERLINE_MIN) {
        const reason = quality.autoSkipReason
          ? `Quality: ${quality.autoSkipReason} (score ${quality.totalScore}/100 too low to watch)`
          : `Quality score ${quality.totalScore}/100 < ${BORDERLINE_MIN} (too low to watch)`;
        this.addEvent({ ...fullEventBase, action: 'skipped', skipReason: reason, ...makeQualityFields(quality) });
        logger.info({ mint, symbol, score: quality.totalScore, reason: quality.autoSkipReason ?? 'low score' },
          'Graduation sniper: score too low — permanent skip ❌');
        notifyPaperSkip(quality, reason);
        return;
      }

      // Borderline zone: score 50–69 (including soft-fail metrics that may recover) → staged watching
      if (quality.totalScore < this.config.minQualityScore) {
        const watchReason = quality.autoSkipReason
          ? `Borderline score ${quality.totalScore}/100 with soft-fail (${quality.autoSkipReason}) — watching to T+180s`
          : `Borderline score ${quality.totalScore}/100 — watching to T+180s`;
        logger.info({ mint, symbol, score: quality.totalScore, softFail: quality.autoSkipReason ?? 'none' },
          'Graduation sniper: borderline — entering staged watching (T+180s, T+600s) 👀');
        const watched = await this.stagedReEvaluation(
          mint, symbol, poolPda, heliusKey, wsolVaultPubkey, quality, detectedAt,
        );
        if (!watched) {
          const reason = quality.autoSkipReason
            ? `Quality watching: ${quality.autoSkipReason} — no improvement by T+600s`
            : `Quality watching: no improvement by T+600s — skip`;
          this.addEvent({ ...fullEventBase, action: 'skipped', skipReason: reason, ...makeQualityFields(quality) });
          notifyPaperSkip(quality, reason);
          return;
        }
        // Staged re-evaluation passed — promote to entering with improved metrics
        quality = watched;
        logger.info({ mint, symbol, score: quality.totalScore },
          'Graduation sniper: staged re-evaluation PASSED ✅ — entering with improved metrics');
      }

      const qualityEventFields = makeQualityFields(quality);

      logger.info({ mint, symbol, score: quality.totalScore, multiplier: quality.positionMultiplier },
        `Graduation sniper: quality gate PASSED ✅ — score ${quality.totalScore}/100 → ${(quality.positionMultiplier * 100).toFixed(0)}% size`);

      // Variable position size based on quality score
      const positionSizeSol = this.config.positionSizeSol * quality.positionMultiplier;

      // ── IMMEDIATE ENTRY (quality gate already passed — no candle wait) ─────────
      // Candle-based entry (wait for green candle 1 + breakout above c1.high)
      // was removed — it caused unreliable rejections on strong tokens when the
      // DexScreener m5 snapshot showed 0 buys despite real on-chain activity.
      // Quality scoring (liquidity / buyers / buy-pressure / holders) provides
      // sufficient signal; candle confirmation added latency without improving accuracy.

      const maxEntryAt = detectedAt + this.config.maxEntryWindowMs;

      if (Date.now() > maxEntryAt) {
        this.addEvent({ ...fullEventBase, action: 'skipped',
          skipReason: 'Entry window expired (quality check took too long)', ...qualityEventFields });
        logger.warn({ mint, symbol }, 'Graduation sniper: entry window expired ⏱❌');
        return;
      }

      // Fetch current price — on-chain reserves first, DexScreener as fallback
      let entryPrice = 0;
      if (wsolVaultPubkey && tokenVaultPubkey) {
        try {
          const r = await this.fetchOnChainPoolReserves(wsolVaultPubkey, tokenVaultPubkey);
          if (r && r.solBalance > 0 && r.tokenBalanceUi > 0) {
            entryPrice = (r.solBalance / r.tokenBalanceUi) * effectiveSolUsd;
          }
        } catch { /* fall through to DexScreener */ }
      }
      if (!entryPrice) {
        try {
          const dex = await this.fetchPrice(mint);
          if (dex && dex.price > 0) entryPrice = dex.price;
        } catch { /* non-fatal */ }
      }

      if (!entryPrice) {
        this.addEvent({ ...fullEventBase, action: 'skipped',
          skipReason: 'Could not determine entry price (on-chain + DexScreener both unavailable)',
          ...qualityEventFields });
        logger.warn({ mint, symbol }, 'Graduation sniper: no entry price available — skip ❌');
        return;
      }

      // Entry drift filter — skip if price already ran > 8% from detection baseline
      if (initialPrice > 0) {
        const driftPct = ((entryPrice - initialPrice) / initialPrice) * 100;
        if (driftPct > ENTRY_DRIFT_ABORT_PCT) {
          this.addEvent({ ...fullEventBase, action: 'skipped',
            skipReason: `Entry drift ${driftPct.toFixed(1)}% > ${ENTRY_DRIFT_ABORT_PCT}% max — missed entry`,
            ...qualityEventFields });
          logger.info({ mint, symbol, driftPct: driftPct.toFixed(1), initialPrice, entryPrice },
            'Graduation sniper: entry drift exceeded — skip ❌');
          return;
        }
      }

      logger.info({ mint, symbol, entryPrice: entryPrice.toExponential(4) },
        'Graduation sniper: quality gate passed — entering immediately ✅');

      // ── Paper sniper tap-in (always fires when quality passes) ───────────────
      this.paperCallback?.(mint, entryPrice, symbol, name, detectedAt, initialPrice, {
        poolLiquidityUsd:     quality ? quality.liquiditySol * 150 : undefined,
        liquiditySol:         quality?.liquiditySol,
        uniqueBuyers:         quality?.uniqueBuyers,
        buyPressureRatio:     quality?.buyPressureRatio,
        creatorHoldingsPct:   quality?.creatorHoldingsPct,
        topHolderPct:         quality?.topHolderPct,
        whaleDetected:        quality?.whaleDetected,
        qualityScore:         quality?.totalScore,
        onChainPriceConfirmed: true,
      } satisfies GraduationQualityMeta);

      // ── Dip-Retrace strategy: add to dip-watch instead of entering immediately ─
      // Regardless of liveOnlySkip (paper-only mode), add to dip watch so the
      // frontend always shows the watching panel. liveOnlySkip is forwarded to
      // addToDipWatch so the actual enterPosition is skipped in paper-only mode.
      logger.info({ mint, symbol, entryPrice: entryPrice.toExponential(4) },
        'Graduation sniper: quality gate passed — adding to dip-retrace watch ✅');

      this.addToDipWatch({
        mint, symbol, name,
        graduationPrice: entryPrice,
        signature,
        initialPrice,
        detectedAt,
        positionSizeSol,
        quality,
        liveOnlySkip,
      });
      this.addEvent({ ...fullEventBase, action: 'watching', watchStage: undefined,
        skipReason: `Dip-watch started — monitoring for ${DIP_MIN_PCT}–${DIP_MAX_PCT}% dump + ${RETRACE_MIN_PCT}% retrace (30 min window)`,
        ...qualityEventFields });


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

  // ── Staged re-evaluation for borderline tokens (score 50–69) ─────────────────
  // Waits to T+180s then T+600s from graduation detection, re-checks quality with
  // fast mode (no delays — pool fully indexed), and enters only if metrics are
  // ACTIVELY IMPROVING vs the T+60s baseline. A flat or declining token is skipped.
  //
  // "Improving" = score ≥ minQualityScore(70) AND at least one of:
  //   • uniqueBuyers grew vs baseline (more traders joining)
  //   • liquiditySol held or grew (LP not being removed)
  //
  // At T+180s: still borderline (50–69) but buyers/liq growing → keep watching.
  // At T+600s: final gate — must hit ≥70 with improvement, else permanent skip.
  private async stagedReEvaluation(
    mint:            string,
    symbol:          string,
    poolPda:         string | null,
    heliusKey:       string | null,
    wsolVaultPubkey: string | null,
    baseline:        QualityMetrics,
    detectedAt:      number,
  ): Promise<QualityMetrics | null> {

    const isImproving = (q: QualityMetrics): boolean =>
      q.uniqueBuyers > baseline.uniqueBuyers ||
      q.liquiditySol > baseline.liquiditySol * 0.95;

    // Emit a "watching" event so it appears in the frontend events feed immediately.
    const watchBase = {
      id:          crypto.randomUUID(),
      detectedAt:  detectedAt,
      mint,
      symbol,
      txSignature: "",
      qualityScore:   baseline.totalScore,
      liquiditySol:   baseline.liquiditySol,
      uniqueBuyers:   baseline.uniqueBuyers,
      buyPressureRatio: baseline.buyPressureRatio,
      baselineBuyers: baseline.uniqueBuyers,
      baselineLiq:    baseline.liquiditySol,
    } as const;

    this.addEvent({ ...watchBase, action: "watching", watchStage: "T+180s",
      skipReason: `Borderline score ${baseline.totalScore}/100 — watching metrics to T+180s` });

    // ── T+180s re-check ───────────────────────────────────────────────────────
    const wait180 = Math.max(0, (detectedAt + 180_000) - Date.now());
    if (wait180 > 0) {
      logger.info({ mint, symbol, waitMs: Math.round(wait180) },
        'Graduation sniper: watching — waiting for T+180s re-check 🕐');
      await new Promise<void>((r) => setTimeout(r, wait180));
    }

    const q180 = await tokenQualityService.collectQualityData(
      mint, symbol, poolPda, 0, heliusKey, wsolVaultPubkey, /* fastMode */ true,
    );

    logger.info({
      mint, symbol,
      score180: q180.totalScore,
      liq180:   q180.liquiditySol.toFixed(1),
      buyers180: q180.uniqueBuyers,
      bpr180:   q180.buyPressureRatio.toFixed(2),
      improving: isImproving(q180),
      hardFail: q180.autoSkipReason ?? 'none',
    }, 'Graduation sniper: T+180s re-check result');

    // Hard-fail at re-check (e.g. creator dumped, LP removed) → permanent skip
    if (q180.autoSkipReason) {
      logger.info({ mint, symbol, reason: q180.autoSkipReason },
        'Graduation sniper: T+180s hard-fail — permanent skip ❌');
      return null;
    }

    // Passes threshold AND improving → enter now
    if (q180.totalScore >= this.config.minQualityScore && isImproving(q180)) {
      logger.info({ mint, symbol, score: q180.totalScore },
        'Graduation sniper: T+180s quality improved past threshold — ENTER ✅');
      return q180;
    }

    // Flat or declining even in borderline range → skip
    if (!isImproving(q180)) {
      logger.info({ mint, symbol, score: q180.totalScore },
        'Graduation sniper: T+180s metrics flat/declining — permanent skip ❌');
      return null;
    }

    // Still borderline (50–69) but improving trend → watch to T+600s
    logger.info({ mint, symbol, score: q180.totalScore },
      'Graduation sniper: T+180s borderline but improving — watching to T+600s 🕐');

    // Emit a watching event showing we are extending to T+600s
    this.addEvent({
      ...watchBase, action: "watching", watchStage: "T+600s",
      qualityScore:     q180.totalScore,
      liquiditySol:     q180.liquiditySol,
      uniqueBuyers:     q180.uniqueBuyers,
      buyPressureRatio: q180.buyPressureRatio,
      skipReason: `T+180s borderline (score ${q180.totalScore}/100, ${q180.uniqueBuyers} buyers) — still improving, watching to T+600s`,
    });

    // ── T+600s final re-check ─────────────────────────────────────────────────
    const wait600 = Math.max(0, (detectedAt + 600_000) - Date.now());
    if (wait600 > 0) {
      logger.info({ mint, symbol, waitMs: Math.round(wait600) },
        'Graduation sniper: watching — waiting for T+600s final re-check 🕐');
      await new Promise<void>((r) => setTimeout(r, wait600));
    }

    const q600 = await tokenQualityService.collectQualityData(
      mint, symbol, poolPda, 0, heliusKey, wsolVaultPubkey, /* fastMode */ true,
    );

    logger.info({
      mint, symbol,
      score600: q600.totalScore,
      liq600:   q600.liquiditySol.toFixed(1),
      buyers600: q600.uniqueBuyers,
      bpr600:   q600.buyPressureRatio.toFixed(2),
      improving: isImproving(q600),
      hardFail: q600.autoSkipReason ?? 'none',
    }, 'Graduation sniper: T+600s final re-check result');

    if (q600.autoSkipReason) {
      logger.info({ mint, symbol, reason: q600.autoSkipReason },
        'Graduation sniper: T+600s hard-fail — permanent skip ❌');
      return null;
    }

    if (q600.totalScore >= this.config.minQualityScore && isImproving(q600)) {
      logger.info({ mint, symbol, score: q600.totalScore },
        'Graduation sniper: T+600s quality improved past threshold — ENTER ✅');
      return q600;
    }

    logger.info({ mint, symbol, score: q600.totalScore },
      'Graduation sniper: T+600s no improvement — permanent skip ❌');
    return null;
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

  private async extractMintFromTx(signature: string): Promise<{ mint: string; wsolVaultPubkey: string | null; tokenVaultPubkey: string | null } | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;

    const SOL_MINT = "So11111111111111111111111111111111111111112";

    // ── getTransaction with token balance scan ────────────────────────────────
    // Helius fires the WS logsNotification at "confirmed" commitment, but their
    // RPC indexer takes an additional 1–5 seconds before getTransaction returns
    // data for that signature. Starting at 0 ms wastes all early retries.
    // Schedule: 1.5s, 3s, 5s, 8s, 12s, 18s — first attempt lands inside the
    // typical 1–3s Helius indexing window; later slots catch slow blocks.
    // commitment: "confirmed" matches the WS subscription so the RPC node
    // looks in the confirmed ledger, not only finalized.
    const delays = [1_500, 3_000, 5_000, 8_000, 12_000, 18_000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      await new Promise((r) => setTimeout(r, delays[attempt]!));

      try {
        type TokenBalance = { mint: string; accountIndex: number; uiTokenAmount?: { uiAmount?: number | null } };
        type AccountKey   = { pubkey: string };
        type TxResult = {
          result: {
            blockTime?: number | null;
            transaction?: {
              message?: {
                accountKeys?: AccountKey[];
              };
            };
            meta?: {
              preTokenBalances?:  TokenBalance[];
              postTokenBalances?: TokenBalance[];
              logMessages?:       string[];
              // v0 versioned transactions: ALT-resolved accounts (indices continue after accountKeys)
              loadedAddresses?: {
                writable?: string[];
                readonly?: string[];
              };
            };
          } | null;
        };

        const res = await axios.post<TxResult>(
          `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
          {
            jsonrpc: "2.0",
            id:      1,
            method:  "getTransaction",
            params:  [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
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

        // ── Hard age gate: reject any migration TX older than 30 seconds ─────
        // Two-layer check:
        //  1. Hard 30s cap — any TX confirmed >30s ago is a dead pool, period.
        //     Covers Helius WebSocket replays AND tokens that rugged instantly.
        //  2. Pre-boot guard — TX confirmed before this process started is
        //     always a Helius replay regardless of age. Kept as belt-and-braces.
        //
        // blockTime = Unix timestamp (seconds) from Solana RPC getTransaction.
        // It is ALWAYS present for confirmed/finalized TXs; null only for
        // very-recent unconfirmed slots (which we DO want to trade, so skip check).
        const MAX_TX_AGE_SEC = 30;
        const blockTime = txResult.blockTime;
        if (blockTime != null) {
          const nowSec  = Math.floor(Date.now() / 1000);
          const ageSec  = nowSec - blockTime;

          // Layer 1: hard 30-second ceiling
          if (ageSec > MAX_TX_AGE_SEC) {
            logger.warn(
              { signature, blockTime, ageSec, limit: MAX_TX_AGE_SEC, serverStartSec: this.serverStartTimeSec },
              `Graduation sniper: STALE migration rejected — ${ageSec}s old (limit ${MAX_TX_AGE_SEC}s) ⛔`,
            );
            return null;
          }

          // Layer 2: pre-boot guard (TX existed before this server process started)
          if (blockTime < this.serverStartTimeSec - 5) {
            logger.warn(
              { signature, blockTime, ageSec, serverStartSec: this.serverStartTimeSec },
              "Graduation sniper: PRE-BOOT migration rejected — Helius replay ⛔",
            );
            return null;
          }

          logger.info(
            { signature, blockTime, ageSec },
            `Graduation sniper: age check passed — ${ageSec}s old ✅`,
          );
        }

        const staticAccountKeys = txResult.transaction?.message?.accountKeys ?? [];
        // v0 versioned TXs use Address Lookup Tables (ALTs). The accountIndex in
        // preTokenBalances / postTokenBalances spans the FULL account list:
        //   [staticAccountKeys..., loadedAddresses.writable..., loadedAddresses.readonly...]
        // Without merging, any vault whose accountIndex >= staticAccountKeys.length
        // resolves to undefined → wsolVaultPubkey = null → liquiditySol = 0.
        const loadedWritable  = (txResult.meta?.loadedAddresses?.writable ?? []).map((p) => ({ pubkey: p }));
        const loadedReadonly  = (txResult.meta?.loadedAddresses?.readonly ?? []).map((p) => ({ pubkey: p }));
        const accountKeys     = [...staticAccountKeys, ...loadedWritable, ...loadedReadonly];

        const postBalances   = txResult.meta?.postTokenBalances ?? [];
        const preBalances    = txResult.meta?.preTokenBalances  ?? [];
        const txLogMessages  = txResult.meta?.logMessages ?? [];

        logger.debug({
          signature,
          staticKeys:    staticAccountKeys.length,
          loadedWritable: loadedWritable.length,
          loadedReadonly: loadedReadonly.length,
          totalKeys:     accountKeys.length,
        }, "Graduation sniper: account key counts (static + ALT-resolved)");

        // ── Pump.fun migration validator (CRITICAL anti-false-positive gate) ──
        // Both conditions MUST be true for a genuine pump.fun graduation TX:
        //
        //   1. MIGRATION_WALLET (39azUY…) appears in the TX account keys —
        //      pump.fun's dedicated migration signer is present for EVERY
        //      official graduation and NEVER appears in non-graduation TXes.
        //
        //   2. TX logs contain "Instruction: Migrate" or "MigrateV2" —
        //      Anchor emits this line ONLY when the pump.fun bonding-curve
        //      "migrate" or "migrate_v2" instruction executes. No random
        //      PumpSwap TX contains this log line.
        //
        // Requiring BOTH (AND, not OR) means:
        //   • A TX from the migration wallet that is NOT a migrate call → rejected
        //   • A migrate instruction from a DIFFERENT wallet → rejected
        //   • Only the official pump.fun migration wallet + official migrate
        //     instruction combination is accepted.
        //
        // This is the deepest guard (layer 3). Layers 1+2 already filter
        // to this wallet + instruction before this code is reached.
        const hasMigrationWallet = accountKeys.some(
          (k) => k.pubkey === MIGRATION_WALLET,
        );
        const hasMigrateInstruction = txLogMessages.some((l) => {
          const lower = l.toLowerCase();
          return lower.includes("instruction: migrate")
              || lower.includes("migrate_v2")
              || lower.includes("migratev2");
        });

        if (!hasMigrationWallet || !hasMigrateInstruction) {
          logger.warn(
            {
              signature,
              attempt:          attempt + 1,
              hasMigrationWallet,
              hasMigrateInstruction,
              accountKeyCount:  accountKeys.length,
              logCount:         txLogMessages.length,
            },
            hasMigrationWallet
              ? "Graduation sniper: NOT a pump.fun graduation — migration wallet present but no migrate instruction ⛔"
              : hasMigrateInstruction
                ? "Graduation sniper: NOT a pump.fun graduation — migrate instruction found but wrong wallet ⛔"
                : "Graduation sniper: NOT a pump.fun graduation — missing both migration wallet and migrate instruction ⛔",
          );
          return null; // definitive reject — retry won't help
        }

        logger.info(
          { signature, hasMigrationWallet, hasMigrateInstruction },
          "Graduation sniper: pump.fun migration confirmed — wallet ✅ + instruction ✅",
        );

        // ── Mint extraction — LP-token-safe for migrate_v2 ────────────────────
        // PumpSwap's migrate_v2 creates LP tokens inside the same TX.
        // LP tokens ONLY appear in postTokenBalances (newly minted).
        // The actual graduating meme token ALWAYS appears in preTokenBalances
        // because its bonding-curve account is modified/closed during migration.
        //
        // Priority order:
        //  1. First non-SOL mint in preTokenBalances → guaranteed to be the meme token
        //  2. Non-SOL mint in postTokenBalances that ALSO appears in pre → pool vault
        //  3. Any non-SOL mint anywhere → last resort (may be LP if 1+2 fail)
        const preMintSet     = new Set(preBalances.map((b) => b.mint).filter(Boolean));
        const preNonSolMint  = preBalances.map((b) => b.mint).find((m) => m && m !== SOL_MINT);
        const postSafeMint   = postBalances.map((b) => b.mint).find((m) => m && m !== SOL_MINT && preMintSet.has(m));
        const anyMint        = [...preBalances, ...postBalances].map((b) => b.mint).find((m) => m && m !== SOL_MINT);
        const mint           = preNonSolMint ?? postSafeMint ?? anyMint;

        logger.info(
          { signature, attempt: attempt + 1, mint: mint ?? "none", preCount: preBalances.length, postCount: postBalances.length },
          "Graduation sniper: token balance scan",
        );

        if (mint) {
          // ── Vault extraction: prefer NEWLY-CREATED accounts ───────────────
          // During a PumpSwap migration TX:
          //   • Bonding-curve wSOL vault: appears in BOTH pre AND post balances
          //     (pre = ~85 SOL accumulated, post = 0 after draining into AMM).
          //     Reading this gives the HIGH bonding-curve SOL/token ratio = inflated price.
          //   • New AMM pool wSOL vault: appears ONLY in postBalances (pre = absent/0).
          //     Reading this gives the CORRECT new pool SOL/token ratio = real market price.
          //
          // Strategy: prefer accounts whose accountIndex was NOT present in preBalances
          // (newly created = zero pre-balance).  Fall back to highest-post-balance if
          // no new accounts are found (shouldn't happen for PumpSwap migrations).

          const preWsolIndices  = new Set(preBalances.filter((b) => b.mint === SOL_MINT).map((b) => b.accountIndex));
          const preTokenIndices = new Set(preBalances.filter((b) => b.mint === mint).map((b) => b.accountIndex));

          // Prefer newly-created wSOL accounts (not in pre), sorted by highest post-balance
          const newWsolEntries = postBalances
            .filter((b) => b.mint === SOL_MINT && !preWsolIndices.has(b.accountIndex))
            .sort((a, b) => (b.uiTokenAmount?.uiAmount ?? 0) - (a.uiTokenAmount?.uiAmount ?? 0));
          // Fallback: any wSOL account sorted by highest post-balance
          const allWsolEntries = postBalances
            .filter((b) => b.mint === SOL_MINT)
            .sort((a, b) => (b.uiTokenAmount?.uiAmount ?? 0) - (a.uiTokenAmount?.uiAmount ?? 0));

          const wsolEntry       = newWsolEntries[0] ?? allWsolEntries[0];
          const wsolVaultPubkey = wsolEntry
            ? (accountKeys[wsolEntry.accountIndex]?.pubkey ?? null)
            : null;

          // Prefer newly-created token accounts (not in pre), sorted by highest post-balance
          const newTokenEntries = postBalances
            .filter((b) => b.mint === mint && !preTokenIndices.has(b.accountIndex))
            .sort((a, b) => (b.uiTokenAmount?.uiAmount ?? 0) - (a.uiTokenAmount?.uiAmount ?? 0));
          // Fallback: any token account sorted by highest post-balance
          const allTokenEntries = postBalances
            .filter((b) => b.mint === mint)
            .sort((a, b) => (b.uiTokenAmount?.uiAmount ?? 0) - (a.uiTokenAmount?.uiAmount ?? 0));

          const tokenEntry       = newTokenEntries[0] ?? allTokenEntries[0];
          const tokenVaultPubkey = tokenEntry
            ? (accountKeys[tokenEntry.accountIndex]?.pubkey ?? null)
            : null;

          logger.info({
            signature, mint,
            wsolSource:  newWsolEntries.length > 0 ? "new-account" : "fallback-highest",
            tokenSource: newTokenEntries.length > 0 ? "new-account" : "fallback-highest",
            newWsolCount:  newWsolEntries.length,
            newTokenCount: newTokenEntries.length,
          }, "Graduation sniper: vault extraction strategy");

          logger.info({
            signature, mint,
            wsolVaultPubkey:  wsolVaultPubkey?.slice(0, 8) ?? null,
            tokenVaultPubkey: tokenVaultPubkey?.slice(0, 8) ?? null,
            attempt: attempt + 1,
          }, "Graduation sniper: mint + both vaults extracted ✅");
          return { mint, wsolVaultPubkey, tokenVaultPubkey };
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

  // ── On-chain pool SOL check ─────────────────────────────────────────────────
  // Reads the WSOL token account balance directly from Helius or public RPC.
  // Falls back through Helius → public mainnet RPC so it works without Helius key.
  private async fetchOnChainPoolSol(wsolVaultPubkey: string): Promise<number | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    const rpcUrls = [
      ...(apiKey ? [`https://mainnet.helius-rpc.com/?api-key=${apiKey}`] : []),
      "https://api.mainnet-beta.solana.com",
      "https://solana-mainnet.g.alchemy.com/v2/demo",
    ];
    type TokenAmountResult = {
      result?: { value?: { uiAmount?: number | null } };
    };
    for (const rpcUrl of rpcUrls) {
      try {
        const res = await axios.post<TokenAmountResult>(
          rpcUrl,
          { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [wsolVaultPubkey] },
          { timeout: 6_000 },
        );
        const uiAmount = res.data?.result?.value?.uiAmount;
        if (uiAmount != null && uiAmount > 0) return uiAmount;
      } catch {
        // try next RPC
      }
    }
    logger.warn({ wsolVaultPubkey: wsolVaultPubkey.slice(0, 8) }, "Graduation sniper: fetchOnChainPoolSol — all RPCs failed");
    return null;
  }

  // ── On-chain pool reserves (both vaults in one parallel RPC pair) ───────────
  // Fetches wSOL vault balance AND token vault balance simultaneously.
  // Price = solBalance / tokenBalanceUi (SOL per token) × SOL/USD = USD price.
  // Available in ~200ms with zero indexer lag — vaults created by migration TX.
  // This is the authoritative price source for the entry pipeline; DexScreener
  // is only used for ongoing monitoring after the position is open (60s+ lag).
  private async fetchOnChainPoolReserves(
    wsolVaultPubkey: string,
    tokenVaultPubkey: string,
  ): Promise<{ solBalance: number; tokenBalanceRaw: number; tokenBalanceUi: number } | null> {
    const apiKey = process.env["HELIUS_API_KEY"];
    if (!apiKey) return null;
    const rpc = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    try {
      type BalResp = {
        result?: {
          value?: {
            uiAmount?: number | null;
            amount?: string;
            decimals?: number;
          } | null;
        };
      };

      const [solRes, tokRes] = await Promise.all([
        axios.post<BalResp>(rpc,
          { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [wsolVaultPubkey] },
          { timeout: 4_000 },
        ),
        axios.post<BalResp>(rpc,
          { jsonrpc: "2.0", id: 2, method: "getTokenAccountBalance", params: [tokenVaultPubkey] },
          { timeout: 4_000 },
        ),
      ]);

      const solBal    = solRes.data?.result?.value?.uiAmount ?? null;
      const tokBal    = tokRes.data?.result?.value?.uiAmount ?? null;
      const tokRawStr = tokRes.data?.result?.value?.amount ?? "0";
      const tokRaw    = Number(tokRawStr);

      if (solBal == null || tokBal == null || tokBal <= 0) {
        logger.warn({
          wsolVaultPubkey: wsolVaultPubkey.slice(0, 8),
          tokenVaultPubkey: tokenVaultPubkey.slice(0, 8),
          solBal, tokBal,
        }, "Graduation sniper: fetchOnChainPoolReserves — null or zero balance");
        return null;
      }

      return { solBalance: solBal, tokenBalanceRaw: tokRaw, tokenBalanceUi: tokBal };
    } catch (err) {
      logger.warn({
        wsolVaultPubkey: wsolVaultPubkey.slice(0, 8),
        tokenVaultPubkey: tokenVaultPubkey.slice(0, 8),
        err: (err as Error).message,
      }, "Graduation sniper: fetchOnChainPoolReserves failed");
      return null;
    }
  }

  private async fetchPrice(mint: string): Promise<{ price: number; symbol: string; name: string; liquidityUsd: number; dexId: string } | null> {
    try {
      type DexPair = {
        priceUsd: string;
        pairAddress?: string;
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
      const AMM_DEXES = new Set(["raydium", "pumpswap", "pump-amm", "orca", "meteora"]);
      const sorted = [...pairs].sort((a, b) => {
        const aAmm = AMM_DEXES.has(a.dexId ?? "") ? 1 : 0;
        const bAmm = AMM_DEXES.has(b.dexId ?? "") ? 1 : 0;
        if (bAmm !== aAmm) return bAmm - aAmm;
        return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
      });

      const best         = sorted[0]!;
      const price        = parseFloat(best.priceUsd) || 0;
      let   liquidityUsd = best.liquidity?.usd ?? 0;
      if (price <= 0) return null;

      // ── On-chain liquidity fallback ─────────────────────────────────────────
      // DexScreener takes 3–5 min to index liquidity for new PumpSwap graduates.
      // When it returns 0, use the pairAddress from the DexScreener response to
      // read the pool's WSOL vault balance directly from chain.
      // PumpSwap pools are keypair-based (NOT PDAs), so pairAddress is the only
      // reliable way to locate the pool account on-chain.
      if (liquidityUsd === 0 && best.pairAddress) {
        const solUsd = await this.fetchCachedSolUsd();
        if (solUsd > 0) {
          const onChainLiq = await this.fetchPumpSwapLiquidityUsd(best.pairAddress, solUsd);
          if (onChainLiq > 0) liquidityUsd = onChainLiq;
        }
      }

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
    detectionPrice?: number,
    graduationDetectedAt?: number,
    preQuote?: { quote: unknown; fee: number; fetchedAt: number } | null,
    positionSizeSolOverride?: number,
    quality?: QualityMetrics | null,
  ): Promise<void> {
    const cfg = this.config;
    const id  = uid();
    const buyStart = Date.now();
    const actualPositionSizeSol = positionSizeSolOverride ?? cfg.positionSizeSol;

    logger.info({
      mint, symbol,
      preBuyPrice: price,
      detectionPrice: detectionPrice ?? null,
      positionSizeSol: actualPositionSizeSol,
      qualityScore: quality?.totalScore ?? null,
      multiplier: quality?.positionMultiplier ?? null,
      preQuoteAgeMs: preQuote ? buyStart - preQuote.fetchedAt : null,
      msSinceDetection: graduationDetectedAt ? buyStart - graduationDetectedAt : null,
    }, "Sniper timing: T7 — enterPosition called, Jupiter buy starting ⚡");

    // Execute real on-chain buy via Jupiter — confirmed before recording position
    let txSignature: string;
    let tokenAmount: number;
    let sizeSol: number;
    try {
      const result = await jupiterSwapService.buy(mint, actualPositionSizeSol, cfg.slippageBps, cfg.priorityFeeLamports, preQuote, cfg.jitoTipLamports);
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
    // Fires for BOTH positive drift (chased a pump) and large negative drift
    // (bonding-curve vault price mismatch → filled into an already-dead pool).
    // STRIKE/LAZY class: detection price was bonding curve vault price ($8.975e-5)
    // but Jupiter filled at the real AMM pool price ($9.548e-6 = -89.4%).
    const fillDriftTriggered =
      entryDriftPct !== undefined &&
      (entryDriftPct > MAX_FILL_DRIFT_PCT || entryDriftPct < -MAX_FILL_DRIFT_PCT);

    if (fillDriftTriggered) {
      const driftDir = entryDriftPct! > 0 ? `+${entryDriftPct!.toFixed(1)}% above` : `${entryDriftPct!.toFixed(1)}% below`;
      logger.warn(
        { mint, symbol, entryDriftPct: entryDriftPct!.toFixed(1), MAX_FILL_DRIFT_PCT, actualEntryPrice, detectionPrice },
        `Graduation sniper: FILL DRIFT ${entryDriftPct! > 0 ? "TOO HIGH" : "NEGATIVE (dead pool)"} — emergency-selling immediately 🚨`,
      );
      const fillDriftReason = `Fill drift abort — filled ${driftDir} detection price (±${MAX_FILL_DRIFT_PCT}% threshold) — emergency sold`;
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
      detectedAt:         graduationDetectedAt ?? nowMs,
      entryAt:            nowMs,
      entryPrice:         actualEntryPrice,
      currentPrice:       actualEntryPrice,
      sizeSol,
      tp1Hit:             false,
      tp2Hit:             false,
      tp3Hit:             false,
      remainingFraction:  1.0,
      effectiveSlPrice:   actualEntryPrice * (1 - cfg.slPct / 100),
      trailingHigh:       actualEntryPrice,
      status:             "open",
      realizedPnlSol:     0,
      unrealizedPnlSol:   0,
      totalPnlSol:        0,
      pnlPct:             0,
      txSignature,
      tokenAmount:        actualTokenAmount,
      entrySig:           txSignature,
      exitSig:            undefined,
      tp1RealizedSol:     0,
      tp2RealizedSol:     0,
      tp3RealizedSol:     0,
      runnerRealizedSol:  0,
      detectionPrice,
      entryDriftPct,
      msDetectionToFill,
      // Quality metrics stored at entry for dashboard + analytics
      qualityScore:       quality?.totalScore      ?? 0,
      liquiditySol:       quality?.liquiditySol    ?? 0,
      buyPressureRatio:   quality?.buyPressureRatio ?? 1,
      uniqueBuyers:       quality?.uniqueBuyers    ?? 0,
      topHolderPct:       quality?.topHolderPct    ?? 0,
      whaleDetected:      quality?.whaleDetected   ?? false,
      positionMultiplier: quality?.positionMultiplier ?? 1,
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
        `🛡️ Hard SL: -${cfg.slPct}% from entry ($${fmtTgPrice(actualEntryPrice * (1 - cfg.slPct / 100))})\n` +
        `🎯 TP1: +${cfg.tp1Pct}% → sell ${cfg.tp1ClosePct}%\n` +
        `🎯 TP2: +${cfg.tp2Pct}% → sell ${cfg.tp2ClosePct}%\n` +
        `🔥 TP3: +${cfg.tp3Pct}% → sell ${cfg.tp3ClosePct}% (runner)\n` +
        `📊 Quality: ${quality?.totalScore ?? 0}/100 × ${((quality?.positionMultiplier ?? 1) * 100).toFixed(0)}% size\n` +
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
    this.sellFailCount.delete(pos.mint);      // reset on confirmed close
    this.sellPressureStartAt.delete(pos.mint); // clear sell pressure timer
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
    breakdownKey?: "tp1" | "tp2" | "tp3",
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

    if (breakdownKey === "tp1")      pos.tp1RealizedSol += closePnl;
    else if (breakdownKey === "tp2") pos.tp2RealizedSol += closePnl;
    else if (breakdownKey === "tp3") pos.tp3RealizedSol += closePnl;

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
        // Whale dump: 20-39% liquidity drop in 30s (spec: >5 SOL whale dump → exit)
        const prevSolEst  = prev / (price > 0 ? price * 150 : 1);   // rough SOL estimate at current price
        const solDropEst  = prevSolEst * (dropPct / 100);
        if (dropPct >= 20 && dropPct < LIQUIDITY_DROP_TRIGGER && !pos.tp1Hit && solDropEst >= 5) {
          logger.warn(
            { mint: pos.mint, symbol: pos.symbol, prev: prev.toFixed(0), now: liquidityUsd.toFixed(0), dropPct: dropPct.toFixed(1), solDropEst: solDropEst.toFixed(1) },
            "Graduation sniper: WHALE DUMP detected — emergency exit (pre-TP1) 🐋",
          );
          if (isTelegramConfigured()) {
            void sendTelegram(
              `🐋 <b>SNIPER WHALE DUMP EXIT</b>\n` +
              `──────────────────────\n` +
              `🪙 Token: <b>${pos.symbol}</b>\n` +
              `📋 CA: <code>${pos.mint}</code>\n` +
              `💧 Liquidity: <b>$${prev.toFixed(0)} → $${liquidityUsd.toFixed(0)}</b>\n` +
              `📉 Drop: <b>-${dropPct.toFixed(1)}%</b> (~${solDropEst.toFixed(1)} SOL) in 30s\n` +
              `🚨 Whale dump detected — exiting position\n` +
              `🕐 ${toIST(new Date())}`,
            );
          }
          void this.closePosition(pos, `Whale dump: -${dropPct.toFixed(0)}% liquidity in 30s (~${solDropEst.toFixed(1)} SOL)`, price);
        } else if (dropPct >= LIQUIDITY_DROP_TRIGGER) {
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

  // ── Candle builder ─────────────────────────────────────────────────────────
  // Observes price for `windowMs` (default 10 000) by polling on-chain reserves
  // every 3 s. Returns OHLC + buy/sell delta from DexScreener m5 snapshot.

  private async buildCandle(
    mint: string,
    wsolVaultPubkey: string | null,
    tokenVaultPubkey: string | null,
    solUsd: number,
    windowMs: number,
  ): Promise<{ open: number; close: number; high: number; low: number; buysDelta: number; sellsDelta: number; isGreen: boolean; isActive: boolean }> {
    const startMs = Date.now();

    // Snapshot DexScreener m5 buys/sells at start of window
    let startBuys  = 0;
    let startSells = 0;
    try {
      type DexPair = { baseToken: { address: string }; txns?: { m5?: { buys?: number; sells?: number } } };
      const r = await axios.get<{ pairs?: DexPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`, { timeout: 5_000 },
      );
      const pair = r.data?.pairs?.[0];
      startBuys  = pair?.txns?.m5?.buys  ?? 0;
      startSells = pair?.txns?.m5?.sells ?? 0;
    } catch { /* non-fatal */ }

    // First price sample = open
    let openPrice  = 0;
    let highPrice  = 0;
    let lowPrice   = Infinity;
    let closePrice = 0;

    const samplePrice = async (): Promise<number> => {
      if (wsolVaultPubkey && tokenVaultPubkey) {
        try {
          const res = await this.fetchOnChainPoolReserves(wsolVaultPubkey, tokenVaultPubkey);
          if (res && res.solBalance > 0 && res.tokenBalanceUi > 0) {
            return (res.solBalance / res.tokenBalanceUi) * solUsd;
          }
        } catch { /* fall through to DexScreener */ }
      }
      // DexScreener fallback
      try {
        const res = await this.fetchPrice(mint);
        if (res && res.price > 0) return res.price;
      } catch { /* ignore */ }
      return 0;
    };

    // Poll every 3 s until window expires
    const interval = 3_000;
    while (Date.now() - startMs < windowMs) {
      const p = await samplePrice();
      if (p > 0) {
        if (openPrice === 0) openPrice = p;
        if (p > highPrice) highPrice = p;
        if (p < lowPrice)  lowPrice  = p;
        closePrice = p;
      }
      const remaining = windowMs - (Date.now() - startMs);
      if (remaining <= 0) break;
      await new Promise<void>((r) => setTimeout(r, Math.min(interval, remaining)));
    }

    // Snapshot DexScreener m5 buys/sells at end of window
    let endBuys  = startBuys;
    let endSells = startSells;
    try {
      type DexPair = { baseToken: { address: string }; txns?: { m5?: { buys?: number; sells?: number } } };
      const r = await axios.get<{ pairs?: DexPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`, { timeout: 5_000 },
      );
      const pair = r.data?.pairs?.[0];
      endBuys  = pair?.txns?.m5?.buys  ?? startBuys;
      endSells = pair?.txns?.m5?.sells ?? startSells;
    } catch { /* non-fatal */ }

    const buysDelta  = Math.max(0, endBuys  - startBuys);
    const sellsDelta = Math.max(0, endSells - startSells);
    const finalClose = closePrice > 0 ? closePrice : openPrice;
    const finalLow   = lowPrice < Infinity ? lowPrice : openPrice;
    const finalHigh  = Math.max(highPrice, openPrice, finalClose);

    return {
      open:       openPrice,
      close:      finalClose,
      high:       finalHigh,
      low:        finalLow,
      buysDelta,
      sellsDelta,
      isGreen:    finalClose > openPrice && openPrice > 0,
      isActive:   buysDelta > 0,
    };
  }

  // ── SL evaluator — 3-phase staged SL (pre-TP1 only) ─────────────────────
  // Spec:
  //   Phase 1 (0–2 min):  hard SL -20% from entry price
  //   Phase 2 (2–10 min): trailing SL -25% from peak
  //   Phase 3 (10min+):   trailing SL -30% from peak
  // After any TP hit, SL management moves to the trailing logic in _checkPositionPriceInner.

  private async checkStagedSL(pos: SniperPosition, price: number): Promise<boolean> {
    // After any TP hit, SL is managed by the trailing stop in the price loop
    if (pos.tp1Hit || pos.tp2Hit || pos.tp3Hit) return false;

    const ageMs = Date.now() - pos.entryAt;

    if (ageMs < STAGED_SL_PHASE1_MS) {
      // Phase 1 (0–2 min): hard SL -20% from ENTRY price (catches instant rugs)
      const slThreshold = pos.entryPrice * (1 - STAGED_SL_PHASE1_PCT / 100);
      pos.effectiveSlPrice = slThreshold;
      const dropFromEntry = (1 - price / pos.entryPrice) * 100;
      if (dropFromEntry >= STAGED_SL_PHASE1_PCT) {
        logger.warn(
          { mint: pos.mint, symbol: pos.symbol, dropFromEntry: dropFromEntry.toFixed(1), phase: 1, ageMin: (ageMs / 60000).toFixed(1) },
          "Graduation sniper: Staged SL Phase 1 triggered (-20% from entry) ❌",
        );
        await this.closePosition(
          pos,
          `Staged SL Ph1 -${STAGED_SL_PHASE1_PCT}% from entry (${(ageMs / 60000).toFixed(1)}m)`,
          price,
        );
        return true;
      }
    } else if (ageMs < STAGED_SL_PHASE2_MS) {
      // Phase 2 (2–10 min): trailing SL -25% from peak
      const slThreshold = pos.trailingHigh * (1 - STAGED_SL_PHASE2_PCT / 100);
      pos.effectiveSlPrice = slThreshold;
      if (price <= slThreshold) {
        logger.warn(
          { mint: pos.mint, symbol: pos.symbol, dropFromPeak: ((1 - price / pos.trailingHigh) * 100).toFixed(1), phase: 2 },
          "Graduation sniper: Staged SL Phase 2 triggered (-25% from peak) ❌",
        );
        await this.closePosition(
          pos,
          `Staged SL Ph2 -${STAGED_SL_PHASE2_PCT}% from peak ($${fmtTgPrice(pos.trailingHigh)})`,
          price,
        );
        return true;
      }
    } else {
      // Phase 3 (10min+): trailing SL -30% from peak
      const slThreshold = pos.trailingHigh * (1 - STAGED_SL_PHASE3_PCT / 100);
      pos.effectiveSlPrice = slThreshold;
      if (price <= slThreshold) {
        logger.warn(
          { mint: pos.mint, symbol: pos.symbol, dropFromPeak: ((1 - price / pos.trailingHigh) * 100).toFixed(1), phase: 3 },
          "Graduation sniper: Staged SL Phase 3 triggered (-30% from peak) ❌",
        );
        await this.closePosition(
          pos,
          `Staged SL Ph3 -${STAGED_SL_PHASE3_PCT}% from peak ($${fmtTgPrice(pos.trailingHigh)})`,
          price,
        );
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
    preloaded?: { price: number; liquidityUsd: number; buysM5?: number; sellsM5?: number },
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
    preloaded?: { price: number; liquidityUsd: number; buysM5?: number; sellsM5?: number },
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

    // ── Always update trailing high ────────────────────────────────────────
    if (price > pos.trailingHigh || pos.trailingHigh === 0) {
      pos.trailingHigh = price;
    }

    // ── TP3 runner: trailing SL -runnerTrailingPct% from peak ─────────────────
    if (pos.tp3Hit) {
      const trailStop = pos.trailingHigh * (1 - cfg.trailingStopPct / 100);
      pos.effectiveSlPrice = trailStop;
      if (price <= trailStop) {
        await this.closePosition(
          pos,
          `Runner trailing stop -${cfg.trailingStopPct}% from peak ($${fmtTgPrice(pos.trailingHigh)})`,
          price,
        );
        return;
      }
      this.updateLivePnl(pos);
      void this.persistPosition(pos);
      return;
    }

    // ── TP2 runner: trailing SL -trailingStopAfterTp2Pct% from peak ──────────
    if (pos.tp2Hit) {
      const trailStop = pos.trailingHigh * (1 - cfg.trailingStopAfterTp2Pct / 100);
      pos.effectiveSlPrice = trailStop;
      if (price <= trailStop) {
        await this.closePosition(
          pos,
          `TP2 trailing stop -${cfg.trailingStopAfterTp2Pct}% from peak ($${fmtTgPrice(pos.trailingHigh)})`,
          price,
        );
        return;
      }
      // ── TP3 check ────────────────────────────────────────────────────────────
      const tp3Price = pos.entryPrice * (1 + cfg.tp3Pct / 100);
      const tp3Frac  = cfg.tp3ClosePct / 100;
      if (!pos.tp3Hit && price >= tp3Price) {
        pos.tp3Hit = true;
        try {
          await this.partialClose(pos, tp3Frac, `TP3 +${cfg.tp3Pct}% — sell ${cfg.tp3ClosePct}%`, price, 'tp3');
        } catch (err) {
          pos.tp3Hit = false;
          logger.error({ mint, symbol: pos.symbol, err: (err as Error).message },
            'Graduation sniper: TP3 sell FAILED ❌ — reverted, will retry next tick');
          return;
        }
        let tp3Persisted = false;
        for (let attempt = 0; attempt < 10 && !tp3Persisted; attempt++) {
          try { await this.persistPosition(pos); tp3Persisted = true; }
          catch (err) {
            logger.warn({ mint, attempt, err: (err as Error).message }, 'Graduation sniper: TP3 atomic persist retry');
            await new Promise((r) => setTimeout(r, 3_000));
          }
        }
        if (!tp3Persisted) logger.error({ mint }, 'Graduation sniper: TP3 persist failed after all retries ⚠️');
        logger.info({ mint, symbol: pos.symbol, price }, 'Graduation sniper: TP3 hit 🔥 — runner mode active');
        if (isTelegramConfigured()) {
          const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp3Frac;
          void sendTelegram(
            `🔥 <b>SNIPER TP3 HIT 🔴 LIVE</b>
──────────────────────
` +
            `🪙 Token: <b>${pos.symbol}</b>
📋 CA: <code>${pos.mint}</code>
` +
            `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${cfg.tp3Pct}%)
` +
            `💰 Sold ${cfg.tp3ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>
` +
            `🏃 Runner mode — trailing stop ${cfg.trailingStopPct}% below peak
` +
            `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position
🕐 ${toIST(new Date())}`,
          );
        }
      }
      this.updateLivePnl(pos);
      void this.persistPosition(pos);
      return;
    }

    // ── TP1 hit: breakeven SL, then check TP2 ────────────────────────────────
    if (pos.tp1Hit) {
      pos.effectiveSlPrice = pos.entryPrice;
      if (price <= pos.entryPrice) {
        await this.closePosition(pos, 'Breakeven SL after TP1', price);
        return;
      }
      if (!pos.tp2Hit && price >= tp2Price) {
        pos.tp2Hit = true;
        pos.trailingHigh = Math.max(pos.trailingHigh, price);
        try {
          await this.partialClose(pos, tp2Frac, `TP2 +${cfg.tp2Pct}% — sell ${cfg.tp2ClosePct}%`, price, 'tp2');
        } catch (err) {
          pos.tp2Hit = false;
          logger.error({ mint, symbol: pos.symbol, err: (err as Error).message },
            'Graduation sniper: TP2 sell FAILED ❌ — reverted, will retry next tick');
          return;
        }
        let tp2Persisted = false;
        for (let attempt = 0; attempt < 10 && !tp2Persisted; attempt++) {
          try { await this.persistPosition(pos); tp2Persisted = true; }
          catch (err) {
            logger.warn({ mint, attempt, err: (err as Error).message }, 'Graduation sniper: TP2 atomic persist retry');
            await new Promise((r) => setTimeout(r, 3_000));
          }
        }
        if (!tp2Persisted) logger.error({ mint }, 'Graduation sniper: TP2 persist failed after all retries ⚠️');
        logger.info({ mint, symbol: pos.symbol, price }, 'Graduation sniper: TP2 hit 🚀');
        if (isTelegramConfigured()) {
          const partialPnl = (price / pos.entryPrice - 1) * pos.sizeSol * tp2Frac;
          void sendTelegram(
            `🚀 <b>SNIPER TP2 HIT 🔴 LIVE</b>
──────────────────────
` +
            `🪙 Token: <b>${pos.symbol}</b>
📋 CA: <code>${pos.mint}</code>
` +
            `💵 Price: <b>$${fmtTgPrice(price)}</b> (+${cfg.tp2Pct}%)
` +
            `💰 Sold ${cfg.tp2ClosePct}% → ~<b>+${partialPnl.toFixed(4)} SOL</b>
` +
            `🎯 Next: TP3 +${cfg.tp3Pct}% — trailing SL -${cfg.trailingStopAfterTp2Pct}% from peak
` +
            `📦 Remaining: ${((pos.remainingFraction) * 100).toFixed(0)}% position
🕐 ${toIST(new Date())}`,
          );
        }
      }
      this.updateLivePnl(pos);
      void this.persistPosition(pos);
      return;
    }

    // ── Sell pressure emergency exit (pre-TP1 only) ────────────────────────────
    // Spec: sell pressure > buy pressure for 60 consecutive seconds → emergency exit
    if (!pos.tp1Hit && !pos.tp2Hit && !pos.tp3Hit) {
      const buysM5  = preloaded?.buysM5  ?? 0;
      const sellsM5 = preloaded?.sellsM5 ?? 0;
      // Sell pressure: sells exceed buys by at least 50% in the last 5 minutes
      const hasSellPressure = sellsM5 > 0 && sellsM5 > buysM5 * 1.5;
      if (hasSellPressure) {
        if (!this.sellPressureStartAt.has(mint)) {
          this.sellPressureStartAt.set(mint, now);
          logger.debug({ mint, symbol: pos.symbol, sellsM5, buysM5 }, "Graduation sniper: sell pressure timer started");
        }
        const pressureDurationMs = now - (this.sellPressureStartAt.get(mint) ?? now);
        if (pressureDurationMs >= 60_000) {
          logger.warn(
            { mint, symbol: pos.symbol, sellsM5, buysM5, pressureSec: (pressureDurationMs / 1000).toFixed(0) },
            "Graduation sniper: SELL PRESSURE >60s — emergency exit 🚨",
          );
          this.sellPressureStartAt.delete(mint);
          await this.closePosition(
            pos,
            `Sell pressure >60s (${sellsM5} sells vs ${buysM5} buys in 5m)`,
            price,
          );
          return;
        }
      } else {
        // Reset the timer when buy pressure recovers
        if (this.sellPressureStartAt.has(mint)) {
          this.sellPressureStartAt.delete(mint);
          logger.debug({ mint, symbol: pos.symbol }, "Graduation sniper: sell pressure reset — buy pressure recovered");
        }
      }
    }

    // ── Pre-TP1: staged SL check (3-phase: -20%/-25%/-30%) ──────────────────
    if (await this.checkStagedSL(pos, price)) return;

    // ── Dead position exit (>2h open, <5% move, no TP hit) ───────────────────
    {
      const movePct = Math.abs((price / pos.entryPrice - 1) * 100);
      if (ageMs >= DEAD_POSITION_MS && movePct < DEAD_MOVE_PCT) {
        logger.info(
          { mint, symbol: pos.symbol, ageH: (ageMs / 3_600_000).toFixed(1), movePct: movePct.toFixed(2) },
          'Graduation sniper: dead position exit — no momentum',
        );
        await this.closePosition(pos, 'Dead — No Momentum', price);
        return;
      }
    }

    // ── TP1 check ────────────────────────────────────────────────────────────
    if (!pos.tp1Hit && price >= tp1Price) {
      await this.executeTP1Atomic(pos, price, tp1Frac, cfg.tp1Pct, cfg.tp1ClosePct);
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
  ): Promise<Map<string, { price: number; liquidityUsd: number; buysM5: number; sellsM5: number }>> {
    const result = new Map<string, { price: number; liquidityUsd: number; buysM5: number; sellsM5: number }>();
    if (mints.length === 0) return result;

    // Split into batches of at most BATCH_DEXSCREENER_MAX
    for (let i = 0; i < mints.length; i += BATCH_DEXSCREENER_MAX) {
      const batch = mints.slice(i, i + BATCH_DEXSCREENER_MAX);
      try {
        type DexPair = {
          baseToken: { address: string };
          pairAddress?: string;
          priceUsd: string;
          liquidity?: { usd?: number };
          dexId?: string;
          txns?: { m5?: { buys: number; sells: number }; h1?: { buys: number; sells: number } };
        };
        this.dexscreenerCallsThisMinute++;
        this.dexscreenerCallsTotal++;
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${batch.join(",")}`,
          { timeout: 8_000 },
        );
        const pairs = Array.isArray(res.data) ? res.data : [];

        // Group pairs by their base token address; pick highest-liquidity AMM pair
        const byMint = new Map<string, DexPair[]>();
        for (const pair of pairs) {
          const mint = pair.baseToken?.address;
          if (!mint) continue;
          const group = byMint.get(mint) ?? [];
          group.push(pair);
          byMint.set(mint, group);
        }

        for (const [mint, pairGroup] of byMint) {
          const AMM_DEXES = new Set(["raydium", "pumpswap", "pump-amm", "orca", "meteora"]);
          const sorted = [...pairGroup].sort((a, b) => {
            const aAmm = AMM_DEXES.has(a.dexId ?? "") ? 1 : 0;
            const bAmm = AMM_DEXES.has(b.dexId ?? "") ? 1 : 0;
            if (bAmm !== aAmm) return bAmm - aAmm;
            return (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
          });
          const best  = sorted[0]!;
          const price = parseFloat(best.priceUsd) || 0;
          if (price > 0) {
            result.set(mint, {
              price,
              liquidityUsd: best.liquidity?.usd ?? 0,
              buysM5:  best.txns?.m5?.buys  ?? 0,
              sellsM5: best.txns?.m5?.sells ?? 0,
            });
            // Cache pool address → used by on-chain liquidity fallback below
            if (best.pairAddress) {
              this.pumpswapVaultCache.set(`pair:${mint}`, best.pairAddress);
            }
          }
        }
      } catch (err) {
        logger.warn(
          { batchSize: batch.length, err: (err as Error).message },
          "Graduation sniper: fetchBatchedPrices failed — will use Jupiter fallback",
        );
      }
    }

    // ── On-chain liquidity fallback for tokens with 0 DexScreener liquidity ──
    // DexScreener takes 3–5 min to populate liquidity.usd for newly graduated
    // PumpSwap tokens. When it's 0, use the DexScreener pairAddress (also in
    // the response) to read the pool's WSOL vault balance directly from chain.
    // PumpSwap pool accounts are keypair-based (NOT PDAs), so we use the pair
    // address directly rather than trying to derive it.
    const zeroLiqMints = [...result.entries()]
      .filter(([, d]) => d.liquidityUsd === 0)
      .map(([m]) => m);

    if (zeroLiqMints.length > 0) {
      const solUsd = await this.fetchCachedSolUsd();
      if (solUsd > 0) {
        await Promise.all(
          zeroLiqMints.map(async (mint) => {
            const poolAddr = this.pumpswapVaultCache.get(`pair:${mint}`) ?? null;
            if (!poolAddr) return;
            const onChainLiq = await this.fetchPumpSwapLiquidityUsd(poolAddr, solUsd);
            if (onChainLiq > 0) {
              const existing = result.get(mint)!;
              result.set(mint, { ...existing, liquidityUsd: onChainLiq });
            }
          }),
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
          entry_sig, exit_sig,
          tp3_hit, tp3_realized_sol,
          quality_score, liquidity_sol, buy_pressure_ratio, unique_buyers,
          top_holder_pct, whale_detected, position_multiplier
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
          $21,$22,$23,$24,$25,$26,
          $27,$28,$29,$30,$31,$32,$33,$34,$35
        )
        ON CONFLICT (id) DO UPDATE SET
          current_price      = EXCLUDED.current_price,
          tp1_hit            = EXCLUDED.tp1_hit,
          tp2_hit            = EXCLUDED.tp2_hit,
          tp3_hit            = EXCLUDED.tp3_hit,
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
          tp3_realized_sol   = EXCLUDED.tp3_realized_sol,
          runner_realized_sol= EXCLUDED.runner_realized_sol,
          token_amount       = EXCLUDED.token_amount,
          tx_signature       = EXCLUDED.tx_signature,
          entry_sig          = EXCLUDED.entry_sig,
          exit_sig           = EXCLUDED.exit_sig,
          quality_score      = EXCLUDED.quality_score,
          liquidity_sol      = EXCLUDED.liquidity_sol,
          buy_pressure_ratio = EXCLUDED.buy_pressure_ratio,
          unique_buyers      = EXCLUDED.unique_buyers,
          top_holder_pct     = EXCLUDED.top_holder_pct,
          whale_detected     = EXCLUDED.whale_detected,
          position_multiplier= EXCLUDED.position_multiplier
      `, [
        pos.id, pos.mint, pos.symbol, pos.name, pos.detectedAt, pos.entryAt,
        pos.entryPrice, pos.currentPrice, pos.sizeSol, pos.tp1Hit, pos.tp2Hit,
        pos.remainingFraction, pos.effectiveSlPrice, pos.trailingHigh, pos.status,
        pos.realizedPnlSol, pos.closeReason ?? null, pos.closedAt ?? null,
        pos.exitPrice ?? null, pos.txSignature,
        pos.tp1RealizedSol, pos.tp2RealizedSol, pos.runnerRealizedSol, pos.tokenAmount ?? 0,
        pos.entrySig ?? "", pos.exitSig ?? null,
        pos.tp3Hit ?? false, pos.tp3RealizedSol ?? 0,
        pos.qualityScore ?? 0, pos.liquiditySol ?? 0, pos.buyPressureRatio ?? 1,
        pos.uniqueBuyers ?? 0, pos.topHolderPct ?? 0, pos.whaleDetected ?? false,
        pos.positionMultiplier ?? 1,
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
      name:               symbol,
      detectedAt:         entryAtMs ?? Date.now(),
      entryAt:            entryAtMs ?? Date.now(),
      entryPrice,
      currentPrice,
      sizeSol,
      tp1Hit:             false,
      tp2Hit:             false,
      tp3Hit:             false,
      remainingFraction:  1.0,
      effectiveSlPrice:   entryPrice * (1 - cfg.slPct / 100),
      trailingHigh:       Math.max(entryPrice, currentPrice),
      status:             "open",
      realizedPnlSol:     0,
      unrealizedPnlSol:   0,
      totalPnlSol:        0,
      pnlPct:             0,
      txSignature:        "",
      tokenAmount:        estimatedTokens,
      entrySig:           "",
      exitSig:            undefined,
      tp1RealizedSol:     0,
      tp2RealizedSol:     0,
      tp3RealizedSol:     0,
      runnerRealizedSol:  0,
      qualityScore:       0,
      liquiditySol:       0,
      buyPressureRatio:   1,
      uniqueBuyers:       0,
      topHolderPct:       0,
      whaleDetected:      false,
      positionMultiplier: 1,
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

  // ── Dip-Retrace watch methods ──────────────────────────────────────────────

  private addToDipWatch(opts: {
    mint: string;
    symbol: string;
    name: string;
    graduationPrice: number;
    signature: string;
    initialPrice: number;
    detectedAt: number;
    positionSizeSol: number;
    quality: QualityMetrics;
    liveOnlySkip: string | null;
  }): void {
    // Do not add if already watching (e.g. from a duplicate graduation event)
    if (this.dipWatchMap.has(opts.mint)) return;

    const now = Date.now();
    const entry: DipWatchInternal = {
      mint:             opts.mint,
      symbol:           opts.symbol,
      name:             opts.name,
      watchStartedAt:   now,
      expiresAt:        now + DIP_WATCH_DURATION_MS,
      graduationPrice:  opts.graduationPrice,
      peakHigh:         opts.graduationPrice,
      dipLow:           opts.graduationPrice,
      currentPrice:     opts.graduationPrice,
      state:            "pumping",
      dumpPct:          0,
      retracePct:       0,
      qualityScore:     opts.quality.totalScore,
      _quality:         opts.quality,
      _signature:       opts.signature,
      _positionSizeSol: opts.positionSizeSol,
      _detectedAt:      opts.detectedAt,
      _initialPrice:    opts.initialPrice,
      _liveOnlySkip:    opts.liveOnlySkip,
    };

    // Reserve the mint in seenMints so no other graduation event starts a second watcher
    this.seenMints.add(opts.mint);
    this.dipWatchMap.set(opts.mint, entry);

    logger.info(
      { mint: opts.mint, symbol: opts.symbol, graduationPrice: opts.graduationPrice.toExponential(4), expiresIn: '30m' },
      `Graduation sniper: dip-retrace watcher started 👀 (${DIP_MIN_PCT}–${DIP_MAX_PCT}% dump + ${RETRACE_MIN_PCT}% retrace triggers entry)`,
    );
  }

  private async checkDipWatchers(): Promise<void> {
    if (this.dipWatchMap.size === 0) return;

    const now = Date.now();
    const expired: string[] = [];

    for (const [mint, entry] of this.dipWatchMap.entries()) {
      // ── Expiry check ──────────────────────────────────────────────────────
      if (now >= entry.expiresAt) {
        expired.push(mint);
        entry.state = "expired";
        logger.info({ mint, symbol: entry.symbol, dumpPct: entry.dumpPct.toFixed(1), peakHigh: entry.peakHigh.toExponential(4) },
          'Graduation sniper: dip-watch EXPIRED — no pattern in 30 min ⏱');
        this.addEvent({
          id: uid(), detectedAt: entry._detectedAt, mint, symbol: entry.symbol,
          action: 'skipped', txSignature: entry._signature,
          skipReason: `Dip-watch expired — no ${DIP_MIN_PCT}–${DIP_MAX_PCT}% dump+retrace in 30 min (peak dump was ${entry.dumpPct.toFixed(1)}%)`,
          qualityScore: entry.qualityScore,
        });
        continue;
      }

      // ── Fetch current price ───────────────────────────────────────────────
      let price = 0;
      try {
        const priceData = await this.fetchPrice(mint);
        if (priceData && priceData.price > 0) {
          price = priceData.price;
          // Update symbol/name if DexScreener returns better data
          if (priceData.symbol && entry.symbol === mint.slice(0, 8)) entry.symbol = priceData.symbol;
          if (priceData.name   && entry.name   === mint.slice(0, 8)) entry.name   = priceData.name;
        }
      } catch { /* non-fatal — skip this cycle */ }

      if (price <= 0) continue;

      entry.currentPrice = price;

      // ── Update peak high and dip low ─────────────────────────────────────
      if (price > entry.peakHigh) {
        entry.peakHigh = price;
        // Reset dipLow to current price — we're at a new high, fresh dump-tracking
        entry.dipLow = price;
      } else if (price < entry.dipLow) {
        entry.dipLow = price;
      }

      // ── Compute dip/retrace metrics ───────────────────────────────────────
      const dumpMagnitude = entry.peakHigh - entry.dipLow;
      entry.dumpPct    = entry.peakHigh > 0 ? (dumpMagnitude / entry.peakHigh) * 100 : 0;
      entry.retracePct = dumpMagnitude > 0 ? ((price - entry.dipLow) / dumpMagnitude) * 100 : 0;

      // ── State update ──────────────────────────────────────────────────────
      const validDump    = entry.dumpPct >= DIP_MIN_PCT && entry.dumpPct <= DIP_MAX_PCT;
      const validRetrace = entry.retracePct >= RETRACE_MIN_PCT;

      if (price >= entry.peakHigh) {
        entry.state = "pumping";
      } else if (entry.dumpPct >= DIP_MIN_PCT) {
        entry.state = (validDump && validRetrace) ? "retracing" : "dumped";
      }

      // ── Entry trigger ─────────────────────────────────────────────────────
      if (validDump && validRetrace) {
        logger.info({
          mint, symbol: entry.symbol,
          dumpPct:    entry.dumpPct.toFixed(1),
          retracePct: entry.retracePct.toFixed(1),
          peakHigh:   entry.peakHigh.toExponential(4),
          dipLow:     entry.dipLow.toExponential(4),
          entryPrice: price.toExponential(4),
        }, 'Graduation sniper: DIP-RETRACE TRIGGERED — entering position 🎯');

        // Remove from watch map BEFORE awaiting enterPosition so parallel cycles
        // don't double-trigger
        expired.push(mint);
        entry.state = "entered";

        if (!entry._liveOnlySkip) {
          void this.enterDipPosition(entry, price);
        } else {
          logger.info({ mint, symbol: entry.symbol, skip: entry._liveOnlySkip },
            'Graduation sniper: dip-retrace triggered — paper-only, skip live entry');
        }

        this.addEvent({
          id: uid(), detectedAt: entry._detectedAt, mint, symbol: entry.symbol,
          action: 'entered', txSignature: entry._signature,
          qualityScore:     entry.qualityScore,
          skipReason: undefined,
        });
      }
    }

    // Clean up expired / triggered entries
    for (const mint of expired) {
      this.dipWatchMap.delete(mint);
    }

    if (expired.length > 0) this.broadcast();
  }

  private async enterDipPosition(entry: DipWatchInternal, triggerPrice: number): Promise<void> {
    try {
      await this.enterPosition(
        entry.mint, entry.symbol, entry.name,
        triggerPrice, entry._signature,
        entry._initialPrice, entry._detectedAt,
        null, entry._positionSizeSol, entry._quality,
      );
    } catch (err) {
      logger.error(
        { mint: entry.mint, symbol: entry.symbol, err: (err as Error).message },
        'Graduation sniper: dip-retrace entry FAILED',
      );
    }
  }

  getDipWatchers(): DipWatchEntry[] {
    return Array.from(this.dipWatchMap.values()).map((e) => ({
      mint:            e.mint,
      symbol:          e.symbol,
      name:            e.name,
      watchStartedAt:  e.watchStartedAt,
      expiresAt:       e.expiresAt,
      graduationPrice: e.graduationPrice,
      peakHigh:        e.peakHigh,
      dipLow:          e.dipLow,
      currentPrice:    e.currentPrice,
      state:           e.state,
      dumpPct:         e.dumpPct,
      retracePct:      e.retracePct,
      qualityScore:    e.qualityScore,
    }));
  }

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
    fn: (mint: string, entryPrice: number, symbol: string, name: string, detectedAt: number, detectionPrice: number, qualityMeta?: GraduationQualityMeta) => void,
  ): void {
    this.paperCallback = fn;
  }
}

export const graduationSniperService = new GraduationSniperService();
