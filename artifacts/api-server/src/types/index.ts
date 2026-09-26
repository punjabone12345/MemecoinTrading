export interface Settings {
  botEnabled: boolean;
  startingBalanceUsd: number;
  currentBalanceUsd: number;
  riskPerTradePct: number;       // e.g. 0.5% risk per trade
  maxOpenPositions: number;       // default 5
  minAiScore: number;            // default 75
  minRiskRewardRatio: number;    // default 2.0
  universeSize: number;          // default 100
  paperTradingOnly: boolean;     // true
  liveTradingEnabled: boolean;   // false

  // Legacy & background service compatibility fields
  startingBalanceSol: number;
  currentBalanceSol: number;
  positionSizeSol: number;
  sniperSlippagePct: number;
  sniperStagnationPct: number;
  tradingWindowEnabled: boolean;
  tradingWindowStart: string;
  tradingWindowEnd: string;
  emaPeriodMinutes: number;
  pumpTargetPct: number;
  rugcheckRetryDelayMin: number;
  fakeSetupSpikeCapUsd: number;
  maxTrackingDurationMin: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  tp1Pct: number;
  tp1ExitPct: number;
  tp2Pct: number;
  tp2ExitPct: number;
  tp3Pct: number;
  tp3ExitPct: number;
  trailingSLPct: number;
  wt1Tp1Pct: number;
  wt1Tp1Exit: number;
  wt1Tp2Pct: number;
  wt1Tp2Exit: number;
  wt1Tp2Trail: number;
  wt1Tp3Pct: number;
  wt1Tp3Exit: number;
  wt1Tp3Trail: number;
  wt2Tp1Pct: number;
  wt2Tp1Exit: number;
  wt2Tp2Pct: number;
  wt2Tp2Exit: number;
  wt2Tp2Trail: number;
  wt2Tp3Pct: number;
  wt2Tp3Exit: number;
  wt2Tp3Trail: number;
  wt3Tp1Pct: number;
  wt3Tp1Exit: number;
  wt3Tp2Pct: number;
  wt3Tp2Exit: number;
  wt3Tp2Trail: number;
  wt3Tp3Pct: number;
  wt3Tp3Exit: number;
  wt3Tp3Trail: number;
  minLiquidity: number;
  minMc: number;
  sustainDurationSec: number;
  [key: string]: any;
}

export interface AltcoinAsset {
  id: string;                    // e.g. "hype", "link", "avax"
  symbol: string;                // e.g. "HYPE", "LINK", "AVAX"
  name: string;                  // e.g. "Hyperliquid", "Chainlink"
  category: string;              // e.g. "L1/L2", "DeFi", "Oracle", "AI"
  price: number;                 // current USD price
  priceChange24h: number;        // % change 24h
  volume24h: number;             // 24h volume USD
  marketCap: number;             // Market Cap USD
  high24h: number;
  low24h: number;
  isMemecoin: boolean;           // false
  isStablecoin: boolean;         // false
  liquidityScore: number;        // 0-100
  tradabilityScore: number;      // 0-100
  universeRank: number;          // 1 to 100
  lastUpdated: number;           // timestamp ms
}

export interface ScoreBreakdown {
  trend: number;         // 0-20
  momentum: number;      // 0-20
  volume: number;        // 0-20
  structure: number;     // 0-20
  volatility: number;    // 0-10
  htfAlignment: number;  // 0-10
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
  aiScore: number;               // 0-100
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
  closeReason: 'TP_HIT' | 'SL_HIT' | 'MANUAL_EXIT' | 'INVALIDATED' | (string & {});
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
    tracking?: number;
    positions?: number;
    pending?: number;
    queued?: number;
    discovered?: number;
  };
}

export interface WSMessage {
  type: 'altcoin_status' | 'balance' | 'alert' | 'settings' | 'sniper_status';
  data: unknown;
}
