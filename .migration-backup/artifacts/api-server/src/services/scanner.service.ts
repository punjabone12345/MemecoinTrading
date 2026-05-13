import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const SCAN_INTERVAL_MS = 4_000;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1_000;   // clean stale tokens every 2 min
const TOKEN_TTL_MS = 15 * 60 * 1_000;          // token expires after 15 min without refresh
const HIGH_AI_SCORE_THRESHOLD = 80;
const QUERIES_PER_SCAN = 5;                     // was 3, now 5
const BOOSTED_EVERY_N_SCANS = 3;               // was 5, now 3

// 30 rotating keywords — meme culture + chain culture + new-launch patterns
const MEME_QUERIES = [
  "pump", "pepe", "cat", "dog", "ai", "moon", "based",
  "trump", "elon", "meme", "inu", "shib", "bonk", "wif",
  "sol", "baby", "degen", "giga", "chad", "frog",
  "wojak", "cope", "sigma", "ape", "bear", "bull",
  "retard", "send", "rip", "wen",
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
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private broadcaster: ((tokens: ScannedToken[]) => void) | null = null;
  private alreadyAlertedHighScore: Set<string> = new Set();
  private isScanning = false;
  private scanCount = 0;
  private totalExpired = 0;

  setBroadcaster(fn: (tokens: ScannedToken[]) => void) {
    this.broadcaster = fn;
  }

  /** Remove tokens that haven't been refreshed within TOKEN_TTL_MS */
  private cleanup() {
    const cutoff = Date.now() - TOKEN_TTL_MS;
    let removed = 0;
    for (const [addr, token] of this.tokens) {
      if (token.lastUpdated < cutoff) {
        this.tokens.delete(addr);
        removed++;
      }
    }
    if (removed > 0) {
      this.totalExpired += removed;
      logger.debug({ removed, remaining: this.tokens.size, totalExpired: this.totalExpired }, "Scanner: expired stale tokens");
    }
  }

  /** Fetch latest + top boosted and recently profiled token addresses */
  private async fetchBoostedAddresses(): Promise<string[]> {
    const [topBoostsRes, latestBoostsRes, profilesRes] = await Promise.allSettled([
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-boosts/top/v1`,
        { timeout: 8000 },
      ),
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-boosts/latest/v1`,
        { timeout: 8000 },
      ),
      axios.get<{ tokenAddress: string; chainId: string }[]>(
        `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
        { timeout: 8000 },
      ),
    ]);

    const addresses = new Set<string>();
    if (topBoostsRes.status === "fulfilled" && Array.isArray(topBoostsRes.value.data)) {
      topBoostsRes.value.data
        .filter((b) => b.chainId === "solana")
        .slice(0, 30)
        .forEach((b) => addresses.add(b.tokenAddress));
    }
    if (latestBoostsRes.status === "fulfilled" && Array.isArray(latestBoostsRes.value.data)) {
      latestBoostsRes.value.data
        .filter((b) => b.chainId === "solana")
        .slice(0, 30)
        .forEach((b) => addresses.add(b.tokenAddress));
    }
    if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
      profilesRes.value.data
        .filter((p) => p.chainId === "solana")
        .slice(0, 30)
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

  /** Search 5 rotating keyword queries per scan (was 3) */
  private async fetchSearchPairs(): Promise<DexScreenerPair[]> {
    const queries: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCAN; i++) {
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
      const useBoosted = this.scanCount % BOOSTED_EVERY_N_SCANS === 0;
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
        logger.debug(
          { scanCount: this.scanCount, newTokens: newCount, total: this.tokens.size },
          "Scanner: new tokens found",
        );
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
    this.cleanupIntervalId = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info(
      {
        intervalMs: SCAN_INTERVAL_MS,
        queriesPerScan: QUERIES_PER_SCAN,
        totalKeywords: MEME_QUERIES.length,
        tokenTtlMin: TOKEN_TTL_MS / 60_000,
      },
      "Scanner started — rotating keywords + boosted/profiled + TTL expiry",
    );
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
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

  getTotalExpired(): number {
    return this.totalExpired;
  }

  getScanCount(): number {
    return this.scanCount;
  }
}

export const scannerService = new ScannerService();
