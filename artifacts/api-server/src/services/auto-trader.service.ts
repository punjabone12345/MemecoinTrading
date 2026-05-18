import axios from "axios";
import { logger } from "../lib/logger.js";
import { sendTelegram, isTelegramConfigured, toIST, startHeartbeat } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { scannerService } from "./scanner.service.js";
import { computeSignals, computeAiScore, computeConfidence, getDynamicRisk } from "./ai-scoring.service.js";
import { mapPairToToken } from "./scanner.service.js";
import { analyseTokenWithAi, buildAnalysisInput } from "./ai-analysis.service.js";
import { checkTokenSafety } from "./rugcheck.service.js";
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
}

// ─── Default config ────────────────────────────────────────────────────────────
const DEFAULT_CONFIG: AutoTraderConfig = {
  solPerTrade: 0.5,
  maxConcurrentTrades: 3,

  // ── AI quality ────────────────────────────────────────────────────────────
  minAiScore: 72,               // raised: only high-conviction entries
  minConfidence: 65,            // raised: need solid data quality

  // ── Liquidity & volume ────────────────────────────────────────────────────
  minLiquidityUsd:  30_000,     // raised $15K→$30K: deeper pools are much harder to rug
  minVolume24hUsd:  15_000,     // raised: ensures real organic trading history
  minVolume1hUsd:   5_000,      // raised: strong activity happening RIGHT NOW

  // ── Momentum ─────────────────────────────────────────────────────────────
  minBuyRatio1h:    0.68,       // raised: stronger buy conviction required
  minPriceChange1h: 8,          // raised: needs meaningful momentum, not just +5%
  minTransactions24h: 80,       // raised: more activity = more organic market

  // ── Market cap sweet spot ────────────────────────────────────────────────
  minMcapUsd:  30_000,          // raised: avoid dust/fake micro-caps
  maxMcapUsd: 400_000,          // $400K ceiling — still has 10-50x potential

  // ── Pair age ──────────────────────────────────────────────────────────────
  minPairAgeMinutes: 10,        // raised 5→10 min: survive the highest-risk early window
  maxPairAgeHours:   6,         // 6h max — fresh tokens only

  // ── Rug guards ────────────────────────────────────────────────────────────
  minLiquidityMcapRatio: 0.18,  // raised 12%→18%: stronger pool backing required
  maxFdvMcapRatio:       6.0,   // tightened 8→6: less unlocked supply overhang allowed
  maxPriceDropH6Pct:   -15,     // tightened: reject anything down >15% in 6h
  maxPriceDropH24Pct:  -25,     // tightened: reject anything down >25% in 24h
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

  // 2a. Pool drain — extreme volume spike in 5m relative to liquidity.
  //     Lowered threshold: even 1.5× is dangerous (was 2×).
  const drainRatio = liq > 0 ? vol5m / liq : 0;
  if (vol5m > 0 && liq > 0) {
    if (drainRatio >= 1.5)
      return fail(`Pool drain: 5m vol $${Math.round(vol5m).toLocaleString()} is ${(drainRatio * 100).toFixed(0)}% of liquidity — LP being drained`);
    // Any drain WITH falling price = selling into LP
    if (drainRatio >= 0.5 && (pc5m !== null && pc5m < -3))
      return fail(`Pool drain + dump: 5m vol ${(drainRatio * 100).toFixed(0)}% of LP and price down ${pc5m?.toFixed(1)}% — LP being drained`);
  }

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

  // 2g. Absolute liquidity floor — pools under $20K are trivially drained
  //     even if they technically pass the liq/mcap ratio check.
  if (liq < 20_000)
    return fail(`Absolute liquidity $${Math.round(liq).toLocaleString()} < $20K — too thin to exit safely`);

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

  // Volume/Liquidity ratio: too low = ghost token, too high = wash/fake volume
  const volLiqRatio = liq > 0 && vol1h > 0 ? vol1h / liq : 0;
  if (vol1h > 0 && liq > 0) {
    if (volLiqRatio < 0.3)
      return fail(`Vol/Liq ${volLiqRatio.toFixed(2)}x < 0.3x — not enough real interest relative to pool size`);
    if (volLiqRatio > 8)
      return fail(`Vol/Liq ${volLiqRatio.toFixed(1)}x > 8x — likely wash/fake volume manipulation`);
  }

  // Minimum recent buy transactions in 5m (proxy for unique buyers in window)
  // Only apply after 10m to avoid rejecting brand-new launches
  if (ageMin > 10 && total5m > 0 && buys5m < 5)
    return fail(`Only ${buys5m} buy txns in last 5m — insufficient buyer activity (need ≥5)`);

  // Volume growth: 5m pace vs 1h baseline
  // If 5m annualised is < 25% of 1h volume, momentum is clearly dying
  if (vol5m > 0 && vol1h > 0 && ageMin > 20) {
    const pacedHourlyVol = vol5m * 12;
    if (pacedHourlyVol < vol1h * 0.25)
      return fail(`Volume fading: 5m pace ~$${Math.round(pacedHourlyVol).toLocaleString()}/hr vs $${Math.round(vol1h).toLocaleString()}/hr 1h avg — momentum declining`);
  }

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

    // Daily loss cap: if today's cumulative loss >= 2 SOL, pause for 24h
    if (this.dailyLossPausedUntil > Date.now()) {
      const resumeInHours = Math.ceil((this.dailyLossPausedUntil - Date.now()) / 3_600_000);
      logger.info({ resumeInHours }, "Auto-trader: skipping cycle — daily loss cap active");
      return;
    }
    const dailyLoss = this.getDailyLoss();
    if (dailyLoss <= -2) {
      this.dailyLossPausedUntil = Date.now() + 24 * 3_600_000;
      logger.warn({ dailyLoss: dailyLoss.toFixed(4) }, "Auto-trader: daily loss cap hit (-2 SOL) — pausing 24h");
      void sendTelegram(
        `🚨 <b>DAILY LOSS CAP HIT</b>\n` +
        `──────────────────────\n` +
        `📉 Today's losses: <b>${dailyLoss.toFixed(4)} SOL</b>\n` +
        `⏸️ Bot auto-paused for 24 hours to protect capital.\n` +
        `🔔 Resumes at ${toIST(new Date(this.dailyLossPausedUntil))}`,
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

        // Passed pre-filter — add to candidates for DexScreener verification
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

      // Sort by AI score descending
      qualifiedCandidates.sort((a, b) => b.aiScore - a.aiScore);

      // ── STAGE 2: DexScreener mandatory verification ───────────────────────
      // Re-fetch every candidate directly from DexScreener and re-run the full
      // quality filter on the REAL data. GeckoTerminal frequently shows
      // inflated liquidity ($50K+) for pools that DexScreener shows at $1-$10.
      // A token MUST pass this step before any trade is opened.
      // We check up to 5 candidates in score order and stop at the first winner.
      const MAX_VERIFY = 5;
      const verifiedCandidates: typeof qualifiedCandidates = [];

      for (const c of qualifiedCandidates.slice(0, MAX_VERIFY)) {
        try {
          // 5-stage verification: search-by-CA → pair-address → token-address →
          // symbol-search → GeckoTerminal. Prioritises Raydium, validates liq/vol.
          // Only truly rejects a token if ALL 5 sources return nothing valid.
          const contractAddress = c.pair.baseToken.address;
          const dexPair = await scannerService.verifyPairForTrading(
            c.pairAddress,
            contractAddress,
            c.symbol,
          );

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

          // Extra intelligence: warn if scanner data was wildly off (rug signal)
          const liqRatio = c.liquidityUsd > 0 ? dexLiq / c.liquidityUsd : 0;
          if (c.liquidityUsd > 0 && dexLiq < c.liquidityUsd * 0.1) {
            // DexScreener shows <10% of what scanner claimed → data fabrication
            decisions.push({
              ...c,
              action: "filtered",
              reason: `DexScreener liquidity mismatch: scanner claimed $${Math.round(c.liquidityUsd).toLocaleString()} but DexScreener shows $${Math.round(dexLiq).toLocaleString()} — likely fake/inflated`,
            });
            continue;
          }

          // Run the full quality filter on the REAL DexScreener pair
          const dexFilterResult = qualityFilter(dexPair, this.config);
          if (!dexFilterResult.pass) {
            decisions.push({
              ...c,
              action: "filtered",
              reason: `DexScreener verify failed: ${dexFilterResult.reason} (dexLiq=$${Math.round(dexLiq).toLocaleString()}, dexVol24h=$${Math.round(dexVol24h).toLocaleString()})`,
            });
            continue;
          }

          logger.info(
            { symbol: c.symbol, aiScore: c.aiScore, dexLiq, dexPrice, dexMcap, dexVol24h },
            "Auto-trader: DexScreener verification PASSED — candidate confirmed"
          );

          verifiedCandidates.push({ ...c, liquidityUsd: dexLiq, priceUsd: dexPrice, marketCapUsd: dexMcap, pair: dexPair });
          break; // We only need 1 verified candidate per cycle (1-trade-per-cycle cap)
        } catch (err) {
          decisions.push({ ...c, action: "filtered", reason: `DexScreener verify error: ${err instanceof Error ? err.message : "unknown"}` });
        }
      }

      // Remaining pre-filter qualifiers that we didn't verify (no slots or beyond MAX_VERIFY)
      for (const c of qualifiedCandidates.slice(verifiedCandidates.length + (qualifiedCandidates.length > MAX_VERIFY ? MAX_VERIFY : qualifiedCandidates.length))) {
        decisions.push({ ...c, action: "skipped_slots", reason: "No available trade slots (max concurrent reached)" });
      }

      const slots = Math.min(1, maxConcurrentTrades - openPositions.length);
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

        try {
          const position = await paperTradingService.buyDirect(token, tradeSizeSol, undefined, llm);
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
