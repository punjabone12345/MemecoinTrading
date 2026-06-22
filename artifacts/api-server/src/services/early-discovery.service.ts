import WebSocket from "ws";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { broadcast } from "../websocket/server.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";
import { checkTokenSafety } from "./rugcheck.service.js";
import {
  calculateDemandScore, checkEntryConditions, checkQualityExit,
  getPositionSizeMultiplier,
  type DemandMetrics, type DemandScores,
} from "./demand-scorer.js";

// ── Constants ──────────────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM  = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPFUN_API_BASE = "https://client-api-2-74b1891ee9f9.herokuapp.com";
const DEXSCREENER_BASE = "https://api.dexscreener.com";
const HELIUS_WS_BASE   = "wss://atlas-mainnet.helius-rpc.com";

const POLL_INTERVAL_MS     = 30_000;
const MAX_TRACK_AGE_MS     = 30 * 60 * 1000;  // 30 min
const MAX_TRACKED_TOKENS   = 60;
const ENTRY_CONFIRM_MS     = 2 * 60 * 1000;   // 2 min confirmation window
const STARTING_BALANCE     = 1.0;             // SOL
const KV_CONFIG_KEY        = "ed_config";
const KV_BALANCE_KEY       = "ed_balance";

const HELIUS_API_KEY = process.env["HELIUS_API_KEY"] ?? "";

// ── Types ──────────────────────────────────────────────────────────────────────
export type EDTokenStatus = "tracking" | "rejected" | "eligible" | "entered" | "exited";

export interface EDToken {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  imageUri: string;
  launchAt: number;
  lastUpdatedAt: number;
  priceUsd: number;
  marketCapUsd: number;
  bondingCurvePct: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  uniqueBuyers: number;
  prevUniqueBuyers: number;
  buyerAcceleration: number;
  buyersPerMinute: number;
  creatorHoldingsPct: number;
  topHolderPct: number;
  whaleParticipation: boolean;
  rugcheckStatus: "pending" | "passed" | "failed";
  rugcheckReason: string;
  rugcheckScore: number;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  scores: DemandScores;
  status: EDTokenStatus;
  rejectionReason: string;
  firstEligibleAt: number | null;
  discoveryPrice: number;
  positionId: string | null;
  pollCount: number;
  creatorSold: boolean;
}

export interface EDPosition {
  id: string;
  mint: string;
  symbol: string;
  name: string;
  entryAt: number;
  entryPrice: number;
  entryMcap: number;
  entryScore: number;
  currentPrice: number;
  currentMcap: number;
  sizeSol: number;
  remainingFraction: number;
  effectiveSlPrice: number;
  trailingHigh: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  status: "open" | "closed";
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  pnlPct: number;
  closeReason: string;
  closedAt: number | null;
  exitPrice: number | null;
  tp1RealizedSol: number;
  tp2RealizedSol: number;
  runnerRealizedSol: number;
  closingScore: number | null;
  positionMultiplier: number;
}

export interface EDConfig {
  enabled: boolean;
  positionSizeSol: number;
  maxOpenPositions: number;
  minScore: number;
  minBondingCurvePct: number;
  minUniqueBuyers: number;
  minBuyPressureRatio: number;
  slPct: number;
  tp1Pct: number;
  tp1ClosePct: number;
  tp2Pct: number;
  tp2ClosePct: number;
  runnerTrailingPct: number;
}

export interface EDStatus {
  wsConnected: boolean;
  wsReconnects: number;
  enabled: boolean;
  trackedCount: number;
  eligibleCount: number;
  enteredCount: number;
  rejectedCount: number;
  launchesDetected: number;
  virtualBalance: number;
  startingBalance: number;
  openCount: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  totalRealizedPnlSol: number;
  totalUnrealizedPnlSol: number;
  config: EDConfig;
}

const DEFAULT_CONFIG: EDConfig = {
  enabled: true,
  positionSizeSol: 0.1,
  maxOpenPositions: 5,
  minScore: 95,
  minBondingCurvePct: 70,
  minUniqueBuyers: 25,
  minBuyPressureRatio: 3,
  slPct: 20,
  tp1Pct: 80,
  tp1ClosePct: 25,
  tp2Pct: 200,
  tp2ClosePct: 35,
  runnerTrailingPct: 25,
};

function uid(): string {
  return `ed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ── Service ───────────────────────────────────────────────────────────────────
class EarlyDiscoveryService {
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  private tokens = new Map<string, EDToken>();
  private openPositions = new Map<string, EDPosition>();
  private closedPositions: EDPosition[] = [];
  private virtualBalance = STARTING_BALANCE;
  private wins = 0;
  private losses = 0;
  private launchesDetected = 0;
  private config = { ...DEFAULT_CONFIG };

  // ── Init ──────────────────────────────────────────────────────────────────
  async init(): Promise<void> {
    await this.loadConfig();
    await this.loadBalance();
    await this.loadPositions();
    logger.info({ trackedTokens: this.tokens.size, openPositions: this.openPositions.size, virtualBalance: this.virtualBalance }, "Early discovery: initialised");
  }

  start(): void {
    if (!HELIUS_API_KEY) {
      logger.warn("Early discovery: HELIUS_API_KEY not set — WebSocket disabled. Paper trading active in offline mode.");
    } else {
      this.connectWs();
    }
    this.pollInterval = setInterval(() => this.pollCycle(), POLL_INTERVAL_MS);
    logger.info("Early discovery: started");
  }

  // ── Helius WebSocket ──────────────────────────────────────────────────────
  private connectWs(): void {
    if (!HELIUS_API_KEY) return;
    try {
      const wsUrl = `${HELIUS_WS_BASE}?api-key=${HELIUS_API_KEY}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.wsConnected = true;
        logger.info("Early discovery: Helius WS connected");
        this.subscribe();
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
        }, 30_000);
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          this.handleWsMessage(msg);
        } catch { /* ignore malformed */ }
      };

      this.ws.onclose = () => {
        this.wsConnected = false;
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.wsReconnects++;
        const delay = Math.min(30_000, 3_000 * this.wsReconnects);
        logger.warn({ reconnects: this.wsReconnects, delayMs: delay }, "Early discovery: WS closed — reconnecting");
        setTimeout(() => this.connectWs(), delay);
      };

      this.ws.onerror = (err) => {
        logger.error({ err: (err as Error).message }, "Early discovery: WS error");
      };
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Early discovery: WS connect failed");
      setTimeout(() => this.connectWs(), 10_000);
    }
  }

  private subscribe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "transactionSubscribe",
      params: [
        {
          accountInclude: [PUMPFUN_PROGRAM],
          commitment: "confirmed",
          failed: false,
        },
        {
          encoding: "base64",
          transactionDetails: "full",
          showRewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
    }));
    logger.info("Early discovery: subscribed to pump.fun program transactions");
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    if (msg["method"] !== "transactionNotification") return;
    const params = msg["params"] as Record<string, unknown> | undefined;
    const result = params?.["result"] as Record<string, unknown> | undefined;
    if (!result) return;

    const sig = result["signature"] as string | undefined;
    const txWrapper = result["transaction"] as Record<string, unknown> | undefined;
    if (!txWrapper) return;

    const meta = txWrapper["meta"] as Record<string, unknown> | undefined;
    const logMessages = (meta?.["logMessages"] as string[] | undefined) ?? [];

    const isCreate = logMessages.some((l) =>
      l.includes("Instruction: Create") || l.includes("Program log: Instruction: Create")
    );
    if (!isCreate) return;

    const postTokenBalances = (meta?.["postTokenBalances"] as Array<{ mint?: string; owner?: string }> | undefined) ?? [];
    let mint: string | null = null;
    for (const bal of postTokenBalances) {
      if (bal.mint && bal.mint.length > 32 && !this.tokens.has(bal.mint)) {
        mint = bal.mint;
        break;
      }
    }
    if (!mint) return;
    if (this.tokens.has(mint)) return;

    logger.info({ mint: mint.slice(0, 8), sig: sig?.slice(0, 8) }, "Early discovery: new pump.fun launch detected 🚀");
    this.launchesDetected++;
    void this.onNewLaunch(mint);
  }

  // ── New token onboarding ──────────────────────────────────────────────────
  private async onNewLaunch(mint: string): Promise<void> {
    if (this.tokens.size >= MAX_TRACKED_TOKENS) {
      this.pruneOldTokens();
      if (this.tokens.size >= MAX_TRACKED_TOKENS) {
        logger.debug({ mint: mint.slice(0, 8) }, "Early discovery: too many tracked tokens, skipping new launch");
        return;
      }
    }

    const now = Date.now();
    const token: EDToken = {
      mint,
      symbol: "???",
      name: "Loading…",
      creator: "",
      imageUri: "",
      launchAt: now,
      lastUpdatedAt: now,
      priceUsd: 0,
      marketCapUsd: 0,
      bondingCurvePct: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      uniqueBuyers: 0,
      prevUniqueBuyers: 0,
      buyerAcceleration: 0,
      buyersPerMinute: 0,
      creatorHoldingsPct: 0,
      topHolderPct: 0,
      whaleParticipation: false,
      rugcheckStatus: "pending",
      rugcheckReason: "",
      rugcheckScore: 0,
      mintAuthority: false,
      freezeAuthority: false,
      scores: { buyerGrowthScore: 0, volumeScore: 0, buyPressureScore: 0, walletQualityScore: 0, bondingCurveScore: 0, finalScore: 0, buyPressureRatio: 0 },
      status: "tracking",
      rejectionReason: "",
      firstEligibleAt: null,
      discoveryPrice: 0,
      positionId: null,
      pollCount: 0,
      creatorSold: false,
    };

    this.tokens.set(mint, token);
    this.broadcast();

    // Fetch initial metadata + run rugcheck concurrently
    const [pfData] = await Promise.all([
      this.fetchPumpFunData(mint),
      this.runRugcheck(mint, token),
    ]);

    if (pfData) {
      token.symbol       = pfData.symbol || "???";
      token.name         = pfData.name   || mint.slice(0, 8);
      token.creator      = pfData.creator || "";
      token.imageUri     = pfData.imageUri || "";
      token.marketCapUsd = pfData.marketCapUsd;
      token.bondingCurvePct = pfData.bondingCurvePct;
      token.discoveryPrice  = pfData.priceUsd;
      token.priceUsd        = pfData.priceUsd;
    }
    token.lastUpdatedAt = Date.now();
    this.broadcast();
  }

  private async runRugcheck(mint: string, token: EDToken): Promise<void> {
    try {
      const result = await checkTokenSafety(mint, 0);
      token.rugcheckStatus    = result.pass ? "passed" : "failed";
      token.rugcheckReason    = result.reason;
      token.rugcheckScore     = result.score;
      token.mintAuthority     = Boolean(result.mintAuthority);
      token.freezeAuthority   = Boolean(result.freezeAuthority);
      token.topHolderPct      = result.topHolderPct;

      if (!result.pass) {
        token.status          = "rejected";
        token.rejectionReason = result.reason;
        logger.info({ mint: mint.slice(0, 8), reason: result.reason }, "Early discovery: token REJECTED by rugcheck ❌");
      }
    } catch (err) {
      logger.warn({ mint: mint.slice(0, 8), err: (err as Error).message }, "Early discovery: rugcheck failed — treating as failed");
      token.rugcheckStatus  = "failed";
      token.rugcheckReason  = "Rugcheck API error";
      token.status          = "rejected";
      token.rejectionReason = "Rugcheck API error";
    }
    token.lastUpdatedAt = Date.now();
    this.broadcast();
  }

  // ── Polling cycle ─────────────────────────────────────────────────────────
  private async pollCycle(): Promise<void> {
    this.pruneOldTokens();
    const active = [...this.tokens.values()].filter((t) => t.status === "tracking" || t.status === "eligible");
    for (const token of active) {
      await this.pollToken(token);
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    this.checkPositions();
    this.broadcast();
  }

  private async pollToken(token: EDToken): Promise<void> {
    try {
      const [pfData, dexData] = await Promise.all([
        this.fetchPumpFunData(token.mint),
        this.fetchDexData(token.mint),
      ]);

      if (pfData) {
        if (token.symbol === "???" || token.symbol === "") token.symbol = pfData.symbol || "???";
        if (token.name === "Loading…" || token.name === "") token.name = pfData.name || token.mint.slice(0, 8);
        token.creator         = pfData.creator || token.creator;
        token.imageUri        = pfData.imageUri || token.imageUri;
        token.marketCapUsd    = pfData.marketCapUsd;
        token.bondingCurvePct = pfData.bondingCurvePct;
        token.priceUsd        = pfData.priceUsd;
        if (token.discoveryPrice === 0 && pfData.priceUsd > 0) token.discoveryPrice = pfData.priceUsd;
      }

      if (dexData) {
        token.prevUniqueBuyers = token.uniqueBuyers;
        token.uniqueBuyers     = Math.max(token.uniqueBuyers, dexData.uniqueBuyers);
        const buyerGain        = token.uniqueBuyers - token.prevUniqueBuyers;
        const elapsedMin       = POLL_INTERVAL_MS / 60_000;
        token.buyersPerMinute  = buyerGain > 0 ? buyerGain / elapsedMin : token.buyersPerMinute;
        token.buyerAcceleration = buyerGain;
        token.buyVolumeSol     = dexData.buyVolumeSol;
        token.sellVolumeSol    = dexData.sellVolumeSol;
        if (dexData.priceUsd > 0) token.priceUsd = dexData.priceUsd;
        if (token.discoveryPrice === 0 && dexData.priceUsd > 0) token.discoveryPrice = dexData.priceUsd;
      }

      const metrics: DemandMetrics = {
        uniqueBuyers:       token.uniqueBuyers,
        prevUniqueBuyers:   token.prevUniqueBuyers,
        buyerAcceleration:  token.buyerAcceleration,
        buyersPerMinute:    token.buyersPerMinute,
        buyVolumeSol:       token.buyVolumeSol,
        sellVolumeSol:      token.sellVolumeSol,
        bondingCurvePct:    token.bondingCurvePct,
        topHolderPct:       token.topHolderPct,
        creatorHoldingsPct: token.creatorHoldingsPct,
        whaleParticipation: token.whaleParticipation,
      };
      token.scores = calculateDemandScore(metrics);

      const entryCheck = checkEntryConditions(
        token.scores, metrics, token.rugcheckStatus === "passed",
        token.discoveryPrice, token.priceUsd, this.config.minScore,
      );

      if (entryCheck.eligible) {
        if (!token.firstEligibleAt) token.firstEligibleAt = Date.now();
        token.status = "eligible";

        const confirmMs = Date.now() - token.firstEligibleAt;
        if (confirmMs >= ENTRY_CONFIRM_MS) {
          this.enterPaperTrade(token);
        }
      } else {
        if (token.status === "eligible") {
          token.firstEligibleAt = null;
          token.status = "tracking";
        }
      }

      token.pollCount++;
      token.lastUpdatedAt = Date.now();
    } catch (err) {
      logger.warn({ mint: token.mint.slice(0, 8), err: (err as Error).message }, "Early discovery: poll failed");
    }
  }

  // ── Data fetching ─────────────────────────────────────────────────────────
  private async fetchPumpFunData(mint: string): Promise<{
    symbol: string; name: string; creator: string; imageUri: string;
    marketCapUsd: number; bondingCurvePct: number; priceUsd: number;
  } | null> {
    try {
      type PFCoin = {
        symbol?: string; name?: string; creator?: string; image_uri?: string;
        usd_market_cap?: number; bonding_curve_progress?: number;
        virtual_sol_reserves?: number; virtual_token_reserves?: number;
      };
      const res = await axios.get<PFCoin>(`${PUMPFUN_API_BASE}/coins/${mint}`, { timeout: 6_000 });
      const d = res.data;
      const solReserves = (d.virtual_sol_reserves ?? 0) / 1e9;
      const tokReserves = (d.virtual_token_reserves ?? 0) / 1e6;
      const priceUsd    = solReserves > 0 && tokReserves > 0 ? (solReserves / tokReserves) * 150 : 0;
      return {
        symbol: d.symbol ?? "???",
        name:   d.name   ?? "",
        creator: d.creator ?? "",
        imageUri: d.image_uri ?? "",
        marketCapUsd: d.usd_market_cap ?? 0,
        bondingCurvePct: d.bonding_curve_progress ?? 0,
        priceUsd,
      };
    } catch { return null; }
  }

  private async fetchDexData(mint: string): Promise<{
    buyVolumeSol: number; sellVolumeSol: number; uniqueBuyers: number; priceUsd: number;
  } | null> {
    try {
      type DexPair = {
        priceUsd?: string; dexId?: string;
        txns?: { m5?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number } };
        volume?: { m5?: number; h1?: number };
      };
      const res = await axios.get<DexPair[]>(`${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`, { timeout: 5_000 });
      const pairs = Array.isArray(res.data) ? res.data : [];
      const pair = pairs.find((p) => ["pumpswap","pump-amm","pump_amm","raydium"].includes(p.dexId ?? ""))
        ?? pairs.find((p) => (parseFloat(p.priceUsd ?? "0") || 0) > 0);
      if (!pair) return null;

      const m5     = pair.txns?.m5;
      const h1     = pair.txns?.h1;
      const buys   = (m5?.buys ?? 0) + (h1?.buys ?? 0);
      const sells  = (m5?.sells ?? 0) + (h1?.sells ?? 0);
      const volM5  = pair.volume?.m5 ?? 0;
      const volH1  = pair.volume?.h1 ?? 0;
      const totalVol = (volM5 + volH1) / 150;
      const buyPct = buys + sells > 0 ? buys / (buys + sells) : 0.5;

      return {
        buyVolumeSol:  totalVol * buyPct,
        sellVolumeSol: totalVol * (1 - buyPct),
        uniqueBuyers:  buys,
        priceUsd:      parseFloat(pair.priceUsd ?? "0") || 0,
      };
    } catch { return null; }
  }

  // ── Paper trade entry ─────────────────────────────────────────────────────
  private enterPaperTrade(token: EDToken): void {
    if (token.status === "entered" || token.positionId) return;
    if (this.openPositions.size >= this.config.maxOpenPositions) {
      logger.info({ mint: token.mint.slice(0, 8), open: this.openPositions.size }, "Early discovery: max open positions reached");
      return;
    }
    const multiplier = getPositionSizeMultiplier(token.scores.finalScore);
    if (multiplier === 0) return;

    const sizeSol = this.config.positionSizeSol * multiplier;
    if (this.virtualBalance < sizeSol) {
      logger.warn({ virtualBalance: this.virtualBalance, sizeSol }, "Early discovery: insufficient balance");
      return;
    }

    const now      = Date.now();
    const entryPx  = token.priceUsd;
    if (!(entryPx > 0)) return;

    const slPrice = entryPx * (1 - this.config.slPct / 100);

    const pos: EDPosition = {
      id: uid(),
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      entryAt: now,
      entryPrice: entryPx,
      entryMcap: token.marketCapUsd,
      entryScore: token.scores.finalScore,
      currentPrice: entryPx,
      currentMcap: token.marketCapUsd,
      sizeSol,
      remainingFraction: 1.0,
      effectiveSlPrice: slPrice,
      trailingHigh: entryPx,
      tp1Hit: false,
      tp2Hit: false,
      status: "open",
      realizedPnlSol: 0,
      unrealizedPnlSol: 0,
      totalPnlSol: 0,
      pnlPct: 0,
      closeReason: "",
      closedAt: null,
      exitPrice: null,
      tp1RealizedSol: 0,
      tp2RealizedSol: 0,
      runnerRealizedSol: 0,
      closingScore: null,
      positionMultiplier: multiplier,
    };

    this.virtualBalance -= sizeSol;
    this.openPositions.set(token.mint, pos);
    token.status = "entered";
    token.positionId = pos.id;

    void this.persistPosition(pos);
    void this.persistBalance();

    logger.info({ mint: token.mint.slice(0, 8), symbol: token.symbol, score: token.scores.finalScore, sizeSol, entryPx }, "Early discovery: PAPER TRADE ENTERED 📄🎯");

    if (isTelegramConfigured()) {
      const tp1Px = entryPx * (1 + this.config.tp1Pct / 100);
      const tp2Px = entryPx * (1 + this.config.tp2Pct / 100);
      void sendTelegram(
        `📄 <b>EARLY DISCOVERY — PAPER ENTRY</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🪙 <b>${token.symbol}</b>  <code>${token.mint.slice(0, 8)}…</code>\n\n` +
        `📊 <b>Demand Score: ${token.scores.finalScore}/120</b>\n` +
        `  Buyer Growth: ${token.scores.buyerGrowthScore}/25\n` +
        `  Volume:       ${token.scores.volumeScore}/25\n` +
        `  Buy Pressure: ${token.scores.buyPressureScore}/25\n` +
        `  Wallet Quality: ${token.scores.walletQualityScore}/25\n` +
        `  Bonding Curve:  ${token.scores.bondingCurveScore}/20\n\n` +
        `💵 Entry: $${entryPx.toExponential(3)} | MC: $${(token.marketCapUsd / 1000).toFixed(1)}K\n` +
        `🛑 SL: $${slPrice.toExponential(3)} (-${this.config.slPct}%)\n` +
        `🎯 TP1: $${tp1Px.toExponential(3)} (+${this.config.tp1Pct}%)\n` +
        `🎯 TP2: $${tp2Px.toExponential(3)} (+${this.config.tp2Pct}%)\n` +
        `💰 Size: ${sizeSol.toFixed(3)} SOL | Balance: ${this.virtualBalance.toFixed(3)} SOL\n` +
        `🔗 <a href="https://dexscreener.com/solana/${token.mint}">DexScreener</a> | 🕐 ${toIST(new Date())}`
      );
    }
  }

  // ── Position management ───────────────────────────────────────────────────
  private checkPositions(): void {
    for (const [mint, pos] of this.openPositions) {
      const token = this.tokens.get(mint);
      const currentPx = token?.priceUsd ?? 0;
      if (!(currentPx > 0)) continue;

      pos.currentPrice = currentPx;
      pos.currentMcap  = token?.marketCapUsd ?? 0;
      if (currentPx > pos.trailingHigh) pos.trailingHigh = currentPx;

      const gainPct = ((currentPx - pos.entryPrice) / pos.entryPrice) * 100;
      pos.pnlPct = gainPct;

      const remaining = pos.sizeSol * pos.remainingFraction;
      pos.unrealizedPnlSol = remaining * (gainPct / 100);
      pos.totalPnlSol      = pos.realizedPnlSol + pos.unrealizedPnlSol;

      // Quality exit check (score collapse / buy pressure collapse)
      if (token) {
        const qExit = checkQualityExit(token.scores, {
          uniqueBuyers: token.uniqueBuyers,
          prevUniqueBuyers: token.prevUniqueBuyers,
          buyerAcceleration: 0,
          buyersPerMinute: token.buyersPerMinute,
          buyVolumeSol: token.buyVolumeSol,
          sellVolumeSol: token.sellVolumeSol,
          bondingCurvePct: token.bondingCurvePct,
          topHolderPct: token.topHolderPct,
          creatorHoldingsPct: token.creatorHoldingsPct,
          whaleParticipation: token.whaleParticipation,
        });
        if (qExit) {
          this.closePaperPosition(pos, `Quality exit: ${qExit}`, currentPx);
          continue;
        }
        if (token.creatorSold) {
          this.closePaperPosition(pos, "Creator sold tokens", currentPx);
          continue;
        }
      }

      // SL check
      if (currentPx <= pos.effectiveSlPrice) {
        this.closePaperPosition(pos, `Stop loss hit (${gainPct.toFixed(1)}%)`, currentPx);
        continue;
      }

      // TP1
      if (!pos.tp1Hit && gainPct >= this.config.tp1Pct) {
        const sellFrac     = this.config.tp1ClosePct / 100;
        const sellSol      = pos.sizeSol * pos.remainingFraction * sellFrac;
        const pnl          = sellSol * (gainPct / 100);
        pos.tp1RealizedSol = pnl;
        pos.realizedPnlSol += pnl;
        pos.remainingFraction *= (1 - sellFrac);
        pos.effectiveSlPrice  = pos.entryPrice; // move to breakeven
        pos.tp1Hit = true;

        logger.info({ mint: mint.slice(0, 8), symbol: pos.symbol, gainPct: gainPct.toFixed(1), pnl: pnl.toFixed(4) }, "Early discovery: TP1 hit 🎯");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🎯 <b>PAPER TP1 HIT — ${pos.symbol}</b>\n` +
            `+${gainPct.toFixed(1)}% | Sold ${this.config.tp1ClosePct}% | PnL: +${pnl.toFixed(4)} SOL\n` +
            `SL moved to breakeven | Runner: ${(pos.remainingFraction * 100).toFixed(0)}% remaining\n` +
            `🔗 <a href="https://dexscreener.com/solana/${mint}">Chart</a>`
          );
        }
      }

      // TP2
      if (pos.tp1Hit && !pos.tp2Hit && gainPct >= this.config.tp2Pct) {
        const sellFrac     = this.config.tp2ClosePct / 100;
        const sellSol      = pos.sizeSol * pos.remainingFraction * sellFrac;
        const pnl          = sellSol * (gainPct / 100);
        pos.tp2RealizedSol = pnl;
        pos.realizedPnlSol += pnl;
        pos.remainingFraction *= (1 - sellFrac);
        pos.tp2Hit = true;

        logger.info({ mint: mint.slice(0, 8), symbol: pos.symbol, gainPct: gainPct.toFixed(1), pnl: pnl.toFixed(4) }, "Early discovery: TP2 hit 🎯🎯");
        if (isTelegramConfigured()) {
          void sendTelegram(
            `🎯🎯 <b>PAPER TP2 HIT — ${pos.symbol}</b>\n` +
            `+${gainPct.toFixed(1)}% | Sold ${this.config.tp2ClosePct}% | PnL: +${pnl.toFixed(4)} SOL\n` +
            `Runner trailing -${this.config.runnerTrailingPct}% from high\n` +
            `🔗 <a href="https://dexscreener.com/solana/${mint}">Chart</a>`
          );
        }
      }

      // Runner trailing stop (active after TP2)
      if (pos.tp2Hit) {
        const runnerSl = pos.trailingHigh * (1 - this.config.runnerTrailingPct / 100);
        if (currentPx <= runnerSl) {
          const remaining = pos.sizeSol * pos.remainingFraction;
          const pnl       = remaining * (gainPct / 100);
          pos.runnerRealizedSol = pnl;
          pos.realizedPnlSol    += pnl;
          pos.remainingFraction  = 0;
          this.closePaperPosition(pos, `Runner trailing stop (-${this.config.runnerTrailingPct}% from ${pos.trailingHigh.toExponential(3)})`, currentPx);
        }
      }

      void this.persistPosition(pos);
    }
  }

  private closePaperPosition(pos: EDPosition, reason: string, exitPx: number): void {
    if (pos.status !== "open") return;
    const token = this.tokens.get(pos.mint);

    const gainPct        = ((exitPx - pos.entryPrice) / pos.entryPrice) * 100;
    const remaining      = pos.sizeSol * pos.remainingFraction;
    const finalPnl       = remaining * (gainPct / 100);
    pos.realizedPnlSol  += finalPnl;
    pos.remainingFraction = 0;
    pos.status           = "closed";
    pos.closeReason      = reason;
    pos.closedAt         = Date.now();
    pos.exitPrice        = exitPx;
    pos.totalPnlSol      = pos.realizedPnlSol;
    pos.pnlPct           = ((pos.totalPnlSol) / pos.sizeSol) * 100;
    pos.closingScore     = token?.scores.finalScore ?? null;

    this.virtualBalance += pos.sizeSol + pos.realizedPnlSol;
    this.openPositions.delete(pos.mint);
    this.closedPositions.unshift(pos);
    if (this.closedPositions.length > 200) this.closedPositions = this.closedPositions.slice(0, 200);

    if (pos.realizedPnlSol > 0) this.wins++; else this.losses++;
    if (token) { token.status = "exited"; }

    void this.persistPosition(pos);
    void this.persistBalance();

    logger.info({ mint: pos.mint.slice(0, 8), symbol: pos.symbol, reason, pnl: pos.realizedPnlSol.toFixed(4), pnlPct: pos.pnlPct.toFixed(1) }, "Early discovery: paper position CLOSED");

    if (isTelegramConfigured()) {
      const emoji = pos.realizedPnlSol > 0 ? "💚" : "💔";
      void sendTelegram(
        `${emoji} <b>PAPER CLOSED — ${pos.symbol}</b>\n` +
        `PnL: ${pos.realizedPnlSol >= 0 ? "+" : ""}${pos.realizedPnlSol.toFixed(4)} SOL (${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(1)}%)\n` +
        `Reason: ${reason}\n` +
        `TP1: ${pos.tp1Hit ? "✅" : "○"} | TP2: ${pos.tp2Hit ? "✅" : "○"}\n` +
        `Balance: ${this.virtualBalance.toFixed(3)} SOL\n` +
        `🔗 <a href="https://dexscreener.com/solana/${pos.mint}">Chart</a>`
      );
    }
  }

  // ── Token pruning ─────────────────────────────────────────────────────────
  private pruneOldTokens(): void {
    const cutoff = Date.now() - MAX_TRACK_AGE_MS;
    for (const [mint, token] of this.tokens) {
      if (token.launchAt < cutoff && token.status !== "entered") {
        this.tokens.delete(mint);
      }
    }
  }

  // ── DB persistence ────────────────────────────────────────────────────────
  private async persistPosition(pos: EDPosition): Promise<void> {
    try {
      await execute(
        `INSERT INTO ed_positions (id,mint,symbol,name,entry_at,entry_price,entry_mcap,entry_score,
           current_price,current_mcap,size_sol,remaining_fraction,effective_sl_price,trailing_high,
           tp1_hit,tp2_hit,status,realized_pnl_sol,unrealized_pnl_sol,total_pnl_sol,pnl_pct,
           close_reason,closed_at,exit_price,tp1_realized_sol,tp2_realized_sol,runner_realized_sol,
           closing_score,position_multiplier)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         ON CONFLICT (id) DO UPDATE SET
           current_price=EXCLUDED.current_price, current_mcap=EXCLUDED.current_mcap,
           remaining_fraction=EXCLUDED.remaining_fraction, effective_sl_price=EXCLUDED.effective_sl_price,
           trailing_high=EXCLUDED.trailing_high, tp1_hit=EXCLUDED.tp1_hit, tp2_hit=EXCLUDED.tp2_hit,
           status=EXCLUDED.status, realized_pnl_sol=EXCLUDED.realized_pnl_sol,
           unrealized_pnl_sol=EXCLUDED.unrealized_pnl_sol, total_pnl_sol=EXCLUDED.total_pnl_sol,
           pnl_pct=EXCLUDED.pnl_pct, close_reason=EXCLUDED.close_reason, closed_at=EXCLUDED.closed_at,
           exit_price=EXCLUDED.exit_price, tp1_realized_sol=EXCLUDED.tp1_realized_sol,
           tp2_realized_sol=EXCLUDED.tp2_realized_sol, runner_realized_sol=EXCLUDED.runner_realized_sol,
           closing_score=EXCLUDED.closing_score`,
        [pos.id, pos.mint, pos.symbol, pos.name, pos.entryAt, pos.entryPrice, pos.entryMcap, pos.entryScore,
         pos.currentPrice, pos.currentMcap, pos.sizeSol, pos.remainingFraction, pos.effectiveSlPrice, pos.trailingHigh,
         pos.tp1Hit, pos.tp2Hit, pos.status, pos.realizedPnlSol, pos.unrealizedPnlSol, pos.totalPnlSol, pos.pnlPct,
         pos.closeReason, pos.closedAt, pos.exitPrice, pos.tp1RealizedSol, pos.tp2RealizedSol, pos.runnerRealizedSol,
         pos.closingScore, pos.positionMultiplier],
      );
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Early discovery: persist position failed");
    }
  }

  private async persistBalance(): Promise<void> {
    try {
      await execute(
        `INSERT INTO kv_store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        [KV_BALANCE_KEY, String(this.virtualBalance)],
      );
    } catch { /* non-fatal */ }
  }

  private async persistConfig(): Promise<void> {
    try {
      await execute(
        `INSERT INTO kv_store(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
        [KV_CONFIG_KEY, JSON.stringify(this.config)],
      );
    } catch { /* non-fatal */ }
  }

  private async loadConfig(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(`SELECT value FROM kv_store WHERE key=$1`, [KV_CONFIG_KEY]);
      if (rows.length > 0) {
        const saved = JSON.parse(rows[0]!.value) as Partial<EDConfig>;
        const merged = { ...DEFAULT_CONFIG, ...saved };
        if (!merged.maxOpenPositions || merged.maxOpenPositions < 1) merged.maxOpenPositions = DEFAULT_CONFIG.maxOpenPositions;
        if (!merged.positionSizeSol  || merged.positionSizeSol  <= 0) merged.positionSizeSol = DEFAULT_CONFIG.positionSizeSol;
        this.config = merged;
      }
    } catch { /* table may not exist yet */ }
  }

  private async loadBalance(): Promise<void> {
    try {
      const rows = await query<{ value: string }>(`SELECT value FROM kv_store WHERE key=$1`, [KV_BALANCE_KEY]);
      if (rows.length > 0) {
        const val = parseFloat(rows[0]!.value);
        this.virtualBalance = val > 0 ? val : STARTING_BALANCE;
      }
    } catch { this.virtualBalance = STARTING_BALANCE; }
  }

  private async loadPositions(): Promise<void> {
    try {
      const rows = await query<{
        id: string; mint: string; symbol: string; name: string;
        entry_at: string; entry_price: number; entry_mcap: number; entry_score: number;
        current_price: number; current_mcap: number; size_sol: number; remaining_fraction: number;
        effective_sl_price: number; trailing_high: number; tp1_hit: boolean; tp2_hit: boolean;
        status: string; realized_pnl_sol: number; unrealized_pnl_sol: number; total_pnl_sol: number;
        pnl_pct: number; close_reason: string; closed_at: string | null; exit_price: number | null;
        tp1_realized_sol: number; tp2_realized_sol: number; runner_realized_sol: number;
        closing_score: number | null; position_multiplier: number;
      }>(`SELECT * FROM ed_positions ORDER BY entry_at DESC LIMIT 200`, []);

      for (const row of rows) {
        const pos: EDPosition = {
          id: row.id, mint: row.mint, symbol: row.symbol, name: row.name,
          entryAt: Number(row.entry_at), entryPrice: row.entry_price, entryMcap: row.entry_mcap,
          entryScore: row.entry_score, currentPrice: row.current_price, currentMcap: row.current_mcap,
          sizeSol: row.size_sol, remainingFraction: row.remaining_fraction,
          effectiveSlPrice: row.effective_sl_price, trailingHigh: row.trailing_high,
          tp1Hit: row.tp1_hit, tp2Hit: row.tp2_hit, status: row.status as "open" | "closed",
          realizedPnlSol: row.realized_pnl_sol, unrealizedPnlSol: row.unrealized_pnl_sol,
          totalPnlSol: row.total_pnl_sol, pnlPct: row.pnl_pct, closeReason: row.close_reason,
          closedAt: row.closed_at ? Number(row.closed_at) : null, exitPrice: row.exit_price,
          tp1RealizedSol: row.tp1_realized_sol, tp2RealizedSol: row.tp2_realized_sol,
          runnerRealizedSol: row.runner_realized_sol, closingScore: row.closing_score,
          positionMultiplier: row.position_multiplier ?? 1,
        };
        if (pos.status === "open") this.openPositions.set(pos.mint, pos);
        else this.closedPositions.push(pos);

        if (pos.status === "open") this.wins += pos.realizedPnlSol > 0 ? 1 : 0;
      }
      this.wins = this.closedPositions.filter((p) => p.realizedPnlSol > 0).length;
      this.losses = this.closedPositions.filter((p) => p.realizedPnlSol <= 0).length;
    } catch { /* table may not exist yet */ }
  }

  // ── WebSocket broadcast ───────────────────────────────────────────────────
  private broadcast(): void {
    broadcast({ type: "ed_update", data: null, timestamp: Date.now() });
  }

  // ── Public REST API ───────────────────────────────────────────────────────
  getStatus(): EDStatus {
    const tokenArr = [...this.tokens.values()];
    const openPosArr = [...this.openPositions.values()];
    const unrealizedPnl = openPosArr.reduce((sum, p) => sum + p.unrealizedPnlSol, 0);
    const realizedPnl   = this.closedPositions.reduce((sum, p) => sum + p.realizedPnlSol, 0);
    return {
      wsConnected: this.wsConnected,
      wsReconnects: this.wsReconnects,
      enabled: this.config.enabled,
      trackedCount: tokenArr.filter((t) => t.status === "tracking").length,
      eligibleCount: tokenArr.filter((t) => t.status === "eligible").length,
      enteredCount:  tokenArr.filter((t) => t.status === "entered").length,
      rejectedCount: tokenArr.filter((t) => t.status === "rejected").length,
      launchesDetected: this.launchesDetected,
      virtualBalance: this.virtualBalance,
      startingBalance: STARTING_BALANCE,
      openCount: this.openPositions.size,
      tradesTotal: this.wins + this.losses,
      wins: this.wins,
      losses: this.losses,
      totalRealizedPnlSol: realizedPnl,
      totalUnrealizedPnlSol: unrealizedPnl,
      config: { ...this.config },
    };
  }

  getTokens(): EDToken[] {
    return [...this.tokens.values()].sort((a, b) => b.scores.finalScore - a.scores.finalScore);
  }

  getPositions(): { open: EDPosition[]; closed: EDPosition[] } {
    return {
      open:   [...this.openPositions.values()].sort((a, b) => b.entryAt - a.entryAt),
      closed: this.closedPositions.slice(0, 100),
    };
  }

  getConfig(): EDConfig { return { ...this.config }; }

  async updateConfig(patch: Partial<EDConfig>): Promise<EDConfig> {
    this.config = { ...this.config, ...patch };
    await this.persistConfig();
    return this.getConfig();
  }

  async resetPaperBalance(): Promise<void> {
    this.virtualBalance = STARTING_BALANCE;
    await this.persistBalance();
  }

  // Allow injecting a test token for debugging
  injectTestToken(mint: string): void {
    void this.onNewLaunch(mint);
  }
}

export const earlyDiscoveryService = new EarlyDiscoveryService();
