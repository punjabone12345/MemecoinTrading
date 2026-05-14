import type { DexScreenerPair, TokenSignals } from "../types/index.js";

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Score 0–100 using 6 components.
 *
 * Core philosophy: reward EARLY-stage momentum, not late/topped pumps.
 * A token that pumped 500% in 1h is almost certainly in distribution.
 * A token up 20% in 1h but still up 8% in the last 5m is just getting started.
 *
 *  Component                     Max   Notes
 *  ─────────────────────────────────────────────────────────────────────
 *  Entry timing (early vs late)   30   Is the pump JUST starting? Best signal.
 *  Buy/sell ratio 1h              20   Demand vs supply pressure
 *  Liquidity depth                15   Safety / exit-ability
 *  Volume intensity (vol/mcap)    20   Real trading activity
 *  Mcap sweet spot                15   Upside potential
 *  ─────────────────────────────────────────────────────────────────────
 *  Total                         100
 *
 * Entry timing explained:
 *   - We want tokens where momentum is FRESH: 5m is strong relative to 1h.
 *   - If 1h is huge (>100%) but 5m is flat/negative → already pumped, distribution.
 *   - If 1h is moderate (10-50%) and 5m is also positive and healthy → early stage.
 *   - If both 5m and 1h are strongly positive → confirmed uptrend.
 *   - Hard cap: if 1h > 300% → max timing score capped at 12 (likely too late).
 */
export function computeSignals(pair: DexScreenerPair): TokenSignals {
  const pc1h = pair.priceChange?.h1 ?? 0;
  const pc5m = pair.priceChange?.m5 ?? 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const total1h = buys1h + sells1h;
  const liq = pair.liquidity?.usd || 0;
  const vol1hRaw = pair.volume?.h1 || 0;
  const vol24h = pair.volume?.h24 || 0;
  const effectiveVol1h = vol1hRaw > 0 ? vol1hRaw : vol24h / 24;
  const marketCap = pair.marketCap || pair.fdv || 0;

  // ── 1. Entry timing / pump stage (max 30 pts) ─────────────────────────────
  // Goal: find tokens where momentum is STARTING, not ENDING.
  //
  // Best signals (early pump):
  //   • 5m is positive AND strong relative to 1h
  //   • 1h is moderate (not already exhausted)
  //   • Both timeframes agree on direction
  //
  // Worst signals (late pump):
  //   • 1h already up huge (>150%) but 5m is flat or negative
  //   • Classic distribution: retail latecomers while early buyers exit
  let timingScore = 0;

  // Case 1: Already pumped massively in 1h with stalling/negative 5m → LATE, penalise hard
  if (pc1h > 300 && pc5m < 5) {
    timingScore = 4;  // nearly dead signal — likely distributing
  } else if (pc1h > 150 && pc5m < 0) {
    timingScore = 6;  // pumped hard, now reversing — dangerous entry
  } else if (pc1h > 100 && pc5m < 2) {
    timingScore = 10; // strong 1h pump but momentum stalling
  } else {
    // Normal scoring — reward fresh momentum
    // Base from 1h:
    let base1h = 0;
    if (pc1h >= 50)  base1h = 16;
    else if (pc1h >= 30) base1h = 14;
    else if (pc1h >= 20) base1h = 12;
    else if (pc1h >= 10) base1h = 10;
    else if (pc1h >= 5)  base1h = 7;
    else if (pc1h >= 2)  base1h = 4;
    else if (pc1h >= 0)  base1h = 2;
    else base1h = 0;

    // 5m bonus: is momentum fresh RIGHT NOW?
    let bonus5m = 0;
    if (pc5m >= 15) bonus5m = 14;
    else if (pc5m >= 8)  bonus5m = 11;
    else if (pc5m >= 4)  bonus5m = 8;
    else if (pc5m >= 2)  bonus5m = 5;
    else if (pc5m >= 0)  bonus5m = 2;
    else if (pc5m >= -3) bonus5m = 0;
    else bonus5m = -4; // actively dumping in 5m — big negative signal

    timingScore = clamp(base1h + bonus5m, 0, 30);
  }

  // ── 2. Buy/sell ratio 1h (max 20 pts) ─────────────────────────────────────
  // Higher conviction: need a solid majority of buyers, not just a slim edge
  let buyRatioScore = 0;
  if (total1h > 0) {
    const ratio = buys1h / total1h;
    if (ratio >= 0.82)      buyRatioScore = 20;
    else if (ratio >= 0.72) buyRatioScore = 17;
    else if (ratio >= 0.65) buyRatioScore = 14;
    else if (ratio >= 0.58) buyRatioScore = 11;
    else if (ratio >= 0.52) buyRatioScore = 8;
    else if (ratio >= 0.45) buyRatioScore = 4;
    else                    buyRatioScore = 1;
  }

  // ── 3. Liquidity depth (max 15 pts) ───────────────────────────────────────
  // Higher weight on mid-tier liquidity ($20K-$200K) — deep enough for real trading
  // but not so deep it's already a large-cap. Very thin liquidity (<$10K) is dangerous.
  let liquidityScore = 0;
  if (liq >= 500_000)      liquidityScore = 15;
  else if (liq >= 200_000) liquidityScore = 14;
  else if (liq >= 100_000) liquidityScore = 12;
  else if (liq >= 50_000)  liquidityScore = 10;
  else if (liq >= 25_000)  liquidityScore = 7;
  else if (liq >= 10_000)  liquidityScore = 4;
  else if (liq >= 5_000)   liquidityScore = 1;
  else                     liquidityScore = 0; // dangerous

  // ── 4. Volume intensity: hourly volume / market cap (max 20 pts) ──────────
  // High vol/mcap ratio means the token is trading its entire market cap in an
  // hour — intense interest. This is a strong signal for fresh momentum.
  let volumeMcapScore = 0;
  if (marketCap > 0 && effectiveVol1h > 0) {
    const ratio = effectiveVol1h / marketCap;
    if (ratio >= 1.5)       volumeMcapScore = 20;
    else if (ratio >= 1.0)  volumeMcapScore = 18;
    else if (ratio >= 0.5)  volumeMcapScore = 15;
    else if (ratio >= 0.2)  volumeMcapScore = 12;
    else if (ratio >= 0.1)  volumeMcapScore = 9;
    else if (ratio >= 0.05) volumeMcapScore = 6;
    else if (ratio >= 0.02) volumeMcapScore = 3;
    else                    volumeMcapScore = 1;
  }

  // ── 5. Mcap sweet spot (max 15 pts) ───────────────────────────────────────
  // Target the $100K–$2M range: small enough to 5-10x, large enough to be real.
  // Sub-$50K is either a fresh launch (risky) or a rug remnant.
  let mcapScore = 0;
  if (marketCap >= 200_000 && marketCap <= 1_000_000)       mcapScore = 15;
  else if (marketCap > 1_000_000 && marketCap <= 3_000_000) mcapScore = 12;
  else if (marketCap > 3_000_000 && marketCap <= 8_000_000) mcapScore = 9;
  else if (marketCap > 8_000_000 && marketCap <= 20_000_000) mcapScore = 5;
  else if (marketCap >= 100_000 && marketCap < 200_000)     mcapScore = 11;
  else if (marketCap >= 50_000 && marketCap < 100_000)      mcapScore = 7;
  else if (marketCap > 0 && marketCap < 50_000)             mcapScore = 2;
  else                                                       mcapScore = 0;

  return {
    momentumScore: clamp(timingScore, 0, 30),
    buyRatioScore: clamp(buyRatioScore, 0, 20),
    liquidityScore: clamp(liquidityScore, 0, 15),
    volumeMcapScore: clamp(volumeMcapScore, 0, 20),
    mcapScore: clamp(mcapScore, 0, 15),
  };
}

export function computeAiScore(signals: TokenSignals): number {
  const raw =
    signals.momentumScore +
    signals.buyRatioScore +
    signals.liquidityScore +
    signals.volumeMcapScore +
    signals.mcapScore;
  return Math.round(clamp(raw, 0, 100));
}

export function computeConfidence(pair: DexScreenerPair): number {
  let confidence = 100;
  const priceUsd = parseFloat(pair.priceUsd) || 0;
  const liq = pair.liquidity?.usd || 0;
  const total1h = (pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0);
  const vol24h = pair.volume?.h24 || 0;

  if (!priceUsd || priceUsd <= 0) confidence -= 30;
  if (liq < 20_000)    confidence -= 25; // raised from 5K — thin liquidity is a red flag
  else if (liq < 10_000) confidence -= 15;
  if (total1h < 10)    confidence -= 25; // raised from 5 — need more activity signal
  else if (total1h < 20) confidence -= 10;
  if (vol24h < 2_000)  confidence -= 15;
  if (!pair.pairCreatedAt) confidence -= 10;

  return Math.max(0, confidence);
}

/**
 * Dynamic SL/TP percentages based on AI score tier.
 *
 * Philosophy: tighter stops, realistic targets.
 * Memecoins are volatile — a wide -20% SL means guaranteed large loss on bad trades.
 * Tighter SL means smaller losses when wrong, and we MUST be selective about entries.
 *
 * Score  | SL    | TP    | Rationale
 * ──────────────────────────────────────────────────────────
 * 90+    | -10%  | 80%   | High conviction early pump — great risk/reward
 * 80-89  | -9%   | 50%   | Strong signal — solid but not moonshot
 * 72-79  | -8%   | 35%   | Good signal — conservative target
 * <72    | -7%   | 25%   | Lower conviction — tight in/out
 */
export function getDynamicRisk(score: number): { slPercent: number; tpPercent: number } {
  if (score >= 90) return { slPercent: 10, tpPercent: 80 };
  if (score >= 80) return { slPercent: 9,  tpPercent: 50 };
  if (score >= 72) return { slPercent: 8,  tpPercent: 35 };
  return { slPercent: 7, tpPercent: 25 };
}
