import type { DexScreenerPair, TokenSignals } from "../types/index.js";

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Score 0–100 using 5 components (max 100 pts):
 *
 *  Component                Max   Notes
 *  ─────────────────────────────────────────────────────────────
 *  1h price momentum         30   Primary trend signal
 *  5m momentum bonus          5   Early-pump detection (additive)
 *  Buy/sell ratio 1h         20   Demand vs supply pressure
 *  Liquidity depth           15   Safety / trade-ability
 *  Effective vol / mcap      20   Activity intensity
 *  Mcap sweet spot           15   Upside potential
 *  ─────────────────────────────────────────────────────────────
 *  (1h + 5m are capped together at 35)
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

  // ── 1. 1h price momentum (max 30 pts) ────────────────────────────────────
  let momentumScore = 0;
  if (pc1h >= 100) momentumScore = 30;
  else if (pc1h >= 50) momentumScore = 28;
  else if (pc1h >= 30) momentumScore = 25;
  else if (pc1h >= 15) momentumScore = 21;
  else if (pc1h >= 8) momentumScore = 17;
  else if (pc1h >= 4) momentumScore = 13;
  else if (pc1h >= 1) momentumScore = 8;
  else if (pc1h >= 0) momentumScore = 4;
  else if (pc1h >= -5) momentumScore = 1;
  else momentumScore = 0;

  // ── 2. 5m momentum bonus (max 5 pts, additive with 1h capped at 35) ─────
  let pumpBonus = 0;
  if (pc5m >= 30) pumpBonus = 5;
  else if (pc5m >= 15) pumpBonus = 4;
  else if (pc5m >= 8) pumpBonus = 3;
  else if (pc5m >= 4) pumpBonus = 2;
  else if (pc5m >= 1) pumpBonus = 1;

  const combinedMomentum = clamp(momentumScore + pumpBonus, 0, 35);

  // ── 3. Buy/sell ratio 1h (max 20 pts) ────────────────────────────────────
  let buyRatioScore = 0;
  if (total1h > 0) {
    const ratio = buys1h / total1h;
    if (ratio >= 0.85) buyRatioScore = 20;
    else if (ratio >= 0.75) buyRatioScore = 18;
    else if (ratio >= 0.65) buyRatioScore = 15;
    else if (ratio >= 0.58) buyRatioScore = 12;
    else if (ratio >= 0.52) buyRatioScore = 9;
    else if (ratio >= 0.45) buyRatioScore = 5;
    else buyRatioScore = 2;
  }

  // ── 4. Liquidity depth (max 15 pts) ──────────────────────────────────────
  let liquidityScore = 0;
  if (liq >= 500_000) liquidityScore = 15;
  else if (liq >= 200_000) liquidityScore = 13;
  else if (liq >= 100_000) liquidityScore = 11;
  else if (liq >= 50_000) liquidityScore = 9;
  else if (liq >= 20_000) liquidityScore = 6;
  else if (liq >= 5_000) liquidityScore = 3;
  else liquidityScore = 0;

  // ── 5. Effective hourly volume / market cap (max 20 pts) ─────────────────
  let volumeMcapScore = 0;
  if (marketCap > 0 && effectiveVol1h > 0) {
    const ratio = effectiveVol1h / marketCap;
    if (ratio >= 1.0) volumeMcapScore = 20;
    else if (ratio >= 0.5) volumeMcapScore = 18;
    else if (ratio >= 0.2) volumeMcapScore = 15;
    else if (ratio >= 0.1) volumeMcapScore = 12;
    else if (ratio >= 0.05) volumeMcapScore = 9;
    else if (ratio >= 0.02) volumeMcapScore = 6;
    else if (ratio >= 0.005) volumeMcapScore = 3;
    else volumeMcapScore = 1;
  }

  // ── 6. Mcap sweet spot (max 15 pts) ──────────────────────────────────────
  let mcapScore = 0;
  if (marketCap >= 100_000 && marketCap <= 1_000_000) mcapScore = 15;
  else if (marketCap > 1_000_000 && marketCap <= 5_000_000) mcapScore = 12;
  else if (marketCap > 5_000_000 && marketCap <= 20_000_000) mcapScore = 8;
  else if (marketCap > 20_000_000 && marketCap <= 100_000_000) mcapScore = 4;
  else if (marketCap >= 50_000 && marketCap < 100_000) mcapScore = 10;
  else if (marketCap > 0 && marketCap < 50_000) mcapScore = 3;
  else mcapScore = 0;

  return {
    momentumScore: combinedMomentum,
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

/**
 * Dynamic SL/TP percentages based on AI score tier.
 * Wider SL to survive volatility, aggressive TP for moonshots.
 *
 * Score  | SL   | TP     | Rationale
 * ────────────────────────────────────────────
 * 95+    | -20% | 500%   | Ultra high conviction, max moonshot
 * 90-94  | -18% | 200%   | High conviction, big upside
 * 80-89  | -15% | 80%    | Strong signal, moderate moonshot
 * 70-79  | -12% | 50%    | Good signal, reasonable target
 * <70    | -12% | 35%    | Lower conviction, tighter target
 */
export function getDynamicRisk(score: number): { slPercent: number; tpPercent: number } {
  if (score >= 95) return { slPercent: 20, tpPercent: 500 };
  if (score >= 90) return { slPercent: 18, tpPercent: 200 };
  if (score >= 80) return { slPercent: 15, tpPercent: 80 };
  if (score >= 70) return { slPercent: 12, tpPercent: 50 };
  return { slPercent: 12, tpPercent: 35 };
}
