import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const SCAN_INTERVAL_MS = 4000;
const HIGH_AI_SCORE_THRESHOLD = 80;

// Rotating search queries targeting active Solana meme coins
const MEME_QUERIES = [
  "pump", "pepe", "cat", "dog", "ai", "moon", "based",
  "trump", "elon", "meme", "inu", "shib", "bonk", "wif",
  "sol", "baby", "degen", "giga", "chad", "frog",
];
let queryRotation = 0;

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
  private scanCount = 0;

  setBroadcaster(fn: (tokens: ScannedToken[]) => void) {
    this.broadcaster = fn;
  }

  /** Fetch boosted + profiled token addresses from DexScreener */
  private async fetchBoostedAddresses(): Promise<string[]> {
    const [boostsRes, profilesRes] = await Promise.allSettled([
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`,
        { timeout: 8000 },
      ),
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 8000 },
      ),
    ]);

    const addresses = new Set<string>();
    if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
      boostsRes.value.data
        .filter((b) => b.chainId === "solana")
        .slice(0, 50)
        .forEach((b) => addresses.add(b.tokenAddress));
    }
    if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
      profilesRes.value.data
        .filter((p) => p.chainId === "solana")
        .slice(0, 50)
        .forEach((p) => addresses.add(p.tokenAddress));
    }
    return Array.from(addresses);
  }

  /** Fetch pairs for a batch of token addresses (max 30 per request) */
  private async fetchPairsForAddresses(addresses: string[]): Promise<DexScreenerPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += 30) {
      chunks.push(addresses.slice(i, i + 30));
    }

    const results = await Promise.allSettled(
      chunks.map((chunk) =>
        axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${chunk.join(",")}`,
          { timeout: 8000 },
        ),
      ),
    );

    const pairs: DexScreenerPair[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value.data.pairs)) {
        pairs.push(...r.value.data.pairs.filter((p) => p.chainId === "solana"));
      }
    }
    return pairs;
  }

  /** Search for trending meme coin pairs using rotating keyword queries */
  private async fetchSearchPairs(): Promise<DexScreenerPair[]> {
    // Pick 3 queries per scan cycle (rotate through the list)
    const queries: string[] = [];
    for (let i = 0; i < 3; i++) {
      queries.push(MEME_QUERIES[queryRotation % MEME_QUERIES.length]!);
      queryRotation++;
    }

    const results = await Promise.allSettled(
      queries.map((q) =>
        axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`,
          { timeout: 8000 },
        ),
      ),
    );

    const pairs: DexScreenerPair[] = [];
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value.data.pairs)) {
        // Only Solana meme coin pairs (not SOL/USDC etc.) — filter out quote tokens named SOL/USDC
        const filtered = r.value.data.pairs.filter(
          (p) =>
            p.chainId === "solana" &&
            !["SOL", "USDC", "USDT", "WSOL"].includes(p.baseToken.symbol),
        );
        pairs.push(...filtered.slice(0, 20));
      }
    }
    return pairs;
  }

  async fetchSolanaPairs(): Promise<DexScreenerPair[]> {
    try {
      // Every 5th scan refresh the boosted/profiled address list
      const useBoosted = this.scanCount % 5 === 0;
      const allPairs: DexScreenerPair[] = [];

      const [searchPairs, boostedPairs] = await Promise.allSettled([
        this.fetchSearchPairs(),
        useBoosted
          ? this.fetchBoostedAddresses().then((addrs) => this.fetchPairsForAddresses(addrs))
          : Promise.resolve([] as DexScreenerPair[]),
      ]);

      if (searchPairs.status === "fulfilled") allPairs.push(...searchPairs.value);
      if (boostedPairs.status === "fulfilled") allPairs.push(...boostedPairs.value);

      // Deduplicate by pair address, keep highest-volume version
      const seen = new Map<string, DexScreenerPair>();
      for (const pair of allPairs) {
        const existing = seen.get(pair.pairAddress);
        if (!existing || (pair.volume?.h24 ?? 0) > (existing.volume?.h24 ?? 0)) {
          seen.set(pair.pairAddress, pair);
        }
      }

      return Array.from(seen.values());
    } catch (err) {
      logger.error({ err }, "Scanner fetch error");
      return [];
    }
  }

  private async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scanCount++;
    try {
      const pairs = await this.fetchSolanaPairs();
      let newCount = 0;
      for (const pair of pairs) {
        const token = mapPairToToken(pair);
        const isNew = !this.tokens.has(token.pairAddress);
        this.tokens.set(token.pairAddress, token);
        if (isNew) newCount++;

        if (
          token.aiScore >= HIGH_AI_SCORE_THRESHOLD &&
          !this.alreadyAlertedHighScore.has(token.pairAddress)
        ) {
          this.alreadyAlertedHighScore.add(token.pairAddress);
          alertsService.highAiScore(token.symbol, token.aiScore, token.pairAddress);
          setTimeout(() => this.alreadyAlertedHighScore.delete(token.pairAddress), 300_000);
        }
      }

      if (newCount > 0) {
        logger.debug({ scanCount: this.scanCount, newTokens: newCount, total: this.tokens.size }, "Scanner: new tokens found");
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
    logger.info({ intervalMs: SCAN_INTERVAL_MS, queries: MEME_QUERIES.length }, "Scanner started — rotating meme coin queries + boosted tokens");
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

  getTokenCount(): number {
    return this.tokens.size;
  }
}

export const scannerService = new ScannerService();
