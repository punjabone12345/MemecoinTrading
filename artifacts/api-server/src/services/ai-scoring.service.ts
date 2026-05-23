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

  // Case 1: Already pumped hard in 1h — check 5m to see if momentum is STILL alive
  if (pc1h > 300 && pc5m < 0) {
    timingScore = 4;  // massive pump + reversing in 5m → distributing, very dangerous
  } else if (pc1h > 300 && pc5m < 5) {
    timingScore = 8;  // massive pump but 5m is flat — might still squeeze, risky
  } else if (pc1h > 150 && pc5m < -3) {
    timingScore = 6;  // pumped hard and clearly reversing now → avoid
  } else if (pc1h > 100 && pc5m >= 8) {
    timingScore = 20; // big 1h AND still ripping in 5m → momentum confirmed, valid entry
  } else if (pc1h > 100 && pc5m >= 3) {
    timingScore = 14; // big 1h and 5m still positive → late but moving
  } else if (pc1h > 100 && pc5m < 0) {
    timingScore = 7;  // big 1h, now negative 5m → rolling over, avoid
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
  // Calibrated to the $20K minimum (minLiquidityUsd config).
  // Reward deeper pools — easier exit, harder to rug.
  let liquidityScore = 0;
  if (liq >= 200_000)      liquidityScore = 15;
  else if (liq >= 100_000) liquidityScore = 14;
  else if (liq >= 60_000)  liquidityScore = 12;
  else if (liq >= 40_000)  liquidityScore = 10;
  else if (liq >= 30_000)  liquidityScore = 8;  // solid entry
  else if (liq >= 20_000)  liquidityScore = 6;  // meets minimum — valid entry
  else                     liquidityScore = 0;  // below floor — never trade

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
  // Target $20K–$400K — small enough for 10-50x, still has real market activity.
  // Above $400K has diminishing moonshot potential; below $20K is often fake/dust.
  let mcapScore = 0;
  if (marketCap >= 30_000 && marketCap <= 200_000)          mcapScore = 15;  // prime early-pump zone
  else if (marketCap > 200_000 && marketCap <= 400_000)     mcapScore = 13;  // still in target range
  else if (marketCap >= 20_000 && marketCap < 30_000)       mcapScore = 10;  // micro launch — riskier
  else if (marketCap > 400_000 && marketCap <= 1_000_000)   mcapScore = 7;   // decent but less upside
  else if (marketCap > 1_000_000 && marketCap <= 3_000_000) mcapScore = 4;   // large for a memecoin
  else if (marketCap > 3_000_000)                           mcapScore = 1;   // not our target
  else if (marketCap > 0 && marketCap < 20_000)             mcapScore = 2;   // dust / not real
  else                                                       mcapScore = 0;

  return {
    momentumScore: clamp(timingScore, 0, 30),
    buyRatioScore: clamp(buyRatioScore, 0, 20),
    liquidityScore: clamp(liquidityScore, 0, 15),
    volumeMcapScore: clamp(volumeMcapScore, 0, 20),
    mcapScore: clamp(mcapScore, 0, 15),
  };
}

export function computeAiScore(signals: TokenSignals, boosts = 0): number {
  const raw =
    signals.momentumScore +
    signals.buyRatioScore +
    signals.liquidityScore +
    signals.volumeMcapScore +
    signals.mcapScore +
    boosts;
  return Math.round(clamp(raw, 0, 100));
}

/**
 * Score boosts for high-conviction entry patterns (max +40 pts total).
 *
 * These reward healthy market structure: pullbacks, dip-buying, sustained
 * accumulation, and organic growth — all the signals of a quality entry.
 * They are applied AFTER DexScreener verification on the real pair data.
 *
 * Pump.fun graduation bonus: when pump.fun's bonding curve fills (~85 SOL),
 * it creates a Raydium pool and graduates the token. This is the EXACT event
 * where 15-20 people buy simultaneously causing slippage, then the token often
 * 10x-100x. Detection: mint address ends in "pump" + pair is very fresh.
 */
export function computeEntryBoosts(pair: DexScreenerPair): number {
  let boost = 0;

  const pc1h = pair.priceChange?.h1 ?? 0;
  const pc5m = pair.priceChange?.m5 ?? 0;
  const pc6h = pair.priceChange?.h6 ?? 0;
  const buys1h  = pair.txns?.h1?.buys  || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const total1h = buys1h + sells1h;
  const buys5m  = pair.txns?.m5?.buys  || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const total5m = buys5m + sells5m;
  const liq  = pair.liquidity?.usd || 0;
  const vol1h = pair.volume?.h1 || 0;
  const vol5m = pair.volume?.m5 || 0;
  const buyRatio1h = total1h > 0 ? buys1h / total1h : 0;
  const buyRatio5m = total5m > 0 ? buys5m / total5m : 0;
  const pairAgeMinutes = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60_000
    : 999;

  // ── Pump.fun graduation bonus (highest priority) ─────────────────────────
  // Pump.fun graduates when bonding curve fills → Raydium pool created.
  // These tokens can go 10-100x from graduation price. Best window: first 90 min.
  const mintAddress = pair.baseToken?.address ?? "";
  const isPumpFunToken = mintAddress.toLowerCase().endsWith("pump");
  if (isPumpFunToken && pairAgeMinutes < 90 && buyRatio1h >= 0.58) {
    // Very fresh graduate with buy pressure — highest conviction signal
    boost += 20;
  } else if (isPumpFunToken && pairAgeMinutes < 180) {
    // Still fresh pump.fun token, second window
    boost += 10;
  }

  // +10: Deep pool AND strong buyer dominance — accumulation in progress
  if (liq >= 40_000 && buyRatio1h >= 0.72 && total1h >= 30)
    boost += 10;

  // +8: Smart money buying a dip — 6h was down but 1h recovering strongly
  if (pc6h < -5 && pc1h > 15 && buyRatio1h >= 0.68)
    boost += 8;

  // +7: Higher low forming — 5m positive and controlled after 1h gain (healthy pullback recovery)
  if (pc1h > 5 && pc1h < 40 && pc5m >= 2 && pc5m <= 12)
    boost += 7;

  // +6: Buy pressure sustained — 5m still positive with strong buy ratio (momentum confirmed)
  if (pc5m > 0 && pc1h > 8 && buyRatio5m >= 0.65 && total5m >= 6)
    boost += 6;

  // +5: Whales holding — 5m volume not elevated relative to 1h pace (not dumping)
  const expected5mPace = vol1h > 0 ? vol1h / 12 : 0;
  if (expected5mPace > 0 && vol5m > 0 && (vol5m / expected5mPace) < 1.5 && buyRatio1h >= 0.62)
    boost += 5;

  // +4: Consolidation before breakout — moderate 1h gain, 5m just turning up
  if (pc1h >= 10 && pc1h <= 35 && pc5m >= 1 && pc5m <= 8 && buyRatio1h >= 0.60 && total1h >= 20)
    boost += 4;

  return Math.min(boost, 40);
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
 * Philosophy: LET WINNERS RUN. Memecoins are early-pump plays — they either
 * rug fast (SL catches it) or they pump 2-10x. Wide SL is critical because
 * meme coins routinely dip 20-30% before their main pump. Tight SLs get
 * stopped out by normal volatility and are the primary cause of losses.
 *
 * Risk/reward at 150% TP + 20% SL = 7.5:1 → break-even at only 12% win rate.
 *
 * Score  | SL    | TP    | Rationale
 * ──────────────────────────────────────────────────────────
 * 90+    | -22%  | 400%  | Highest conviction — survive dips, ride to 5x
 * 85-89  | -20%  | 250%  | Very strong — wide SL avoids shakeouts
 * 80-84  | -18%  | 180%  | Strong signal — give room to breathe
 * 75-79  | -15%  | 120%  | Good signal — wider than before
 * <75    | -12%  | 80%   | Floor — never set too tight
 */
export function getDynamicRisk(score: number): { slPercent: number; tpPercent: number } {
  if (score >= 90) return { slPercent: 22, tpPercent: 500 };
  if (score >= 85) return { slPercent: 20, tpPercent: 350 };
  if (score >= 80) return { slPercent: 18, tpPercent: 250 };
  if (score >= 75) return { slPercent: 15, tpPercent: 180 };
  return { slPercent: 15, tpPercent: 120 };
}
