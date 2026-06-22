/**
 * demand-scorer.ts
 * Pure scoring engine for Early Demand Discovery — no external calls.
 * Max score = 120 (Buyer Growth 25 + Volume 25 + Buy Pressure 25 + Wallet Quality 25 + Bonding Curve 20)
 */

export interface DemandMetrics {
  uniqueBuyers: number;
  prevUniqueBuyers: number;
  buyerAcceleration: number;
  buyersPerMinute: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  bondingCurvePct: number;
  topHolderPct: number;
  creatorHoldingsPct: number;
  whaleParticipation: boolean;
}

export interface DemandScores {
  buyerGrowthScore: number;
  volumeScore: number;
  buyPressureScore: number;
  walletQualityScore: number;
  bondingCurveScore: number;
  finalScore: number;
  buyPressureRatio: number;
}

function scoreBuyerGrowth(uniqueBuyers: number, buyersPerMin: number): number {
  let base = 0;
  if      (uniqueBuyers >= 100) base = 20;
  else if (uniqueBuyers >= 50)  base = 15;
  else if (uniqueBuyers >= 25)  base = 10;
  else if (uniqueBuyers >= 10)  base = 5;

  let accel = 0;
  if      (buyersPerMin >= 10) accel = 5;
  else if (buyersPerMin >= 5)  accel = 3;
  else if (buyersPerMin >= 2)  accel = 2;

  return Math.min(25, base + accel);
}

function scoreVolume(buyVolumeSol: number): number {
  if (buyVolumeSol >= 100) return 25;
  if (buyVolumeSol >= 50)  return 20;
  if (buyVolumeSol >= 20)  return 15;
  if (buyVolumeSol >= 5)   return 10;
  if (buyVolumeSol >= 1)   return 5;
  return 0;
}

function scoreBuyPressure(ratio: number): number {
  if (ratio >= 5.0) return 25;
  if (ratio >= 4.0) return 20;
  if (ratio >= 3.0) return 15;
  if (ratio >= 2.0) return 10;
  if (ratio >= 1.5) return 5;
  return 0;
}

function scoreWalletQuality(topHolderPct: number, whaleParticipation: boolean, creatorHoldingsPct: number): number {
  let base = 15;
  if      (topHolderPct <= 0)   base = 15;
  else if (topHolderPct < 5)    base = 25;
  else if (topHolderPct < 10)   base = 20;
  else if (topHolderPct < 15)   base = 15;
  else if (topHolderPct < 20)   base = 10;
  else if (topHolderPct < 25)   base = 5;
  else                           base = 0;

  const whaleBonus     = whaleParticipation ? 3 : 0;
  const creatorPenalty = creatorHoldingsPct > 5 ? 10 : 0;

  return Math.max(0, Math.min(25, base + whaleBonus - creatorPenalty));
}

function scoreBondingCurve(pct: number): number {
  if (pct >= 80) return 20;
  if (pct >= 70) return 15;
  if (pct >= 60) return 10;
  if (pct >= 50) return 5;
  return 0;
}

export function calculateDemandScore(metrics: DemandMetrics): DemandScores {
  const buyPressureRatio = metrics.sellVolumeSol > 0
    ? metrics.buyVolumeSol / metrics.sellVolumeSol
    : (metrics.buyVolumeSol > 0 ? 5.0 : 0);

  const buyerGrowthScore   = scoreBuyerGrowth(metrics.uniqueBuyers, metrics.buyersPerMinute);
  const volumeScore        = scoreVolume(metrics.buyVolumeSol);
  const buyPressureScore   = scoreBuyPressure(buyPressureRatio);
  const walletQualityScore = scoreWalletQuality(metrics.topHolderPct, metrics.whaleParticipation, metrics.creatorHoldingsPct);
  const bondingCurveScore  = scoreBondingCurve(metrics.bondingCurvePct);
  const finalScore         = buyerGrowthScore + volumeScore + buyPressureScore + walletQualityScore + bondingCurveScore;

  return { buyerGrowthScore, volumeScore, buyPressureScore, walletQualityScore, bondingCurveScore, finalScore, buyPressureRatio };
}

export interface EntryCheckResult {
  eligible: boolean;
  blockers: string[];
}

export function checkEntryConditions(
  scores: DemandScores,
  metrics: DemandMetrics,
  rugcheckStatus: "pending" | "passed" | "failed",
  discoveryPrice: number,
  currentPrice: number,
  minScore: number,
): EntryCheckResult {
  const blockers: string[] = [];

  if (scores.finalScore < minScore)
    blockers.push(`Score ${scores.finalScore} < ${minScore}`);

  // Require at least 10 unique buyers (lowered from 25 — DexScreener lags on new tokens)
  if (metrics.uniqueBuyers < 10)
    blockers.push(`Buyers ${metrics.uniqueBuyers} < 10`);

  // Buy pressure: only block if there is actual sell volume AND ratio is bad.
  // If there are zero sells (pure buy pressure), that's a strong signal — don't block.
  if (metrics.sellVolumeSol > 0.01 && scores.buyPressureRatio < 1.5)
    blockers.push(`Buy pressure ${scores.buyPressureRatio.toFixed(1)}x < 1.5x`);

  // Bonding curve: lowered to 60% (was 70%) — catch tokens earlier with genuine demand
  if (metrics.bondingCurvePct < 60)
    blockers.push(`Bonding curve ${metrics.bondingCurvePct.toFixed(0)}% < 60%`);

  // Only hard-block on confirmed rug — "pending" (API unavailable) is not a block
  if (rugcheckStatus === "failed")
    blockers.push("Rugcheck failed");

  // Creator risk: only block if creator holds a significant amount
  if (metrics.creatorHoldingsPct > 10)
    blockers.push(`Creator holds ${metrics.creatorHoldingsPct.toFixed(1)}% > 10%`);

  // Top holder: raised threshold — rugcheck already blocks >40%
  if (metrics.topHolderPct > 25)
    blockers.push(`Top holder ${metrics.topHolderPct.toFixed(1)}% > 25%`);

  if (discoveryPrice > 0 && currentPrice > 0) {
    const pumpPct = ((currentPrice - discoveryPrice) / discoveryPrice) * 100;
    if (pumpPct > 200)
      blockers.push(`Already pumped ${pumpPct.toFixed(0)}% from discovery (anti-FOMO)`);
  }

  return { eligible: blockers.length === 0, blockers };
}

export function getPositionSizeMultiplier(score: number): number {
  if (score >= 100) return 1.00;
  if (score >= 80)  return 0.75;
  if (score >= 60)  return 0.50;
  if (score >= 40)  return 0.35;
  return 0;
}

export function checkQualityExit(scores: DemandScores, metrics: DemandMetrics): string | null {
  if (scores.finalScore < 60)      return `Score collapsed to ${scores.finalScore}`;
  if (scores.buyPressureRatio < 1) return `Buy pressure collapsed to ${scores.buyPressureRatio.toFixed(2)}x`;
  if (metrics.topHolderPct > 25)   return `Top holder concentration ${metrics.topHolderPct.toFixed(1)}% > 25%`;
  return null;
}
