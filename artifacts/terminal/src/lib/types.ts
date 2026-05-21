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

export interface AutoTraderStatus {
  paused: boolean; running: boolean; lastRunAt: number | null;
  lastRunTokensEvaluated: number; lastRunTradesOpened: number; totalTradesOpened: number;
  telegramEnabled: boolean; nextRunIn: number; scannerPoolSize: number;
  config: AutoTraderConfig;
  circuitBreaker: CircuitBreakerStatus;
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
