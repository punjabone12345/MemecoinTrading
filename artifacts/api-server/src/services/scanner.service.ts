import axios from "axios";
import { logger } from "../lib/logger.js";
import { computeSignals, computeAiScore, computeConfidence } from "./ai-scoring.service.js";
import { alertsService } from "./alerts.service.js";
import type { DexScreenerPair, ScannedToken } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

// ─── Timing & limits ─────────────────────────────────────────────────────────
// Budget: DexScreener public limit ≈ 300 req/min (5 req/s).
// Scanner uses at most CONCURRENCY requests at a time with 200 ms between
// batches → ~4 req/s peak for scanning, leaving ~1 req/s headroom for
// the auto-trader's per-trade verification calls.
const SCAN_INTERVAL_MS      = 8_000;  // 8 s between ticks (was 5 s)
const QUERIES_PER_SCAN      = 20;     // queries per tick (was 30) — 20/8s = 2.5 req/s
const SCAN_CONCURRENCY      = 5;      // max parallel DexScreener requests at once
const SCAN_BATCH_DELAY_MS   = 200;    // ms pause between batches of SCAN_CONCURRENCY
const MAX_RESULTS_PER_QUERY = 30;     // DexScreener returns up to 30 per search

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
  // Requests are issued in batches of SCAN_CONCURRENCY with SCAN_BATCH_DELAY_MS
  // pauses between batches to avoid saturating DexScreener's rate limit and
  // leaving headroom for the auto-trader's per-trade verification calls.
  private async fetchSearchPairs(): Promise<DexScreenerPair[]> {
    const queries: string[] = [];
    for (let i = 0; i < QUERIES_PER_SCAN; i++) {
      queries.push(DISCOVERY_QUERIES[queryRotation % DISCOVERY_QUERIES.length]!);
      queryRotation++;
    }

    const pairs: DexScreenerPair[] = [];

    // Process in batches of SCAN_CONCURRENCY
    for (let offset = 0; offset < queries.length; offset += SCAN_CONCURRENCY) {
      const batch = queries.slice(offset, offset + SCAN_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((q) =>
          axios.get<{ pairs: DexScreenerPair[] }>(
            `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(q)}`,
            { timeout: 10_000 },
          ),
        ),
      );

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

      // Brief pause between batches — keeps scanner well under the rate limit
      if (offset + SCAN_CONCURRENCY < queries.length) {
        await new Promise((r) => setTimeout(r, SCAN_BATCH_DELAY_MS));
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

  // ── HTTP helper: retries on 429/5xx with exponential backoff ─────────────────

  private async dexGet<T>(url: string, retries = 3): Promise<T | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await axios.get<T>(url, { timeout: 12_000 });
        return res.data;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        const isRetryable = !status || status === 429 || status >= 500;
        if (isRetryable && attempt < retries) {
          const delay = Math.min(500 * 2 ** attempt, 4_000);
          logger.warn({ url, attempt, status, delay }, "DexScreener: retryable error — waiting before retry");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        logger.warn({ url, attempt, status, err: (err as Error).message }, "DexScreener: lookup failed");
        return null;
      }
    }
    return null;
  }

  // ── Pair validator — rejects fake/stale/underpowered pairs ──────────────────

  private isValidPair(p: DexScreenerPair): boolean {
    if (!p.pairAddress) return false;
    const liq    = p.liquidity?.usd ?? 0;
    const vol24h = p.volume?.h24    ?? 0;
    const mcap   = p.marketCap || p.fdv || 0;
    if (liq    < 5_000)  return false;  // too illiquid
    if (vol24h < 10_000) return false;  // not trading
    if (mcap > 0 && liq > 0 && mcap / liq > 500) return false; // inflated mcap — likely fake
    return true;
  }

  // ── Pair ranker — Raydium first, then liquidity, then volume ─────────────────

  private rankPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
    return [...pairs].sort((a, b) => {
      const aRaydium = a.dexId === "raydium" ? 1 : 0;
      const bRaydium = b.dexId === "raydium" ? 1 : 0;
      if (bRaydium !== aRaydium) return bRaydium - aRaydium; // Raydium pairs first
      const liqDiff = (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
      if (liqDiff !== 0) return liqDiff;                      // then highest liquidity
      return (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);    // then highest volume
    });
  }

  // ── Stage A: Search by contract address (most reliable for fresh pools) ───────
  // GET /latest/dex/search?q={contractAddress}
  // Returns all pairs across all DEXes for that exact token CA.
  // This is the PRIMARY method — more reliable than pair-address lookup because
  // the CA never changes even when pools are migrated or re-indexed.

  private async searchByContractAddress(contractAddress: string): Promise<DexScreenerPair[]> {
    const data = await this.dexGet<{ pairs: DexScreenerPair[] }>(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(contractAddress)}`,
    );
    if (!data?.pairs) return [];
    return data.pairs.filter(
      (p) => p.chainId === "solana" && p.baseToken.address.toLowerCase() === contractAddress.toLowerCase(),
    );
  }

  // ── Stage B: Direct pair-address lookup ───────────────────────────────────────
  // GET /latest/dex/pairs/solana/{pairAddress}
  // Precise but fails if the pair address is stale or the pool was migrated.

  private async lookupByPairAddress(pairAddress: string): Promise<DexScreenerPair[]> {
    const data = await this.dexGet<{ pairs: DexScreenerPair[] }>(
      `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${pairAddress}`,
    );
    return data?.pairs?.filter((p) => p.chainId === "solana") ?? [];
  }

  // ── Stage C: Token-address endpoint ───────────────────────────────────────────
  // GET /tokens/v1/solana/{address}
  // NOTE: returns a bare array [], NOT { pairs: [] }

  private async lookupByTokenAddress(contractAddress: string): Promise<DexScreenerPair[]> {
    const data = await this.dexGet<DexScreenerPair[] | { pairs: DexScreenerPair[] }>(
      `${DEXSCREENER_BASE}/tokens/v1/solana/${contractAddress}`,
    );
    if (!data) return [];
    const arr: DexScreenerPair[] = Array.isArray(data)
      ? data
      : (data as { pairs: DexScreenerPair[] }).pairs ?? [];
    return arr.filter((p) => p.chainId === "solana");
  }

  // ── Stage D: Symbol search ────────────────────────────────────────────────────
  // GET /latest/dex/search?q={symbol}
  // Fuzzy fallback — filters to exact symbol match on Solana.

  private async searchBySymbol(symbol: string): Promise<DexScreenerPair[]> {
    const data = await this.dexGet<{ pairs: DexScreenerPair[] }>(
      `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(symbol)}`,
    );
    if (!data?.pairs) return [];
    return data.pairs.filter(
      (p) => p.chainId === "solana" && p.baseToken.symbol.toLowerCase() === symbol.toLowerCase(),
    );
  }

  // ── Stage E: GeckoTerminal fallback (free, no API key) ───────────────────────
  // GET https://api.geckoterminal.com/api/v2/networks/solana/tokens/{ca}/pools
  // Converts GeckoTerminal pool format into a minimal DexScreenerPair shape.

  private async lookupViaGeckoTerminal(contractAddress: string): Promise<DexScreenerPair[]> {
    try {
      type GtPool = {
        attributes: {
          address: string;
          name: string;
          dex_id: string;
          reserve_in_usd: string;
          volume_usd: { h24: string };
          fdv_usd: string | null;
          market_cap_usd: string | null;
          base_token_price_usd: string;
          transactions: { h1?: { buys?: number; sells?: number }; h24?: { buys?: number; sells?: number } };
          price_change_percentage: { h1?: string; h24?: string };
          pool_created_at: string | null;
        };
        relationships: { base_token: { data: { id: string } } };
      };
      type GtResponse = { data: GtPool[] };

      const res = await axios.get<GtResponse>(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${contractAddress}/pools?sort=h24_volume_usd_liquidity_desc&page=1`,
        { timeout: 12_000, headers: { Accept: "application/json;version=20230302" } },
      );
      const pools = res.data?.data ?? [];

      return pools.slice(0, 5).map((pool): DexScreenerPair => {
        const attr = pool.attributes;
        const liq   = parseFloat(attr.reserve_in_usd) || 0;
        const vol24 = parseFloat(attr.volume_usd?.h24) || 0;
        const price = parseFloat(attr.base_token_price_usd) || 0;
        const mcap  = parseFloat(attr.market_cap_usd ?? attr.fdv_usd ?? "0") || 0;
        // Derive a symbol from pool name (e.g. "TOKEN / SOL" → "TOKEN")
        const sym   = attr.name.split(/[\s/]+/)[0] ?? "UNKNOWN";
        return {
          chainId: "solana",
          dexId: attr.dex_id ?? "unknown",
          url: `https://www.geckoterminal.com/solana/pools/${attr.address}`,
          pairAddress: attr.address,
          baseToken: { address: contractAddress, name: sym, symbol: sym },
          quoteToken: { address: "", name: "SOL", symbol: "SOL" },
          priceNative: String(price),
          priceUsd: String(price),
          txns: {
            m5:  { buys: 0, sells: 0 },
            h1:  { buys: attr.transactions?.h1?.buys ?? 0, sells: attr.transactions?.h1?.sells ?? 0 },
            h6:  { buys: 0, sells: 0 },
            h24: { buys: attr.transactions?.h24?.buys ?? 0, sells: attr.transactions?.h24?.sells ?? 0 },
          },
          volume: { m5: 0, h1: 0, h6: 0, h24: vol24 },
          priceChange: {
            m5: 0,
            h1: parseFloat(attr.price_change_percentage?.h1 ?? "0") || 0,
            h6: 0,
            h24: parseFloat(attr.price_change_percentage?.h24 ?? "0") || 0,
          },
          liquidity: { usd: liq, base: 0, quote: 0 },
          fdv: mcap,
          marketCap: mcap,
          pairCreatedAt: attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : undefined,
          info: {},
        };
      });
    } catch (err) {
      logger.warn({ contractAddress, err: (err as Error).message }, "GeckoTerminal: lookup failed");
      return [];
    }
  }

  // ── Master verification lookup — used by auto-trader before opening trades ────
  // Tries 5 sources in order, validates each result set, returns best pair.
  // A token is ONLY rejected as "not found" if all 5 sources return nothing valid.

  async verifyPairForTrading(
    pairAddress: string,
    contractAddress: string,
    symbol: string,
  ): Promise<DexScreenerPair | null> {
    const strategies: Array<{ label: string; fn: () => Promise<DexScreenerPair[]> }> = [
      // A — search by CA (most reliable, catches migrated pools)
      {
        label: "search-by-ca",
        fn: () => this.searchByContractAddress(contractAddress),
      },
      // B — direct pair address (precise, fails if stale)
      {
        label: "pair-address",
        fn: () => this.lookupByPairAddress(pairAddress),
      },
      // C — token address endpoint
      {
        label: "token-address",
        fn: () => this.lookupByTokenAddress(contractAddress),
      },
      // D — symbol search (fuzzy last resort for DexScreener)
      {
        label: "symbol-search",
        fn: () => this.searchBySymbol(symbol),
      },
      // E — GeckoTerminal (independent data source, different infrastructure)
      {
        label: "geckoterminal",
        fn: () => this.lookupViaGeckoTerminal(contractAddress),
      },
    ];

    for (const { label, fn } of strategies) {
      try {
        const pairs = await fn();
        // Validate and rank — pick best valid pair
        const valid = this.rankPairs(pairs.filter((p) => this.isValidPair(p)));
        if (valid.length > 0) {
          logger.debug({ symbol, pairAddress, source: label }, "DexScreener verify: found via source");
          return valid[0]!;
        }
        // Source returned pairs but none passed validation — log and continue
        if (pairs.length > 0) {
          logger.warn(
            { symbol, source: label, count: pairs.length },
            "DexScreener verify: pairs found but all failed validation — trying next source",
          );
        }
      } catch (err) {
        logger.warn({ symbol, source: label, err: (err as Error).message }, "DexScreener verify: source error — trying next");
      }
    }

    logger.warn({ symbol, pairAddress, contractAddress }, "DexScreener verify: all 5 sources exhausted — pair not found");
    return null;
  }

  // ── Legacy public methods kept for backward compatibility ─────────────────────

  /** @deprecated Use verifyPairForTrading() instead */
  async getPairFromDex(pairAddress: string): Promise<DexScreenerPair | null> {
    const pairs = await this.lookupByPairAddress(pairAddress);
    const valid = pairs.filter((p) => this.isValidPair(p));
    return this.rankPairs(valid)[0] ?? null;
  }

  /** @deprecated Use verifyPairForTrading() instead */
  async getPairByContractAddress(contractAddress: string, preferPairAddress?: string): Promise<DexScreenerPair | null> {
    const [bySearch, byToken] = await Promise.all([
      this.searchByContractAddress(contractAddress),
      this.lookupByTokenAddress(contractAddress),
    ]);
    const all = [...bySearch, ...byToken].filter((p) => this.isValidPair(p));
    if (preferPairAddress) {
      const exact = all.find((p) => p.pairAddress === preferPairAddress);
      if (exact) return exact;
    }
    return this.rankPairs(all)[0] ?? null;
  }

  /** @deprecated Use verifyPairForTrading() instead */
  async getPairBySymbol(symbol: string, preferPairAddress?: string): Promise<DexScreenerPair | null> {
    const pairs = await this.searchBySymbol(symbol);
    const valid = pairs.filter((p) => this.isValidPair(p));
    if (preferPairAddress) {
      const exact = valid.find((p) => p.pairAddress === preferPairAddress);
      if (exact) return exact;
    }
    return this.rankPairs(valid)[0] ?? null;
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
