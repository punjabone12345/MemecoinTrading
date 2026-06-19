export interface ScannedToken {
  pairAddress: string; name: string; symbol: string; address: string;
  priceUsd: number; liquidity: number; marketCap: number; fdv: number;
  volume24h: number; volume1h: number; volume5m: number;
  buys1h: number; sells1h: number; buys24h: number; sells24h: number;
  priceChange1h: number; priceChange5m: number; priceChange6h: number; priceChange24h: number;
  pairAgeLabel: string; dexId: string; url: string; imageUrl: string;
  aiScore: number; confidence: number;
  signals: { momentumScore: number; buyRatioScore: number; liquidityScore: number; volumeMcapScore: number; mcapScore: number; }
  lastUpdated: number;
}

export interface Position {
  positionId: string; symbol: string; tokenName: string; pairAddress: string;
  contractAddress: string; imageUrl: string;
  entryPrice: number; exitPrice?: number; sizeSol: number;
  slPercent: number; tpPercent: number; slPrice: number; tpPrice: number;
  entryMarketCap: number; tpMarketCap: number; slMarketCap: number;
  aiScore: number; confidence: number;
  openedAt: string; closedAt?: string; status: "open" | "closed";
  closeReason?: "manual" | "stop_loss" | "take_profit";
  pnlSol?: number; pnlPercent?: number; holdTimeMs?: number;
  note?: string;
  tradeSource?: "bot" | "rss";
  llmVerdict?: "TRADE" | "SKIP" | "RISKY";
  llmProvider?: "gemini" | "groq" | "heuristic" | "none";
  llmConfidence?: number;
  llmReasoning?: string;
  llmRisks?: string[];
  llmStrengths?: string[];
  llmDurationMs?: number;
  llmScore?: number; llmRiskLevel?: string;
  llmSecondaryVerdict?: string; llmSecondaryProvider?: string;
  // tiered TP tracking
  tp1Price?: number; tp2Price?: number;
  tp1Hit?: boolean; tp2Hit?: boolean;
  remainingSizeSol?: number; partialPnlSol?: number;
  pairAgeMinutes?: number;
  // RugCheck on-chain safety data captured at entry
  rugScore?: number;
  rugLpLockedPct?: number;
  rugTopHolderPct?: number;
  rugWarnRisks?: string[];
  // live fields (from getOpenPositionsWithLivePnl)
  livePnlSol?: number; livePnlPercent?: number; currentPrice?: number;
  entryLiquidityUsd?: number;
}

export interface Portfolio {
  solBalance: number; initialBalance: number;
  totalPnlSol: number; totalPnlPercent: number;
  openPositionsCount: number; openPositionsValueSol: number;
}

export interface AnalyticsSnapshot {
  totalTrades: number; winCount: number; lossCount: number; winRate: number;
  totalPnlSol: number; totalPnlPercent: number;
  dailyPnl: number; weeklyPnl: number; monthlyPnl: number;
  bestTradePnl: number; worstTradePnl: number;
  avgRR: number; avgWinSol: number; avgLossSol: number; avgHoldTimeMinutes: number;
  profitFactor: number;
  currentStreak: number;
  currentStreakType: "win" | "loss" | "none";
  winRateLast10: number;
  calendarPnl: Record<string, number>;
}

export interface Alert {
  id: string; type: "trade_opened"|"trade_closed"|"stop_loss_hit"|"take_profit_hit"|"high_ai_score";
  title: string; message: string; pairAddress?: string; tokenSymbol?: string;
  positionId?: string; aiScore?: number; createdAt: number; read: boolean;
}

export interface CircuitBreakerStatus {
  consecutiveLossActive: boolean;
  consecutiveLossResumesAt: number | null;
  consecutiveLossResumesInMin: number | null;
  dailyLossActive: boolean;
  dailyLossResumesAt: number | null;
  dailyLossResumesInHours: number | null;
  currentStreak: number;
  dailyLossSol: number;
}

export interface MarketHealthStatus {
  state: "ACTIVE" | "NEUTRAL" | "DEAD";
  passCount: number;
  checkedAt: number;
  poolSize: number;
  conditions: {
    positiveTokensPassed: boolean;
    positiveTokensCount: number;
    avgBuyRatioPassed: boolean;
    avgBuyRatio: number;
    recentPairsPassed: boolean;
    recentPairsCount: number;
  };
}

export interface AutoTraderStatus {
  paused: boolean; running: boolean; lastRunAt: number | null;
  lastRunTokensEvaluated: number; lastRunTradesOpened: number; totalTradesOpened: number;
  telegramEnabled: boolean; nextRunIn: number; scannerPoolSize: number;
  config: AutoTraderConfig;
  circuitBreaker: CircuitBreakerStatus;
  marketHealth: MarketHealthStatus | null;
}

export interface AutoTraderConfig {
  solPerTrade: number; maxConcurrentTrades: number;
  minAiScore: number; minConfidence: number;
  minLiquidityUsd: number; minVolume24hUsd: number; minVolume1hUsd: number;
  minBuyRatio1h: number; minPriceChange1h: number; minTransactions24h: number;
  minMcapUsd: number; maxMcapUsd: number;
  minPairAgeMinutes: number; maxPairAgeHours: number;
  minLiquidityMcapRatio: number; maxFdvMcapRatio: number;
  maxPriceDropH6Pct: number; maxPriceDropH24Pct: number;
  consecutiveLossLimit: number; consecutiveLossPauseHours: number;
  dailyLossLimitSol: number; dailyLossPauseHours: number;
}

export interface CycleDecision {
  symbol: string; tokenName: string; pairAddress: string;
  aiScore: number; confidence: number;
  liquidityUsd: number; volume24hUsd: number; volume1hUsd: number;
  marketCapUsd: number; buyRatio1h: number; priceChange1h: number;
  pairAgeMinutes: number; priceUsd: number;
  slPercent: number; tpPercent: number;
  action: "traded" | "filtered" | "skipped_duplicate" | "skipped_slots" | "skipped_balance";
  reason: string;
  positionId?: string;
  llmVerdict?: "TRADE" | "SKIP" | "RISKY" | "none";
  llmConfidence?: number;
  llmReasoning?: string;
  llmRisks?: string[];
  llmStrengths?: string[];
  llmProvider?: string;
  llmDurationMs?: number;
}

export type LossTag =
  | "rug_speed" | "fast_rug" | "slow_dump" | "no_ai_recovery"
  | "borderline_score" | "borderline_conf"
  | "thin_liquidity" | "micro_cap" | "large_cap"
  | "high_fdv_risk" | "fake_price"
  | "quick_tp" | "strong_win" | "high_score_win" | "good_liquidity_win" | "momentum_win";

export interface LossJournalEntry {
  positionId: string;
  symbol: string;
  contractAddress: string;
  openedAt: string;
  closedAt: string;
  holdTimeMs: number;
  pnlSol: number;
  pnlPercent: number;
  aiScore: number;
  confidence: number;
  entryMcapUsd: number;
  entryLiquidityUsd: number;
  slPercent: number;
  tpPercent: number;
  tags: LossTag[];
  warnings: string[];
  recordedAt: number;
  note?: string;
  isWin: boolean;
}

export interface FilterSuggestion {
  filter: string;
  currentValue: string | number;
  suggestedValue: string | number;
  reason: string;
  priority: "high" | "medium" | "low";
  confidence: number;
}

export interface LossInsights {
  totalLosses: number;
  totalWins: number;
  totalTrades: number;
  totalLossSol: number;
  totalWinSol: number;
  avgLossSol: number;
  avgWinSol: number;
  avgHoldMinutes: number;
  avgWinHoldMinutes: number;
  avgLossHoldMinutes: number;
  tagFrequency: Record<string, number>;
  tagPercentage: Record<string, number>;
  winTagPercentage: Record<string, number>;
  lossTagPercentage: Record<string, number>;
  avgAiScore: number;
  avgConfidence: number;
  borderlineScoreCount: number;
  borderlineConfCount: number;
  instantRugs: number;
  fastRugs: number;
  slowDumps: number;
  longLosses: number;
  suggestions: FilterSuggestion[];
  recentLosses: LossJournalEntry[];
  recentWins: LossJournalEntry[];
  allEntries: LossJournalEntry[];
}

export interface CycleRecord {
  cycleId: number;
  startedAt: number;
  finishedAt: number;
  tokensEvaluated: number;
  tradesOpened: number;
  decisions: CycleDecision[];
}

// ── Pump.fun Pre-Graduation Trader (Module A) ─────────────────────────────────

export interface PumpfunScoreBreakdown {
  graduationSpeed: number;
  volumeAcceleration: number;
  uniqueBuyerGrowth: number;
  txVelocity: number;
  mcapAcceleration: number;
  holderDistribution: number;
  whaleAccumulation: number;
  creatorRisk: number;
  momentumStrength: number;
  total: number;
}

export type PumpfunTokenStatus =
  | "watching" | "candidate" | "buySignal" | "bought"
  | "graduated" | "exited" | "rejected";

export interface PumpfunTrackedToken {
  mint: string;
  symbol: string;
  name: string;
  firstSeen: number;
  lastUpdated: number;
  priceUsd: number;
  mcap: number;
  graduationPct: number;
  pairAddress: string;
  uniqueBuyers: string[];
  score: number;
  scoreBreakdown: PumpfunScoreBreakdown;
  status: PumpfunTokenStatus;
  rejectionReason?: string;
  positionId?: string;
  creatorSold: boolean;
}

export interface PumpfunPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  detectedAt: number;
  entryAt: number;
  entryPrice: number;
  entryMcap: number;
  entryGraduationPct: number;
  entryScore: number;
  currentPrice: number;
  sizeSol: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
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
}

export interface PumpfunEvent {
  id: string;
  ts: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "rejected";
  skipReason?: string;
  score?: number;
  graduationPct?: number;
}

export interface PumpfunScoreWeights {
  graduationSpeed: number;
  volumeAcceleration: number;
  uniqueBuyerGrowth: number;
  txVelocity: number;
  mcapAcceleration: number;
  holderDistribution: number;
  whaleAccumulation: number;
  creatorRisk: number;
  momentumStrength: number;
}

export interface PumpfunConfig {
  enabled: boolean;
  minAiScore: number;
  positionSizeSol: number;
  maxOpenPositions: number;
  graduationMinPct: number;
  graduationMaxPct: number;
  virtualBalanceSol: number;
  scoreWeights: PumpfunScoreWeights;
}

export interface PumpfunStatus {
  wsConnected: boolean;
  wsReconnects: number;
  ppConnected: boolean;
  ppReconnects: number;
  solPriceUsd: number;
  enabled: boolean;
  trackedCount: number;
  candidateCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  virtualBalance: number;
  openCount: number;
  config: PumpfunConfig;
}

// ── Graduation Sniper ────────────────────────────────────────────────────────

export interface SniperConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  tp3Pct: number;
  tp3ClosePct: number;
  trailingStopPct: number;
  trailingStopAfterTp2Pct: number;
  trailingStopAfterTp3Pct: number;
  runnerTrailingPct: number;
  waitBeforeEntryMs: number;
  slippageBps: number;
  priorityFeeLamports: number;
  jitoTipLamports: number;
  minQualityScore: number;
  maxEntryWindowMs: number;
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
  entrySig: string;
  exitSig?: string;
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  tp3RealizedSol: number;
  runnerRealizedSol: number;
  // Runtime-only fields (not persisted to DB) — populated by getOpenPositions()
  closingAttempt?: number;
  isStuck?: boolean;
  lastError?: string;
  lastPriceAt?: number;
  // Entry drift / latency analysis
  detectionPrice?: number;
  entryDriftPct?: number;
  msDetectionToFill?: number;
  // Quality metrics at entry
  qualityScore?: number;
  liquiditySol?: number;
  buyPressureRatio?: number;
  uniqueBuyers?: number;
  topHolderPct?: number;
  whaleDetected?: boolean;
  positionMultiplier?: number;
}

export interface SniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "watching";
  skipReason?: string;
  txSignature: string;
  // Quality metrics (present for entered + quality-skipped events)
  qualityScore?: number;
  liquiditySol?: number;
  uniqueBuyers?: number;
  buyPressureRatio?: number;
  topHolderPct?: number;
  creatorHoldingsPct?: number;
  whaleDetected?: boolean;
  // Staged re-evaluation fields (present for watching events)
  watchStage?: "T+180s" | "T+600s";
  baselineBuyers?: number;
  baselineLiq?: number;
}

export interface SniperStatus {
  wsConnected: boolean;
  wsReconnects: number;
  lastWsMessageAt: number;     // ms epoch; 0 = never received a message this session
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

// ── Paper Sniper ─────────────────────────────────────────────────────────────

export interface PaperPosition {
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
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
  detectionPrice?: number;
  entryDriftPct?: number;
  msDetectionToFill?: number;
  lastPriceAt?: number;
}

export interface PaperSniperEvent {
  id: string;
  detectedAt: number;
  mint: string;
  symbol: string;
  action: "entered" | "skipped" | "closed" | "watching";
  skipReason?: string;
  closeReason?: string;
  pnlSol?: number;
  watchStage?: "T+180s" | "T+600s";
  baselineBuyers?: number;
  baselineLiq?: number;
  qualityScore?: number;
  uniqueBuyers?: number;
  liquiditySol?: number;
}

export interface PaperConfig {
  positionSizeSol:    number;
  maxOpenPositions:   number;
  tp1Pct:             number;
  tp1ClosePct:        number;
  tp2Pct:             number;
  tp2ClosePct:        number;
  tp3Pct:             number;
  tp3ClosePct:        number;
  trailingStopPct:    number;
  slPhase1Pct:        number;
  slPhase2Pct:        number;
  slPhase3Pct:        number;
  slAfterTp1Pct:      number;
  deadCoinWindowMs:     number;
  deadCoinMinMovePct:   number;
  maxFillDriftPct:      number;
  simulatedExecDelayMs: number;
  // Quality pre-entry filters
  enableLiquidityFilter:    boolean;
  minLiquidityUsd:          number;
  enableBondingCurveFilter: boolean;
  maxBondingCurveMinutes:   number;
  enableHolderFilter:       boolean;
  minHolderCount:           number;
  // Strategy exit filters
  enableCreatorFilter:      boolean;
  maxCreatorHoldingsPct:    number;
  enableSellPressureExit:   boolean;
  enableWhaleDumpExit:      boolean;
  // Quality scoring thresholds (paper-configurable)
  minUniqueBuyers:          number;
  minBuyPressureRatio:      number;
  maxTopHolderPct:          number;
  minLiquiditySolQuality:   number;
}

export interface PaperSniperStatus {
  enabled: boolean;
  virtualBalance: number;
  startingBalance: number;
  openCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  totalCombinedPnlSol: number;
  capitalInOpen: number;
  config: PaperConfig;
}

// ── Stuck tokens — tokens in wallet not tracked as open positions ──────────────
export interface StuckToken {
  mint: string;
  symbol: string;         // from open-position record (if found) or "UNKNOWN"
  uiAmount: number;       // human-readable token balance (e.g. 1,234.56)
  rawAmount: number;      // raw token units (used for sell)
  raydiumUrl: string;     // quick-sell link
}

// ── Sniper health metrics — rate counters + connection status ─────────────────
export interface SniperHealthMetrics {
  jupiterCallsThisMinute: number;
  dexscreenerCallsThisMinute: number;
  jupiterCallsTotal: number;
  dexscreenerCallsTotal: number;
  wsConnected: boolean;
  isLowLiquidityHour: boolean;
  openPositions: number;
  walletBalance: number;
  uptimeMs: number;
}
