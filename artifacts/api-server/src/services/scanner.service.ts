import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

// ─── Timing & limits ─────────────────────────────────────────────────────────
// 5 s interval × 30 parallel queries = 6 req/s = 360 req/min
// DexScreener public limit is ~300 req/min so we cap parallel at 25 per tick
const SCAN_INTERVAL_MS      = 5_000;
const QUERIES_PER_SCAN      = 30;   // keyword queries per scan tick (was 25)
const MAX_RESULTS_PER_QUERY = 30;   // DexScreener returns up to 30 per search

// ─── Pool lifecycle ───────────────────────────────────────────────────────────
const CLEANUP_INTERVAL_MS  = 2 * 60 * 1_000;
const TOKEN_TTL_MS         = 20 * 60 * 1_000;   // keep tokens for 20 min (was 45) — faster churn = fresher pool
const MAX_POOL_AGE_HOURS   = 72;
const MAX_POOL_AGE_MS      = MAX_POOL_AGE_HOURS * 60 * 60 * 1_000;
const MIN_POOL_LIQUIDITY_USD = 500;              // wide net — auto-trader filters more tightly
const HIGH_AI_SCORE_THRESHOLD = 65;

// ─── Discovery query list ─────────────────────────────────────────────────────
// Strategy: rotate through DIVERSE short terms that surface completely different
// sets of tokens. Single letters are the key insight — "a" returns 30 tokens
// with "a" prominent in the name sorted by DexScreener activity, completely
// different from "z". This covers the entire universe instead of the same
// 40 meme-keyword tokens repeating.
const DISCOVERY_QUERIES: string[] = [
  // ── Single letters — each guaranteed-distinct result set ──────────────────
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",

  // ── Digits — numeric-named tokens (100x, 420, 1000, etc.) ────────────────
  "1", "2", "3", "4", "5", "6", "7", "8", "9",

  // ── 2-char combos that find tokens keyword lists miss ─────────────────────
  "ai", "fi", "gg", "oo", "pp", "xx", "zz", "io", "og", "gm",
  "gg", "lp", "op", "ng", "rk", "sk", "st", "wl", "xp", "yb",

  // ── Animals (broader than current list) ───────────────────────────────────
  "cat", "dog", "inu", "frog", "wolf", "bear", "bull", "fish", "rat", "crab",
  "penguin", "hamster", "pig", "shib", "bonk", "wif", "bird", "snake",
  "bunny", "fox", "deer", "bat", "duck", "owl", "goat", "lion", "tiger",
  "shark", "whale", "dino", "lizard", "horse", "cow", "ant", "bee",

  // ── People/culture ─────────────────────────────────────────────────────────
  "trump", "elon", "pepe", "chad", "sigma", "degen", "baby", "giga", "wojak",
  "cope", "ape", "based", "bro", "king", "god", "chad", "sir", "mr",
  "papa", "mama", "lady", "boy", "girl", "man", "guy", "son", "pop",

  // ── Meme / momentum terms ─────────────────────────────────────────────────
  "moon", "pump", "gem", "alpha", "fire", "hot", "new", "launch", "1000x",
  "420", "mega", "super", "ultra", "max", "meme", "hype", "nuke", "rocket",
  "laser", "blaze", "rekt", "rug", "send", "wen", "bags", "hodl", "gm",
  "wagmi", "ngmi", "shill", "gg", "fud",

  // ── Tech/AI tokens ─────────────────────────────────────────────────────────
  "gpt", "llm", "web3", "defi", "nft", "dao", "dex", "swap", "yield",
  "stake", "farm", "vault", "node", "chain", "block", "hash", "net",

  // ── Geography / current events ─────────────────────────────────────────────
  "usa", "china", "japan", "india", "russia", "euro", "uk", "usd", "btc",
  "eth", "sol", "ton", "maga", "vote", "war", "peace",

  // ── Solana-ecosystem specific ─────────────────────────────────────────────
  "raydium", "meteora", "pumpfun", "letsbonk", "jup", "bonk", "jito",
  "photon", "boop", "virtuals",

  // ── Shapes / numbers / misc ──────────────────────────────────────────────
  "zero", "one", "two", "big", "tiny", "mini", "maxi", "rich", "poor",
  "fast", "slow", "dark", "light", "black", "white", "red", "blue", "gold",

  // ── Current viral meme names ─────────────────────────────────────────────
  "pnut", "moodeng", "popcat", "act", "chillguy", "fwog", "popo",
  "slerf", "myro", "smol", "nub", "bome", "michi", "wen", "silly",
];

// Deterministic rotation — every scan picks the next QUERIES_PER_SCAN slice
let queryRotation = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Scanner class ────────────────────────────────────────────────────────────

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

  // ── Source 1: Broad keyword rotation ──────────────────────────────────────
  // Picks the next QUERIES_PER_SCAN slice from DISCOVERY_QUERIES (wraps around).
  // Single-letter queries are the core improvement — each letter returns a
  // completely different set of active tokens from DexScreener.
  private async fetchSearchPairs(): Promise<DexScreenerPair[]> {
    const queries: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCAN; i++) {
      queries.push(DISCOVERY_QUERIES[queryRotation % DISCOVERY_QUERIES.length]!);
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
        pairs.push(...filtered.slice(0, MAX_RESULTS_PER_QUERY));
      }
    }
    return pairs;
  }

  // ── Source 2: DexScreener curated lists (boosts + profiles) ───────────────
  // These surface tokens DexScreener itself promotes — often the hottest new
  // launches that organic search would miss.
  private async fetchCuratedLists(): Promise<{ tokenAddresses: string[]; pairAddresses: string[] }> {
    type DexEntry = { tokenAddress: string; chainId: string; url?: string };
    const [topBoostsRes, latestBoostsRes, profilesRes] = await Promise.allSettled([
      axios.get<DexEntry[]>(`${DEXSCREENER_BASE}/token-boosts/top/v1`,      { timeout: 8000 }),
      axios.get<DexEntry[]>(`${DEXSCREENER_BASE}/token-boosts/latest/v1`,   { timeout: 8000 }),
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

  // ── Source 3: Batch-fetch by token addresses ───────────────────────────────
  // NOTE: /tokens/v1/solana/{addresses} returns a bare array [], NOT { pairs: [] }
  private async fetchPairsForTokenAddresses(addresses: string[]): Promise<DexScreenerPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < addresses.length; i += 30) chunks.push(addresses.slice(i, i + 30));

    const results = await Promise.allSettled(
      chunks.map((chunk) =>
        axios.get<DexScreenerPair[] | { pairs: DexScreenerPair[] }>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${chunk.join(",")}`,
          { timeout: 8000 },
        ),
      ),
    );

    const pairs: DexScreenerPair[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const data = r.value.data;
        // API returns a bare array — handle both formats defensively
        const arr: DexScreenerPair[] = Array.isArray(data) ? data : (data as { pairs: DexScreenerPair[] }).pairs ?? [];
        pairs.push(...arr.filter((p) => p.chainId === "solana"));
      }
    }
    return pairs;
  }

  // ── Source 4: Batch-fetch by pair addresses ────────────────────────────────
  private async fetchPairsForPairAddresses(pairAddresses: string[]): Promise<DexScreenerPair[]> {
    const chunks: string[][] = [];
    for (let i = 0; i < pairAddresses.length; i += 30) chunks.push(pairAddresses.slice(i, i + 30));

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
        if (Array.isArray(data.pairs)) pairs.push(...data.pairs.filter((p) => p.chainId === "solana"));
      }
    }
    return pairs;
  }

  // ── Master fetch: all 4 sources run in parallel ────────────────────────────
  async fetchSolanaPairs(): Promise<DexScreenerPair[]> {
    try {
      const [searchResult, curatedResult] = await Promise.allSettled([
        this.fetchSearchPairs(),
        this.fetchCuratedLists().then(async ({ tokenAddresses, pairAddresses }) => {
          const [byPair, byToken] = await Promise.allSettled([
            pairAddresses.length > 0
              ? this.fetchPairsForPairAddresses(pairAddresses)
              : Promise.resolve([] as DexScreenerPair[]),
            tokenAddresses.length > 0
              ? this.fetchPairsForTokenAddresses(tokenAddresses)
              : Promise.resolve([] as DexScreenerPair[]),
          ]);
          const combined: DexScreenerPair[] = [];
          if (byPair.status === "fulfilled") combined.push(...byPair.value);
          if (byToken.status === "fulfilled") combined.push(...byToken.value);
          return combined;
        }),
      ]);

      const allPairs: DexScreenerPair[] = [];
      if (searchResult.status === "fulfilled") allPairs.push(...searchResult.value);
      if (curatedResult.status === "fulfilled") allPairs.push(...curatedResult.value);

      // Deduplicate by pair address — keep highest-volume version
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

  // ── Ingest fetched pairs into the pool ─────────────────────────────────────
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
        const liq = pair.liquidity?.usd ?? 0;
        if (liq < MIN_POOL_LIQUIDITY_USD) { skippedNoLiq++; continue; }
        if (pair.pairCreatedAt && (Date.now() - pair.pairCreatedAt) > MAX_POOL_AGE_MS) { skippedStale++; continue; }
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

      this.totalSkippedNoLiq  += skippedNoLiq;
      this.totalSkippedStale  += skippedStale;

      logger.debug(
        { scanCount: this.scanCount, newTokens: newCount, total: this.tokens.size, skippedNoLiq, skippedStale },
        "Scanner: scan complete",
      );

      this.broadcaster?.(this.getAll());
    } finally {
      this.isScanning = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start() {
    if (this.intervalId) return;
    void this.scan();
    this.intervalId = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.cleanupIntervalId = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    logger.info(
      {
        intervalMs: SCAN_INTERVAL_MS,
        queriesPerScan: QUERIES_PER_SCAN,
        totalQueryTerms: DISCOVERY_QUERIES.length,
        tokenTtlMin: TOKEN_TTL_MS / 60_000,
        maxPoolAgeHours: MAX_POOL_AGE_HOURS,
        minPoolLiquidityUsd: MIN_POOL_LIQUIDITY_USD,
        strategy: "alphabet-rotation + boosts/profiles — 500-800 unique tokens per cycle",
      },
      "Scanner started — broad discovery mode (alphabet + meme + curated)",
    );
  }

  stop() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    if (this.cleanupIntervalId) { clearInterval(this.cleanupIntervalId); this.cleanupIntervalId = null; }
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

  /**
   * Fallback lookup by token contract address when pairAddress lookup returns null.
   * Uses /tokens/v1/solana/{address} and picks the highest-liquidity Solana pair,
   * preferring the known pairAddress if it shows up.
   */
  async getPairByContractAddress(contractAddress: string, preferPairAddress?: string): Promise<DexScreenerPair | null> {
    try {
      const res = await axios.get<DexScreenerPair[] | { pairs: DexScreenerPair[] }>(
        `${DEXSCREENER_BASE}/tokens/v1/solana/${contractAddress}`,
        { timeout: 8000 },
      );
      // /tokens/v1/solana/{address} returns a bare array [], NOT { pairs: [] }
      const data = res.data;
      const rawPairs: DexScreenerPair[] = Array.isArray(data) ? data : (data as { pairs: DexScreenerPair[] }).pairs ?? [];
      const pairs = rawPairs.filter((p) => p.chainId === "solana");
      if (pairs.length === 0) return null;
      if (preferPairAddress) {
        const exact = pairs.find((p) => p.pairAddress === preferPairAddress);
        if (exact) return exact;
      }
      return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] ?? null;
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

  getTokenCount(): number { return this.tokens.size; }
  getTotalExpired(): number { return this.totalExpired; }
  getScanCount(): number { return this.scanCount; }
}

export const scannerService = new ScannerService();
