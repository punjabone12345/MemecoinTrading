import axios from "axios";
import { logger } from "../lib/logger.js";
import { sendTelegram, isTelegramConfigured } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { computeSignals, computeAiScore } from "./ai-scoring.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const AUTO_TRADE_INTERVAL_MS = 30_000;
const MAX_HISTORY_CYCLES = 50;
const MAX_CONCURRENT_AUTO_TRADES = 10;

export interface AutoTraderConfig {
  solPerTrade: number;
  minAiScore: number;
  minLiquidity: number;
  minConfidence: number;
  slPct: number;
  tpPct: number;
  cooldownMs: number;
  maxConcurrentTrades: number;
}

export interface CycleDecision {
  symbol: string;
  address: string;
  pairAddress: string;
  aiScore: number;
  confidence: number;
  liquidityUsd: number;
  priceUsd: number;
  action: "traded" | "skipped_score" | "skipped_liquidity" | "skipped_confidence" | "skipped_cooldown" | "skipped_slots";
  reason: string;
  tradeId?: string;
}

export interface CycleRecord {
  cycleId: number;
  startedAt: number;
  finishedAt: number;
  tokensEvaluated: number;
  tradesOpened: number;
  decisions: CycleDecision[];
}

export interface AutoTraderStatus {
  paused: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastRunTokensEvaluated: number;
  lastRunTradesOpened: number;
  totalTradesOpened: number;
  telegramEnabled: boolean;
  cooldownTokens: string[];
  nextRunIn: number;
  config: AutoTraderConfig;
}

interface ScoredCandidate {
  pair: DexScreenerPair;
  aiScore: number;
  confidence: number;
  liquidity: number;
  priceUsd: number;
}

function pairAgeLabel(createdAt: number): string {
  const ageMs = Date.now() - createdAt;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function mapPairToScannedToken(pair: DexScreenerPair, overrideScore?: number): ScannedToken {
  const signals = computeSignals(pair);
  const aiScore = overrideScore ?? computeAiScore(signals);
  const priceUsd = parseFloat(pair.priceUsd) || 0;
  const priceNative = parseFloat(pair.priceNative) || 0;
  return {
    pairAddress: pair.pairAddress,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    address: pair.baseToken.address,
    priceUsd,
    priceNative,
    liquidity: pair.liquidity?.usd || 0,
    marketCap: pair.marketCap || pair.fdv || 0,
    fdv: pair.fdv || 0,
    volume24h: pair.volume?.h24 || 0,
    volume1h: pair.volume?.h1 || 0,
    volume5m: pair.volume?.m5 || 0,
    buys24h: pair.txns?.h24?.buys || 0,
    sells24h: pair.txns?.h24?.sells || 0,
    buys1h: pair.txns?.h1?.buys || 0,
    sells1h: pair.txns?.h1?.sells || 0,
    buys5m: pair.txns?.m5?.buys || 0,
    sells5m: pair.txns?.m5?.sells || 0,
    priceChange5m: pair.priceChange?.m5 || 0,
    priceChange1h: pair.priceChange?.h1 || 0,
    priceChange6h: pair.priceChange?.h6 || 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    pairAge: pair.pairCreatedAt || 0,
    pairAgeLabel: pair.pairCreatedAt ? pairAgeLabel(pair.pairCreatedAt) : "?",
    dexId: pair.dexId,
    chainId: pair.chainId,
    url: pair.url,
    imageUrl: pair.info?.imageUrl,
    aiScore,
    signals,
    lastUpdated: Date.now(),
  };
}

function computeAutoTraderScore(pair: DexScreenerPair): { aiScore: number; confidence: number } {
  const vol1h = pair.volume?.h1 || 0;
  const vol24h = pair.volume?.h24 || 0;
  const liquidity = pair.liquidity?.usd || 0;
  const marketCap = pair.marketCap || pair.fdv || 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const totalTxns1h = buys1h + sells1h;
  const priceChange1h = pair.priceChange?.h1 || 0;
  const priceUsd = parseFloat(pair.priceUsd) || 0;

  const expectedHourlyVol = vol24h / 24;
  let volAccelScore = 0;
  if (expectedHourlyVol > 0) {
    const accel = vol1h / expectedHourlyVol;
    if (accel >= 5) volAccelScore = 100;
    else if (accel >= 3) volAccelScore = 85;
    else if (accel >= 2) volAccelScore = 70;
    else if (accel >= 1.5) volAccelScore = 55;
    else if (accel >= 1) volAccelScore = 40;
    else volAccelScore = 10;
  }

  let buyPressureScore = 50;
  if (totalTxns1h > 0) buyPressureScore = Math.round((buys1h / totalTxns1h) * 100);

  let momentumScore = 50;
  if (priceChange1h >= 30) momentumScore = 95;
  else if (priceChange1h >= 15) momentumScore = 85;
  else if (priceChange1h >= 8) momentumScore = 75;
  else if (priceChange1h >= 3) momentumScore = 65;
  else if (priceChange1h >= 0) momentumScore = 50;
  else if (priceChange1h >= -5) momentumScore = 35;
  else momentumScore = 15;

  let liquidityScore = 0;
  if (liquidity >= 500_000) liquidityScore = 90;
  else if (liquidity >= 100_000) liquidityScore = 75;
  else if (liquidity >= 50_000) liquidityScore = 60;
  else if (liquidity >= 20_000) liquidityScore = 45;
  else liquidityScore = 10;

  let volLiqScore = 0;
  if (liquidity > 0) {
    const ratio = vol1h / liquidity;
    if (ratio >= 2) volLiqScore = 95;
    else if (ratio >= 1) volLiqScore = 80;
    else if (ratio >= 0.5) volLiqScore = 65;
    else if (ratio >= 0.1) volLiqScore = 45;
    else volLiqScore = 20;
  }

  let mcapScore = 50;
  if (marketCap > 0) {
    if (marketCap >= 50_000 && marketCap <= 10_000_000) mcapScore = 80;
    else if (marketCap > 10_000_000 && marketCap <= 100_000_000) mcapScore = 65;
    else if (marketCap < 50_000) mcapScore = 25;
    else mcapScore = 40;
  }

  const aiScore = Math.round(
    volAccelScore * 0.25 + buyPressureScore * 0.2 + momentumScore * 0.2 +
    liquidityScore * 0.15 + volLiqScore * 0.1 + mcapScore * 0.1,
  );

  let confidence = 100;
  if (!priceUsd || priceUsd <= 0) confidence -= 30;
  if (liquidity < 5_000) confidence -= 25;
  if (totalTxns1h < 5) confidence -= 20;
  if (vol24h < 1_000) confidence -= 15;
  if (!pair.pairCreatedAt) confidence -= 10;

  return {
    aiScore: Math.max(0, Math.min(100, aiScore)),
    confidence: Math.max(0, confidence),
  };
}

class AutoTraderService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private running = false;
  private lastRunAt: number | null = null;
  private lastRunTokensEvaluated = 0;
  private lastRunTradesOpened = 0;
  private totalTradesOpened = 0;
  private cooldownMap: Map<string, number> = new Map();
  private nextRunAt = 0;
  private cycleCounter = 0;
  private history: CycleRecord[] = [];

  private config: AutoTraderConfig = {
    solPerTrade: 0.5,
    minAiScore: 68,
    minLiquidity: 20_000,
    minConfidence: 70,
    slPct: 0.1,
    tpPct: 0.3,
    cooldownMs: 5 * 60_000,
    maxConcurrentTrades: MAX_CONCURRENT_AUTO_TRADES,
  };

  getConfig(): AutoTraderConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<AutoTraderConfig>): AutoTraderConfig {
    const allowed: (keyof AutoTraderConfig)[] = [
      "solPerTrade", "minAiScore", "minLiquidity", "minConfidence",
      "slPct", "tpPct", "cooldownMs", "maxConcurrentTrades",
    ];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        (this.config as unknown as Record<string, number>)[key] = patch[key] as number;
      }
    }
    logger.info({ config: this.config }, "Auto-trader config updated");
    return { ...this.config };
  }

  pause(): void {
    this.paused = true;
    logger.info("Auto-trader paused");
  }

  resume(): void {
    this.paused = false;
    logger.info("Auto-trader resumed");
    void this.run();
  }

  isPaused(): boolean {
    return this.paused;
  }

  getHistory(): CycleRecord[] {
    return [...this.history].reverse();
  }

  private isOnCooldown(tokenAddress: string): boolean {
    const ts = this.cooldownMap.get(tokenAddress);
    if (!ts) return false;
    return Date.now() - ts < this.config.cooldownMs;
  }

  private setCooldown(tokenAddress: string): void {
    this.cooldownMap.set(tokenAddress, Date.now());
    setTimeout(() => this.cooldownMap.delete(tokenAddress), this.config.cooldownMs);
  }

  private async fetchCandidateAddresses(): Promise<string[]> {
    const [profilesRes, boostsRes] = await Promise.allSettled([
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 10_000 },
      ),
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`,
        { timeout: 10_000 },
      ),
    ]);

    const addresses = new Set<string>();

    if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
      profilesRes.value.data
        .filter((t) => t.chainId === "solana")
        .slice(0, 30)
        .forEach((t) => addresses.add(t.tokenAddress));
    }

    if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
      boostsRes.value.data
        .filter((t) => t.chainId === "solana")
        .slice(0, 30)
        .forEach((t) => addresses.add(t.tokenAddress));
    }

    return Array.from(addresses);
  }

  private async fetchPairsForAddress(tokenAddress: string): Promise<DexScreenerPair[]> {
    try {
      const res = await axios.get<{ pairs: DexScreenerPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${tokenAddress}`,
        { timeout: 8000 },
      );
      return (res.data.pairs || []).filter((p) => p.chainId === "solana");
    } catch {
      return [];
    }
  }

  private async run(): Promise<void> {
    if (this.running || this.paused) return;
    this.running = true;
    this.nextRunAt = Date.now() + AUTO_TRADE_INTERVAL_MS;
    const cycleId = ++this.cycleCounter;
    const startedAt = Date.now();
    const decisions: CycleDecision[] = [];

    logger.info({ cycleId }, "Auto-trader: cycle started");

    try {
      const { minAiScore, minLiquidity, minConfidence, solPerTrade, slPct, tpPct, maxConcurrentTrades } = this.config;

      const addresses = await this.fetchCandidateAddresses();
      logger.info({ count: addresses.length }, "Auto-trader: candidate addresses fetched");

      const openPositions = paperTradingService.getOpenTrades();
      const slotsAvailable = maxConcurrentTrades - openPositions.length;

      if (slotsAvailable <= 0) {
        logger.info({ open: openPositions.length }, "Auto-trader: max concurrent trades reached, skipping cycle");
        this.history.push({ cycleId, startedAt, finishedAt: Date.now(), tokensEvaluated: 0, tradesOpened: 0, decisions });
        if (this.history.length > MAX_HISTORY_CYCLES) this.history.shift();
        return;
      }

      const pairsPerAddress = await Promise.allSettled(
        addresses.map((addr) => this.fetchPairsForAddress(addr)),
      );

      const candidates: ScoredCandidate[] = [];

      for (const result of pairsPerAddress) {
        if (result.status !== "fulfilled") continue;
        for (const pair of result.value) {
          const priceUsd = parseFloat(pair.priceUsd) || 0;
          const liquidity = pair.liquidity?.usd || 0;
          const { aiScore, confidence } = computeAutoTraderScore(pair);
          const base: Omit<CycleDecision, "action" | "reason"> = {
            symbol: pair.baseToken.symbol,
            address: pair.baseToken.address,
            pairAddress: pair.pairAddress,
            aiScore,
            confidence,
            liquidityUsd: liquidity,
            priceUsd,
          };

          if (liquidity < minLiquidity) {
            decisions.push({ ...base, action: "skipped_liquidity", reason: `Liquidity $${liquidity.toFixed(0)} < $${minLiquidity}` });
            continue;
          }
          if (aiScore < minAiScore) {
            decisions.push({ ...base, action: "skipped_score", reason: `Score ${aiScore} < ${minAiScore}` });
            continue;
          }
          if (confidence < minConfidence) {
            decisions.push({ ...base, action: "skipped_confidence", reason: `Confidence ${confidence} < ${minConfidence}` });
            continue;
          }
          if (this.isOnCooldown(pair.baseToken.address)) {
            decisions.push({ ...base, action: "skipped_cooldown", reason: "Token on 5-min cooldown" });
            continue;
          }
          candidates.push({ pair, aiScore, confidence, liquidity, priceUsd });
        }
      }

      candidates.sort((a, b) => b.aiScore - a.aiScore);
      const toTrade = candidates.slice(0, slotsAvailable);
      const skippedSlots = candidates.slice(slotsAvailable);

      for (const { pair } of skippedSlots) {
        const priceUsd = parseFloat(pair.priceUsd) || 0;
        const { aiScore, confidence } = computeAutoTraderScore(pair);
        decisions.push({
          symbol: pair.baseToken.symbol,
          address: pair.baseToken.address,
          pairAddress: pair.pairAddress,
          aiScore,
          confidence,
          liquidityUsd: pair.liquidity?.usd || 0,
          priceUsd,
          action: "skipped_slots",
          reason: "No trade slots available",
        });
      }

      this.lastRunTokensEvaluated = addresses.length;
      this.lastRunTradesOpened = 0;
      this.lastRunAt = Date.now();

      for (const candidate of toTrade) {
        const { pair, aiScore, confidence, priceUsd } = candidate;
        const symbol = pair.baseToken.symbol;
        const tokenAddress = pair.baseToken.address;
        const stopLossPrice = priceUsd * (1 - slPct);
        const takeProfitPrice = priceUsd * (1 + tpPct);

        try {
          const token = mapPairToScannedToken(pair, aiScore);
          const trade = await paperTradingService.buyDirect(token, solPerTrade, stopLossPrice, takeProfitPrice);

          this.setCooldown(tokenAddress);
          this.lastRunTradesOpened++;
          this.totalTradesOpened++;

          decisions.push({
            symbol,
            address: tokenAddress,
            pairAddress: pair.pairAddress,
            aiScore,
            confidence,
            liquidityUsd: pair.liquidity?.usd || 0,
            priceUsd,
            action: "traded",
            reason: `Opened ${solPerTrade} SOL | SL $${stopLossPrice.toFixed(8)} | TP $${takeProfitPrice.toFixed(8)}`,
            tradeId: trade.id,
          });

          logger.info({ tradeId: trade.id, symbol, aiScore, confidence }, "Auto-trader: trade opened");

          const msg =
            `⚡ <b>Auto-Trade: ${symbol}</b>\n` +
            `📊 Score: <b>${aiScore}/100</b> | Confidence: ${confidence}%\n` +
            `💰 Entry: <b>$${priceUsd.toFixed(8)}</b> | Size: <b>${solPerTrade} SOL</b>\n` +
            `🛑 SL: $${stopLossPrice.toFixed(8)} (-${(slPct * 100).toFixed(0)}%)\n` +
            `🎯 TP: $${takeProfitPrice.toFixed(8)} (+${(tpPct * 100).toFixed(0)}%)\n` +
            `🔗 <a href="${pair.url}">DexScreener</a>`;

          void sendTelegram(msg);
        } catch (err) {
          logger.warn({ err, symbol }, "Auto-trader: failed to open trade");
        }
      }

      if (toTrade.length === 0) {
        logger.info({ evaluated: addresses.length, candidates: candidates.length }, "Auto-trader: no qualifying tokens this cycle");
      } else {
        logger.info({ opened: this.lastRunTradesOpened }, "Auto-trader: cycle complete");
      }
    } catch (err) {
      logger.error({ err }, "Auto-trader: cycle error");
    } finally {
      this.history.push({ cycleId, startedAt, finishedAt: Date.now(), tokensEvaluated: this.lastRunTokensEvaluated, tradesOpened: this.lastRunTradesOpened, decisions });
      if (this.history.length > MAX_HISTORY_CYCLES) this.history.shift();
      this.running = false;
    }
  }

  start(): void {
    if (this.intervalId) return;
    void this.run();
    this.intervalId = setInterval(() => void this.run(), AUTO_TRADE_INTERVAL_MS);
    this.nextRunAt = Date.now() + AUTO_TRADE_INTERVAL_MS;
    logger.info(
      { intervalSec: AUTO_TRADE_INTERVAL_MS / 1000, telegramEnabled: isTelegramConfigured(), config: this.config },
      "Auto-trader service started",
    );
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getStatus(): AutoTraderStatus {
    return {
      paused: this.paused,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastRunTokensEvaluated: this.lastRunTokensEvaluated,
      lastRunTradesOpened: this.lastRunTradesOpened,
      totalTradesOpened: this.totalTradesOpened,
      telegramEnabled: isTelegramConfigured(),
      cooldownTokens: Array.from(this.cooldownMap.keys()),
      nextRunIn: Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000)),
      config: this.getConfig(),
    };
  }
}

export const autoTraderService = new AutoTraderService();
