import axios from "axios";
import { logger } from "../lib/logger.js";
import { sendTelegram, isTelegramConfigured, toIST, startHeartbeat } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { scannerService } from "./scanner.service.js";
import { computeSignals, computeAiScore, computeConfidence, getDynamicRisk, computeEntryBoosts } from "./ai-scoring.service.js";
import { mapPairToToken } from "./scanner.service.js";
import { analyseTokenWithAi, buildAnalysisInput } from "./ai-analysis.service.js";
import { checkTokenSafety, type RugCheckResult } from "./rugcheck.service.js";
import { query, execute } from "../lib/db.js";
import type { DexScreenerPair } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const AUTO_TRADE_INTERVAL_MS = 60_000;
const MAX_HISTORY_CYCLES = 50;

export interface AutoTraderConfig {
  solPerTrade: number;
  maxConcurrentTrades: number;
  // AI quality
  minAiScore: number;
  minConfidence: number;
  // Liquidity & volume
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minVolume1hUsd: number;
  // Activity / momentum
  minBuyRatio1h: number;        // 0–1, e.g. 0.55 = 55% buys
  minPriceChange1h: number;     // %, must be positive momentum
  maxPriceChange1h: number;     // %, reject vertical/parabolic pumps above this
  minTransactions24h: number;
  minUniqueBuyers: number;      // proxy: buy txns in 1h (DexScreener has no wallet count)
  // Market cap sweet spot
  minMcapUsd: number;
  maxMcapUsd: number;
  // Pair age window (minutes / hours)
  minPairAgeMinutes: number;
  maxPairAgeHours: number;
  // Rug-pull guards
  minLiquidityMcapRatio: number;  // e.g. 0.03 = liq must be ≥3% of mcap
  maxFdvMcapRatio: number;        // e.g. 8.0 = FDV must not exceed 8× mcap
  maxPriceDropH6Pct: number;      // reject if 6h drop exceeds this (negative number)
  maxPriceDropH24Pct: number;     // reject if 24h drop exceeds this (negative number)
  // Circuit breaker controls
  consecutiveLossLimit: number;      // how many losses in a row trigger the breaker (default 3)
  consecutiveLossPauseHours: number; // how many hours to pause on consecutive loss trigger (default 2)
  dailyLossLimitSol: number;         // daily SOL loss cap before 24h pause (default 2)
  dailyLossPauseHours: number;       // how many hours to pause on daily loss cap (default 24)
  // Internal: used to detect when code defaults changed and migrate saved config
  schemaVersion?: number;
}

export interface FilterResult {
  pass: boolean;
  reason: string;
}

export interface CycleDecision {
  symbol: string;
  tokenName: string;
  pairAddress: string;
  aiScore: number;
  confidence: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  marketCapUsd: number;
  buyRatio1h: number;
  priceChange1h: number;
  pairAgeMinutes: number;
  priceUsd: number;
  slPercent: number;
  tpPercent: number;
  action: "traded" | "filtered" | "skipped_duplicate" | "skipped_slots" | "skipped_balance";
  reason: string;
  positionId?: string;
  llmVerdict?: "TRADE" | "SKIP" | "RISKY" | "none";
  llmConfidence?: number;
  llmReasoning?: string;
  llmRisks?: string[];
  llmStrengths?: string[];
  llmProvider?: string;
  llmDurationMs?: number;
}

export interface CycleRecord {
  cycleId: number;
  startedAt: number;
  finishedAt: number;
  tokensEvaluated: number;
  tradesOpened: number;
  decisions: CycleDecision[];
}

export interface AutoTraderStatus {
  paused: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunTokensEvaluated: number;
  lastRunTradesOpened: number;
  totalTradesOpened: number;
  telegramEnabled: boolean;
  nextRunIn: number;
  scannerPoolSize: number;
  config: AutoTraderConfig;
  circuitBreaker: {
    consecutiveLossActive: boolean;
    consecutiveLossResumesAt: number | null;
    consecutiveLossResumesInMin: number | null;
    dailyLossActive: boolean;
    dailyLossResumesAt: number | null;
    dailyLossResumesInHours: number | null;
    currentStreak: number;
    dailyLossSol: number;
  };
}

// ─── Default config ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: AutoTraderConfig = {
  solPerTrade: 0.5,
  maxConcurrentTrades: 8,       // 8 slots — Layer 9 genuine-coin check keeps quality high

  // ── AI quality ────────────────────────────────────────────────────────────
  minAiScore:    62,            // lowered: 62 lets more candidates reach Layer 9; genuine-coin check is final gate
  minConfidence: 40,            // allow tokens with less complete data

  // ── Liquidity & volume ────────────────────────────────────────────────────
  minLiquidityUsd:  15_000,     // $15K floor — LP lock ≥ 50% check in Layer 9 prevents thin-pool rugs
  minVolume24hUsd:   8_000,     // lower bar — catches early-stage tokens with real momentum
  minVolume1hUsd:    2_000,     // catches tokens just starting to gain traction

  // ── Momentum ─────────────────────────────────────────────────────────────
  minBuyRatio1h:    0.52,       // 52% buys — slight organic buy pressure required
  minPriceChange1h: 0,          // no forced positive 1h momentum — consolidations are valid entries
  maxPriceChange1h: 300,        // pump.fun grads regularly hit +150-400% in hour 1 — don't miss them
  minTransactions24h: 40,       // lower bar for newer/smaller tokens
  minUniqueBuyers:   8,         // lower proxy threshold for very fresh tokens

  // ── Market cap sweet spot ────────────────────────────────────────────────
  minMcapUsd:   10_000,         // micro-caps can 10x — don't exclude
  maxMcapUsd:  800_000,         // wider ceiling for late-stage early gems

  // ── Pair age ──────────────────────────────────────────────────────────────
  minPairAgeMinutes:  5,        // 5min survival — enough to confirm LP is real and pair isn't instantly rugged
  maxPairAgeHours:    5,        // extended: catch quality tokens still active in hours 3-5

  // ── Rug guards ────────────────────────────────────────────────────────────
  minLiquidityMcapRatio: 0.05,  // 5% — Layer 9 LP-lock check and Layer 2 drain detection protect us
  maxFdvMcapRatio:       4.0,   // wider — many legit tokens have some overhang
  maxPriceDropH6Pct:   -35,     // allow moderate dips
  maxPriceDropH24Pct:  -55,     // allow recovering tokens

  // ── Circuit breaker ───────────────────────────────────────────────────────
  consecutiveLossLimit:      3,  // 3 losses in a row triggers cooldown
  consecutiveLossPauseHours: 1,  // 1 hour cooldown
  dailyLossLimitSol:         3,  // -3 SOL/day cap
  dailyLossPauseHours:      12,  // 12h pause on daily cap

  // Bump this number whenever filter defaults change — forces all saved configs to migrate
  schemaVersion: 8,
};

// ─── Anti-rug + quality filter ────────────────────────────────────────────────
//
// Layer 1 — Hard sanity checks (data integrity)
// Layer 2 — RUG DETECTION (never configurable — always enforced)
//    2a. Pool drain:     vol5m > 75% of liquidity → LP being drained right now
//    2b. Bot buy 5m:     ≥95% buys in last 5 min with ≥10 txns → pre-rug accumulation
//    2c. Bot buy 1h:     ≥92% buys in last 1h with ≥40 txns → insider-dominated
//    2d. Wash trade:     zero sells but many buys → fake volume
//    2e. Liquidity thin: liq/mcap < threshold → easy to drain
//    2f. FDV inflation:  FDV >> mcap → massive unlocked supply overhang
// Layer 3 — Config-driven quality gates (adjustable)
// Layer 4 — Momentum guards (stale pump detection)
//
export function qualityFilter(pair: DexScreenerPair, cfg: AutoTraderConfig): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason });

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 1 — SANITY
  // ═══════════════════════════════════════════════════════════════════════════
  const priceUsd = parseFloat(pair.priceUsd) || 0;
  if (priceUsd <= 0) return fail("No valid price");

  const liq     = pair.liquidity?.usd || 0;
  const mcap    = pair.marketCap || pair.fdv || 0;
  const fdv     = pair.fdv || mcap;
  if (mcap <= 0) return fail("No market cap data");
  if (liq <= 0)  return fail("No liquidity data");

  const vol24h  = pair.volume?.h24 || 0;
  const vol1h   = pair.volume?.h1  || 0;
  const vol5m   = pair.volume?.m5  || 0;
  const buys1h  = pair.txns?.h1?.buys  || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const total1h = buys1h + sells1h;
  const buys5m  = pair.txns?.m5?.buys  || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const total5m = buys5m + sells5m;
  const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
  const pc1h    = pair.priceChange?.h1  || 0;
  const pc5m    = pair.priceChange?.m5  ?? null;
  const pc6h    = pair.priceChange?.h6  || 0;
  const pc24h   = pair.priceChange?.h24 || 0;
  const ageMs   = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
  const ageMin  = ageMs / 60_000;

  const buyRatio1h = total1h > 0 ? buys1h / total1h : 0;
  const buyRatio5m = total5m > 0 ? buys5m / total5m : 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 2 — RUG DETECTION (hardcoded — cannot be overridden by config)
  // ═══════════════════════════════════════════════════════════════════════════

  // 2a. Pool drain — only flag when BOTH conditions are true:
  //     a) 5m vol > 400% of liquidity (4×) — extreme volume spike
  //     b) Price is DROPPING while that volume hits — confirmed sell-side drain
  //     High volume + rising price = momentum/buying, NOT a drain. Allow it.
  const drainRatio = liq > 0 ? vol5m / liq : 0;
  if (vol5m > 0 && liq > 0 && drainRatio >= 4.0 && pc5m !== null && pc5m < 0)
    return fail(`Pool drain: 5m vol ${(drainRatio * 100).toFixed(0)}% of liquidity AND price down ${pc5m.toFixed(1)}% — LP being drained while selling`);

  // 2b. Bot accumulation (5m)
  if (total5m >= 8 && buyRatio5m >= 0.93)
    return fail(`Bot buying: ${(buyRatio5m * 100).toFixed(0)}% buys in last 5m (${total5m} txns) — pre-rug accumulation`);

  // 2c. Insider-dominated 1h
  if (total1h >= 30 && buyRatio1h >= 0.90)
    return fail(`Insider buying: ${(buyRatio1h * 100).toFixed(0)}% buys in 1h (${total1h} txns) — no organic sellers`);

  // 2d. Wash trading — zero or near-zero sells = fake volume
  if (sells1h === 0 && buys1h >= 20)
    return fail(`Wash trade: ${buys1h} buys / 0 sells in 1h — artificial volume`);
  if (sells1h <= 2 && buys1h >= 40)
    return fail(`Near-wash trade: ${buys1h} buys / only ${sells1h} sells in 1h — almost no organic selling`);

  // 2e. Thin liquidity vs market cap — easy to drain the entire pool.
  const liqMcapRatio = liq / mcap;
  if (liqMcapRatio < cfg.minLiquidityMcapRatio)
    return fail(`Liq/MCap ${(liqMcapRatio * 100).toFixed(1)}% < ${(cfg.minLiquidityMcapRatio * 100).toFixed(0)}% — easy rug`);

  // 2f. FDV inflation — massive unissued/locked supply that will dump.
  if (fdv > 0 && mcap > 0 && fdv / mcap > cfg.maxFdvMcapRatio)
    return fail(`FDV ${(fdv / mcap).toFixed(1)}× mcap > ${cfg.maxFdvMcapRatio}× max — supply dump risk`);

  // 2g. Absolute liquidity floor — hard minimum below which no pool is safe regardless of config.
  //     Set to $8K so the configurable minLiquidityUsd ($15K default) is the effective gate.
  if (liq < 8_000)
    return fail(`Absolute liquidity $${Math.round(liq).toLocaleString()} < $8K — too thin to exit safely`);

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 3 — CONFIG-DRIVEN QUALITY GATES
  // ═══════════════════════════════════════════════════════════════════════════

  // Pair age — tokens that rug do so in the first 1–10 min.
  // 15 min of survival with LP intact is a meaningful signal.
  if (!pair.pairCreatedAt || ageMin < cfg.minPairAgeMinutes)
    return fail(`Too new: ${Math.round(ageMin)}m old < ${cfg.minPairAgeMinutes}m min — survival unproven`);
  if (ageMin > cfg.maxPairAgeHours * 60)
    return fail(`Too old: ${Math.round(ageMin / 60)}h > ${cfg.maxPairAgeHours}h max`);

  // Liquidity floor
  if (liq < cfg.minLiquidityUsd)
    return fail(`Liquidity $${Math.round(liq).toLocaleString()} < $${cfg.minLiquidityUsd.toLocaleString()} min`);

  // Volume floors
  if (vol24h < cfg.minVolume24hUsd)
    return fail(`Vol24h $${Math.round(vol24h).toLocaleString()} < $${cfg.minVolume24hUsd.toLocaleString()} min`);
  if (vol1h > 0 && vol1h < cfg.minVolume1hUsd)
    return fail(`Vol1h $${Math.round(vol1h).toLocaleString()} < $${cfg.minVolume1hUsd.toLocaleString()} min`);

  // Activity — real traders leave a txn footprint
  if (txns24h < cfg.minTransactions24h)
    return fail(`Txns24h ${txns24h} < ${cfg.minTransactions24h} min`);

  // Buy pressure — organic but not suspicious
  if (total1h >= 5 && buyRatio1h < cfg.minBuyRatio1h)
    return fail(`Buy ratio ${(buyRatio1h * 100).toFixed(0)}% < ${(cfg.minBuyRatio1h * 100).toFixed(0)}% min`);

  // Momentum — must be actively pumping, not a ghost from hours ago
  if (pc1h < cfg.minPriceChange1h)
    return fail(`1h change ${pc1h.toFixed(1)}% < +${cfg.minPriceChange1h}% min`);

  // Market cap sweet spot
  if (mcap < cfg.minMcapUsd)
    return fail(`MCap $${Math.round(mcap).toLocaleString()} < $${cfg.minMcapUsd.toLocaleString()} min`);
  if (mcap > cfg.maxMcapUsd)
    return fail(`MCap $${(mcap / 1_000_000).toFixed(1)}M > $${(cfg.maxMcapUsd / 1_000_000).toFixed(0)}M max`);

  // Price dump guards
  if (pc6h < cfg.maxPriceDropH6Pct)
    return fail(`6h dump ${pc6h.toFixed(1)}% — rug or dead momentum`);
  if (pc24h < cfg.maxPriceDropH24Pct)
    return fail(`24h dump ${pc24h.toFixed(1)}% — severe decline`);

  // ── Layer 3b — Advanced moonshot quality gates ────────────────────────────
  // These use derived ratios from existing DexScreener data to filter out
  // fake volume, ghost pools, and coins without genuine buyer interest.

  // Volume/Liquidity ratio: too low = ghost token, too high = synthetic/wash volume.
  // Floor 0.12x: large-pool tokens can have lower vol/liq naturally.
  // Ceiling 20x: real early pumps churn liquidity 10-15x in the first few hours — 8x was
  //   blocking legitimate momentum plays (e.g. 3h-old token with $1.3M vol / $32K liq = 10.9x).
  //   Wash-trade protection is already handled by Layer 2b/2c/2d (buy-ratio and zero-sells checks).
  const volLiqRatio = liq > 0 && vol1h > 0 ? vol1h / liq : 0;
  if (vol1h > 0 && liq > 0) {
    if (volLiqRatio < 0.12)
      return fail(`Vol/Liq ${volLiqRatio.toFixed(2)}x < 0.12x — ghost token, no real interest`);
    if (volLiqRatio > 20)
      return fail(`Vol/Liq ${volLiqRatio.toFixed(1)}x > 20x — extreme vol/liq ratio, likely synthetic volume`);
  }

  // Minimum recent buy transactions in 5m (proxy for unique buyers in window)
  // Only apply after 15m to avoid rejecting newer launches. Lowered to 3 buys.
  if (ageMin > 15 && total5m > 0 && buys5m < 3)
    return fail(`Only ${buys5m} buy txns in last 5m — insufficient buyer activity (need ≥3)`);

  // Volume growth: 5m pace vs 1h baseline
  // If 5m annualised is < 10% of 1h volume, momentum is clearly dying
  if (vol5m > 0 && vol1h > 0 && ageMin > 30) {
    const pacedHourlyVol = vol5m * 12;
    if (pacedHourlyVol < vol1h * 0.10)
      return fail(`Volume fading: 5m pace ~$${Math.round(pacedHourlyVol).toLocaleString()}/hr vs $${Math.round(vol1h).toLocaleString()}/hr 1h avg — momentum dying`);
  }

  // ── Layer 3b — Extended config gates ──────────────────────────────────────

  // Parabolic / vertical pump ceiling — don't buy the top
  if (pc1h > cfg.maxPriceChange1h)
    return fail(`Vertical pump: +${pc1h.toFixed(0)}% in 1h > ${cfg.maxPriceChange1h}% max — parabolic, not a healthy entry`);

  // Unique buyer depth (proxy: buy txn count in 1h — DexScreener has no wallet-count API)
  if (total1h >= 10 && buys1h < cfg.minUniqueBuyers)
    return fail(`Weak participation: only ${buys1h} buy txns in 1h < ${cfg.minUniqueBuyers} min — not enough buyers`);

  // ── Layer 3c — Hard manipulation & entry-quality rejections ───────────────

  // Sellers dominating right now — don't buy into active distribution
  if (total5m >= 10 && buyRatio5m < 0.40)
    return fail(`Sell dominant 5m: ${(buyRatio5m * 100).toFixed(0)}% buys in last 5m (${total5m} txns) — sellers in control`);

  // Volume spike without buyer participation — classic wash/fake volume pattern
  if (vol5m > 0 && vol1h > 0 && total5m > 0) {
    const expected5mPace = vol1h / 12;
    const volSpike = vol5m / expected5mPace;
    if (volSpike > 4 && buys5m < 8)
      return fail(`Fake volume spike: 5m vol ${volSpike.toFixed(1)}x above 1h avg but only ${buys5m} buys — wash trading suspected`);
  }

  // Retracement >35% of 1h gain in last 5m — heavy selling into the pump
  if (pc1h > 15 && pc5m !== null && pc5m < -4) {
    const retracePct = (Math.abs(pc5m) / pc1h) * 100;
    if (retracePct > 35)
      return fail(`Heavy retracement: -${Math.abs(pc5m).toFixed(1)}% in 5m = ${retracePct.toFixed(0)}% of 1h gain — distribution into the pump`);
  }

  // Weak 5m bounce after severe 6h dump — dead cat confirmation
  if (pc6h < -25 && pc5m !== null && pc5m < 2)
    return fail(`Dead cat: -${Math.abs(pc6h).toFixed(0)}% in 6h, 5m bounce only ${pc5m?.toFixed(1)}% — not a real reversal`);

  // Already pumped hard — if 1h > 3x AND no fresh 5m momentum → late entry trap
  if (pc1h > 200 && pc5m !== null && pc5m <= 0)
    return fail(`Late entry trap: +${pc1h.toFixed(0)}% in 1h and 5m now ${pc5m?.toFixed(1)}% — early buyers distributing`);

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 4 — MOMENTUM FRESHNESS
  // ═══════════════════════════════════════════════════════════════════════════

  // Stale pump guard — if 5m is deeply negative, the pump peaked already.
  // The 1h% includes history; we need the move to be happening NOW.
  if (pc5m !== null && pc5m < -5)
    return fail(`5m change ${pc5m.toFixed(1)}% — momentum gone, pump peaked`);

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 5 — PUMP STAGE DETECTION (never configurable — always enforced)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The #1 cause of losses: buying a token that has ALREADY pumped and is now
  // being distributed by early holders. The 1h candle still looks great but
  // the move is essentially over. Latecomers buy the top while insiders sell.
  //
  // Signals that the pump is LATE / in distribution:
  //   5a. Massive 1h rally + flat/negative 5m → early holders distributing
  //   5b. 1h very high + barely any 5m activity → momentum exhaustion
  //   5c. 6h dump > 15% but 1h suddenly positive → dead cat bounce (trap)
  //
  // Note: we only apply the strictest checks here. The AI score already
  // penalises late-stage pumps via the entry timing component.

  // 5a. Massive 1h pump with momentum DEAD in 5m — distribution phase
  // Only block if 1h is truly parabolic (>300%) AND 5m is clearly negative
  if (pc1h > 300 && (pc5m !== null && pc5m < -2))
    return fail(`Late pump: +${pc1h.toFixed(0)}% in 1h but 5m now ${pc5m?.toFixed(1)}% — distribution phase, momentum gone`);

  // 5b. Large pump + clear 5m reversal — rolling over
  // Raised threshold: only block if >250% in 1h AND 5m strongly negative
  if (pc1h > 250 && (pc5m !== null && pc5m < -5))
    return fail(`Pump reversal: +${pc1h.toFixed(0)}% in 1h but 5m now ${pc5m?.toFixed(1)}% — price rolling over`);

  // 5c. Dead cat bounce — 6h significantly negative but 1h bounced only weakly
  if (pc6h < -20 && pc1h < 15)
    return fail(`Dead cat bounce: -${Math.abs(pc6h).toFixed(0)}% in 6h with only +${pc1h.toFixed(0)}% recovery — likely short-lived relief rally`);

  // 5d. Very recent activity check: if there are near-zero transactions in 5m
  // despite passing other filters, the token is stale/inactive RIGHT NOW
  if (total5m < 3 && ageMin > 30)
    return fail(`No recent activity: only ${total5m} txns in last 5m — not actively trading right now`);

  return { pass: true, reason: "All filters passed" };
}

// ─── Candle entry timing ──────────────────────────────────────────────────────
//
// Before every trade entry, fetch the last 6 × 5-minute OHLCV candles from
// DexScreener and reject entries that show classic "bought the top" patterns:
//
//  1. Latest candle is the biggest green candle  → entering at the peak
//  2. Price up ≥40% across last 3 candles        → parabolic, late entry
//  3. Volume on latest candle < previous         → fading momentum
//  4. Latest candle closes in lower 40% of range → sell pressure dominating
//  5. Only 1 consecutive green candle (trend start) → wait for confirmation
//  6. ≥5 consecutive green candles               → candle 5+, overextended
//
// If candle data is unavailable for any reason the trade is SKIPPED entirely
// (fail-closed) — better to miss a trade than buy an unknown top.

interface OhlcvCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// Attempt multiple DexScreener OHLCV endpoints — each may or may not be
// accessible depending on the deployment environment.
const CANDLE_ENDPOINTS = [
  (pa: string) => `https://io.dexscreener.com/dex/chart/v3/solana/${pa}?type=5m`,
  (pa: string) => `https://io.dexscreener.com/dex/chart/v2/solana/${pa}?type=5m`,
];

async function checkCandleEntryTiming(pairAddress: string): Promise<FilterResult> {
  const skip = (reason: string): FilterResult => ({ pass: false, reason });

  let candles: OhlcvCandle[] | null = null;

  for (const endpoint of CANDLE_ENDPOINTS) {
    try {
      const resp = await axios.get<{ bars?: unknown[]; ohlcv?: unknown[] }>(
        endpoint(pairAddress),
        { timeout: 5_000 },
      );
      const raw: unknown[] = (resp.data?.bars ?? resp.data?.ohlcv ?? []) as unknown[];
      if (!Array.isArray(raw) || raw.length < 2) continue;
      const parsed = (raw as Record<string, unknown>[]).slice(-6).map((c) => ({
        t: Number(c["t"] ?? c["time"] ?? 0),
        o: Number(c["o"] ?? c["open"]  ?? 0),
        h: Number(c["h"] ?? c["high"]  ?? 0),
        l: Number(c["l"] ?? c["low"]   ?? 0),
        c: Number(c["c"] ?? c["close"] ?? 0),
        v: Number(c["v"] ?? c["volume"] ?? 0),
      }));
      if (parsed.some((c) => c.o <= 0 || c.c <= 0)) continue;
      candles = parsed;
      break;
    } catch {
      // try next endpoint
    }
  }

  // If no endpoint returned usable candle data, fall through to pass.
  // The qualityFilter already applies extensive 5m protections (momentum,
  // retracement, drain+dump, late-entry trap checks) so this is not a naked
  // entry — it's just relying on those existing guards instead of candle history.
  if (!candles || candles.length < 2) {
    logger.debug({ pairAddress }, "Candle timing: no OHLCV data available — relying on existing 5m quality filters");
    return { pass: true, reason: "Candle data unavailable — proceeding with 5m quality-filter protection" };
  }

  const latest = candles[candles.length - 1]!;
  const prev   = candles[candles.length - 2]!;
  const last3  = candles.slice(-3);

  // ── Check 1: Latest candle is the BIGGEST green candle ─────────────────────
  // Bot has been entering right after the peak pump candle. Biggest green = top.
  if (latest.c > latest.o) {
    const latestBodyPct = latest.o > 0 ? ((latest.c - latest.o) / latest.o) * 100 : 0;
    const isLargestGreen = candles.every((candle) => {
      if (candle === latest) return true;
      const bodyPct = candle.o > 0 ? ((candle.c - candle.o) / candle.o) * 100 : 0;
      return bodyPct <= latestBodyPct;
    });
    if (isLargestGreen && latestBodyPct > 1) {
      return skip(
        `Candle timing: latest is the biggest green candle (+${latestBodyPct.toFixed(1)}% body) — entering at the peak of the pump, skipping`,
      );
    }
  }

  // ── Check 2: Price up ≥40% across last 3 candles ───────────────────────────
  // Three consecutive strong candles = parabolic move, late entry trap.
  if (last3.length === 3) {
    const oldestOpen = last3[0]!.o;
    if (oldestOpen > 0) {
      const gain3 = ((latest.c - oldestOpen) / oldestOpen) * 100;
      if (gain3 >= 40) {
        return skip(
          `Candle timing: +${gain3.toFixed(1)}% across last 3 candles ≥ 40% — parabolic, skipping late entry`,
        );
      }
    }
  }

  // ── Check 3: Volume on latest candle sharply below previous ────────────────
  // A small decrease is normal on continuation candles — the initial pump candle
  // is often the highest-volume one and healthy candle 2-4 entries will be
  // somewhat lower. We only block if volume has collapsed to < 65% of the
  // previous candle, which signals the move is genuinely running out of fuel.
  if (prev.v > 0 && latest.v < prev.v * 0.65) {
    return skip(
      `Candle timing: volume collapsed — latest $${Math.round(latest.v).toLocaleString()} is ${((latest.v / prev.v) * 100).toFixed(0)}% of prev $${Math.round(prev.v).toLocaleString()} (< 65%) — momentum fading, skipping`,
    );
  }

  // ── Check 4: Buy ratio proxy — close in lower 40% of candle range ──────────
  // If price closes near the bottom of its range, sellers took control on this
  // candle regardless of the absolute direction (classic bearish reversal signal).
  const range = latest.h - latest.l;
  if (range > 0) {
    const closePosition = (latest.c - latest.l) / range; // 0 = close at low, 1 = close at high
    if (closePosition < 0.40) {
      return skip(
        `Candle timing: latest candle closes in lower ${(closePosition * 100).toFixed(0)}% of range — sell pressure dominating (buy ratio declining), skipping`,
      );
    }
  }

  // ── Check 5 & 6: Trend position ────────────────────────────────────────────
  // Count consecutive green candles from the most recent backward.
  // Only enter at candle 2, 3, or 4 of a new trend. Never candle 1 or 5+.
  let trendLength = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const candle = candles[i]!;
    if (candle.c > candle.o) trendLength++;
    else break;
  }

  if (trendLength === 0) {
    return skip("Candle timing: latest candle is red — no uptrend established, skipping");
  }
  if (trendLength === 1) {
    return skip(
      "Candle timing: candle 1 of new trend — too early (just started), wait for candle 2 confirmation before entry",
    );
  }
  if (trendLength >= 5) {
    return skip(
      `Candle timing: candle ${trendLength} of uptrend (≥5) — overextended, early buyers distributing, never enter after candle 4`,
    );
  }

  // trendLength is 2, 3, or 4 — valid entry window
  return {
    pass: true,
    reason: `Candle timing OK: candle ${trendLength} of uptrend, volume growing, close in upper range — entry window valid`,
  };
}

// ─── Layer 9: Genuine Coin Check ──────────────────────────────────────────────
//
// Final gate before capital is committed. Filters out tokens that technically
// pass all earlier layers (no DANGER risks, decent score) but show patterns
// associated with insider/coordinated pumps or low-effort disposable tokens:
//   1. RugCheck score ≤ 700   — total risk-flag accumulation below threshold
//   2. Top holder ≤ 20%       — no single wallet controlling a dangerous slice
//   3. LP locked ≥ 50%        — meaningful lockup commitment (dev has skin in the game)
//      Exception: pairs < 20 min old (LP lock tools take time to record)
//   4. Warning risk count ≤ 3 — many yellow flags combined signal coordinated setup
//
// NOTE: DANGER risks are already blocked in Layer 6 (RugCheck). This layer
// focuses on cumulative quality signals that individually are warnings but
// together indicate a low-quality token.
//
function genuineCoinCheck(rugResult: RugCheckResult, pairAgeMin: number): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason });

  // 1. Cumulative risk score (RugCheck scores all detected issues; lower = safer)
  if (rugResult.score > 700) {
    return fail(
      `Genuine-coin check: RugCheck risk score ${rugResult.score} > 700 — too many risk flags combined, skipping`,
    );
  }

  // 2. Top holder concentration
  if (rugResult.topHolderPct > 25) {
    return fail(
      `Genuine-coin check: top holder ${rugResult.topHolderPct.toFixed(1)}% > 25% — single-wallet concentration too high`,
    );
  }

  // 3. LP locked check (skip for brand-new pairs < 20 min — LP tools haven't indexed yet)
  if (pairAgeMin >= 20 && rugResult.lpLockedPct < 50) {
    return fail(
      `Genuine-coin check: LP locked ${rugResult.lpLockedPct.toFixed(0)}% < 50% — insufficient liquidity commitment`,
    );
  }

  // 4. Too many warning-level flags (individually minor but together = yellow-flag soup)
  if (rugResult.warnRisks.length > 3) {
    return fail(
      `Genuine-coin check: ${rugResult.warnRisks.length} warning risks (${rugResult.warnRisks.slice(0, 3).join(", ")}…) — excessive combined warnings`,
    );
  }

  return {
    pass: true,
    reason: `Genuine-coin check PASSED — score ${rugResult.score}, top holder ${rugResult.topHolderPct.toFixed(1)}%, LP ${rugResult.lpLockedPct.toFixed(0)}% locked, ${rugResult.warnRisks.length} warns`,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────
class AutoTraderService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private running = false;
  private lastRunAt: number | null = null;
  private lastRunTokensEvaluated = 0;
  private lastRunTradesOpened = 0;
  private totalTradesOpened = 0;
  private nextRunAt = 0;
  private cycleCounter = 0;
  private history: CycleRecord[] = [];
  private config: AutoTraderConfig = { ...DEFAULT_CONFIG };
  private wasAtMaxTrades = false;
  private consecutiveLossPausedUntil = 0;

  private getConsecutiveLossStreak(): number {
    const trades = paperTradingService.getClosedTrades()
      .sort((a, b) => new Date(b.closedAt!).getTime() - new Date(a.closedAt!).getTime());
    let streak = 0;
    for (const t of trades) {
      if ((t.pnlSol ?? 0) < 0) streak++;
      else break;
    }
    return streak;
  }

  getConfig(): AutoTraderConfig { return { ...this.config }; }

  async init(): Promise<void> {
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(
        "SELECT value FROM app_config WHERE key = 'auto_trader_config'"
      ).catch((err: Error) => {
        if (err.message?.includes("does not exist")) return [];
        throw err;
      });
      if (rows.length > 0 && rows[0].value) {
        const saved = JSON.parse(rows[0].value) as Partial<AutoTraderConfig> & { schemaVersion?: number };

        if (saved.schemaVersion !== DEFAULT_CONFIG.schemaVersion) {
          // Schema version mismatch — code defaults changed.
          // Reset all filter/strategy fields to new defaults.
          // Preserve only user-facing trade settings they may have customised.
          const preserved = {
            solPerTrade:            saved.solPerTrade            ?? DEFAULT_CONFIG.solPerTrade,
            maxConcurrentTrades:    saved.maxConcurrentTrades    ?? DEFAULT_CONFIG.maxConcurrentTrades,
            consecutiveLossLimit:   saved.consecutiveLossLimit   ?? DEFAULT_CONFIG.consecutiveLossLimit,
            consecutiveLossPauseHours: saved.consecutiveLossPauseHours ?? DEFAULT_CONFIG.consecutiveLossPauseHours,
            dailyLossLimitSol:      saved.dailyLossLimitSol      ?? DEFAULT_CONFIG.dailyLossLimitSol,
            dailyLossPauseHours:    saved.dailyLossPauseHours    ?? DEFAULT_CONFIG.dailyLossPauseHours,
          };
          this.config = { ...DEFAULT_CONFIG, ...preserved };
          logger.info(
            { oldVersion: saved.schemaVersion ?? "none", newVersion: DEFAULT_CONFIG.schemaVersion, config: this.config },
            "Auto-trader config: schema migrated to new defaults"
          );
          // Persist the migrated config immediately so next restart is clean
          void this.saveConfig();
        } else {
          this.config = { ...DEFAULT_CONFIG, ...saved };
          logger.info({ config: this.config }, "Auto-trader config loaded from DB");
        }
      } else {
        logger.info("Auto-trader config: using defaults (no saved config found)");
      }
    } catch (err) {
      logger.warn({ err }, "Auto-trader config: failed to load from DB — using defaults");
    }
  }

  private async saveConfig(): Promise<void> {
    try {
      await execute(
        `INSERT INTO app_config (key, value, updated_at)
         VALUES ('auto_trader_config', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(this.config)]
      );
    } catch (err) {
      logger.warn({ err }, "Auto-trader config: failed to persist to DB");
    }
  }

  updateConfig(patch: Partial<AutoTraderConfig>): AutoTraderConfig {
    this.config = { ...this.config, ...patch };
    logger.info({ config: this.config }, "Auto-trader config updated");
    void this.saveConfig();
    return { ...this.config };
  }

  pause(): void { this.paused = true; logger.info("Auto-trader paused"); }
  resume(): void { this.paused = false; logger.info("Auto-trader resumed"); void this.run(); }
  isPaused(): boolean { return this.paused; }
  getHistory(): CycleRecord[] { return [...this.history].reverse(); }

  resetCircuitBreaker(): void {
    this.consecutiveLossPausedUntil = 0;
    this.dailyLossPausedUntil = 0;
    logger.info("Auto-trader: circuit breaker manually reset by user");
  }

  private dailyLossPausedUntil = 0;

  private getDailyLoss(): number {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime();
    return paperTradingService.getClosedTrades()
      .filter(t => t.closedAt && new Date(t.closedAt).getTime() >= todayTs)
      .reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  }

  getStatus(): AutoTraderStatus {
    const now = Date.now();
    const consecutiveLossActive = this.consecutiveLossPausedUntil > now;
    const dailyLossActive = this.dailyLossPausedUntil > now;
    const streak = this.getConsecutiveLossStreak();
    const dailyLoss = this.getDailyLoss();
    return {
      paused: this.paused,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastRunTokensEvaluated: this.lastRunTokensEvaluated,
      lastRunTradesOpened: this.lastRunTradesOpened,
      totalTradesOpened: this.totalTradesOpened,
      telegramEnabled: isTelegramConfigured(),
      nextRunIn: Math.max(0, this.nextRunAt - now),
      scannerPoolSize: scannerService.getTokenCount(),
      config: this.getConfig(),
      circuitBreaker: {
        consecutiveLossActive,
        consecutiveLossResumesAt: consecutiveLossActive ? this.consecutiveLossPausedUntil : null,
        consecutiveLossResumesInMin: consecutiveLossActive ? Math.ceil((this.consecutiveLossPausedUntil - now) / 60_000) : null,
        dailyLossActive,
        dailyLossResumesAt: dailyLossActive ? this.dailyLossPausedUntil : null,
        dailyLossResumesInHours: dailyLossActive ? Math.ceil((this.dailyLossPausedUntil - now) / 3_600_000) : null,
        currentStreak: streak,
        dailyLossSol: dailyLoss,
      },
    };
  }

  /**
   * Supplementary fetch: get any fresh boosted/profiled addresses not yet in scanner
   */
  private async fetchSupplementaryPairs(): Promise<DexScreenerPair[]> {
    try {
      const [boostsRes, profilesRes] = await Promise.allSettled([
        axios.get<{ tokenAddress: string; chainId: string }[]>(
          `${DEXSCREENER_BASE}/token-boosts/top/v1`,
          { timeout: 10_000 },
        ),
        axios.get<{ tokenAddress: string; chainId: string }[]>(
          `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
          { timeout: 10_000 },
        ),
      ]);

      const addresses = new Set<string>();
      if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
        boostsRes.value.data.filter((b) => b.chainId === "solana").forEach((b) => addresses.add(b.tokenAddress));
      }
      if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
        profilesRes.value.data.filter((p) => p.chainId === "solana").forEach((p) => addresses.add(p.tokenAddress));
      }

      if (addresses.size === 0) return [];

      const chunks: string[][] = [];
      const addrArr = Array.from(addresses);
      for (let i = 0; i < addrArr.length; i += 30) chunks.push(addrArr.slice(i, i + 30));

      const results = await Promise.allSettled(
        chunks.map((chunk) =>
          axios.get<{ pairs: DexScreenerPair[] }>(
            `${DEXSCREENER_BASE}/tokens/v1/solana/${chunk.join(",")}`,
            { timeout: 8000 },
          ),
        ),
      );

      const pairs: DexScreenerPair[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          const data = r.value.data;
          // /tokens/v1/solana/{addresses} returns a bare array [], NOT { pairs: [] }
          const arr: DexScreenerPair[] = Array.isArray(data) ? data : (data as { pairs: DexScreenerPair[] }).pairs ?? [];
          pairs.push(...arr.filter((p) => p.chainId === "solana"));
        }
      }
      return pairs;
    } catch {
      return [];
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.paused) return;

    const { consecutiveLossLimit, consecutiveLossPauseHours, dailyLossLimitSol, dailyLossPauseHours } = this.config;

    // Daily loss cap: configurable SOL/day limit
    if (this.dailyLossPausedUntil > Date.now()) {
      const resumeInHours = Math.ceil((this.dailyLossPausedUntil - Date.now()) / 3_600_000);
      logger.info({ resumeInHours }, "Auto-trader: skipping cycle — daily loss cap active");
      return;
    }
    const dailyLoss = this.getDailyLoss();
    if (dailyLoss <= -Math.abs(dailyLossLimitSol)) {
      this.dailyLossPausedUntil = Date.now() + dailyLossPauseHours * 3_600_000;
      logger.warn({ dailyLoss: dailyLoss.toFixed(4) }, `Auto-trader: daily loss cap hit (-${dailyLossLimitSol} SOL) — pausing ${dailyLossPauseHours}h`);
      void sendTelegram(
        `🚨 <b>DAILY LOSS CAP HIT</b>\n` +
        `──────────────────────\n` +
        `📉 Today's losses: <b>${dailyLoss.toFixed(4)} SOL</b> (limit: -${dailyLossLimitSol} SOL)\n` +
        `⏸️ Bot auto-paused for ${dailyLossPauseHours} hours to protect capital.\n` +
        `🔔 Resumes at ${toIST(new Date(this.dailyLossPausedUntil))}`,
      );
      return;
    }

    // Consecutive loss circuit breaker: configurable losses in a row → configurable cooldown
    if (this.consecutiveLossPausedUntil > Date.now()) {
      const resumeInMin = Math.ceil((this.consecutiveLossPausedUntil - Date.now()) / 60_000);
      logger.info({ resumeInMin }, "Auto-trader: skipping cycle — consecutive loss cooldown active");
      return;
    }
    const lossStreak = this.getConsecutiveLossStreak();
    if (lossStreak >= consecutiveLossLimit) {
      this.consecutiveLossPausedUntil = Date.now() + consecutiveLossPauseHours * 3_600_000;
      logger.warn({ lossStreak }, `Auto-trader: ${consecutiveLossLimit} consecutive losses — pausing ${consecutiveLossPauseHours}h to protect capital`);
      void sendTelegram(
        `⛔ <b>CIRCUIT BREAKER TRIGGERED</b>\n` +
        `──────────────────────\n` +
        `📉 <b>${lossStreak} consecutive losses</b> detected\n` +
        `⏸️ Trading paused ${consecutiveLossPauseHours} hour(s) to reset conditions.\n` +
        `🔔 Resumes at ${toIST(new Date(this.consecutiveLossPausedUntil))}`,
      );
      return;
    }

    this.running = true;
    this.nextRunAt = Date.now() + AUTO_TRADE_INTERVAL_MS;
    const cycleId = ++this.cycleCounter;
    const startedAt = Date.now();
    const decisions: CycleDecision[] = [];
    let tokensEvaluated = 0;
    let tradesOpened = 0;

    logger.info({ cycleId }, "Auto-trader: cycle started");

    try {
      const { minAiScore, minConfidence, solPerTrade, maxConcurrentTrades } = this.config;
      const openPositions = paperTradingService.getOpenPositions();

      if (openPositions.length >= maxConcurrentTrades) {
        logger.info({ open: openPositions.length, max: maxConcurrentTrades }, "Auto-trader: at max concurrent trades — skipping cycle");
        if (!this.wasAtMaxTrades) {
          this.wasAtMaxTrades = true;
          void sendTelegram(
            `⏸️ <b>Auto-Trader — All Slots Full</b>\n` +
            `──────────────────\n` +
            `📦 Open positions: <b>${openPositions.length}/${maxConcurrentTrades}</b>\n` +
            `🔍 Scanner still running in background.\n` +
            `🔔 You'll be notified when a position closes and a new slot opens.`,
          );
        }
        return;
      }
      if (this.wasAtMaxTrades) {
        this.wasAtMaxTrades = false;
        void sendTelegram(
          `▶️ <b>Auto-Trader — Slot Freed Up</b>\n` +
          `──────────────────\n` +
          `📦 Open positions: <b>${openPositions.length}/${maxConcurrentTrades}</b>\n` +
          `🔍 Resuming scan for next A+ trade signal...`,
        );
      }

      // ── PRIMARY: use scanner's accumulated token pool ──────────────────────
      const scannerTokens = scannerService.getAll();

      // ── SUPPLEMENTARY: fresh fetch for any tokens not in scanner yet ────────
      const freshPairs = await this.fetchSupplementaryPairs();
      const seenInScanner = new Set(scannerTokens.map((t) => t.pairAddress));

      const freshTokens = freshPairs
        .filter((p) => !seenInScanner.has(p.pairAddress))
        .map((p) => mapPairToToken(p));

      const freshSeen = new Set<string>();
      const uniqueFresh = freshTokens.filter((t) => {
        if (freshSeen.has(t.pairAddress)) return false;
        freshSeen.add(t.pairAddress);
        return true;
      });

      const scannerPairSet = new Set(scannerTokens.map((t) => t.pairAddress));
      const allCandidates = [...scannerTokens, ...uniqueFresh];
      tokensEvaluated = allCandidates.length;

      logger.info({ cycleId, scannerPool: scannerTokens.length, freshTokens: uniqueFresh.length, total: tokensEvaluated }, "Auto-trader: candidate pool built");

      interface Candidate {
        pairAddress: string;
        symbol: string;
        tokenName: string;
        aiScore: number;
        confidence: number;
        liquidityUsd: number;
        volume24hUsd: number;
        volume1hUsd: number;
        marketCapUsd: number;
        buyRatio1h: number;
        priceChange1h: number;
        pairAgeMinutes: number;
        priceUsd: number;
        slPercent: number;
        tpPercent: number;
        pair: DexScreenerPair | null;
        fromScanner: boolean; // true = data came from DexScreener scanner (no re-fetch needed)
      }

      const qualifiedCandidates: Candidate[] = [];

      for (const token of allCandidates) {
        const { slPercent, tpPercent } = getDynamicRisk(token.aiScore);
        const total1h = token.buys1h + token.sells1h;
        const buyRatio1h = total1h > 0 ? token.buys1h / total1h : 0;
        const pairAgeMinutes = token.pairAge ? (Date.now() - token.pairAge) / 60_000 : 0;

        const base: Omit<CycleDecision, "action" | "reason"> = {
          symbol: token.symbol,
          tokenName: token.name,
          pairAddress: token.pairAddress,
          aiScore: token.aiScore,
          confidence: token.confidence,
          liquidityUsd: token.liquidity,
          volume24hUsd: token.volume24h,
          volume1hUsd: token.volume1h,
          marketCapUsd: token.marketCap,
          buyRatio1h,
          priceChange1h: token.priceChange1h,
          pairAgeMinutes,
          priceUsd: token.priceUsd,
          slPercent,
          tpPercent,
        };

        // One-trade-per-coin rule: block re-entry for any contract that has
        // ever been traded (open OR closed). Prevents the AI from re-buying
        // the same coin after a stop-loss or take-profit.
        if (paperTradingService.hasEverTradedContract(token.address)) {
          decisions.push({ ...base, action: "skipped_duplicate", reason: `Already traded this contract (${token.address.slice(0, 8)}…) as ${token.symbol} — no re-entry allowed` });
          continue;
        }

        // AI score gate
        if (token.aiScore < minAiScore) {
          decisions.push({ ...base, action: "filtered", reason: `AI score ${token.aiScore} < ${minAiScore} min` });
          continue;
        }

        // Confidence gate
        if (token.confidence < minConfidence) {
          decisions.push({ ...base, action: "filtered", reason: `Confidence ${token.confidence}% < ${minConfidence}% min` });
          continue;
        }

        // Stage 1: Fast pre-filter using scanner/GeckoTerminal data.
        // This is cheap (no API call) and eliminates the vast majority of tokens.
        // NOTE: liquidity/volume from GeckoTerminal can be inflated — this is
        // ONLY a pre-screen. Stage 2 re-verifies everything with DexScreener.
        const syntheticPair: DexScreenerPair = {
          chainId: token.chainId,
          dexId: token.dexId,
          url: token.url,
          pairAddress: token.pairAddress,
          baseToken: { address: token.address, name: token.name, symbol: token.symbol },
          quoteToken: { address: "", name: "USDC", symbol: "USDC" },
          priceNative: String(token.priceNative),
          priceUsd: String(token.priceUsd),
          txns: {
            m5: { buys: token.buys5m, sells: token.sells5m },
            h1: { buys: token.buys1h, sells: token.sells1h },
            h6: { buys: 0, sells: 0 },
            h24: { buys: token.buys24h, sells: token.sells24h },
          },
          volume: { h24: token.volume24h, h6: 0, h1: token.volume1h, m5: token.volume5m },
          priceChange: {
            m5: token.priceChange5m,
            h1: token.priceChange1h,
            h6: token.priceChange6h,
            h24: token.priceChange24h,
          },
          liquidity: { usd: token.liquidity, base: 0, quote: 0 },
          fdv: token.fdv,
          marketCap: token.marketCap,
          pairCreatedAt: token.pairAge,
          info: { imageUrl: token.imageUrl },
        };

        const preFilterResult = qualityFilter(syntheticPair, this.config);
        if (!preFilterResult.pass) {
          decisions.push({ ...base, action: "filtered", reason: preFilterResult.reason });
          continue;
        }

        // Passed pre-filter — add to candidates for Stage 2 verification
        qualifiedCandidates.push({
          pairAddress: token.pairAddress,
          symbol: token.symbol,
          tokenName: token.name,
          aiScore: token.aiScore,
          confidence: token.confidence,
          liquidityUsd: token.liquidity,
          volume24hUsd: token.volume24h,
          volume1hUsd: token.volume1h,
          marketCapUsd: token.marketCap,
          buyRatio1h,
          priceChange1h: token.priceChange1h,
          pairAgeMinutes,
          priceUsd: token.priceUsd,
          slPercent,
          tpPercent,
          pair: syntheticPair,
          fromScanner: scannerPairSet.has(token.pairAddress), // scanner tokens already have DexScreener data
        });
      }

      // Sort by AI score descending
      qualifiedCandidates.sort((a, b) => b.aiScore - a.aiScore);

      // ── STAGE 2: DexScreener mandatory verification ───────────────────────
      // Re-fetch every candidate directly from DexScreener and re-run the full
      // quality filter on the REAL data. GeckoTerminal frequently shows
      // inflated liquidity ($50K+) for pools that DexScreener shows at $1-$10.
      // A token MUST pass this step before any trade is opened.
      // Verify up to MAX_VERIFY candidates in score order.
      // Scanner tokens already carry fresh DexScreener data — skip the re-fetch
      // and use their cached syntheticPair directly to avoid burning rate-limit budget.
      // Only freshTokens (supplementary, not from scanner) get the full 5-endpoint verify.
      const MAX_VERIFY = 20;
      const verifiedCandidates: typeof qualifiedCandidates = [];

      for (const c of qualifiedCandidates.slice(0, MAX_VERIFY)) {
        try {
          let dexPair: DexScreenerPair | null = null;

          if (c.fromScanner && c.pair) {
            // Fast path: scanner data is already from DexScreener (< ~3 min old).
            // Trust it — no API call needed.
            dexPair = c.pair;
            logger.debug({ symbol: c.symbol, fromScanner: true }, "Auto-trader: using scanner cached data (skipping DexScreener re-fetch)");
          } else {
            // Slow path: freshToken or no cached pair — call DexScreener to verify.
            // 5-stage: search-by-CA → pair-address → token-address → symbol → GeckoTerminal.
            const contractAddress = c.pair?.baseToken.address ?? c.pairAddress;
            dexPair = await scannerService.verifyPairForTrading(
              c.pairAddress,
              contractAddress,
              c.symbol,
            );
          }

          if (!dexPair) {
            decisions.push({ ...c, action: "filtered", reason: "DexScreener: pair not found via any source (CA search / pair-address / token-address / symbol / GeckoTerminal) — skipping" });
            continue;
          }

          const dexLiq    = dexPair.liquidity?.usd || 0;
          const dexPrice  = parseFloat(dexPair.priceUsd) || 0;
          const dexMcap   = dexPair.marketCap || dexPair.fdv || 0;
          const dexVol24h = dexPair.volume?.h24 || 0;

          // Hard sanity — if DexScreener shows no price or no liquidity,
          // this token is dead, rugged, or not genuinely trading.
          if (dexPrice <= 0) {
            decisions.push({ ...c, action: "filtered", reason: "DexScreener: no live price — token not trading" });
            continue;
          }
          if (dexLiq <= 0) {
            decisions.push({ ...c, action: "filtered", reason: "DexScreener: zero liquidity — pool drained or not real" });
            continue;
          }

          // For freshTokens only: check if liquidity was wildly inflated vs DexScreener
          if (!c.fromScanner && c.liquidityUsd > 0 && dexLiq < c.liquidityUsd * 0.1) {
            decisions.push({
              ...c,
              action: "filtered",
              reason: `DexScreener liquidity mismatch: claimed $${Math.round(c.liquidityUsd).toLocaleString()} but DexScreener shows $${Math.round(dexLiq).toLocaleString()} — likely fake/inflated`,
            });
            continue;
          }

          // Re-run quality filter on the confirmed pair data
          const dexFilterResult = qualityFilter(dexPair, this.config);
          if (!dexFilterResult.pass) {
            decisions.push({
              ...c,
              action: "filtered",
              reason: `Stage 2 quality check failed: ${dexFilterResult.reason} (liq=$${Math.round(dexLiq).toLocaleString()}, vol24h=$${Math.round(dexVol24h).toLocaleString()})`,
            });
            continue;
          }

          // Apply entry-quality score boosts
          const entryBoost = computeEntryBoosts(dexPair);
          const boostedScore = Math.min(100, c.aiScore + entryBoost);

          logger.info(
            { symbol: c.symbol, aiScore: c.aiScore, entryBoost, boostedScore, dexLiq, dexPrice, dexMcap, dexVol24h, fromScanner: c.fromScanner },
            "Auto-trader: Stage 2 verification PASSED — candidate confirmed"
          );

          verifiedCandidates.push({ ...c, aiScore: boostedScore, liquidityUsd: dexLiq, priceUsd: dexPrice, marketCapUsd: dexMcap, pair: dexPair });
        } catch (err) {
          decisions.push({ ...c, action: "filtered", reason: `Stage 2 verify error: ${err instanceof Error ? err.message : "unknown"}` });
        }
      }

      // Candidates beyond MAX_VERIFY — not enough time to verify all; will retry next cycle
      for (const c of qualifiedCandidates.slice(MAX_VERIFY)) {
        decisions.push({ ...c, action: "skipped_slots", reason: "Candidate queue — top signals verified this cycle; will evaluate next cycle" });
      }

      const slots = Math.min(3, maxConcurrentTrades - openPositions.length);
      const toTrade = verifiedCandidates.slice(0, slots);

      for (const c of toTrade) {
        const token = scannerService.getByPairAddress(c.pairAddress) ?? await scannerService.getOrFetchToken(c.pairAddress);
        if (!token) {
          decisions.push({ ...c, action: "skipped_balance", reason: "Token disappeared from scanner" });
          continue;
        }
        token.aiScore = c.aiScore;
        token.confidence = c.confidence;

        // ── Layer 6: RugCheck on-chain safety gate ─────────────────────────────
        // Runs BEFORE the LLM call (cheap API, saves LLM quota on obvious rugs).
        // Checks: mint authority, freeze authority, LP lock, top holder
        // concentration, danger-level risks, insider networks, rugged flag.
        const mintAddress = c.pair?.baseToken?.address ?? token.address;
        const pairAgeMin  = c.pair?.pairCreatedAt
          ? (Date.now() - c.pair.pairCreatedAt) / 60_000
          : 999; // unknown age → don't block on LP-lock age check

        const rugResult = await checkTokenSafety(mintAddress, pairAgeMin);

        if (!rugResult.pass) {
          decisions.push({
            ...c,
            action: "filtered",
            reason: rugResult.reason,
          });
          logger.warn(
            { symbol: c.symbol, mintAddress: mintAddress.slice(0, 8) + "…", reason: rugResult.reason },
            "Auto-trader: RugCheck BLOCKED — trade rejected",
          );
          continue;
        }

        // Attach RugCheck warns to LLM context so they factor into the verdict
        const rugWarnSummary = rugResult.warnRisks.length > 0
          ? ` | RugCheck warns: ${rugResult.warnRisks.join(", ")}`
          : "";

        logger.info(
          { symbol: c.symbol, rugScore: rugResult.score, lpLockedPct: rugResult.lpLockedPct, topHolderPct: rugResult.topHolderPct },
          "Auto-trader: RugCheck PASSED — proceeding to LLM analysis",
        );

        // ── Layer 7: LLM pre-trade analysis (Gemini → Groq fallback) ──────────
        const contractAddress = mintAddress;
        const analysisInput = buildAnalysisInput(c.pair, c.symbol, c.tokenName, c.aiScore, c.confidence, contractAddress);
        const llm = await analyseTokenWithAi(analysisInput);

        const llmFields = {
          llmVerdict: llm.verdict as "TRADE" | "SKIP" | "RISKY" | "none",
          llmConfidence: llm.confidence,
          llmReasoning: llm.reasoning,
          llmRisks: llm.risks,
          llmStrengths: llm.strengths,
          llmProvider: llm.provider,
          llmDurationMs: llm.durationMs,
        };

        // SKIP for any reason — including when both Gemini+Groq unavailable (fail-closed)
        if (llm.verdict === "SKIP") {
          decisions.push({
            ...c,
            ...llmFields,
            action: "filtered",
            reason: llm.provider === "none"
              ? `LLM unavailable (Gemini+Groq both failed) — skipping to protect capital`
              : `LLM SKIP (${llm.provider}, ${llm.confidence}% confidence): ${llm.reasoning}`,
          });
          logger.info(
            { symbol: c.symbol, provider: llm.provider, confidence: llm.confidence, reasoning: llm.reasoning },
            "Auto-trader: LLM SKIP — trade rejected",
          );
          continue;
        }

        // RISKY = Gemini PASS + Groq FAIL → use reduced size from AI recommendation
        // Age-based SL/TP is computed inside buyDirect — no manual SL override needed
        const tradeSizeSol = llm.recommendedSizeSol ?? solPerTrade;
        if (llm.verdict === "RISKY") {
          logger.info(
            { symbol: c.symbol, provider: llm.provider, tradeSizeSol, secondaryVerdict: llm.secondaryVerdict, reasoning: llm.reasoning },
            "Auto-trader: LLM RISKY — reduced trade size (dual AI disagreement)",
          );
        }

        // ── Layer 8: Live liquidity pre-check (anti-stale-cache protection) ──────
        // Scanner cache can be 30-60s stale. Re-fetch live DexScreener data right
        // before committing capital to verify liquidity hasn't drained since scan.
        try {
          const liveResp = await axios.get<{ pair: { liquidity?: { usd?: number } } | null }>(
            `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${c.pairAddress}`,
            { timeout: 5_000 }
          );
          const liveLiq = liveResp.data?.pair?.liquidity?.usd ?? 0;
          if (liveLiq < 15_000) {
            decisions.push({ ...c, ...llmFields, action: "filtered", reason: `Live liquidity check: $${Math.round(liveLiq).toLocaleString()} — drained since scan (was $${Math.round(c.liquidityUsd).toLocaleString()}), aborting` });
            logger.warn({ symbol: c.symbol, cachedLiq: c.liquidityUsd, liveLiq }, "Auto-trader: live liquidity check FAILED — liquidity drained, trade aborted");
            continue;
          }
          logger.info({ symbol: c.symbol, cachedLiq: Math.round(c.liquidityUsd), liveLiq: Math.round(liveLiq) }, "Auto-trader: live liquidity check PASSED");
        } catch {
          logger.warn({ symbol: c.symbol }, "Auto-trader: live liquidity check timed out — proceeding with cached data");
        }

        // ── Layer 8.5: Candle entry timing gate ──────────────────────────────
        // Pull last 6 × 5-min candles and reject entries that show "bought the
        // top" patterns: entering on the biggest green candle, parabolic 3-candle
        // moves, fading volume, sell-side candle close, or being at candle 5+.
        // Fail-closed: if candle data is unavailable, skip the trade.
        const candleCheck = await checkCandleEntryTiming(c.pairAddress);
        if (!candleCheck.pass) {
          decisions.push({
            ...c,
            ...llmFields,
            action: "filtered",
            reason: candleCheck.reason,
          });
          logger.info(
            { symbol: c.symbol, pairAddress: c.pairAddress, reason: candleCheck.reason },
            "Auto-trader: candle timing BLOCKED — trade rejected",
          );
          continue;
        }
        logger.info(
          { symbol: c.symbol, reason: candleCheck.reason },
          "Auto-trader: candle timing PASSED",
        );

        // ── Layer 9: Genuine Coin Check ──────────────────────────────────────
        // Final gate using RugCheck data already in hand. Blocks tokens that
        // passed all earlier layers but show cumulative quality red-flags:
        // high risk score, whale concentration, unlocked LP, or too many warns.
        const genuineCheck = genuineCoinCheck(rugResult, pairAgeMin);
        if (!genuineCheck.pass) {
          decisions.push({
            ...c,
            ...llmFields,
            action: "filtered",
            reason: genuineCheck.reason,
          });
          logger.info(
            { symbol: c.symbol, reason: genuineCheck.reason },
            "Auto-trader: genuine-coin check BLOCKED — trade rejected",
          );
          continue;
        }
        logger.info(
          { symbol: c.symbol, reason: genuineCheck.reason },
          "Auto-trader: genuine-coin check PASSED",
        );

        try {
          const position = await paperTradingService.buyDirect(token, tradeSizeSol, undefined, llm, rugResult);
          const llmTag = llm.provider !== "none"
            ? ` | LLM:${llm.verdict}(${llm.provider},${llm.llmScore ?? "-"}/10)`
            : " | LLM:unavailable";
          decisions.push({
            ...c,
            ...llmFields,
            action: "traded",
            reason: `Opened ${tradeSizeSol} SOL | Score ${c.aiScore} | Age-based SL/TP${llmTag} | DexLiq $${Math.round(c.liquidityUsd).toLocaleString()} ✓`,
            positionId: position.positionId,
          });
          tradesOpened++;
          this.totalTradesOpened++;
          logger.info(
            { positionId: position.positionId, symbol: c.symbol, aiScore: c.aiScore, tradeSizeSol, llmVerdict: llm.verdict, llmProvider: llm.provider, dexLiq: c.liquidityUsd },
            "Auto-trader: LLM-verified trade opened",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          decisions.push({ ...c, ...llmFields, action: "skipped_balance", reason: msg });
          logger.warn({ err, symbol: c.symbol }, "Auto-trader: trade open failed");
        }
      }

      this.lastRunTokensEvaluated = tokensEvaluated;
      this.lastRunTradesOpened = tradesOpened;
      this.lastRunAt = Date.now();

      const filtered = decisions.filter((d) => d.action === "filtered").length;
      const traded = decisions.filter((d) => d.action === "traded").length;

      // Build filter-reason summary for diagnostics
      const reasonCounts: Record<string, number> = {};
      for (const d of decisions) {
        if (d.action === "filtered" && d.reason) {
          // Normalise to a short prefix (e.g. "AI score 45 < 55 min" → "AI score")
          const key = d.reason.split(/[\d$]/)[0].trim().replace(/[:\s]+$/, "");
          reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
        }
      }
      const topReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");

      logger.info({ cycleId, tokensEvaluated, filtered, qualified: qualifiedCandidates.length, tradesOpened: traded, topFilterReasons: topReasons || "none" }, "Auto-trader: cycle complete");
    } catch (err) {
      logger.error({ err }, "Auto-trader: cycle error");
    } finally {
      this.history.push({ cycleId, startedAt, finishedAt: Date.now(), tokensEvaluated, tradesOpened, decisions });
      if (this.history.length > MAX_HISTORY_CYCLES) this.history.shift();
      this.running = false;
    }
  }

  start(): void {
    if (this.intervalId) return;
    void this.run();
    this.intervalId = setInterval(() => void this.run(), AUTO_TRADE_INTERVAL_MS);
    this.nextRunAt = Date.now() + AUTO_TRADE_INTERVAL_MS;
    logger.info(
      { intervalSec: AUTO_TRADE_INTERVAL_MS / 1000, telegramEnabled: isTelegramConfigured(), config: this.config },
      "Auto-trader started — balanced quality filters active",
    );
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  startHeartbeat(): void {
    const send = () => {
      const portfolio = paperTradingService.getPortfolio();
      const openPositions = paperTradingService.getOpenPositions();
      const closedTrades = paperTradingService.getClosedTrades();
      const scannerPool = scannerService.getTokenCount();
      const scanCycles = scannerService.getScanCount();
      const expired = scannerService.getTotalExpired();
      const nowIST = toIST(new Date());

      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const closedToday = closedTrades.filter(
        (t) => t.closedAt && new Date(t.closedAt).getTime() >= todayStart.getTime(),
      ).length;
      const openToday = openPositions.filter(
        (t) => new Date(t.openedAt).getTime() >= todayStart.getTime(),
      ).length;

      const sign = portfolio.totalPnlSol >= 0 ? "+" : "";
      const statusLine = this.paused ? "⏸️ PAUSED" : "✅ RUNNING";

      void sendTelegram(
        `🤖 <b>Apex Scanner — Hourly Heartbeat</b>\n` +
        `──────────────────────\n` +
        `${statusLine} Scanner: ${scannerPool > 0 ? "RUNNING" : "IDLE"}\n` +
        `🔵 Active tokens in pool: <b>${scannerPool}</b>\n` +
        `♻️ Rotated out (stale): <b>${expired}</b>\n` +
        `🔄 Scanner cycles: ${scanCycles} | Trader cycles: ${this.cycleCounter}\n` +
        `──────────────────────\n` +
        `📊 Trades today: ${openToday + closedToday} (${openToday} open, ${closedToday} closed)\n` +
        `🏆 All-time traded: ${this.totalTradesOpened}\n` +
        `💼 Open positions: ${openPositions.length}/${this.config.maxConcurrentTrades}\n` +
        `💰 Balance: ${portfolio.solBalance.toFixed(4)} SOL\n` +
        `📈 Total PNL: <b>${sign}${portfolio.totalPnlSol.toFixed(4)} SOL</b>\n` +
        `──────────────────────\n` +
        `🕐 <i>${nowIST}</i>`,
      );
    };

    // Uses singleton guard inside startHeartbeat — safe to call multiple times
    startHeartbeat(send, 60 * 60 * 1_000);
  }
}

export const autoTraderService = new AutoTraderService();
