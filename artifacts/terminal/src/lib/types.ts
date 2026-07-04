export interface ScoreBreakdown {
  priceMomentum: number;
  volumeMomentum: number;
  buyPressure: number;
  mcQuality: number;
  total: number;
}

export interface FilterResult {
  name: string;
  passed: boolean;
  value: string;
  required: string;
}

export interface Token {
  mint: string;
  name: string;
  symbol: string;
  score: number;
  marketCap: number;
  volume24h: number;
  priceChange1h: number;
  priceChange5m: number;
  priceChange24h: number;
  buySellRatio: number;
  liquidity: number;
  age: number;
  dexId: string;
  pairAddress: string;
  price: number;
  rugcheck: boolean;
  topHolder: number;
  creatorPct: number;
  status: 'SCANNING' | 'ELIGIBLE' | 'ENTERED' | 'REJECTED';
  rejectReason?: string;
  tradedToday?: boolean;
  scoreBreakdown: ScoreBreakdown;
  filterResults: FilterResult[];
  consecutiveTrending: number;
  volume1hPrev: number;
  volume1hCurrent: number;
  lastChecked?: number;
  sources?: string[];
}

export interface Position {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryMc: number;
  entryTime: string;
  exitPrice?: number;
  exitMc?: number;
  exitTime?: string;
  sizeSol: number;
  pnlSol?: number;
  pnlPct?: number;
  scoreAtEntry: number;
  peakPrice: number;
  slCurrent: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  closeReason?: string;
  status: 'OPEN' | 'CLOSED';
  mode: 'paper' | 'live';
  txSignature?: string;
  currentPrice?: number;
  currentMc?: number;
  buySellRatio?: number;
  dexUrl?: string;
  notes?: string;
  initialSizeSol?: number;
  bankdProfitSol?: number;
  sources?: string[];
}

export interface Analytics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalPnlSol: number;
  bestTrade: number;
  worstTrade: number;
  currentStreak: number;
  maxWinStreak: number;
  maxLossStreak: number;
  maxDrawdown: number;
  avgHoldTimeMinutes: number;
  dailyPnl: number;
  openPositionsCount: number;
  unrealizedPnl: number;
  balance?: number;
}

export interface Settings {
  minMc: number;
  maxMc: number;
  minVolume24h: number;
  minAgeHours: number;
  maxAgeHours: number;
  scanFrequencyMs: number;
  minBuySellRatio: number;
  maxTopHolder: number;
  maxCreatorPct: number;
  minLiquidity: number;
  rugcheckEnabled: boolean;
  minEntryScore: number;
  trendChecksRequired: number;
  maxOpenPositions: number;
  sizeScore90: number;
  sizeScore80: number;
  sizeScore70: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  tp2TrailPct: number;
  tp3Pct: number;
  tp3ClosePct: number;
  trailingSLPct: number;
  trailActivatePct: number;
  maxDailyLossPct: number;
  startingBalanceSol: number;
  currentBalanceSol: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  whaleSlippagePct: number;
}

export interface WhaleBuy {
  wallet: string;
  amountUsd: number;
  timestamp: number;
  txSig: string;
  priceAtDetection: number;
}

export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  poolAddress?: string;
  migrationTime: number;
  expiresAt: number;
  entryTriggered: boolean;
  whaleBuys: WhaleBuy[];
}

export interface WhalePosition {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryTime: number;
  sizeSol: number;
  sizePct: number;
  peakPrice: number;
  lastPrice: number;
  lastLiquidity: number;
  baselineLiquidity: number;
  migrationTime: number;
  pnlPct: number;
}

export interface ClosedWhalePosition extends WhalePosition {
  closeTime: number;
  closeReason: string;
  closePnlPct: number;
}

export interface WhaleBuyLog {
  mint: string;
  name: string;
  symbol: string;
  wallet: string;
  amountUsd: number;
  timestamp: number;
  txSig: string;
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
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

export interface WhaleStatus {
  trackedTokens: TrackedToken[];
  openPositions: WhalePosition[];
  closedPositions: ClosedWhalePosition[];
  recentBuyLog: WhaleBuyLog[];
  queuedSignals: PendingSignal[];
  solPriceUsd: number;
  pendingCount: number;
  stats: { tracking: number; positions: number; queued: number; pending: number };
}

export interface ScanStats {
  scanning: number;
  passed: number;
  eligible: number;
  dailyLossLimitHit?: boolean;
  dailyPnl?: number;
  dailyLossLimit?: number;
  ageBanned?: number;
  freshQueueSize?: number;
  pumpPortalConnected?: boolean;
  pumpfunPolling?: boolean;
  rejectionCounts?: Record<string, number>;
  trenchesCount?: number;
  pumpfunCount?: number;
  meteoraCount?: number;
}
