import axios from "axios";
import { logger } from "../lib/logger.js";
import { sendTelegram, isTelegramConfigured } from "../lib/telegram.js";
import { paperTradingService } from "./paper-trading.service.js";
import { scannerService } from "./scanner.service.js";
import { computeSignals, computeAiScore, computeConfidence, getDynamicRisk } from "./ai-scoring.service.js";
import { mapPairToToken } from "./scanner.service.js";
import type { DexScreenerPair } from "../types/index.js";

const DEXSCREENER_BASE = "https://api.dexscreener.com";
const AUTO_TRADE_INTERVAL_MS = 60_000;
const MAX_HISTORY_CYCLES = 50;

export interface AutoTraderConfig {
  solPerTrade: number;
  maxConcurrentTrades: number;
  // AI quality
  minAiScore: number;
  minConfidence: number;
  // Liquidity & volume
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minVolume1hUsd: number;
  // Activity / momentum
  minBuyRatio1h: number;       // 0–1, e.g. 0.60 = 60% buys
  minPriceChange1h: number;    // %, must be positive momentum
  minTransactions24h: number;
  // Market cap sweet spot
  minMcapUsd: number;
  maxMcapUsd: number;
  // Pair age window (minutes / hours)
  minPairAgeMinutes: number;
  maxPairAgeHours: number;
  // Rug-pull guards
  minLiquidityMcapRatio: number;  // e.g. 0.05 = liq must be ≥5% of mcap
  maxFdvMcapRatio: number;        // e.g. 5.0 = FDV must not exceed 5× mcap
  maxPriceDropH6Pct: number;      // reject if 6h drop exceeds this (negative number)
  maxPriceDropH24Pct: number;     // reject if 24h drop exceeds this (negative number)
}

export interface FilterResult {
  pass: boolean;
  reason: string;
}

export interface CycleDecision {
  symbol: string;
  tokenName: string;
  pairAddress: string;
  aiScore: number;
  confidence: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume1hUsd: number;
  marketCapUsd: number;
  buyRatio1h: number;
  priceChange1h: number;
  pairAgeMinutes: number;
  priceUsd: number;
  slPercent: number;
  tpPercent: number;
  action: "traded" | "filtered" | "skipped_duplicate" | "skipped_slots" | "skipped_balance";
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
  scannerPoolSize: number;
  config: AutoTraderConfig;
}

// ─── Default config: strict quality filters ───────────────────────────────────
const DEFAULT_CONFIG: AutoTraderConfig = {
  solPerTrade: 0.5,
  maxConcurrentTrades: 5,
  // AI
  minAiScore: 65,
  minConfidence: 70,
  // Liquidity & volume
  minLiquidityUsd: 75_000,
  minVolume24hUsd: 100_000,
  minVolume1hUsd: 10_000,
  // Momentum
  minBuyRatio1h: 0.60,
  minPriceChange1h: 3,
  minTransactions24h: 200,
  // Market cap sweet spot ($100k – $20M)
  minMcapUsd: 100_000,
  maxMcapUsd: 20_000_000,
  // Pair age (30 min – 72 hours)
  minPairAgeMinutes: 30,
  maxPairAgeHours: 72,
  // Rug guards
  minLiquidityMcapRatio: 0.05,
  maxFdvMcapRatio: 5.0,
  maxPriceDropH6Pct: -35,
  maxPriceDropH24Pct: -60,
};

// ─── Multi-layer quality + rug-pull filter ────────────────────────────────────
export function qualityFilter(pair: DexScreenerPair, cfg: AutoTraderConfig): FilterResult {
  const fail = (reason: string): FilterResult => ({ pass: false, reason });

  const priceUsd = parseFloat(pair.priceUsd) || 0;
  const liq = pair.liquidity?.usd || 0;
  const vol24h = pair.volume?.h24 || 0;
  const vol1h = pair.volume?.h1 || 0;
  const mcap = pair.marketCap || pair.fdv || 0;
  const fdv = pair.fdv || mcap;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const total1h = buys1h + sells1h;
  const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);
  const pc1h = pair.priceChange?.h1 || 0;
  const pc6h = pair.priceChange?.h6 || 0;
  const pc24h = pair.priceChange?.h24 || 0;
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
  const ageMinutes = ageMs / 60_000;
  const buyRatio1h = total1h > 0 ? buys1h / total1h : 0;

  // ── Sanity ────────────────────────────────────────────────────────────────
  if (priceUsd <= 0) return fail("No valid price");
  if (mcap <= 0) return fail("No market cap data");

  // ── Liquidity floor ───────────────────────────────────────────────────────
  if (liq < cfg.minLiquidityUsd)
    return fail(`Liquidity $${Math.round(liq).toLocaleString()} < $${cfg.minLiquidityUsd.toLocaleString()} min`);

  // ── Volume floors ─────────────────────────────────────────────────────────
  if (vol24h < cfg.minVolume24hUsd)
    return fail(`Vol24h $${Math.round(vol24h).toLocaleString()} < $${cfg.minVolume24hUsd.toLocaleString()} min`);
  if (vol1h < cfg.minVolume1hUsd)
    return fail(`Vol1h $${Math.round(vol1h).toLocaleString()} < $${cfg.minVolume1hUsd.toLocaleString()} min`);

  // ── Activity ──────────────────────────────────────────────────────────────
  if (txns24h < cfg.minTransactions24h)
    return fail(`Txns24h ${txns24h} < ${cfg.minTransactions24h} min`);

  // ── Buy pressure ─────────────────────────────────────────────────────────
  if (total1h < 10)
    return fail(`Only ${total1h} txns in last 1h — can't verify buy pressure`);
  if (buyRatio1h < cfg.minBuyRatio1h)
    return fail(`Buy ratio ${(buyRatio1h * 100).toFixed(0)}% < ${(cfg.minBuyRatio1h * 100).toFixed(0)}% min`);

  // ── Momentum ──────────────────────────────────────────────────────────────
  if (pc1h < cfg.minPriceChange1h)
    return fail(`1h change ${pc1h.toFixed(1)}% < +${cfg.minPriceChange1h}% min`);

  // ── Market cap sweet spot ─────────────────────────────────────────────────
  if (mcap < cfg.minMcapUsd)
    return fail(`MCap $${Math.round(mcap).toLocaleString()} < $${cfg.minMcapUsd.toLocaleString()} min`);
  if (mcap > cfg.maxMcapUsd)
    return fail(`MCap $${(mcap / 1_000_000).toFixed(1)}M > $${(cfg.maxMcapUsd / 1_000_000).toFixed(0)}M max`);

  // ── Pair age window ───────────────────────────────────────────────────────
  if (!pair.pairCreatedAt || ageMinutes < cfg.minPairAgeMinutes)
    return fail(`Pair age ${Math.round(ageMinutes)}m < ${cfg.minPairAgeMinutes}m min`);
  if (ageMinutes > cfg.maxPairAgeHours * 60)
    return fail(`Pair age ${Math.round(ageMinutes / 60)}h > ${cfg.maxPairAgeHours}h max`);

  // ── Rug-pull: liquidity/mcap ratio ───────────────────────────────────────
  const liqMcapRatio = liq / mcap;
  if (liqMcapRatio < cfg.minLiquidityMcapRatio)
    return fail(`Liq/MCap ${(liqMcapRatio * 100).toFixed(1)}% < ${(cfg.minLiquidityMcapRatio * 100).toFixed(0)}% — rug risk`);

  // ── Rug-pull: FDV inflation (massive locked supply) ───────────────────────
  if (fdv > 0 && mcap > 0 && fdv / mcap > cfg.maxFdvMcapRatio)
    return fail(`FDV/MCap ${(fdv / mcap).toFixed(1)}x > ${cfg.maxFdvMcapRatio}x max — dilution risk`);

  // ── Dump detection ────────────────────────────────────────────────────────
  if (pc6h < cfg.maxPriceDropH6Pct)
    return fail(`6h dump ${pc6h.toFixed(1)}% — possible rug or dead momentum`);
  if (pc24h < cfg.maxPriceDropH24Pct)
    return fail(`24h dump ${pc24h.toFixed(1)}% — token in severe decline`);

  // ── Wash-trading suspicion ────────────────────────────────────────────────
  if (sells1h === 0 && buys1h > 20)
    return fail("Zero sells with high buys in 1h — likely wash trading");

  return { pass: true, reason: "All filters passed" };
}

// ─── Service ──────────────────────────────────────────────────────────────────
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
  private config: AutoTraderConfig = { ...DEFAULT_CONFIG };
  private wasAtMaxTrades = false;

  getConfig(): AutoTraderConfig { return { ...this.config }; }

  updateConfig(patch: Partial<AutoTraderConfig>): AutoTraderConfig {
    this.config = { ...this.config, ...patch };
    logger.info({ config: this.config }, "Auto-trader config updated");
    return { ...this.config };
  }

  pause(): void { this.paused = true; logger.info("Auto-trader paused"); }
  resume(): void { this.paused = false; logger.info("Auto-trader resumed"); void this.run(); }
  isPaused(): boolean { return this.paused; }
  getHistory(): CycleRecord[] { return [...this.history].reverse(); }

  /**
   * Supplementary fetch: get any fresh boosted/profiled addresses not yet in scanner
   */
  private async fetchSupplementaryPairs(): Promise<DexScreenerPair[]> {
    try {
      const [boostsRes, profilesRes] = await Promise.allSettled([
        axios.get<{ tokenAddress: string; chainId: string }[]>(
          `${DEXSCREENER_BASE}/token-boosts/top/v1`,
          { timeout: 10_000 },
        ),
        axios.get<{ tokenAddress: string; chainId: string }[]>(
          `${DEXSCREENER_BASE}/token-profiles/latest/v1`,
          { timeout: 10_000 },
        ),
      ]);

      const addresses = new Set<string>();
      if (boostsRes.status === "fulfilled" && Array.isArray(boostsRes.value.data)) {
        boostsRes.value.data.filter((b) => b.chainId === "solana").forEach((b) => addresses.add(b.tokenAddress));
      }
      if (profilesRes.status === "fulfilled" && Array.isArray(profilesRes.value.data)) {
        profilesRes.value.data.filter((p) => p.chainId === "solana").forEach((p) => addresses.add(p.tokenAddress));
      }

      if (addresses.size === 0) return [];

      const chunks: string[][] = [];
      const addrArr = Array.from(addresses);
      for (let i = 0; i < addrArr.length; i += 30) chunks.push(addrArr.slice(i, i + 30));

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
      const { minAiScore, minConfidence, solPerTrade, maxConcurrentTrades } = this.config;
      const openPositions = paperTradingService.getOpenPositions();

      if (openPositions.length >= maxConcurrentTrades) {
        logger.info({ open: openPositions.length, max: maxConcurrentTrades }, "Auto-trader: at max concurrent trades — skipping cycle");
        if (!this.wasAtMaxTrades) {
          this.wasAtMaxTrades = true;
          void sendTelegram(
            `⏸️ <b>Auto-Trader — All Slots Full</b>\n` +
            `──────────────────\n` +
            `📦 Open positions: <b>${openPositions.length}/${maxConcurrentTrades}</b>\n` +
            `🔍 Scanner still running in background.\n` +
            `🔔 You'll be notified when a position closes and a new slot opens.`,
          );
        }
        return;
      }
      if (this.wasAtMaxTrades) {
        this.wasAtMaxTrades = false;
        void sendTelegram(
          `▶️ <b>Auto-Trader — Slot Freed Up</b>\n` +
          `──────────────────\n` +
          `📦 Open positions: <b>${openPositions.length}/${maxConcurrentTrades}</b>\n` +
          `🔍 Resuming scan for next A+ trade signal...`,
        );
      }

      // ── PRIMARY: use scanner's accumulated token pool ──────────────────────
      // Scanner runs every 4s with rotating meme coin queries + boosts/profiles.
      // After the server has been running for a few minutes this pool is rich.
      const scannerTokens = scannerService.getAll();

      // ── SUPPLEMENTARY: fresh fetch for any tokens not in scanner yet ────────
      const freshPairs = await this.fetchSupplementaryPairs();
      const seenInScanner = new Set(scannerTokens.map((t) => t.pairAddress));

      // Convert fresh pairs → scanned tokens, skip ones already in scanner cache
      const freshTokens = freshPairs
        .filter((p) => !seenInScanner.has(p.pairAddress))
        .map((p) => mapPairToToken(p));

      // Deduplicate fresh tokens
      const freshSeen = new Set<string>();
      const uniqueFresh = freshTokens.filter((t) => {
        if (freshSeen.has(t.pairAddress)) return false;
        freshSeen.add(t.pairAddress);
        return true;
      });

      const allCandidates = [...scannerTokens, ...uniqueFresh];
      tokensEvaluated = allCandidates.length;

      logger.info({ cycleId, scannerPool: scannerTokens.length, freshTokens: uniqueFresh.length, total: tokensEvaluated }, "Auto-trader: candidate pool built");

      interface Candidate {
        pairAddress: string;
        symbol: string;
        tokenName: string;
        aiScore: number;
        confidence: number;
        liquidityUsd: number;
        volume24hUsd: number;
        volume1hUsd: number;
        marketCapUsd: number;
        buyRatio1h: number;
        priceChange1h: number;
        pairAgeMinutes: number;
        priceUsd: number;
        slPercent: number;
        tpPercent: number;
        pair: DexScreenerPair | null;
      }

      const qualifiedCandidates: Candidate[] = [];

      for (const token of allCandidates) {
        const { slPercent, tpPercent } = getDynamicRisk(token.aiScore);
        const total1h = token.buys1h + token.sells1h;
        const buyRatio1h = total1h > 0 ? token.buys1h / total1h : 0;
        const pairAgeMinutes = token.pairAge ? (Date.now() - token.pairAge) / 60_000 : 0;

        const base: Omit<CycleDecision, "action" | "reason"> = {
          symbol: token.symbol,
          tokenName: token.name,
          pairAddress: token.pairAddress,
          aiScore: token.aiScore,
          confidence: token.confidence,
          liquidityUsd: token.liquidity,
          volume24hUsd: token.volume24h,
          volume1hUsd: token.volume1h,
          marketCapUsd: token.marketCap,
          buyRatio1h,
          priceChange1h: token.priceChange1h,
          pairAgeMinutes,
          priceUsd: token.priceUsd,
          slPercent,
          tpPercent,
        };

        // Duplicate symbol check
        if (paperTradingService.hasOpenPositionForSymbol(token.symbol)) {
          decisions.push({ ...base, action: "skipped_duplicate", reason: `Already have open position for ${token.symbol}` });
          continue;
        }

        // AI score gate
        if (token.aiScore < minAiScore) {
          decisions.push({ ...base, action: "filtered", reason: `AI score ${token.aiScore} < ${minAiScore} min` });
          continue;
        }

        // Confidence gate
        if (token.confidence < minConfidence) {
          decisions.push({ ...base, action: "filtered", reason: `Confidence ${token.confidence}% < ${minConfidence}% min` });
          continue;
        }

        // Build a synthetic pair object from scanner data to run qualityFilter
        const syntheticPair: DexScreenerPair = {
          chainId: token.chainId,
          dexId: token.dexId,
          url: token.url,
          pairAddress: token.pairAddress,
          baseToken: { address: token.address, name: token.name, symbol: token.symbol },
          quoteToken: { address: "", name: "USDC", symbol: "USDC" },
          priceNative: String(token.priceNative),
          priceUsd: String(token.priceUsd),
          txns: {
            m5: { buys: token.buys5m, sells: token.sells5m },
            h1: { buys: token.buys1h, sells: token.sells1h },
            h6: { buys: 0, sells: 0 },
            h24: { buys: token.buys24h, sells: token.sells24h },
          },
          volume: { h24: token.volume24h, h6: 0, h1: token.volume1h, m5: token.volume5m },
          priceChange: {
            m5: token.priceChange5m,
            h1: token.priceChange1h,
            h6: token.priceChange6h,
            h24: token.priceChange24h,
          },
          liquidity: { usd: token.liquidity, base: 0, quote: 0 },
          fdv: token.fdv,
          marketCap: token.marketCap,
          pairCreatedAt: token.pairAge,
          info: { imageUrl: token.imageUrl },
        };

        const filterResult = qualityFilter(syntheticPair, this.config);
        if (!filterResult.pass) {
          decisions.push({ ...base, action: "filtered", reason: filterResult.reason });
          continue;
        }

        qualifiedCandidates.push({
          pairAddress: token.pairAddress,
          symbol: token.symbol,
          tokenName: token.name,
          aiScore: token.aiScore,
          confidence: token.confidence,
          liquidityUsd: token.liquidity,
          volume24hUsd: token.volume24h,
          volume1hUsd: token.volume1h,
          marketCapUsd: token.marketCap,
          buyRatio1h,
          priceChange1h: token.priceChange1h,
          pairAgeMinutes,
          priceUsd: token.priceUsd,
          slPercent,
          tpPercent,
          pair: syntheticPair,
        });
      }

      // Sort by AI score descending, slot into available positions
      qualifiedCandidates.sort((a, b) => b.aiScore - a.aiScore);
      const slots = maxConcurrentTrades - openPositions.length;
      const toTrade = qualifiedCandidates.slice(0, slots);
      const overflow = qualifiedCandidates.slice(slots);

      for (const c of overflow) {
        decisions.push({ ...c, action: "skipped_slots", reason: "No available trade slots (max concurrent reached)" });
      }

      for (const c of toTrade) {
        const token = scannerService.getByPairAddress(c.pairAddress) ?? await scannerService.getOrFetchToken(c.pairAddress);
        if (!token) {
          decisions.push({ ...c, action: "skipped_balance", reason: "Token disappeared from scanner" });
          continue;
        }
        token.aiScore = c.aiScore;
        token.confidence = c.confidence;

        try {
          const position = await paperTradingService.buyDirect(token, solPerTrade);
          decisions.push({
            ...c,
            action: "traded",
            reason: `Opened ${solPerTrade} SOL | Score ${c.aiScore} | SL -${c.slPercent}% | TP +${c.tpPercent}%`,
            positionId: position.positionId,
          });
          tradesOpened++;
          this.totalTradesOpened++;
          logger.info(
            { positionId: position.positionId, symbol: c.symbol, aiScore: c.aiScore, liq: c.liquidityUsd, vol24h: c.volume24hUsd, mcap: c.marketCapUsd },
            "Auto-trader: HIGH-QUALITY trade opened",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          decisions.push({ ...c, action: "skipped_balance", reason: msg });
          logger.warn({ err, symbol: c.symbol }, "Auto-trader: trade open failed");
        }
      }

      this.lastRunTokensEvaluated = tokensEvaluated;
      this.lastRunTradesOpened = tradesOpened;
      this.lastRunAt = Date.now();

      const filtered = decisions.filter((d) => d.action === "filtered").length;
      const traded = decisions.filter((d) => d.action === "traded").length;
      logger.info({ cycleId, tokensEvaluated, filtered, qualified: qualifiedCandidates.length, tradesOpened: traded }, "Auto-trader: cycle complete");
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
    logger.info(
      { intervalSec: AUTO_TRADE_INTERVAL_MS / 1000, telegramEnabled: isTelegramConfigured(), config: this.config },
      "Auto-trader started — strict quality filters active",
    );
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  startHeartbeat(): void {
    if (!isTelegramConfigured()) {
      logger.info("Heartbeat skipped — Telegram not configured");
      return;
    }

    const send = () => {
      const portfolio = paperTradingService.getPortfolio();
      const openPositions = paperTradingService.getOpenPositions();
      const closedTrades = paperTradingService.getClosedTrades();
      const scannerPool = scannerService.getTokenCount();
      const scanCycles = scannerService.getScanCount();
      const expired = scannerService.getTotalExpired();
      const now = new Date().toUTCString();

      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const closedToday = closedTrades.filter(
        (t) => t.closedAt && new Date(t.closedAt).getTime() >= todayStart.getTime(),
      ).length;
      const openToday = openPositions.filter(
        (p) => new Date(p.openedAt).getTime() >= todayStart.getTime(),
      ).length;

      const pnlSign = portfolio.totalPnlSol >= 0 ? "+" : "";

      void sendTelegram(
        `🤖 <b>Apex Scanner — Hourly Heartbeat</b>\n` +
        `──────────────────\n` +
        `✅ Scanner: <b>RUNNING</b>\n` +
        `🔍 Active tokens in pool: <b>${scannerPool}</b>\n` +
        `♻️ Rotated out (stale): <b>${expired}</b>\n` +
        `🔄 Scanner cycles: <b>${scanCycles}</b> | Trader cycles: <b>${this.cycleCounter}</b>\n` +
        `──────────────────\n` +
        `📊 Trades today: <b>${openToday + closedToday}</b> (${openToday} open, ${closedToday} closed)\n` +
        `📈 All-time traded: <b>${this.totalTradesOpened}</b>\n` +
        `💰 Open positions: <b>${portfolio.openPositionsCount}/${this.config.maxConcurrentTrades}</b>\n` +
        `💵 Balance: <b>${portfolio.solBalance.toFixed(4)} SOL</b>\n` +
        `📉 Total PNL: <b>${pnlSign}${portfolio.totalPnlSol.toFixed(4)} SOL</b>\n` +
        `──────────────────\n` +
        `⏰ Hunting for A+ signals...\n` +
        `<i>${now}</i>`,
      );
    };

    // Send first heartbeat after 5 minutes (not immediately)
    setTimeout(() => {
      send();
      setInterval(send, 60 * 60 * 1000); // then every hour
    }, 5 * 60 * 1000);

    logger.info("Heartbeat started — Telegram status every 1h (first in 5m)");
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
      scannerPoolSize: scannerService.getTokenCount(),
      config: this.getConfig(),
    };
  }
}

export const autoTraderService = new AutoTraderService();
