import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

// 100% DexScreener — no GeckoTerminal. All data is sourced directly from
// DexScreener's API so scanner values match exactly what the user sees on
// the DexScreener website.
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const SCAN_INTERVAL_MS = 4_000;
const CLEANUP_INTERVAL_MS = 2 * 60 * 1_000;
const TOKEN_TTL_MS = 15 * 60 * 1_000;
const HIGH_AI_SCORE_THRESHOLD = 80;
// Run 8 keyword queries per scan (up from 5) to compensate for removed GeckoTerminal
const QUERIES_PER_SCAN = 8;
// Run boosted/profiled every scan (up from every 3) — these are DexScreener's
// own curated token lists and always have accurate data
const BOOSTED_EVERY_N_SCANS = 1;

// Max age to store in pool — tokens older than this are skipped before storing
const MAX_POOL_AGE_HOURS = 48;
const MAX_POOL_AGE_MS = MAX_POOL_AGE_HOURS * 60 * 60 * 1_000;

// Min liquidity to accept — $0 liquidity tokens are useless
// This is DexScreener's real liquidity value — no more fabricated numbers
const MIN_POOL_LIQUIDITY_USD = 500;

// 50 rotating keywords — broad coverage to discover new Solana memecoins
// via DexScreener's own search engine (returns accurate, real-time data)
const MEME_QUERIES = [
  "pump", "pepe", "cat", "dog", "ai", "moon", "based",
  "trump", "elon", "meme", "inu", "shib", "bonk", "wif",
  "sol", "baby", "degen", "giga", "chad", "frog",
  "wojak", "cope", "sigma", "ape", "bear", "bull",
  "send", "wen", "new", "launch",
  "solana", "raydium", "meteora", "pumpfun", "letsbonk",
  "420", "1000x", "gem", "alpha", "fire", "hot",
  "king", "queen", "max", "ultra", "super", "mega",
  "dragon", "tiger", "wolf", "eagle",
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
  private totalSkippedStale = 0;
  private totalSkippedNoLiq = 0;

  setBroadcaster(fn: (tokens: ScannedToken[]) => void) {
    this.broadcaster = fn;
  }

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

  /**
   * Fetch DexScreener's curated token lists (boosts + profiles) and return
   * both token addresses AND pair addresses extracted from each entry's url field.
   * The url field encodes the featured pair address directly, so we can fetch
   * pair data in one step instead of token → pairs (two steps).
   */
  private async fetchCuratedLists(): Promise<{ tokenAddresses: string[]; pairAddresses: string[] }> {
    type DexEntry = { tokenAddress: string; chainId: string; url?: string };
    const [topBoostsRes, latestBoostsRes, profilesRes] = await Promise.allSettled([
      axios.get<DexEntry[]>(`${DEXSCREENER_BASE}/token-boosts/top/v1`,     { timeout: 8000 }),
      axios.get<DexEntry[]>(`${DEXSCREENER_BASE}/token-boosts/latest/v1`,  { timeout: 8000 }),
      axios.get<DexEntry[]>(`${DEXSCREENER_BASE}/token-profiles/latest/v1`, { timeout: 8000 }),
    ]);

    const tokenAddresses = new Set<string>();
    const pairAddresses  = new Set<string>();

    const absorb = (res: typeof topBoostsRes) => {
      if (res.status !== "fulfilled" || !Array.isArray(res.value.data)) return;
      res.value.data
        .filter((e) => e.chainId === "solana")
        .forEach((e) => {
          if (e.tokenAddress) tokenAddresses.add(e.tokenAddress);
          // Extract the pair address from the DexScreener URL's last path segment.
          // e.g. https://dexscreener.com/solana/<pairAddress>
          if (e.url) {
            const seg = e.url.split("/").pop();
            if (seg && seg.length > 20) pairAddresses.add(seg);
          }
        });
    };

    absorb(topBoostsRes);
    absorb(latestBoostsRes);
    absorb(profilesRes);

    return { tokenAddresses: Array.from(tokenAddresses), pairAddresses: Array.from(pairAddresses) };
  }

  /** Fetch pairs by token address — one token can have multiple pools */
  private async fetchPairsForTokenAddresses(addresses: string[]): Promise<DexScreenerPair[]> {
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

  /** Fetch pairs directly by pair address — fastest single-hop lookup */
  private async fetchPairsForPairAddresses(pairAddresses: string[]): Promise<DexScreenerPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < pairAddresses.length; i += 30) {
      chunks.push(pairAddresses.slice(i, i + 30));
    }

    const results = await Promise.allSettled(
      chunks.map((chunk) =>
        axios.get<{ pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${chunk.join(",")}`,
          { timeout: 8000 },
        ),
      ),
    );

    const pairs: DexScreenerPair[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const data = r.value.data;
        // /dex/pairs returns either { pairs: [...] } or a single pair object
        if (Array.isArray(data.pairs)) pairs.push(...data.pairs.filter((p) => p.chainId === "solana"));
      }
    }
    return pairs;
  }

  /**
   * Search rotating keywords against DexScreener's own search API.
   * Returns real-time accurate pair data — price, liquidity, volume all match
   * exactly what you see on dexscreener.com.
   */
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
        // Top 15 per keyword — DexScreener search sorts by relevance+activity
        pairs.push(...filtered.slice(0, 15));
      }
    }
    return pairs;
  }

  /**
   * All data pulled 100% from DexScreener — three independent sources run in parallel:
   *   1. Keyword search (8 rotating queries/scan) — /latest/dex/search
   *   2a. Curated pair addresses (from url field of boosts/profiles) → /dex/pairs/solana
   *   2b. Curated token addresses (from boosts/profiles) → /tokens/v1/solana
   *
   * Every field (price, liquidity, volume, mcap) comes directly from
   * DexScreener and matches exactly what dexscreener.com shows.
   */
  async fetchSolanaPairs(): Promise<DexScreenerPair[]> {
    try {
      const useCurated = this.scanCount % BOOSTED_EVERY_N_SCANS === 0;
      const allPairs: DexScreenerPair[] = [];

      const [searchResult, curatedResult] = await Promise.allSettled([
        this.fetchSearchPairs(),
        useCurated
          ? this.fetchCuratedLists().then(async ({ tokenAddresses, pairAddresses }) => {
              // Fetch both in parallel — pair addresses via direct lookup (1 hop),
              // token addresses via token lookup (may surface additional pools)
              const [byPair, byToken] = await Promise.allSettled([
                pairAddresses.length > 0 ? this.fetchPairsForPairAddresses(pairAddresses) : Promise.resolve([] as DexScreenerPair[]),
                tokenAddresses.length > 0 ? this.fetchPairsForTokenAddresses(tokenAddresses) : Promise.resolve([] as DexScreenerPair[]),
              ]);
              const combined: DexScreenerPair[] = [];
              if (byPair.status === "fulfilled") combined.push(...byPair.value);
              if (byToken.status === "fulfilled") combined.push(...byToken.value);
              return combined;
            })
          : Promise.resolve([] as DexScreenerPair[]),
      ]);

      if (searchResult.status === "fulfilled") allPairs.push(...searchResult.value);
      if (curatedResult.status === "fulfilled") allPairs.push(...curatedResult.value);

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
      let skippedNoLiq = 0;
      let skippedStale = 0;

      for (const pair of pairs) {
        // ── Pre-flight: reject junk pairs before mapping or storing ──────────
        const liq = pair.liquidity?.usd ?? 0;
        if (liq < MIN_POOL_LIQUIDITY_USD) {
          skippedNoLiq++;
          continue;
        }
        if (pair.pairCreatedAt && (Date.now() - pair.pairCreatedAt) > MAX_POOL_AGE_MS) {
          skippedStale++;
          continue;
        }
        const priceUsd = parseFloat(pair.priceUsd) || 0;
        if (priceUsd <= 0) continue;

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

      this.totalSkippedNoLiq += skippedNoLiq;
      this.totalSkippedStale += skippedStale;

      logger.debug(
        {
          scanCount: this.scanCount,
          newTokens: newCount,
          total: this.tokens.size,
          skippedNoLiq,
          skippedStale,
        },
        "Scanner: scan complete",
      );

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
        maxPoolAgeHours: MAX_POOL_AGE_HOURS,
        minPoolLiquidityUsd: MIN_POOL_LIQUIDITY_USD,
        dataSource: "100% DexScreener — GeckoTerminal removed",
      },
      "Scanner started — 100% DexScreener data (keyword search + boosted/profiled tokens)",
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
