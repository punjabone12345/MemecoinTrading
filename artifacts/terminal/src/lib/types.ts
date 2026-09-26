export interface Settings {
  botEnabled: boolean;
  startingBalanceUsd: number;
  currentBalanceUsd: number;
  riskPerTradePct: number;
  maxOpenPositions: number;
  minAiScore: number;
  minRiskRewardRatio: number;
  universeSize: number;
  paperTradingOnly: boolean;
  liveTradingEnabled: boolean;

  // Optional / legacy fields
  startingBalanceSol?: number;
  currentBalanceSol?: number;
  positionSizeSol?: number;
  sniperSlippagePct?: number;
  sniperStagnationPct?: number;
  tradingWindowEnabled?: boolean;
  tradingWindowStart?: string;
  tradingWindowEnd?: string;
  emaPeriodMinutes?: number;
  pumpTargetPct?: number;
  rugcheckRetryDelayMin?: number;
  fakeSetupSpikeCapUsd?: number;
  maxTrackingDurationMin?: number;
  rpcEndpoint?: string;
  slippagePct?: number;
  priorityFeeSol?: number;
  walletPublicKey?: string;
  tp1Pct?: number;
  tp1ExitPct?: number;
  tp2Pct?: number;
  tp2ExitPct?: number;
  tp3Pct?: number;
  tp3ExitPct?: number;
  trailingSLPct?: number;
  minLiquidity?: number;
  minMc?: number;
  sustainDurationSec?: number;
  [key: string]: any;
}

export interface AltcoinAsset {
  id: string;
  symbol: string;
  name: string;
  category: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  high24h: number;
  low24h: number;
  isMemecoin: boolean;
  isStablecoin: boolean;
  liquidityScore: number;
  tradabilityScore: number;
  universeRank: number;
  lastUpdated: number;
}

export interface ScoreBreakdown {
  trend: number;
  momentum: number;
  volume: number;
  structure: number;
  volatility: number;
  htfAlignment: number;
}

export type SignalStatus = 'NO_SETUP' | 'WATCHING' | 'NEAR_ENTRY' | 'ENTRY_READY' | 'IN_POSITION' | 'COOLDOWN' | 'BLOCKED';
export type SetupType = 'TREND_CONTINUATION' | 'BREAKOUT' | 'PULLBACK' | 'REVERSAL' | 'NONE';

export interface TradeThesis {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskDistancePct: number;
  rewardDistancePct: number;
  riskRewardRatio: number;
  invalidationLevel: number;
  targetLevel: number;
  explanation: string[];
}

export interface AltcoinSignal {
  assetId: string;
  symbol: string;
  name: string;
  category: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  aiScore: number;
  scoreBreakdown: ScoreBreakdown;
  status: SignalStatus;
  setupType: SetupType;
  mtfTrend: {
    tf4h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    tf1h: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    tf15m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    tf5m: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  };
  reason: string;
  missingCondition: string | null;
  tradeThesis: TradeThesis;
  lastUpdated: number;
}

export interface PaperPortfolio {
  startingBalanceUsd: number;
  currentEquityUsd: number;
  availableBalanceUsd: number;
  usedMarginUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  totalTrades: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalFeesUsd: number;
}

export interface PaperPosition {
  id: string;
  assetId: string;
  symbol: string;
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeUsd: number;
  quantity: number;
  riskAmountUsd: number;
  riskPct: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  rMultiple: number;
  aiScoreAtEntry: number;
  setupType: SetupType;
  entryTime: number;
  tradeThesis: string[];
}

export interface ClosedPaperPosition extends PaperPosition {
  closeTime: number;
  closePrice: number;
  closeReason: 'TP_HIT' | 'SL_HIT' | 'MANUAL_EXIT' | 'INVALIDATED';
  realizedPnlUsd: number;
  realizedPnlPct: number;
  finalR: number;
}

export interface LearningMetrics {
  modelVersion: string;
  trainingSamples: number;
  validationSamples: number;
  historicalExpectancyR: number;
  candidateExpectancyR: number;
  validationResult: 'IMPROVED' | 'STABLE' | 'REJECTED';
  status: 'ACTIVE' | 'CANDIDATE' | 'REJECTED';
  lastRetrainedAt: number;
  insights: string[];
}

export interface SystemHealth {
  marketDataStatus: 'CONNECTED' | 'DEGRADED' | 'OFFLINE';
  databaseStatus: 'HEALTHY' | 'ERROR';
  scannerStatus: 'RUNNING' | 'STOPPED';
  paperEngineStatus: 'RUNNING' | 'STOPPED';
  learningEngineStatus: 'RUNNING' | 'IDLE';
  lastMarketUpdate: number;
  lastScannerRun: number;
  lastLearningRun: number;
  apiErrorsCount: number;
}

export interface AltcoinStatusResponse {
  serverStartMs: number;
  portfolio: PaperPortfolio;
  signals: AltcoinSignal[];
  openPositions: PaperPosition[];
  closedPositions: ClosedPaperPosition[];
  topOpportunities: AltcoinSignal[];
  health: SystemHealth;
  learning: LearningMetrics;
  stats: {
    totalTracked: number;
    watching: number;
    nearEntry: number;
    entryReady: number;
    openPositions: number;
  };
}

// ── Legacy sniper & diagnostic compatibility interfaces ────────────────────────

export interface BuyerActivity {
  wallet: string;
  amountSol: number;
  amountUsd: number;
  timestamp: number;
  txSignature?: string;
  walletScore?: number;
  gmgnScore?: unknown;
}

export interface TokenCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  poolAddress?: string;
  migrationTime: number;
  firstDiscoveredAt?: number;
  expiresAt: number;
  entryTriggered: boolean;
  buyerActivity: BuyerActivity[];
  rugcheckPassed?: boolean;
  rugcheckAttempts?: number;
  rugcheckRetryAt?: number | null;
  launchMcap?: number;
  candlesCount?: number;
  candles?: TokenCandle[];
  ema20?: number | null;
  ema20Mcap?: number | null;
  emaStartMcap?: number | null;
  pumpTargetMcap?: number | null;
  peakMcapSinceEma?: number;
  pumpTargetHit?: boolean;
  recent20MinLowMcap?: number;
  recent20MinLowPrice?: number;
  sustainStartedAt?: number | null;
  sustainAttempts?: number;
  lastResetReason?: string | null;
  status?: string;
  dexId?: string;
  price?: number;
  mcap?: number;
  liquidity?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange24h?: number;
  volume5m?: number;
  volume1h?: number;
  volume24h?: number;
  txnsH1Buys?: number;
  txnsH1Sells?: number;
  txnsH24Buys?: number;
  txnsH24Sells?: number;
  lastMarketUpdate?: number;
}

export interface SniperPosition {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryMcap: number;
  entryTime: number;
  sizeSol: number;
  sizePct: number;
  peakPrice: number;
  lastPrice: number;
  lastLiquidity: number;
  baselineLiquidity: number;
  migrationTime: number;
  pnlPct: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  initialSizeSol: number;
  remainingSizeSol: number;
  bankedSol: number;
  tpTier: 1 | 2 | 3;
  triggerAmountUsd: number;
  currentSLPrice: number;
  buyDetectedTimestamp?: number;
  entryDelayMs?: number;
  entryMode?: 'solo' | 'consensus';
  entryScore?: number;
  qualifyingWalletsCount?: number;
  buyerWallet?: string;
  priceSource?: 'vault' | 'pool-account' | 'jupiter';
  priceAtDetection?: number;
  actualSlippagePct?: number;
  maxSlippagePct?: number;
}

export interface ClosedSniperPosition extends SniperPosition {
  closeTime: number;
  closeReason: string;
  closePnlPct: number;
}

export interface BuyerActivityLog {
  mint: string;
  name: string;
  symbol: string;
  wallet: string;
  amountUsd: number;
  timestamp: number;
  detectedAt: number;
  txSig: string;
  txType?: 'buy' | 'sell';
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
  walletScore?: number;
  consensusMode?: 'solo' | 'consensus' | 'tracking' | 'none' | 'ban_queued';
  qualifyingWalletsCount?: number;
  gmgnScore?: unknown;
}

export interface PendingSignal {
  mint: string;
  name: string;
  symbol: string;
  sizePct: number;
  triggerAmountUsd: number;
  queuedAt: number;
  priceAtDetection: number;
}

export interface DiagToken {
  mint: string;
  name: string;
  symbol: string;
  first_seen_at: number;
  first_seen_utc: string;
  first_seen_ist: string;
  discovery_source: string;
  initial_mc: number;
  initial_liquidity: number;
  initial_volume: number;
  initial_buy_sell_ratio: number;
  current_mc: number;
  current_liquidity: number;
  current_volume: number;
  current_buy_sell_ratio: number;
  current_wallet_score: number;
  current_qualifying_wallets: number;
  current_age_minutes: number;
  highest_mc: number;
  highest_liquidity: number;
  highest_volume: number;
  highest_buy_sell_ratio: number;
  highest_wallet_score: number;
  highest_qualifying_wallets: number;
  scan_count: number;
  passed_mc_at: number | null;
  passed_liquidity_at: number | null;
  passed_volume_at: number | null;
  passed_rugcheck_at: number | null;
  passed_holder_at: number | null;
  passed_creator_at: number | null;
  passed_wallet_at: number | null;
  passed_entry_at: number | null;
  status: string;
  reject_reason: string | null;
  entry_time: number | null;
  entry_price: number | null;
  entry_mc: number | null;
  entry_wallet_score: number | null;
  entry_qualifying_wallets: number | null;
  entry_mode: string | null;
  entry_risk_tier: string | null;
  entry_reason: string | null;
  last_updated: number;
  created_at: number;
  proximity_score?: number;
  rugcheck_score?: number | null;
  sustain_started_at?: number | null;
  sustain_attempts?: number;
  last_reset_reason?: string | null;
}

export interface DiagError {
  id: number;
  error_type: string;
  message: string;
  mint: string | null;
  details: unknown;
  occurred_at: number;
  occurred_utc: string;
}

export interface DiagFunnelStats {
  total: string;
  passed_rugcheck: string;
  tracking: string;
  thresholds_reached: string;
  sustain_started: string;
  trade_eligible: string;
  traded: string;
  rejected_rugcheck: string;
  rejected_sustain_reset: string;
  expired: string;
  rejected_other: string;
}

export interface DiagDailySummary {
  date: string;
  total_discovered: string;
  total_scans: string;
  avg_scans: string;
  passed_mc: string;
  passed_liquidity: string;
  passed_volume: string;
  passed_rugcheck: string;
  passed_wallet: string;
  passed_entry: string;
  total_traded: string;
  total_rejected: string;
  total_expired: string;
  total_tracked: string;
  rejectionBreakdown: { reject_reason: string; count: string }[];
  errorSummary: { error_type: string; count: string }[];
}

export interface DiagTransaction {
  tx_signature: string;
  mint: string;
  tx_type: 'buy' | 'sell';
  wallet: string;
  amount_usd: number | string;
  tx_timestamp: number | string;
  detected_at: number | string;
  price_at_detection: number | string;
  decision: string;
  decision_reason: string;
  wallet_score: number | string;
  win_rate: number | string | null;
  avg_roi_pct: number | string | null;
  completed_trades: number | string | null;
  wallet_age_days: number | string | null;
  avg_hold_minutes: number | string | null;
  score_points: {
    winRate?: number;
    walletAge?: number;
    completedTrades?: number;
    roi?: number;
    holdTime?: number;
  };
  score_source: string;
  score_status: string;
  consensus_mode: string | null;
  qualifying_wallets: number | string;
  created_at: number | string;
  created_utc?: string;
}

export interface SniperStatus {
  serverStartMs: number;
  trackedTokens: TrackedToken[];
  openPositions: SniperPosition[];
  closedPositions: ClosedSniperPosition[];
  recentBuyLog: BuyerActivityLog[];
  queuedSignals: PendingSignal[];
  solPriceUsd: number;
  pendingCount: number;
  gmgnConfigured: boolean;
  gmgnBannedUntil: number;
  stats: { tracking: number; positions: number; queued: number; pending: number };
}
