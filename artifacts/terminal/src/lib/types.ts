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
  scoreBreakdown: ScoreBreakdown;
  filterResults: FilterResult[];
  consecutiveTrending: number;
  volume1hPrev: number;
  volume1hCurrent: number;
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
  tp3Pct: number;
  tp3ClosePct: number;
  trailingSLPct: number;
  maxDailyLossPct: number;
  startingBalanceSol: number;
  currentBalanceSol: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
}

export interface ScanStats {
  scanning: number;
  passed: number;
  eligible: number;
}
