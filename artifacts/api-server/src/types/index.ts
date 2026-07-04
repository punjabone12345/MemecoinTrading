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
  age: number; // hours
  dexId: string;
  pairAddress: string;
  price: number;
  rugcheck: boolean;
  freezeAuthority: boolean;
  mintAuthority: boolean;
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
  lastChecked: number;
  sources: string[];
}

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

export interface Settings {
  // Scanning
  minMc: number;
  maxMc: number;
  minVolume24h: number;
  minAgeHours: number;
  maxAgeHours: number;
  scanFrequencyMs: number;
  // Filters
  minBuySellRatio: number;
  maxTopHolder: number;
  maxCreatorPct: number;
  minLiquidity: number;
  rugcheckEnabled: boolean;
  // Scoring
  minEntryScore: number;
  trendChecksRequired: number;
  // Positions
  maxOpenPositions: number;
  sizeScore90: number;
  sizeScore80: number;
  sizeScore70: number;
  // TP/SL
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
  // Daily limit
  maxDailyLossPct: number;
  // Paper
  startingBalanceSol: number;
  currentBalanceSol: number;
  // Live
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  whaleSlippagePct: number;
  whaleStagnationPct: number;  // exit if |priceChange1h| < this %, after 1h open
  // Whale TP tier configs ($500-$999 / $1000-$1999 / $2000+)
  wt1Tp1Pct: number;  wt1Tp1Exit: number;
  wt1Tp2Pct: number;  wt1Tp2Exit: number;  wt1Tp2Trail: number;
  wt1Tp3Pct: number;  wt1Tp3Exit: number;  wt1Tp3Trail: number;
  wt2Tp1Pct: number;  wt2Tp1Exit: number;
  wt2Tp2Pct: number;  wt2Tp2Exit: number;  wt2Tp2Trail: number;
  wt2Tp3Pct: number;  wt2Tp3Exit: number;  wt2Tp3Trail: number;
  wt3Tp1Pct: number;  wt3Tp1Exit: number;
  wt3Tp2Pct: number;  wt3Tp2Exit: number;  wt3Tp2Trail: number;
  wt3Tp3Pct: number;  wt3Tp3Exit: number;  wt3Tp3Trail: number;
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
}

export interface WSMessage {
  type: 'positions' | 'tokens' | 'analytics' | 'balance' | 'alert' | 'settings';
  data: unknown;
}
