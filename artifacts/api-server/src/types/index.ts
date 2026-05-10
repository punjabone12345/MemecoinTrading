export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    h24: number;
    h6: number;
    h1: number;
    m5: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
  info?: {
    imageUrl?: string;
    websites?: { label: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
  boosts?: { active: number };
}

export interface ScannedToken {
  pairAddress: string;
  name: string;
  symbol: string;
  address: string;
  priceUsd: number;
  priceNative: number;
  liquidity: number;
  marketCap: number;
  fdv: number;
  volume24h: number;
  volume1h: number;
  volume5m: number;
  buys24h: number;
  sells24h: number;
  buys1h: number;
  sells1h: number;
  buys5m: number;
  sells5m: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  pairAge: number;
  pairAgeLabel: string;
  dexId: string;
  chainId: string;
  url: string;
  imageUrl?: string;
  aiScore: number;
  signals: TokenSignals;
  lastUpdated: number;
}

export interface TokenSignals {
  volumeSpike: boolean;
  buyPressure: boolean;
  highMomentum: boolean;
  lowLiquidity: boolean;
  liquidityScore: number;
  volumeScore: number;
  buyPressureScore: number;
  momentumScore: number;
  volatilityScore: number;
  liquidityMcapRatioScore: number;
  momentumLabel: "🔥 HOT" | "📈 RISING" | "😴 NEUTRAL" | "📉 FALLING";
}

export type TradeStatus = "open" | "closed";
export type TradeDirection = "buy";
export type CloseReason =
  | "manual"
  | "stop_loss"
  | "take_profit"
  | "trailing_stop";

export interface TradeEntry {
  id: string;
  pairAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenAddress: string;
  direction: TradeDirection;
  status: TradeStatus;
  entryPrice: number;
  exitPrice?: number;
  solAmount: number;
  tokenAmount: number;
  entryFee: number;
  exitFee?: number;
  slippage: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
  trailingStopHighPrice?: number;
  trailingStopTriggerPrice?: number;
  openedAt: number;
  closedAt?: number;
  closeReason?: CloseReason;
  pnlSol?: number;
  pnlPercent?: number;
  aiScoreAtEntry?: number;
}

export interface Portfolio {
  solBalance: number;
  initialBalance: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  openPositionsCount: number;
  openPositionsValueSol: number;
}

export interface BuyOrderRequest {
  pairAddress: string;
  solAmount: number;
  stopLoss?: number;
  takeProfit?: number;
  trailingStop?: number;
}

export interface SellOrderRequest {
  tradeId: string;
}

export interface AnalyticsSnapshot {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  dailyPnl: number;
  weeklyPnl: number;
  monthlyPnl: number;
  bestTradePnl: number;
  worstTradePnl: number;
  avgRR: number;
  avgWinSol: number;
  avgLossSol: number;
  avgHoldTimeMinutes: number;
  calendarPnl: Record<string, number>;
}

export interface Alert {
  id: string;
  type:
    | "trade_opened"
    | "trade_closed"
    | "stop_loss_hit"
    | "take_profit_hit"
    | "trailing_stop_hit"
    | "high_ai_score";
  title: string;
  message: string;
  pairAddress?: string;
  tokenSymbol?: string;
  tradeId?: string;
  aiScore?: number;
  createdAt: number;
  read: boolean;
}

export interface WatchlistEntry {
  pairAddress: string;
  addedAt: number;
  note?: string;
}

export interface WsMessage {
  type:
    | "scanner_update"
    | "position_update"
    | "alert"
    | "portfolio_update"
    | "ping";
  data: unknown;
  timestamp: number;
}
