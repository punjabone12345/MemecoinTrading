export interface Settings {
  botEnabled: boolean;
  startingBalanceSol: number;
  currentBalanceSol: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  whaleSlippagePct: number;
  whaleStagnationPct: number;  // exit if |priceChange1h| < this %, after 1h open
  // Trading window (IST)
  tradingWindowEnabled: boolean;
  tradingWindowStart: string;  // HH:MM in IST, e.g. "17:00"
  tradingWindowEnd: string;    // HH:MM in IST, e.g. "00:00" means midnight (end of day)
  // Whale TP tier configs (10s vol $750-$1499 / $1500-$2249 / $2250+)
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
  // Live market data (refreshed every 30s by the server)
  price?: number;
  mcap?: number;
  liquidity?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  volume5m?: number;
  lastMarketUpdate?: number;
}

export interface WhalePosition {
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
  // Multi-stage TP
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  initialSizeSol: number;
  remainingSizeSol: number;
  bankedSol: number;
  tpTier: 1 | 2 | 3;
  triggerAmountUsd: number;
  currentSLPrice: number;
  // Timing: when whale bought vs when we entered
  whaleBuyTimestamp?: number;
  entryDelayMs?: number;
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
