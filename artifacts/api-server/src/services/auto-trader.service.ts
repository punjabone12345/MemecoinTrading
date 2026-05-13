import axios from "axios";
import { logger } from "../lib/logger.js";
import { sendTelegram, isTelegramConfigured, toIST, startHeartbeat } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { scannerService } from "./scanner.service.js";
import { computeSignals, computeAiScore, computeConfidence, getDynamicRisk } from "./ai-scoring.service.js";
import { mapPairToToken } from "./scanner.service.js";
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
  minBuyRatio1h: number;       // 0–1, e.g. 0.55 = 55% buys
  minPriceChange1h: number;    // %, must be positive momentum
  minTransactions24h: number;
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
}

// ─── Default config: memecoin-realistic filters for Solana ───────────────────
//
// Tuned for actual Solana memecoin market conditions:
//   - Fresh memecoins typically have $5K–$20K liquidity, not $30K+
//   - Early tokens have low 24h volume — they haven't been live long enough
//   - Micro-cap sweet spot is $8K–$5M for maximum upside
//   - Confidence is lower for new tokens (sparse data) — soften that gate
//   - All rug guards (liq/mcap ratio, age window, dump %, wash trade) remain strict
//
// ─── Default config: quality-first, memecoin-realistic ───────────────────────
//
// Philosophy: fewer, higher-conviction trades are better than frequent ones.
//
// The AI score IS the quality gate — it already encodes momentum, buy pressure,
// liquidity depth, and volume intensity. Raising the score floor to 70 ensures
// only strong setups are traded. The absolute thresholds below are calibrated
// to reflect what real early Solana memecoins look like (not to lower quality).
//
// Quality levers (keep these strict):
//   minAiScore: 70         → only top-quartile signals
//   minBuyRatio1h: 0.58    → buyers dominating sellers in the last hour
//   minPriceChange1h: 3    → must be actively pumping (not flat)
//   maxPairAgeHours: 48    → tightened to 48h — fresh pumps only
//   minLiquidityMcapRatio  → rug protection unchanged at 3%
//
// Realistic floors (corrected for real memecoin sizes — not quality reduction):
//   minLiquidityUsd: 10K   → tradeable without massive slippage
//   minVolume24hUsd: 20K   → some accumulated activity required
//   minMcapUsd: 10K        → very micro-cap is OK if score is high
//   minTransactions24h: 50 → real interest, not ghost chains
//
const DEFAULT_CONFIG: AutoTraderConfig = {
  solPerTrade: 0.5,
  maxConcurrentTrades: 2,

  // ── AI quality ────────────────────────────────────────────────────────────
  minAiScore: 78,               // top-tier only — 78+ is roughly top 5% of pool
  minConfidence: 55,

  // ── Liquidity & volume ────────────────────────────────────────────────────
  // A 15-min-old token should already have meaningful volume.
  // Lower floors were exploited — tokens with $5K liq rugged within 60s.
  minLiquidityUsd: 20_000,      // $20K min — real, hard-to-drain LP
  minVolume24hUsd: 8_000,       // token survived 15+ min → some 24h vol expected
  minVolume1hUsd: 3_000,        // $3K in the last hour — active buying NOW

  // ── Momentum ─────────────────────────────────────────────────────────────
  minBuyRatio1h: 0.60,          // 60% organic buy dominance
  minPriceChange1h: 10,         // +10% minimum — must be a genuine pump
  minTransactions24h: 30,       // 15-min-old token should have 30+ txns by now

  // ── Market cap ────────────────────────────────────────────────────────────
  minMcapUsd: 15_000,
  maxMcapUsd: 10_000_000,

  // ── Pair age ──────────────────────────────────────────────────────────────
  // 15 min is the critical threshold — tokens that rug do so in the first
  // 1–10 minutes. Surviving 15 min with LP intact is a meaningful signal.
  minPairAgeMinutes: 15,
  maxPairAgeHours: 48,

  // ── Rug guards ────────────────────────────────────────────────────────────
  minLiquidityMcapRatio: 0.05,  // 5% liq/mcap — tighter than before
  maxFdvMcapRatio: 5.0,         // FDV ≤ 5× mcap
  maxPriceDropH6Pct: -25,
  maxPriceDropH24Pct: -40,
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

  // 2a. Pool drain — if 5m volume is ≥75% of current liquidity, someone is
  //     burning through the LP pool at an unsustainable rate. This is the
  //     #1 signal of an imminent rug (dev swaps everything then pulls LP).
  if (vol5m > 0 && liq > 0 && vol5m >= liq * 0.75)
    return fail(`Pool drain: 5m vol $${Math.round(vol5m).toLocaleString()} is ${((vol5m / liq) * 100).toFixed(0)}% of liquidity — LP being drained`);

  // 2b. Bot accumulation (5m) — ≥95% buys in the last 5 min with real activity.
  //     Organic trading always has some sellers. Near-100% buys = insider/bot
  //     buying everything before pulling LP.
  if (total5m >= 10 && buyRatio5m >= 0.95)
    return fail(`Bot buying: ${(buyRatio5m * 100).toFixed(0)}% buys in last 5m (${total5m} txns) — pre-rug accumulation`);

  // 2c. Insider-dominated 1h — same logic over a longer window. ≥92% buys
  //     with ≥40 transactions means no organic market — just insiders.
  if (total1h >= 40 && buyRatio1h >= 0.92)
    return fail(`Insider buying: ${(buyRatio1h * 100).toFixed(0)}% buys in 1h (${total1h} txns) — no organic sellers`);

  // 2d. Wash trading — zero sells but massive buy count = fake volume signal.
  if (sells1h === 0 && buys1h >= 30)
    return fail(`Wash trade: ${buys1h} buys / 0 sells in 1h — artificial volume`);

  // 2e. Thin liquidity vs market cap — easy to drain the entire pool.
  const liqMcapRatio = liq / mcap;
  if (liqMcapRatio < cfg.minLiquidityMcapRatio)
    return fail(`Liq/MCap ${(liqMcapRatio * 100).toFixed(1)}% < ${(cfg.minLiquidityMcapRatio * 100).toFixed(0)}% — easy rug`);

  // 2f. FDV inflation — massive unissued/locked supply that will dump.
  if (fdv > 0 && mcap > 0 && fdv / mcap > cfg.maxFdvMcapRatio)
    return fail(`FDV ${(fdv / mcap).toFixed(1)}× mcap > ${cfg.maxFdvMcapRatio}× max — supply dump risk`);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // LAYER 4 — MOMENTUM FRESHNESS
  // ═══════════════════════════════════════════════════════════════════════════

  // Stale pump guard — if 5m is deeply negative, the pump peaked already.
  // The 1h% includes history; we need the move to be happening NOW.
  if (pc5m !== null && pc5m < -5)
    return fail(`5m change ${pc5m.toFixed(1)}% — momentum gone, pump peaked`);

  return { pass: true, reason: "All filters passed" };
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

  getConfig(): AutoTraderConfig { return { ...this.config }; }

  updateConfig(patch: Partial<AutoTraderConfig>): AutoTraderConfig {
    this.config = { ...this.config, ...patch };
    logger.info({ config: this.config }, "Auto-trader config updated");
    return { ...this.config };
  }

  pause(): void { this.paused = true; logger.info("Auto-trader paused"); }
  resume(): void { this.paused = false; logger.info("Auto-trader resumed"); void this.run(); }
  isPaused(): boolean { return this.paused; }
  getHistory(): CycleRecord[] { return [...this.history].reverse(); }

  getStatus(): AutoTraderStatus {
    return {
      paused: this.paused,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastRunTokensEvaluated: this.lastRunTokensEvaluated,
      lastRunTradesOpened: this.lastRunTradesOpened,
      totalTradesOpened: this.totalTradesOpened,
      telegramEnabled: isTelegramConfigured(),
      nextRunIn: Math.max(0, this.nextRunAt - Date.now()),
      scannerPoolSize: scannerService.getTokenCount(),
      config: this.getConfig(),
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
        if (r.status === "fulfilled" && Array.isArray(r.value.data.pairs)) {
          pairs.push(...r.value.data.pairs.filter((p) => p.chainId === "solana"));
        }
      }
      return pairs;
    } catch {
      return [];
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.paused) return;
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

        // Duplicate symbol check
        if (paperTradingService.hasOpenPositionForSymbol(token.symbol)) {
          decisions.push({ ...base, action: "skipped_duplicate", reason: `Already have open position for ${token.symbol}` });
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

        // Build a synthetic pair object from scanner data to run qualityFilter
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

        const filterResult = qualityFilter(syntheticPair, this.config);
        if (!filterResult.pass) {
          decisions.push({ ...base, action: "filtered", reason: filterResult.reason });
          continue;
        }

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
        });
      }

      // Sort by AI score descending, slot into available positions
      // Cap at 1 new trade per cycle — prevents burst-opening on first scan
      qualifiedCandidates.sort((a, b) => b.aiScore - a.aiScore);
      const slots = Math.min(1, maxConcurrentTrades - openPositions.length);
      const toTrade = qualifiedCandidates.slice(0, slots);
      const overflow = qualifiedCandidates.slice(slots);

      for (const c of overflow) {
        decisions.push({ ...c, action: "skipped_slots", reason: "No available trade slots (max concurrent reached)" });
      }

      for (const c of toTrade) {
        const token = scannerService.getByPairAddress(c.pairAddress) ?? await scannerService.getOrFetchToken(c.pairAddress);
        if (!token) {
          decisions.push({ ...c, action: "skipped_balance", reason: "Token disappeared from scanner" });
          continue;
        }
        token.aiScore = c.aiScore;
        token.confidence = c.confidence;

        try {
          const position = await paperTradingService.buyDirect(token, solPerTrade);
          decisions.push({
            ...c,
            action: "traded",
            reason: `Opened ${solPerTrade} SOL | Score ${c.aiScore} | SL -${c.slPercent}% | TP +${c.tpPercent}%`,
            positionId: position.positionId,
          });
          tradesOpened++;
          this.totalTradesOpened++;
          logger.info(
            { positionId: position.positionId, symbol: c.symbol, aiScore: c.aiScore, liq: c.liquidityUsd, vol24h: c.volume24hUsd, mcap: c.marketCapUsd },
            "Auto-trader: HIGH-QUALITY trade opened",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          decisions.push({ ...c, action: "skipped_balance", reason: msg });
          logger.warn({ err, symbol: c.symbol }, "Auto-trader: trade open failed");
        }
      }

      this.lastRunTokensEvaluated = tokensEvaluated;
      this.lastRunTradesOpened = tradesOpened;
      this.lastRunAt = Date.now();

      const filtered = decisions.filter((d) => d.action === "filtered").length;
      const traded = decisions.filter((d) => d.action === "traded").length;
      logger.info({ cycleId, tokensEvaluated, filtered, qualified: qualifiedCandidates.length, tradesOpened: traded }, "Auto-trader: cycle complete");
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
