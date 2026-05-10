import type { DexScreenerPair, TokenSignals } from "../types/index.js";

const LIQUIDITY_THRESHOLDS = {
  min: 10_000,
  ideal: 100_000,
  max: 2_000_000,
};

function clamp(val: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, val));
}

function scoreLiquidity(liquidityUsd: number): number {
  if (liquidityUsd < LIQUIDITY_THRESHOLDS.min) return 5;
  if (liquidityUsd >= LIQUIDITY_THRESHOLDS.min && liquidityUsd < 50_000) {
    return clamp(5 + ((liquidityUsd - 10_000) / 40_000) * 45);
  }
  if (liquidityUsd >= 50_000 && liquidityUsd < LIQUIDITY_THRESHOLDS.ideal) {
    return clamp(50 + ((liquidityUsd - 50_000) / 50_000) * 30);
  }
  if (
    liquidityUsd >= LIQUIDITY_THRESHOLDS.ideal &&
    liquidityUsd < LIQUIDITY_THRESHOLDS.max
  ) {
    return clamp(80 + ((liquidityUsd - 100_000) / 1_900_000) * 15);
  }
  return 95;
}

function scoreVolumeGrowth(pair: DexScreenerPair): number {
  const vol5m = pair.volume.m5 || 0;
  const vol1h = pair.volume.h1 || 1;
  const vol6h = pair.volume.h6 || 1;
  const vol24h = pair.volume.h24 || 1;

  const annualizedRate5m = vol5m * 12;
  const growthVs1h = vol1h > 0 ? annualizedRate5m / vol1h : 0;
  const growthVs6h = vol6h > 0 ? vol1h / (vol6h / 6) : 0;
  const growthVs24h = vol24h > 0 ? vol6h / (vol24h / 4) : 0;

  const avgGrowth = (growthVs1h + growthVs6h + growthVs24h) / 3;
  return clamp(Math.log10(Math.max(1, avgGrowth) + 1) * 40);
}

function scoreBuyPressure(pair: DexScreenerPair): number {
  const buys5m = pair.txns.m5.buys || 0;
  const sells5m = pair.txns.m5.sells || 0;
  const buys1h = pair.txns.h1.buys || 0;
  const sells1h = pair.txns.h1.sells || 0;

  const total5m = buys5m + sells5m;
  const total1h = buys1h + sells1h;

  const ratio5m = total5m > 0 ? buys5m / total5m : 0.5;
  const ratio1h = total1h > 0 ? buys1h / total1h : 0.5;

  const combined = ratio5m * 0.6 + ratio1h * 0.4;
  return clamp(combined * 100);
}

function scoreVolatility(pair: DexScreenerPair): number {
  const changes = [
    Math.abs(pair.priceChange.m5 || 0),
    Math.abs(pair.priceChange.h1 || 0),
    Math.abs(pair.priceChange.h6 || 0),
    Math.abs(pair.priceChange.h24 || 0),
  ];

  const avgAbsChange = changes.reduce((a, b) => a + b, 0) / 4;

  if (avgAbsChange < 1) return 10;
  if (avgAbsChange < 5) return 30;
  if (avgAbsChange < 15) return 60;
  if (avgAbsChange < 30) return 80;
  if (avgAbsChange < 60) return 65;
  return 40;
}

function scoreMomentum(pair: DexScreenerPair): number {
  const pc5m = pair.priceChange.m5 || 0;
  const pc1h = pair.priceChange.h1 || 0;
  const pc6h = pair.priceChange.h6 || 0;

  const weightedChange = pc5m * 0.5 + pc1h * 0.3 + pc6h * 0.2;

  if (weightedChange > 50) return 95;
  if (weightedChange > 20) return 80;
  if (weightedChange > 10) return 70;
  if (weightedChange > 5) return 60;
  if (weightedChange > 0) return 50;
  if (weightedChange > -5) return 40;
  if (weightedChange > -15) return 25;
  return 10;
}

function scoreLiquidityMcapRatio(
  liquidityUsd: number,
  marketCap: number,
): number {
  if (marketCap <= 0) return 30;
  const ratio = liquidityUsd / marketCap;
  if (ratio > 0.3) return 95;
  if (ratio > 0.15) return 80;
  if (ratio > 0.08) return 65;
  if (ratio > 0.03) return 50;
  if (ratio > 0.01) return 30;
  return 10;
}

export function computeSignals(pair: DexScreenerPair): TokenSignals {
  const liquidityUsd = pair.liquidity?.usd || 0;
  const marketCap = pair.marketCap || pair.fdv || 0;

  const liquidityScore = scoreLiquidity(liquidityUsd);
  const volumeScore = scoreVolumeGrowth(pair);
  const buyPressureScore = scoreBuyPressure(pair);
  const volatilityScore = scoreVolatility(pair);
  const momentumScore = scoreMomentum(pair);
  const liquidityMcapRatioScore = scoreLiquidityMcapRatio(
    liquidityUsd,
    marketCap,
  );

  const buys5m = pair.txns.m5.buys || 0;
  const sells5m = pair.txns.m5.sells || 0;
  const total5m = buys5m + sells5m;
  const buyRatio5m = total5m > 0 ? buys5m / total5m : 0.5;

  const vol5m = pair.volume.m5 || 0;
  const vol1h = pair.volume.h1 || 0;
  const annualizedVol5m = vol5m * 12;

  const volumeSpike = vol1h > 0 ? annualizedVol5m > vol1h * 1.5 : false;
  const buyPressure = buyRatio5m > 0.65;
  const highMomentum = (pair.priceChange.m5 || 0) > 5;
  const lowLiquidity = liquidityUsd < 30_000;

  let momentumLabel: TokenSignals["momentumLabel"];
  const pc1h = pair.priceChange.h1 || 0;
  if (pc1h > 10) momentumLabel = "🔥 HOT";
  else if (pc1h > 2) momentumLabel = "📈 RISING";
  else if (pc1h > -2) momentumLabel = "😴 NEUTRAL";
  else momentumLabel = "📉 FALLING";

  return {
    volumeSpike,
    buyPressure,
    highMomentum,
    lowLiquidity,
    liquidityScore,
    volumeScore,
    buyPressureScore,
    momentumScore,
    volatilityScore,
    liquidityMcapRatioScore,
    momentumLabel,
  };
}

export function computeAiScore(signals: TokenSignals): number {
  const {
    liquidityScore,
    volumeScore,
    buyPressureScore,
    momentumScore,
    volatilityScore,
    liquidityMcapRatioScore,
  } = signals;

  const weighted =
    liquidityScore * 0.2 +
    volumeScore * 0.2 +
    buyPressureScore * 0.2 +
    momentumScore * 0.2 +
    volatilityScore * 0.1 +
    liquidityMcapRatioScore * 0.1;

  return Math.round(clamp(weighted));
}
