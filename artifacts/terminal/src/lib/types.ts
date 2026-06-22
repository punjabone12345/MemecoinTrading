export type EDTokenStatus = "tracking" | "rejected" | "eligible" | "entered" | "exited";

export interface EDScores {
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

export interface EDToken {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  imageUri: string;
  launchAt: number;
  lastUpdatedAt: number;
  priceUsd: number;
  marketCapUsd: number;
  bondingCurvePct: number;
  virtualSolReserves: number;
  targetSolReserves: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  uniqueBuyers: number;
  prevUniqueBuyers: number;
  buyersPerMinute: number;
  creatorHoldingsPct: number;
  topHolderPct: number;
  whaleParticipation: boolean;
  rugcheckStatus: "pending" | "passed" | "failed";
  rugcheckReason: string;
  rugcheckScore: number;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  scores: EDScores;
  status: EDTokenStatus;
  rejectionReason: string;
  firstEligibleAt: number | null;
  discoveryPrice: number;
  positionId: string | null;
  pollCount: number;
  creatorSold: boolean;
  entryChecklist: EntryChecklistItem[];
  bcUpdatedAt: number;
}

export interface EDPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  entryAt: number;
  entryPrice: number;
  entryMcap: number;
  entryScore: number;
  currentPrice: number;
  currentMcap: number;
  sizeSol: number;
  remainingFraction: number;
  effectiveSlPrice: number;
  trailingHigh: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  status: "open" | "closed";
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  pnlPct: number;
  closeReason: string;
  closedAt: number | null;
  exitPrice: number | null;
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
  closingScore: number | null;
  positionMultiplier: number;
}

export interface EDConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  minScore: number;
  minBondingCurvePct: number;
  minUniqueBuyers: number;
  minBuyPressureRatio: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  runnerTrailingPct: number;
}

export interface EDStatus {
  wsConnected: boolean;
  wsReconnects: number;
  ppConnected: boolean;
  ppReconnects: number;
  connectionSource: "pumpportal" | "helius" | "http-poll" | "offline";
  enabled: boolean;
  trackedCount: number;
  eligibleCount: number;
  enteredCount: number;
  rejectedCount: number;
  launchesDetected: number;
  virtualBalance: number;
  startingBalance: number;
  openCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  config: EDConfig;
}

export interface EDPositionPatch {
  entryPrice?: number;
  entryScore?: number;
  sizeSol?: number;
  effectiveSlPrice?: number;
  trailingHigh?: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  closeReason?: string;
  closingScore?: number;
  exitPrice?: number;
  realizedPnlSol?: number;
  tp1RealizedSol?: number;
  tp2RealizedSol?: number;
  runnerRealizedSol?: number;
}

export interface EDAnalytics {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  avgPnl: number;
  medianPnl: number;
  maxDrawdown: number;
  totalRealizedPnl: number;
  openCount: number;
  unrealizedPnl: number;
  byScore: Array<{
    range: string;
    trades: number;
    winRate: number;
    avgPnl: number;
    totalPnl: number;
  }>;
  avgHoldTimeWins: number;
  avgHoldTimeLosses: number;
  recentTrades: EDPosition[];
}
