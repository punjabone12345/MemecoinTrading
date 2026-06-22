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

export interface EntryChecklistItem {
  label: string;
  pass: boolean;
  current: string;
  threshold: string;
  borderline: boolean;
}

function scoreBuyerGrowth(uniqueBuyers: number, buyersPerMin: number): number {
  try {
    let base = 0;
    if      (uniqueBuyers >= 200) base = 25;
    else if (uniqueBuyers >= 100) base = 20;
    else if (uniqueBuyers >= 50)  base = 15;
    else if (uniqueBuyers >= 25)  base = 10;
    else if (uniqueBuyers >= 10)  base = 5;
    else if (uniqueBuyers >= 5)   base = 2;

    let accel = 0;
    if      (buyersPerMin >= 15) accel = 5;
    else if (buyersPerMin >= 10) accel = 4;
    else if (buyersPerMin >= 5)  accel = 3;
    else if (buyersPerMin >= 2)  accel = 2;
    else if (buyersPerMin >= 1)  accel = 1;

    return Math.min(25, base + accel);
  } catch { return 0; }
}

function scoreVolume(buyVolumeSol: number): number {
  try {
    if (buyVolumeSol >= 200) return 25;
    if (buyVolumeSol >= 100) return 22;
    if (buyVolumeSol >= 50)  return 18;
    if (buyVolumeSol >= 20)  return 14;
    if (buyVolumeSol >= 10)  return 10;
    if (buyVolumeSol >= 5)   return 6;
    if (buyVolumeSol >= 2)   return 3;
    if (buyVolumeSol >= 0.5) return 1;
    return 0;
  } catch { return 0; }
}

function scoreBuyPressure(ratio: number): number {
  try {
    if (ratio >= 5.0) return 25;
    if (ratio >= 4.0) return 20;
    if (ratio >= 3.0) return 15;
    if (ratio >= 2.0) return 10;
    if (ratio >= 1.5) return 5;
    if (ratio >= 1.0) return 2;
    return 0;
  } catch { return 0; }
}

function scoreWalletQuality(topHolderPct: number, whaleParticipation: boolean, creatorHoldingsPct: number): number {
  try {
    // For pre-graduation pump.fun tokens, the BONDING CURVE CONTRACT is the top holder
    // and typically holds 50-100% of supply. This is normal and should NOT be penalised.
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
    else                          { base = 1; }

    const whaleBonus     = whaleParticipation ? 5 : 0;
    const creatorPenalty = creatorHoldingsPct > 10 ? 10 : creatorHoldingsPct > 5 ? 5 : 0;

    return Math.max(0, Math.min(25, base + whaleBonus - creatorPenalty));
  } catch { return 0; }
}

function scoreBondingCurve(pct: number): number {
  try {
    if (pct >= 80) return 20;
    if (pct >= 70) return 17;
    if (pct >= 60) return 14;
    if (pct >= 50) return 11;
    if (pct >= 40) return 8;
    if (pct >= 30) return 5;
    if (pct >= 20) return 3;
    if (pct >= 10) return 1;
    return 0;
  } catch { return 0; }
}

export function calculateDemandScore(metrics: DemandMetrics): DemandScores {
  const buyPressureRatio = metrics.sellVolumeSol > 0
    ? metrics.buyVolumeSol / metrics.sellVolumeSol
    : (metrics.buyVolumeSol > 0 ? 5.0 : 0);

  // Each component is independently try-catch'd so one failure doesn't zero the whole score
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
  checklist: EntryChecklistItem[];
}

export function checkEntryConditions(
  scores: DemandScores,
  metrics: DemandMetrics,
  rugcheckStatus: "pending" | "passed" | "failed",
  discoveryPrice: number,
  currentPrice: number,
  minScore: number,
  config?: { minUniqueBuyers?: number; minBuyPressureRatio?: number; minBondingCurvePct?: number },
): EntryCheckResult {
  const blockers: string[] = [];
  const checklist: EntryChecklistItem[] = [];

  const minBuyers = config?.minUniqueBuyers ?? 10;
  const minBpRatio = config?.minBuyPressureRatio ?? 1.5;
  const minBcPct = config?.minBondingCurvePct ?? 60;

  // 1. Score
  const scorePass = scores.finalScore >= minScore;
  const scoreBorderline = !scorePass && scores.finalScore >= minScore - 10;
  if (!scorePass) blockers.push(`Score ${scores.finalScore} < ${minScore}`);
  checklist.push({
    label: `Score ≥${minScore}`,
    pass: scorePass,
    current: `${scores.finalScore}/120`,
    threshold: `${minScore}`,
    borderline: scoreBorderline,
  });

  // 2. Unique buyers
  const buyersPass = metrics.uniqueBuyers >= minBuyers;
  const buyersBorderline = !buyersPass && metrics.uniqueBuyers >= minBuyers - 5;
  if (!buyersPass) blockers.push(`Buyers ${metrics.uniqueBuyers} < ${minBuyers}`);
  checklist.push({
    label: `Unique buyers ≥${minBuyers}`,
    pass: buyersPass,
    current: `${metrics.uniqueBuyers}`,
    threshold: `${minBuyers}`,
    borderline: buyersBorderline,
  });

  // 3. Buy pressure
  const hasSells = metrics.sellVolumeSol > 0.01;
  const bpPass = !hasSells || scores.buyPressureRatio >= minBpRatio;
  const bpBorderline = !bpPass && scores.buyPressureRatio >= minBpRatio * 0.85;
  if (!bpPass) blockers.push(`Buy pressure ${scores.buyPressureRatio.toFixed(1)}x < ${minBpRatio}x`);
  checklist.push({
    label: `Buy pressure >${minBpRatio}x`,
    pass: bpPass,
    current: hasSells ? `${scores.buyPressureRatio.toFixed(2)}x` : "No sells yet",
    threshold: `${minBpRatio}x`,
    borderline: bpBorderline,
  });

  // 4. Bonding curve
  const bcPass = metrics.bondingCurvePct >= minBcPct;
  const bcBorderline = !bcPass && metrics.bondingCurvePct >= minBcPct - 10;
  if (!bcPass) blockers.push(`Bonding curve ${metrics.bondingCurvePct.toFixed(0)}% < ${minBcPct}%`);
  checklist.push({
    label: `Bonding curve ≥${minBcPct}%`,
    pass: bcPass,
    current: `${metrics.bondingCurvePct.toFixed(1)}%`,
    threshold: `${minBcPct}%`,
    borderline: bcBorderline,
  });

  // 5. Rugcheck
  const rugPass = rugcheckStatus !== "failed";
  if (!rugPass) blockers.push("Rugcheck failed");
  checklist.push({
    label: "Rugcheck passed",
    pass: rugPass,
    current: rugcheckStatus,
    threshold: "passed",
    borderline: rugcheckStatus === "pending",
  });

  // 6. Creator holdings
  const creatorPass = metrics.creatorHoldingsPct <= 10;
  const creatorBorderline = !creatorPass && metrics.creatorHoldingsPct <= 12;
  if (!creatorPass) blockers.push(`Creator holds ${metrics.creatorHoldingsPct.toFixed(1)}% > 10%`);
  checklist.push({
    label: "Creator <10%",
    pass: creatorPass,
    current: `${metrics.creatorHoldingsPct.toFixed(1)}%`,
    threshold: "10%",
    borderline: creatorBorderline,
  });

  // 7. Top holder (only block on real wallet concentration, not bonding curve contract)
  const topHolderIsRealWallet = metrics.topHolderPct > 25 && metrics.topHolderPct < 50;
  const topHolderPass = !topHolderIsRealWallet;
  const topHolderBorderline = !topHolderPass && metrics.topHolderPct < 30;
  if (!topHolderPass) blockers.push(`Top holder ${metrics.topHolderPct.toFixed(1)}% > 25% (not bonding curve)`);
  checklist.push({
    label: "Top holder <25%",
    pass: topHolderPass,
    current: metrics.topHolderPct >= 50 ? `${metrics.topHolderPct.toFixed(1)}% (BC contract)` : `${metrics.topHolderPct.toFixed(1)}%`,
    threshold: "25% (excl. BC)",
    borderline: topHolderBorderline,
  });

  // 8. Anti-FOMO: not already pumped >200%
  let fomoPass = true;
  let fomoNote = "N/A";
  if (discoveryPrice > 0 && currentPrice > 0) {
    const pumpPct = ((currentPrice - discoveryPrice) / discoveryPrice) * 100;
    fomoPass = pumpPct <= 200;
    fomoNote = `+${pumpPct.toFixed(0)}% from discovery`;
    if (!fomoPass) blockers.push(`Already pumped ${pumpPct.toFixed(0)}% from discovery (anti-FOMO)`);
  }
  checklist.push({
    label: "Price not pumped >200%",
    pass: fomoPass,
    current: fomoNote,
    threshold: "≤200%",
    borderline: false,
  });

  return { eligible: blockers.length === 0, blockers, checklist };
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
