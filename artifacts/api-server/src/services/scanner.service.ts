import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const SCAN_INTERVAL_MS = 2500;
const HIGH_AI_SCORE_THRESHOLD = 80;

function pairAgeLabel(createdAt: number): string {
  const ageMs = Date.now() - createdAt;
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function mapPairToToken(pair: DexScreenerPair): ScannedToken {
  const signals = computeSignals(pair);
  const aiScore = computeAiScore(signals);
  const confidence = computeConfidence(pair);
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
    buys1h: pair.txns?.h1?.buys || 0,
    sells1h: pair.txns?.h1?.sells || 0,
    buys24h: pair.txns?.h24?.buys || 0,
    sells24h: pair.txns?.h24?.sells || 0,
    buys5m: pair.txns?.m5?.buys || 0,
    sells5m: pair.txns?.m5?.sells || 0,
    priceChange1h: pair.priceChange?.h1 || 0,
    priceChange5m: pair.priceChange?.m5 || 0,
    priceChange6h: pair.priceChange?.h6 || 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    pairAge: pair.pairCreatedAt || 0,
    pairAgeLabel: pair.pairCreatedAt ? pairAgeLabel(pair.pairCreatedAt) : "?",
    dexId: pair.dexId,
    chainId: pair.chainId,
    url: pair.url,
    imageUrl: pair.info?.imageUrl ?? "",
    aiScore,
    confidence,
    signals,
    lastUpdated: Date.now(),
  };
}

class ScannerService {
  private tokens: Map<string, ScannedToken> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private broadcaster: ((tokens: ScannedToken[]) => void) | null = null;
  private alreadyAlertedHighScore: Set<string> = new Set();
  private isScanning = false;

  setBroadcaster(fn: (tokens: ScannedToken[]) => void) {
    this.broadcaster = fn;
  }

  async fetchSolanaPairs(): Promise<DexScreenerPair[]> {
    try {
      const [boostedRes, searchRes] = await Promise.allSettled([
        axios.get<{ tokenAddress: string; chainId: string }[]>(
          `${DEXSCREENER_BASE}/token-boosts/top/v1`,
          { timeout: 8000 },
        ),
        axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/search?q=solana`,
          { timeout: 8000 },
        ),
      ]);

      const pairs: DexScreenerPair[] = [];

      if (boostedRes.status === "fulfilled" && Array.isArray(boostedRes.value.data)) {
        const boostedAddresses = boostedRes.value.data
          .filter((b) => b.chainId === "solana")
          .slice(0, 30)
          .map((b) => b.tokenAddress);

        if (boostedAddresses.length > 0) {
          const chunks: string[][] = [];
          for (let i = 0; i < boostedAddresses.length; i += 10) {
            chunks.push(boostedAddresses.slice(i, i + 10));
          }
          const chunkResults = await Promise.allSettled(
            chunks.map((chunk) =>
              axios.get<{ pairs: DexScreenerPair[] }>(
                `${DEXSCREENER_BASE}/tokens/v1/solana/${chunk.join(",")}`,
                { timeout: 8000 },
              ),
            ),
          );
          for (const r of chunkResults) {
            if (r.status === "fulfilled" && Array.isArray(r.value.data.pairs)) {
              pairs.push(...r.value.data.pairs.filter((p) => p.chainId === "solana"));
            }
          }
        }
      }

      if (searchRes.status === "fulfilled" && Array.isArray(searchRes.value.data.pairs)) {
        pairs.push(...searchRes.value.data.pairs.filter((p) => p.chainId === "solana"));
      }

      const seen = new Set<string>();
      return pairs.filter((p) => {
        if (seen.has(p.pairAddress)) return false;
        seen.add(p.pairAddress);
        return true;
      });
    } catch (err) {
      logger.error({ err }, "Scanner fetch error");
      return [];
    }
  }

  private async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const pairs = await this.fetchSolanaPairs();
      for (const pair of pairs) {
        const token = mapPairToToken(pair);
        this.tokens.set(token.pairAddress, token);

        if (
          token.aiScore >= HIGH_AI_SCORE_THRESHOLD &&
          !this.alreadyAlertedHighScore.has(token.pairAddress)
        ) {
          this.alreadyAlertedHighScore.add(token.pairAddress);
          alertsService.highAiScore(token.symbol, token.aiScore, token.pairAddress);
          setTimeout(() => this.alreadyAlertedHighScore.delete(token.pairAddress), 300_000);
        }
      }

      this.broadcaster?.(this.getAll());
    } finally {
      this.isScanning = false;
    }
  }

  start() {
    if (this.intervalId) return;
    void this.scan();
    this.intervalId = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    logger.info("Scanner service started — polling DexScreener every 2.5s");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getAll(): ScannedToken[] {
    return Array.from(this.tokens.values()).sort((a, b) => b.aiScore - a.aiScore);
  }

  getByPairAddress(pairAddress: string): ScannedToken | undefined {
    return this.tokens.get(pairAddress);
  }

  async getPairFromDex(pairAddress: string): Promise<DexScreenerPair | null> {
    try {
      const res = await axios.get<{ pairs: DexScreenerPair[] }>(
        `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${pairAddress}`,
        { timeout: 8000 },
      );
      return res.data.pairs?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async getOrFetchToken(pairAddress: string): Promise<ScannedToken | null> {
    const cached = this.tokens.get(pairAddress);
    if (cached) return cached;
    const pair = await this.getPairFromDex(pairAddress);
    if (!pair) return null;
    const token = mapPairToToken(pair);
    this.tokens.set(pairAddress, token);
    return token;
  }
}

export const scannerService = new ScannerService();
