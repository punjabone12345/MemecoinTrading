export type EDTokenStatus = "tracking" | "rejected" | "eligible" | "entered" | "exited";

export interface EDScores {
  buyerGrowthScore: number;
  volumeScore: number;
  buyPressureScore: number;
  walletQualityScore: number;
  bondingCurveScore: number; // always 0 — kept for compat, not used
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

export interface EDConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  minScore: number;
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

export interface SniperConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  trailingStopAfterTp2Pct: number;
  tp3Pct: number;
  tp3ClosePct: number;
  trailingStopAfterTp3Pct: number;
  trailingStopPct: number;
  minQualityScore: number;
  maxEntryWindowMs: number;
  waitBeforeEntryMs: number;
  slippageBps: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
}

export interface SniperPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  currentPrice: number;
  sizeSol: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  remainingFraction: number;
  effectiveSlPrice: number;
  trailingHigh: number;
  status: "open" | "closed";
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  pnlPct: number;
  closeReason?: string;
  closedAt?: number;
  exitPrice?: number;
  txSignature: string;
  tokenAmount: number;
  entrySig: string;
  exitSig?: string;
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  tp3RealizedSol: number;
  runnerRealizedSol: number;
  detectionPrice?: number;
  entryDriftPct?: number;
  msDetectionToFill?: number;
  qualityScore: number;
  liquiditySol: number;
  buyPressureRatio: number;
  uniqueBuyers: number;
  topHolderPct: number;
  whaleDetected: boolean;
  positionMultiplier: number;
  closingAttempt?: number;
  isStuck?: boolean;
  lastError?: string;
  lastPriceAt?: number;
}

export interface SniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped";
  skipReason?: string;
  txSignature: string;
  qualityScore?: number;
  liquiditySol?: number;
  uniqueBuyers?: number;
  buyPressureRatio?: number;
  topHolderPct?: number;
  creatorHoldingsPct?: number;
  whaleDetected?: boolean;
}

export interface SniperStatus {
  wsConnected: boolean;
  wsReconnects: number;
  lastWsMessageAt: number;
  enabled: boolean;
  graduationsToday: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  capitalInOpen: number;
  walletBalance: number;
  walletAddress: string;
  walletReady: boolean;
  openCount: number;
  config: SniperConfig;
}

export interface WatchedGrad {
  mint: string;
  symbol: string;
  gradPrice: number;
  currentPrice: number;
  pumpPct: number;
  dumpPct: number;
  retracePct: number;
  phase: 0 | 1 | 2 | 3;
  phase1High: number;
  phase2Low: number;
  addedAt: number;
  lastUpdatedAt: number;
}

export interface StuckToken {
  mint: string;
  symbol: string;
  uiAmount: number;
  rawAmount: number;
  raydiumUrl: string;
}

export interface WalletBalance {
  address: string | null;
  balance: number;
  ready: boolean;
  solscan: string | null;
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
