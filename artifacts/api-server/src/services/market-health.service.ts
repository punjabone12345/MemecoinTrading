import { logger } from "../lib/logger.js";
import { scannerService } from "./scanner.service.js";
import { sendTelegram } from "../lib/telegram.js";

export type MarketState = "ACTIVE" | "NEUTRAL" | "DEAD";

export interface MarketConditions {
  positiveTokensPassed: boolean;
  positiveTokensCount: number;
  avgBuyRatioPassed: boolean;
  avgBuyRatio: number;
  recentPairsPassed: boolean;
  recentPairsCount: number;
}

export interface MarketHealthResult {
  state: MarketState;
  conditions: MarketConditions;
  passCount: number;
  checkedAt: number;
  poolSize: number;
}

const CHECK_INTERVAL_MS = 30 * 60 * 1_000;
const DEAD_RECHECK_MS   = 45 * 60 * 1_000;
const TOP_N             = 20;
const TWO_HOURS_MS      = 2 * 60 * 60 * 1_000;
const MIN_POOL_SIZE     = 10;

class MarketHealthService {
  private lastResult: MarketHealthResult | null = null;
  private lastCheckedAt = 0;

  getLastResult(): MarketHealthResult | null { return this.lastResult; }

  isCheckDue(): boolean {
    if (!this.lastResult) return true;
    // If the last check fired when the pool was too small (startup/deploy scenario),
    // re-run as soon as the pool has grown enough — don't wait the full 30 min.
    if (this.lastResult.poolSize < MIN_POOL_SIZE) {
      return scannerService.getAll().length >= MIN_POOL_SIZE;
    }
    const interval = this.lastResult.state === "DEAD" ? DEAD_RECHECK_MS : CHECK_INTERVAL_MS;
    return Date.now() - this.lastCheckedAt >= interval;
  }

  runCheck(): MarketHealthResult {
    const allTokens = scannerService.getAll();

    if (allTokens.length < MIN_POOL_SIZE) {
      const result: MarketHealthResult = {
        state: "NEUTRAL",
        conditions: {
          positiveTokensPassed: false, positiveTokensCount: 0,
          avgBuyRatioPassed: false,    avgBuyRatio: 0,
          recentPairsPassed: false,    recentPairsCount: 0,
        },
        passCount: 0,
        checkedAt: Date.now(),
        poolSize: allTokens.length,
      };
      this.lastResult = result;
      this.lastCheckedAt = Date.now();
      logger.info({ poolSize: allTokens.length }, "Market health: pool too small — defaulting NEUTRAL");
      return result;
    }

    const top20 = [...allTokens].sort((a, b) => b.aiScore - a.aiScore).slice(0, TOP_N);

    // Condition 1: tokens with positive 1h price change — >12 = PASS, <8 = FAIL
    const positiveCount = top20.filter(t => t.priceChange1h > 0).length;
    const c1Passed = positiveCount > 12;

    // Condition 2: average buy ratio across top 20 — >0.60 = PASS, <0.55 = FAIL
    const avgBuyRatio = top20.reduce((s, t) => {
      const total = t.buys1h + t.sells1h;
      return s + (total > 0 ? t.buys1h / total : 0.5);
    }, 0) / top20.length;
    const c2Passed = avgBuyRatio > 0.60;

    // Condition 3: pairs created in last 2 hours (proxy for pump.fun graduates)
    const twoHoursAgo = Date.now() - TWO_HOURS_MS;
    const recentPairsCount = allTokens.filter(t => t.pairAge > 0 && t.pairAge >= twoHoursAgo).length;
    const c3Passed = recentPairsCount > 15;

    const passCount = [c1Passed, c2Passed, c3Passed].filter(Boolean).length;

    let state: MarketState;
    if (passCount >= 3)      state = "ACTIVE";
    else if (passCount >= 2) state = "NEUTRAL";
    else                     state = "DEAD";

    const result: MarketHealthResult = {
      state,
      conditions: {
        positiveTokensPassed: c1Passed, positiveTokensCount: positiveCount,
        avgBuyRatioPassed:    c2Passed, avgBuyRatio,
        recentPairsPassed:    c3Passed, recentPairsCount,
      },
      passCount,
      checkedAt: Date.now(),
      poolSize: allTokens.length,
    };

    const prevState = this.lastResult?.state;
    this.lastResult = result;
    this.lastCheckedAt = Date.now();

    logger.info(
      {
        state, passCount,
        c1_positive: `${positiveCount}/${TOP_N}`,
        c2_buyRatio: avgBuyRatio.toFixed(2),
        c3_recent2h: recentPairsCount,
        poolSize:    allTokens.length,
      },
      `Market health check: ${state} (${passCount}/3 conditions)`,
    );

    if (prevState !== state) {
      const emoji = state === "ACTIVE" ? "🟢" : state === "NEUTRAL" ? "🟡" : "🔴";
      void sendTelegram(
        `${emoji} <b>Market Health Changed: ${state}</b>\n` +
        `──────────────────────\n` +
        `📊 Conditions passed: <b>${passCount}/3</b>\n` +
        `📈 Positive 1h (>${TOP_N * 0.6} req): <b>${positiveCount}/${TOP_N}</b> ${c1Passed ? "✅" : "❌"}\n` +
        `💰 Avg Buy Ratio (>60% req): <b>${(avgBuyRatio * 100).toFixed(0)}%</b> ${c2Passed ? "✅" : "❌"}\n` +
        `🚀 Recent pairs 2h (>15 req): <b>${recentPairsCount}</b> ${c3Passed ? "✅" : "❌"}\n` +
        `${state === "DEAD" ? "⏸️ New entries paused. Rechecking in 45 min.\n" : ""}` +
        `${state === "NEUTRAL" ? "⚠️ Quality raised: MinScore+5, MinVol1h+50%, Max 2 trades\n" : ""}` +
        `${state === "ACTIVE" ? "✅ Trading normally.\n" : ""}`,
      );
    }

    return result;
  }
}

export const marketHealthService = new MarketHealthService();
