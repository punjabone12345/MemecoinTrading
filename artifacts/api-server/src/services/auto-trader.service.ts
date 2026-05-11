import axios from "axios";
import { logger } from "../lib/logger.js";
import { isTelegramConfigured } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { computeSignals, computeAiScore, computeConfidence, getDynamicRisk } from "./ai-scoring.service.js";
import { mapPairToToken } from "./scanner.service.js";
import type { DexScreenerPair } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const AUTO_TRADE_INTERVAL_MS = 60_000;
const MAX_HISTORY_CYCLES = 50;
const MIN_AI_SCORE = 60;
const SIZE_SOL = 0.5;

export interface AutoTraderConfig {
  solPerTrade: number;
  minAiScore: number;
  maxConcurrentTrades: number;
}

export interface CycleDecision {
  symbol: string;
  pairAddress: string;
  aiScore: number;
  confidence: number;
  liquidityUsd: number;
  priceUsd: number;
  slPercent: number;
  tpPercent: number;
  action: "traded" | "skipped_score" | "skipped_duplicate" | "skipped_slots" | "skipped_balance";
  reason: string;
  positionId?: string;
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
  nextRunIn: number;
  config: AutoTraderConfig;
}

class AutoTraderService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private running = false;
  private lastRunAt: number | null = null;
  private lastRunTokensEvaluated = 0;
  private lastRunTradesOpened = 0;
  private totalTradesOpened = 0;
  private nextRunAt = 0;
  private cycleCounter = 0;
  private history: CycleRecord[] = [];

  private config: AutoTraderConfig = {
    solPerTrade: SIZE_SOL,
    minAiScore: MIN_AI_SCORE,
    maxConcurrentTrades: 10,
  };

  getConfig(): AutoTraderConfig { return { ...this.config }; }

  updateConfig(patch: Partial<AutoTraderConfig>): AutoTraderConfig {
    if (patch.solPerTrade !== undefined) this.config.solPerTrade = patch.solPerTrade;
    if (patch.minAiScore !== undefined) this.config.minAiScore = patch.minAiScore;
    if (patch.maxConcurrentTrades !== undefined) this.config.maxConcurrentTrades = patch.maxConcurrentTrades;
    logger.info({ config: this.config }, "Auto-trader config updated");
    return { ...this.config };
  }

  pause(): void { this.paused = true; logger.info("Auto-trader paused"); }
  resume(): void { this.paused = false; logger.info("Auto-trader resumed"); void this.run(); }
  isPaused(): boolean { return this.paused; }
  getHistory(): CycleRecord[] { return [...this.history].reverse(); }

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
      profilesRes.value.data.filter((t) => t.chainId === "solana").slice(0, 30).forEach((t) => addresses.add(t.tokenAddress));
    }
    if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
      boostsRes.value.data.filter((t) => t.chainId === "solana").slice(0, 30).forEach((t) => addresses.add(t.tokenAddress));
    }
    return Array.from(addresses);
  }

  private async fetchPairsForAddress(address: string): Promise<DexScreenerPair[]> {
    try {
      const res = await axios.get<{ pairs: DexScreenerPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/tokens/${address}`,
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
    let tokensEvaluated = 0;
    let tradesOpened = 0;

    logger.info({ cycleId }, "Auto-trader: cycle started");

    try {
      const { minAiScore, solPerTrade, maxConcurrentTrades } = this.config;
      const openPositions = paperTradingService.getOpenPositions();

      if (openPositions.length >= maxConcurrentTrades) {
        logger.info({ open: openPositions.length }, "Auto-trader: max concurrent trades reached, skipping");
        return;
      }

      const addresses = await this.fetchCandidateAddresses();
      tokensEvaluated = addresses.length;

      const pairsPerAddress = await Promise.allSettled(
        addresses.map((addr) => this.fetchPairsForAddress(addr)),
      );

      interface Candidate { pair: DexScreenerPair; aiScore: number; confidence: number }
      const candidates: Candidate[] = [];

      for (const result of pairsPerAddress) {
        if (result.status !== "fulfilled") continue;
        for (const pair of result.value) {
          const priceUsd = parseFloat(pair.priceUsd) || 0;
          const liq = pair.liquidity?.usd || 0;
          if (priceUsd <= 0) continue;

          const signals = computeSignals(pair);
          const aiScore = computeAiScore(signals);
          const confidence = computeConfidence(pair);
          const { slPercent, tpPercent } = getDynamicRisk(aiScore);

          const base: Omit<CycleDecision, "action" | "reason"> = {
            symbol: pair.baseToken.symbol,
            pairAddress: pair.pairAddress,
            aiScore,
            confidence,
            liquidityUsd: liq,
            priceUsd,
            slPercent,
            tpPercent,
          };

          if (aiScore < minAiScore) {
            decisions.push({ ...base, action: "skipped_score", reason: `Score ${aiScore} < ${minAiScore}` });
            continue;
          }
          if (paperTradingService.hasOpenPositionForSymbol(pair.baseToken.symbol)) {
            decisions.push({ ...base, action: "skipped_duplicate", reason: `Already have open position for ${pair.baseToken.symbol}` });
            continue;
          }
          candidates.push({ pair, aiScore, confidence });
        }
      }

      candidates.sort((a, b) => b.aiScore - a.aiScore);
      const slots = maxConcurrentTrades - openPositions.length;
      const toTrade = candidates.slice(0, slots);
      const skipped = candidates.slice(slots);

      for (const { pair, aiScore, confidence } of skipped) {
        const { slPercent, tpPercent } = getDynamicRisk(aiScore);
        decisions.push({
          symbol: pair.baseToken.symbol,
          pairAddress: pair.pairAddress,
          aiScore,
          confidence,
          liquidityUsd: pair.liquidity?.usd || 0,
          priceUsd: parseFloat(pair.priceUsd) || 0,
          slPercent,
          tpPercent,
          action: "skipped_slots",
          reason: "No available trade slots",
        });
      }

      for (const { pair, aiScore, confidence } of toTrade) {
        const token = mapPairToToken(pair);
        token.aiScore = aiScore;
        token.confidence = confidence;
        const { slPercent, tpPercent } = getDynamicRisk(aiScore);

        try {
          const position = await paperTradingService.buyDirect(token, solPerTrade);
          decisions.push({
            symbol: pair.baseToken.symbol,
            pairAddress: pair.pairAddress,
            aiScore,
            confidence,
            liquidityUsd: pair.liquidity?.usd || 0,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            slPercent,
            tpPercent,
            action: "traded",
            reason: `Opened ${solPerTrade} SOL | SL -${slPercent}% | TP +${tpPercent}%`,
            positionId: position.positionId,
          });
          tradesOpened++;
          this.totalTradesOpened++;
          logger.info({ positionId: position.positionId, symbol: pair.baseToken.symbol, aiScore }, "Auto-trader: trade opened");
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          decisions.push({
            symbol: pair.baseToken.symbol,
            pairAddress: pair.pairAddress,
            aiScore,
            confidence,
            liquidityUsd: pair.liquidity?.usd || 0,
            priceUsd: parseFloat(pair.priceUsd) || 0,
            slPercent,
            tpPercent,
            action: "skipped_balance",
            reason: msg,
          });
          logger.warn({ err, symbol: pair.baseToken.symbol }, "Auto-trader: failed to open trade");
        }
      }

      this.lastRunTokensEvaluated = tokensEvaluated;
      this.lastRunTradesOpened = tradesOpened;
      this.lastRunAt = Date.now();

      logger.info({ cycleId, tokensEvaluated, tradesOpened }, "Auto-trader: cycle complete");
    } catch (err) {
      logger.error({ err }, "Auto-trader: cycle error");
    } finally {
      this.history.push({ cycleId, startedAt, finishedAt: Date.now(), tokensEvaluated, tradesOpened, decisions });
      if (this.history.length > MAX_HISTORY_CYCLES) this.history.shift();
      this.running = false;
    }
  }

  start(): void {
    if (this.intervalId) return;
    void this.run();
    this.intervalId = setInterval(() => void this.run(), AUTO_TRADE_INTERVAL_MS);
    this.nextRunAt = Date.now() + AUTO_TRADE_INTERVAL_MS;
    logger.info({ intervalSec: AUTO_TRADE_INTERVAL_MS / 1000, telegramEnabled: isTelegramConfigured(), config: this.config }, "Auto-trader started");
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
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
      nextRunIn: Math.max(0, Math.round((this.nextRunAt - Date.now()) / 1000)),
      config: this.getConfig(),
    };
  }
}

export const autoTraderService = new AutoTraderService();
