export interface Settings {
  botEnabled: boolean;
  startingBalanceSol: number;
  currentBalanceSol: number;
  rpcEndpoint: string;
  slippagePct: number;
  priorityFeeSol: number;
  walletPublicKey: string;
  sniperSlippagePct: number;
  sniperStagnationPct: number;  // exit if |priceChange1h| < this %, after 1h open
  // Trading window (IST)
  tradingWindowEnabled: boolean;
  tradingWindowStart: string;  // HH:MM in IST, e.g. "17:00"
  tradingWindowEnd: string;    // HH:MM in IST, e.g. "00:00" means midnight (end of day)
  // Sniper TP tier configs (10s vol $750-$1499 / $1500-$2249 / $2250+)
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

export interface BuyerActivity {
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
  buyerActivity: BuyerActivity[];
  // Live market data (refreshed every 30s by the server)
  price?: number;
  mcap?: number;
  liquidity?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  volume5m?: number;
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
  // Timing: when the triggering buy happened vs when we entered
  buyDetectedTimestamp?: number;
  entryDelayMs?: number;
  // Entry checklist — which filters/conditions fired at entry
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
  txSig: string;
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
  walletScore?: number;
  consensusMode?: 'solo' | 'consensus' | 'tracking' | 'none';
  qualifyingWalletsCount?: number;
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

export interface SniperStatus {
  trackedTokens: TrackedToken[];
  openPositions: SniperPosition[];
  closedPositions: ClosedSniperPosition[];
  recentBuyLog: BuyerActivityLog[];
  queuedSignals: PendingSignal[];
  solPriceUsd: number;
  pendingCount: number;
  gmgnConfigured: boolean;
  gmgnBannedUntil: number; // unix ms; 0 if not currently rate-limit banned
  stats: { tracking: number; positions: number; queued: number; pending: number };
}
