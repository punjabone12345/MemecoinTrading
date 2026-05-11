import type { DexScreenerPair, TokenSignals } from "../types/index.js";

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Score 0-100 using 5 components as specified:
 * - 1h price momentum         → up to 30 pts
 * - Buy/sell ratio 1h         → up to 20 pts
 * - Liquidity depth >$50k     → up to 15 pts
 * - Volume spike vs mcap      → up to 20 pts
 * - Mcap sweet spot $50k-$5M  → up to 15 pts
 */
export function computeSignals(pair: DexScreenerPair): TokenSignals {
  const pc1h = pair.priceChange?.h1 || 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const total1h = buys1h + sells1h;
  const liq = pair.liquidity?.usd || 0;
  const vol1h = pair.volume?.h1 || 0;
  const marketCap = pair.marketCap || pair.fdv || 0;

  // 1. 1h price momentum (max 30 pts)
  let momentumScore = 0;
  if (pc1h >= 50) momentumScore = 30;
  else if (pc1h >= 30) momentumScore = 26;
  else if (pc1h >= 15) momentumScore = 22;
  else if (pc1h >= 8) momentumScore = 18;
  else if (pc1h >= 4) momentumScore = 14;
  else if (pc1h >= 1) momentumScore = 9;
  else if (pc1h >= 0) momentumScore = 5;
  else if (pc1h >= -5) momentumScore = 2;
  else momentumScore = 0;

  // 2. Buy/sell ratio 1h (max 20 pts)
  let buyRatioScore = 0;
  if (total1h > 0) {
    const ratio = buys1h / total1h;
    if (ratio >= 0.80) buyRatioScore = 20;
    else if (ratio >= 0.70) buyRatioScore = 17;
    else if (ratio >= 0.60) buyRatioScore = 13;
    else if (ratio >= 0.55) buyRatioScore = 10;
    else if (ratio >= 0.50) buyRatioScore = 7;
    else if (ratio >= 0.40) buyRatioScore = 4;
    else buyRatioScore = 1;
  }

  // 3. Liquidity depth (max 15 pts)
  let liquidityScore = 0;
  if (liq >= 500_000) liquidityScore = 15;
  else if (liq >= 200_000) liquidityScore = 13;
  else if (liq >= 100_000) liquidityScore = 11;
  else if (liq >= 50_000) liquidityScore = 9;
  else if (liq >= 20_000) liquidityScore = 6;
  else if (liq >= 5_000) liquidityScore = 3;
  else liquidityScore = 0;

  // 4. Volume spike vs market cap ratio (max 20 pts)
  let volumeMcapScore = 0;
  if (marketCap > 0 && vol1h > 0) {
    const ratio = vol1h / marketCap;
    if (ratio >= 1.0) volumeMcapScore = 20;
    else if (ratio >= 0.5) volumeMcapScore = 17;
    else if (ratio >= 0.2) volumeMcapScore = 14;
    else if (ratio >= 0.1) volumeMcapScore = 11;
    else if (ratio >= 0.05) volumeMcapScore = 7;
    else if (ratio >= 0.01) volumeMcapScore = 4;
    else volumeMcapScore = 1;
  }

  // 5. Market cap sweet spot $50k–$5M (max 15 pts)
  let mcapScore = 0;
  if (marketCap >= 50_000 && marketCap <= 1_000_000) mcapScore = 15;
  else if (marketCap > 1_000_000 && marketCap <= 5_000_000) mcapScore = 12;
  else if (marketCap > 5_000_000 && marketCap <= 20_000_000) mcapScore = 8;
  else if (marketCap > 20_000_000 && marketCap <= 100_000_000) mcapScore = 4;
  else if (marketCap < 50_000 && marketCap > 0) mcapScore = 5;
  else mcapScore = 0;

  return {
    momentumScore: clamp(momentumScore, 0, 30),
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
  if (liq < 5_000) confidence -= 25;
  if (total1h < 5) confidence -= 20;
  if (vol24h < 1_000) confidence -= 15;
  if (!pair.pairCreatedAt) confidence -= 10;

  return Math.max(0, confidence);
}

/** Dynamic SL/TP percentages based on AI score */
export function getDynamicRisk(score: number): { slPercent: number; tpPercent: number } {
  if (score >= 95) return { slPercent: 5, tpPercent: 500 };
  if (score >= 90) return { slPercent: 7, tpPercent: 200 };
  if (score >= 80) return { slPercent: 8, tpPercent: 100 };
  if (score >= 70) return { slPercent: 10, tpPercent: 60 };
  return { slPercent: 12, tpPercent: 35 };
}
