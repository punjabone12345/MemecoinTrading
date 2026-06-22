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
  // More granular tiers — early tokens can still show good signal with fewer buyers
  let base = 0;
  if      (uniqueBuyers >= 200) base = 25;
  else if (uniqueBuyers >= 100) base = 20;
  else if (uniqueBuyers >= 50)  base = 15;
  else if (uniqueBuyers >= 25)  base = 10;
  else if (uniqueBuyers >= 10)  base = 5;
  else if (uniqueBuyers >= 5)   base = 2;

  // Buy velocity bonus — fast growth is the clearest early signal
  let accel = 0;
  if      (buyersPerMin >= 15) accel = 5;
  else if (buyersPerMin >= 10) accel = 4;
  else if (buyersPerMin >= 5)  accel = 3;
  else if (buyersPerMin >= 2)  accel = 2;
  else if (buyersPerMin >= 1)  accel = 1;

  return Math.min(25, base + accel);
}

function scoreVolume(buyVolumeSol: number): number {
  // Finer gradient at lower volumes — early tokens start small
  if (buyVolumeSol >= 200) return 25;
  if (buyVolumeSol >= 100) return 22;
  if (buyVolumeSol >= 50)  return 18;
  if (buyVolumeSol >= 20)  return 14;
  if (buyVolumeSol >= 10)  return 10;
  if (buyVolumeSol >= 5)   return 6;
  if (buyVolumeSol >= 2)   return 3;
  if (buyVolumeSol >= 0.5) return 1;
  return 0;
}

function scoreBuyPressure(ratio: number): number {
  if (ratio >= 5.0) return 25;
  if (ratio >= 4.0) return 20;
  if (ratio >= 3.0) return 15;
  if (ratio >= 2.0) return 10;
  if (ratio >= 1.5) return 5;
  if (ratio >= 1.0) return 2;
  return 0;
}

function scoreWalletQuality(topHolderPct: number, whaleParticipation: boolean, creatorHoldingsPct: number): number {
  // For pre-graduation pump.fun tokens, the BONDING CURVE CONTRACT is the top holder
  // and typically holds 50-100% of supply. This is normal and should NOT be penalised.
  // Only penalise when a real human wallet concentrates supply (<50% and not 0).
  let base: number;
  if (topHolderPct <= 0) {
    base = 15; // No data — neutral
  } else if (topHolderPct >= 50) {
    base = 15; // Almost certainly the bonding curve contract — neutral
  } else if (topHolderPct < 5)  { base = 25; }
  else if (topHolderPct < 10)   { base = 20; }
  else if (topHolderPct < 15)   { base = 15; }
  else if (topHolderPct < 20)   { base = 10; }
  else if (topHolderPct < 30)   { base = 6; }
  else if (topHolderPct < 40)   { base = 3; }
  else                          { base = 1; } // 40-49% — suspicious but not bonding curve

  const whaleBonus     = whaleParticipation ? 5 : 0;
  const creatorPenalty = creatorHoldingsPct > 10 ? 10 : creatorHoldingsPct > 5 ? 5 : 0;

  return Math.max(0, Math.min(25, base + whaleBonus - creatorPenalty));
}

function scoreBondingCurve(pct: number): number {
  // Graduated tiers starting from 10% — reward early momentum, not just near-graduation
  if (pct >= 80) return 20;
  if (pct >= 70) return 17;
  if (pct >= 60) return 14;
  if (pct >= 50) return 11;
  if (pct >= 40) return 8;
  if (pct >= 30) return 5;
  if (pct >= 20) return 3;
  if (pct >= 10) return 1;
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

  if (metrics.uniqueBuyers < 10)
    blockers.push(`Buyers ${metrics.uniqueBuyers} < 10`);

  if (metrics.sellVolumeSol > 0.01 && scores.buyPressureRatio < 1.5)
    blockers.push(`Buy pressure ${scores.buyPressureRatio.toFixed(1)}x < 1.5x`);

  if (metrics.bondingCurvePct < 60)
    blockers.push(`Bonding curve ${metrics.bondingCurvePct.toFixed(0)}% < 60%`);

  if (rugcheckStatus === "failed")
    blockers.push("Rugcheck failed");

  if (metrics.creatorHoldingsPct > 10)
    blockers.push(`Creator holds ${metrics.creatorHoldingsPct.toFixed(1)}% > 10%`);

  // Only block on real wallet concentration (not bonding curve contract)
  if (metrics.topHolderPct > 25 && metrics.topHolderPct < 50)
    blockers.push(`Top holder ${metrics.topHolderPct.toFixed(1)}% > 25% (not bonding curve)`);

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
  if (metrics.topHolderPct > 25 && metrics.topHolderPct < 50)
    return `Top holder concentration ${metrics.topHolderPct.toFixed(1)}% > 25%`;
  return null;
}
