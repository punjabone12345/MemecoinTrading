import WebSocket from "ws";
import axios from "axios";
import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import { broadcast } from "../websocket/server.js";
import { sendTelegram, isTelegramConfigured, toIST } from "../lib/telegram.js";
import { checkTokenSafety } from "./rugcheck.service.js";
import {
  calculateDemandScore, checkEntryConditions, checkQualityExit,
  getPositionSizeMultiplier,
  type DemandMetrics, type DemandScores, type EntryChecklistItem,
} from "./demand-scorer.js";

// ── Constants ──────────────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM    = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const HELIUS_WS_BASE     = "wss://mainnet.helius-rpc.com";
const PUMPPORTAL_WS_URL  = "wss://pumpportal.fun/api/data";

const POLL_INTERVAL_MS           = 30_000;
const HTTP_POLL_INTERVAL_MS      = 15_000;
const MAX_TRACK_AGE_MS           = 60 * 60 * 1000;
const MAX_REJECTED_AGE_MS        = 3 * 60 * 1000;
const MAX_EXITED_AGE_MS          = 10 * 60 * 1000;
const MAX_TRACKED_TOKENS         = 2000;
const MAX_TOKENS_UI              = 200;
const HTTP_SEEN_CAP              = 5000;
const ENTRY_CONFIRM_MS           = 2 * 60 * 1000;
const STARTING_BALANCE           = 1.0;
const KV_CONFIG_KEY              = "ed_config";
const KV_BALANCE_KEY             = "ed_balance";
const RECONNECT_BASE_MS          = 3_000;
const RECONNECT_MAX_MS           = 30_000;

const HELIUS_API_KEY        = process.env["HELIUS_API_KEY"] ?? "";
const SOLANA_PUBLIC_RPC     = "https://api.mainnet-beta.solana.com";
// pump.fun graduation target = 85 SOL in lamports
const GRADUATION_TARGET_LAMPORTS = 85_000_000_000n;
const ON_CHAIN_INTERVAL_MS  = 20_000;

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
  virtualSolReserves: number;   // raw lamports → shown as SOL for verification
  targetSolReserves: number;    // always 85 SOL graduation target
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
  entryChecklist: EntryChecklistItem[];
  bcUpdatedAt: number;          // timestamp of last bonding curve update (ms)
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

export interface EDPositionPatch {
  entryPrice?: number;
  entryScore?: number;
  sizeSol?: number;
  effectiveSlPrice?: number;
  trailingHigh?: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  closeReason?: string;
  closingScore?: number;
  exitPrice?: number;
  realizedPnlSol?: number;
  tp1RealizedSol?: number;
  tp2RealizedSol?: number;
  runnerRealizedSol?: number;
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
  ppConnected: boolean;
  ppReconnects: number;
  connectionSource: "pumpportal" | "helius" | "http-poll" | "offline";
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
  // HTTP poll (primary — GeckoTerminal new pools, 15s interval)
  private httpPollConnected = false;
  private httpPollTimer: ReturnType<typeof setInterval> | null = null;
  private httpRateLimitUntil = 0;
  private seenByHttpPoll = new Set<string>();
  private totalHttpDiscovered = 0;

  // PumpPortal WebSocket
  private ppWs: WebSocket | null = null;
  private ppConnected = false;
  private ppReconnects = 0;

  // Helius WebSocket (secondary)
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private wsReconnects = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // Helius accountSubscribe tracking: subscriptionId → mint
  private bcSubIdToMint = new Map<number, string>();
  // mint → subscriptionId (to avoid duplicate subscriptions)
  private bcMintToSubId = new Map<string, number>();
  // next request ID counter
  private wsReqId = 10;

  private pdaCache = new Map<string, string>();
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
    this.startHttpPoller();
    this.connectPumpPortal();

    if (HELIUS_API_KEY) {
      this.connectWs();
    } else {
      logger.info("Early discovery: HELIUS_API_KEY not set — HTTP poll + PumpPortal active");
    }

    this.pollInterval = setInterval(() => this.pollCycle(), POLL_INTERVAL_MS);

    // On-chain bonding curve batch refresh (fallback when no Helius WS)
    setTimeout(() => void this.refreshOnChainBondingCurves(), 5_000);
    setInterval(() => void this.refreshOnChainBondingCurves(), ON_CHAIN_INTERVAL_MS);

    logger.info("Early discovery: started");
  }

  // ── HTTP Poller (PRIMARY) ──────────────────────────────────────────────────
  private startHttpPoller(): void {
    type GTTxns = { buys?: number; sells?: number; buyers?: number; sellers?: number };
    type GTPool = {
      attributes?: {
        name?: string;
        pool_created_at?: string;
        base_token_price_usd?: string;
        fdv_usd?: string;
        market_cap_usd?: string | null;
        volume_usd?: { m5?: number; h1?: number; h24?: number };
        transactions?: { m5?: GTTxns; h1?: GTTxns; h6?: GTTxns; h24?: GTTxns };
      };
      relationships?: {
        base_token?: { data?: { id?: string } };
        dex?: { data?: { id?: string } };
      };
    };
    type GTResponse = { data?: GTPool[] };

    const PUMP_DEXES = new Set(["pump-fun", "pumpswap", "pump_amm", "pump-amm"]);

    const poll = async (): Promise<void> => {
      try {
        const res = await axios.get<GTResponse>(
          `${GECKOTERMINAL_BASE}/networks/solana/new_pools?page=1`,
          { timeout: 8_000, headers: { Accept: "application/json;version=20230302" } },
        );
        const pools = res.data?.data ?? [];
        this.httpPollConnected = true;

        let newThisCycle = 0;
        for (const pool of pools) {
          const dexId = pool.relationships?.dex?.data?.id ?? "";
          if (!PUMP_DEXES.has(dexId)) continue;

          const baseTokenId = pool.relationships?.base_token?.data?.id ?? "";
          if (!baseTokenId.startsWith("solana_")) continue;
          const mint = baseTokenId.slice("solana_".length);
          if (!mint || mint.length < 32) continue;

          if (this.seenByHttpPoll.has(mint)) continue;
          this.seenByHttpPoll.add(mint);

          if (!this.tokens.has(mint)) {
            const rawName  = pool.attributes?.name ?? "";
            const symbol   = rawName.includes(" / ") ? rawName.split(" / ")[0]!.trim() : mint.slice(0, 6).toUpperCase();
            const priceUsd     = parseFloat(pool.attributes?.base_token_price_usd ?? "0") || 0;
            const fdv          = parseFloat(pool.attributes?.fdv_usd ?? "0") || 0;
            const mcap         = parseFloat(pool.attributes?.market_cap_usd ?? "0") || 0;
            const marketCapUsd = fdv || mcap;
            const m5t          = pool.attributes?.transactions?.m5;
            const h1t          = pool.attributes?.transactions?.h1;
            const uniqueBuyers = (m5t?.buyers ?? 0) + (h1t?.buyers ?? 0);
            const volM5        = pool.attributes?.volume_usd?.m5 ?? 0;
            const volH1        = pool.attributes?.volume_usd?.h1 ?? 0;
            const buyVolumeSol = (volM5 + volH1) / 150;

            logger.info({ mint: mint.slice(0, 8), symbol, dex: dexId, priceUsd: priceUsd.toFixed(8), marketCapUsd: marketCapUsd.toFixed(0), uniqueBuyers }, "Early discovery: new launch via GeckoTerminal 🚀");
            this.launchesDetected++;
            this.totalHttpDiscovered++;
            newThisCycle++;
            void this.onNewLaunchWithMeta(mint, { symbol, name: symbol, creator: "", priceUsd, marketCapUsd, uniqueBuyers, buyVolumeSol });
          }
        }
        if (newThisCycle > 0) {
          logger.info({ newThisCycle, totalDiscovered: this.totalHttpDiscovered, tracked: this.tokens.size }, "Early discovery: HTTP poll cycle complete");
        }

        if (this.seenByHttpPoll.size > HTTP_SEEN_CAP) {
          const arr = [...this.seenByHttpPoll];
          this.seenByHttpPoll = new Set(arr.slice(arr.length - Math.floor(HTTP_SEEN_CAP / 2)));
        }
      } catch (err) {
        this.httpPollConnected = false;
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429) {
          this.httpRateLimitUntil = Date.now() + 60_000;
          logger.warn("Early discovery: GeckoTerminal rate-limited (429) — pausing 60s");
        } else {
          logger.debug({ err: (err as Error).message }, "Early discovery: GeckoTerminal poll error — retrying");
        }
      }
    };

    const guardedPoll = (): void => {
      if (Date.now() < this.httpRateLimitUntil) return;
      void poll();
    };

    setTimeout(() => { void poll(); }, 3_000);
    this.httpPollTimer = setInterval(guardedPoll, HTTP_POLL_INTERVAL_MS);
    logger.info({ intervalMs: HTTP_POLL_INTERVAL_MS }, "Early discovery: GeckoTerminal poll started (primary token discovery)");
  }

  // ── PumpPortal WebSocket ───────────────────────────────────────────────────
  private connectPumpPortal(): void {
    try {
      const ws = new WebSocket(PUMPPORTAL_WS_URL);

      ws.on("open", () => {
        this.ppConnected = true;
        logger.info("Early discovery: PumpPortal WebSocket connected — subscribing to new token launches");
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      });

      ws.on("message", (raw) => {
        try {
          type PPEvent = {
            txType?: string;
            mint?: string;
            traderPublicKey?: string;
            name?: string;
            symbol?: string;
            marketCapSol?: number;
          };
          const msg = JSON.parse(raw.toString()) as PPEvent;
          if (!msg.mint || msg.txType !== "create") return;

          const mint = msg.mint;
          if (this.tokens.has(mint)) return;

          logger.info({ mint: mint.slice(0, 8), symbol: msg.symbol }, "Early discovery: new launch via PumpPortal 🚀");
          this.launchesDetected++;
          void this.onNewLaunchWithMeta(mint, {
            symbol: msg.symbol ?? mint.slice(0, 6).toUpperCase(),
            name:   msg.name   ?? mint.slice(0, 8),
            creator: msg.traderPublicKey ?? "",
          });
        } catch { /* ignore parse errors */ }
      });

      ws.on("close", () => {
        this.ppConnected = false;
        this.ppReconnects++;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.min(this.ppReconnects, 10));
        logger.warn({ reconnects: this.ppReconnects, delayMs: delay }, "Early discovery: PumpPortal WS closed — reconnecting");
        setTimeout(() => this.connectPumpPortal(), delay);
      });

      ws.on("error", (err) => {
        logger.warn({ err: (err as Error).message }, "Early discovery: PumpPortal WS error");
      });

      this.ppWs = ws;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Early discovery: PumpPortal WS connect failed — retrying in 10s");
      setTimeout(() => this.connectPumpPortal(), 10_000);
    }
  }

  // ── Helius WebSocket ───────────────────────────────────────────────────────
  private connectWs(): void {
    if (!HELIUS_API_KEY) return;
    try {
      const wsUrl = `${HELIUS_WS_BASE}/?api-key=${HELIUS_API_KEY}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this.wsConnected = true;
        this.bcSubIdToMint.clear();
        this.bcMintToSubId.clear();
        logger.info("Early discovery: Helius WS connected");
        this.subscribeLogsAndBondingCurves();
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) (this.ws as WebSocket).ping();
        }, 30_000);
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          this.handleWsMessage(msg);
        } catch { /* ignore malformed */ }
      });

      this.ws.on("close", () => {
        this.wsConnected = false;
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        this.wsReconnects++;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.min(this.wsReconnects, 10));
        logger.warn({ reconnects: this.wsReconnects, delayMs: delay }, "Early discovery: Helius WS closed — reconnecting");
        setTimeout(() => this.connectWs(), delay);
      });

      this.ws.on("error", (err) => {
        logger.warn({ err: (err as Error).message }, "Early discovery: Helius WS error");
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Early discovery: Helius WS connect failed");
      setTimeout(() => this.connectWs(), 10_000);
    }
  }

  private subscribeLogsAndBondingCurves(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    // 1. logsSubscribe for new token detection
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        { mentions: [PUMPFUN_PROGRAM] },
        { commitment: "processed" },
      ],
    }));
    logger.info("Early discovery: Helius logsSubscribe active for pump.fun program");

    // 2. accountSubscribe for all currently tracked tokens (real-time BC updates)
    const active = [...this.tokens.values()].filter(
      (t) => t.status === "tracking" || t.status === "eligible"
    );
    for (const token of active) {
      this.subscribeBondingCurveAccount(token.mint);
    }
    if (active.length > 0) {
      logger.info({ count: active.length }, "Early discovery: Helius accountSubscribe for existing tracked tokens");
    }
  }

  private subscribeBondingCurveAccount(mint: string): void {
    if (!HELIUS_API_KEY || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.bcMintToSubId.has(mint)) return; // already subscribed

    let pda: string;
    try { pda = this.computeBondingCurvePda(mint); } catch { return; }

    const reqId = ++this.wsReqId;
    // Store reqId → mint temporarily; will be replaced by subscriptionId once confirmed
    this.bcSubIdToMint.set(reqId, mint);

    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "accountSubscribe",
      params: [
        pda,
        { encoding: "base64", commitment: "confirmed" },
      ],
    }));
  }

  private handleWsMessage(msg: Record<string, unknown>): void {
    // ── Subscription confirmation ─────────────────────────────────────────
    // When accountSubscribe/logsSubscribe succeeds, Helius replies:
    // { jsonrpc: "2.0", id: <reqId>, result: <subscriptionId> }
    if (typeof msg["result"] === "number" && typeof msg["id"] === "number") {
      const reqId = msg["id"] as number;
      const subId = msg["result"] as number;
      const mint = this.bcSubIdToMint.get(reqId);
      if (mint && reqId > 1) { // id=1 is logsSubscribe, skip
        this.bcSubIdToMint.delete(reqId);
        this.bcSubIdToMint.set(subId, mint);
        this.bcMintToSubId.set(mint, subId);
      }
      return;
    }

    if (msg["method"] === "accountNotification") {
      this.handleAccountNotification(msg);
      return;
    }

    if (msg["method"] !== "logsNotification") return;
    const params = msg["params"] as Record<string, unknown> | undefined;
    const result = params?.["result"] as Record<string, unknown> | undefined;
    const value  = result?.["value"] as Record<string, unknown> | undefined;
    if (!value) return;

    if (value["err"]) return;

    const sig  = value["signature"] as string | undefined;
    const logs = (value["logs"] as string[] | undefined) ?? [];

    const isCreate = logs.some((l) =>
      l.includes("Instruction: Create") || l.includes("Program log: Instruction: Create")
    );
    if (!isCreate || !sig) return;

    let mint: string | null = null;
    for (const log of logs) {
      const m = /mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(log);
      if (m?.[1] && !this.tokens.has(m[1])) { mint = m[1]; break; }
    }
    if (!mint) return;
    if (this.tokens.has(mint)) return;

    logger.info({ mint: mint.slice(0, 8), sig: sig.slice(0, 8) }, "Early discovery: new pump.fun launch via Helius 🚀");
    this.launchesDetected++;
    void this.onNewLaunch(mint);
  }

  private handleAccountNotification(msg: Record<string, unknown>): void {
    try {
      const params = msg["params"] as Record<string, unknown> | undefined;
      const subId  = params?.["subscription"] as number | undefined;
      const result = params?.["result"] as Record<string, unknown> | undefined;
      const value  = result?.["value"] as Record<string, unknown> | undefined;
      if (subId === undefined || !value) return;

      const mint = this.bcSubIdToMint.get(subId);
      if (!mint) return;

      const token = this.tokens.get(mint);
      if (!token || (token.status !== "tracking" && token.status !== "eligible")) {
        // Unsubscribe stale account
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++this.wsReqId, method: "accountUnsubscribe", params: [subId] }));
        }
        this.bcSubIdToMint.delete(subId);
        this.bcMintToSubId.delete(mint);
        return;
      }

      // Parse account data
      const dataArr = (value["data"] as [string, string] | undefined);
      if (!dataArr || dataArr[1] !== "base64") return;
      const data = Buffer.from(dataArr[0], "base64");
      if (data.length < 49) return;

      const virtualSolReservesLamports = data.readBigUInt64LE(32);
      const complete = data[48] === 1;

      const gradPct = complete
        ? 100
        : Math.min(Number(virtualSolReservesLamports * 100n / GRADUATION_TARGET_LAMPORTS), 99.9);

      const virtualSolReservesSol = Number(virtualSolReservesLamports) / 1e9;
      const targetSolReservesSol = Number(GRADUATION_TARGET_LAMPORTS) / 1e9;

      const prev = token.bondingCurvePct;
      token.bondingCurvePct    = gradPct;
      token.virtualSolReserves = virtualSolReservesSol;
      token.targetSolReserves  = targetSolReservesSol;
      token.bcUpdatedAt        = Date.now();

      logger.info(
        {
          mint: mint.slice(0, 8),
          symbol: token.symbol,
          virtualSolReservesSol: virtualSolReservesSol.toFixed(4),
          targetSolReservesSol: targetSolReservesSol.toFixed(0),
          gradPct: gradPct.toFixed(2),
          prev: prev.toFixed(2),
        },
        "Early discovery: bonding curve updated via Helius accountSubscribe ⛓️⚡",
      );

      this.broadcast();
    } catch (err) {
      logger.debug({ err: (err as Error).message }, "Early discovery: accountNotification parse error");
    }
  }

  // ── New token onboarding ──────────────────────────────────────────────────
  private makeEmptyToken(mint: string): EDToken {
    const now = Date.now();
    return {
      mint, symbol: "???", name: "Loading…", creator: "", imageUri: "",
      launchAt: now, lastUpdatedAt: now,
      priceUsd: 0, marketCapUsd: 0, bondingCurvePct: 0,
      virtualSolReserves: 0, targetSolReserves: Number(GRADUATION_TARGET_LAMPORTS) / 1e9,
      buyVolumeSol: 0, sellVolumeSol: 0,
      uniqueBuyers: 0, prevUniqueBuyers: 0, buyerAcceleration: 0, buyersPerMinute: 0,
      creatorHoldingsPct: 0, topHolderPct: 0, whaleParticipation: false,
      rugcheckStatus: "pending", rugcheckReason: "", rugcheckScore: 0,
      mintAuthority: false, freezeAuthority: false,
      scores: { buyerGrowthScore: 0, volumeScore: 0, buyPressureScore: 0, walletQualityScore: 0, bondingCurveScore: 0, finalScore: 0, buyPressureRatio: 0 },
      status: "tracking", rejectionReason: "",
      firstEligibleAt: null, discoveryPrice: 0, positionId: null, pollCount: 0, creatorSold: false,
      entryChecklist: [], bcUpdatedAt: 0,
    };
  }

  private async onNewLaunch(mint: string): Promise<void> {
    return this.onNewLaunchWithMeta(mint, { symbol: "???", name: "Loading…", creator: "" });
  }

  private async onNewLaunchWithMeta(
    mint: string,
    meta: {
      symbol: string; name: string; creator: string;
      priceUsd?: number; marketCapUsd?: number;
      uniqueBuyers?: number; buyVolumeSol?: number;
    },
  ): Promise<void> {
    if (this.tokens.has(mint)) return;
    if (this.tokens.size >= MAX_TRACKED_TOKENS) {
      this.pruneOldTokens();
      if (this.tokens.size >= MAX_TRACKED_TOKENS) {
        logger.debug({ mint: mint.slice(0, 8) }, "Early discovery: too many tracked tokens, skipping");
        return;
      }
    }

    const token = this.makeEmptyToken(mint);
    token.symbol  = meta.symbol;
    token.name    = meta.name;
    token.creator = meta.creator;

    if (meta.priceUsd && meta.priceUsd > 0)     { token.priceUsd = meta.priceUsd; token.discoveryPrice = meta.priceUsd; }
    if (meta.marketCapUsd && meta.marketCapUsd > 0) token.marketCapUsd = meta.marketCapUsd;
    if (meta.uniqueBuyers && meta.uniqueBuyers > 0) token.uniqueBuyers = meta.uniqueBuyers;
    if (meta.buyVolumeSol && meta.buyVolumeSol > 0) token.buyVolumeSol = meta.buyVolumeSol;

    this.tokens.set(mint, token);
    this.broadcast();

    // Subscribe to real-time bonding curve updates via Helius accountSubscribe
    this.subscribeBondingCurveAccount(mint);

    // Run rugcheck
    await this.runRugcheck(mint, token);

    token.lastUpdatedAt = Date.now();
    this.broadcast();
  }

  private async runRugcheck(mint: string, token: EDToken): Promise<void> {
    try {
      const result = await checkTokenSafety(mint, 0);
      token.rugcheckStatus  = result.pass ? "passed" : "failed";
      token.rugcheckReason  = result.reason;
      token.rugcheckScore   = result.score;
      token.mintAuthority   = Boolean(result.mintAuthority);
      token.freezeAuthority = Boolean(result.freezeAuthority);
      token.topHolderPct    = result.topHolderPct;

      const isApiUnavailable = result.reason.includes("API unavailable") || result.reason.includes("API error");
      if (!result.pass && !isApiUnavailable) {
        token.status          = "rejected";
        token.rejectionReason = result.reason;
        logger.info({ mint: mint.slice(0, 8), reason: result.reason }, "Early discovery: token REJECTED by rugcheck ❌");
      } else if (isApiUnavailable) {
        token.rugcheckStatus = "pending";
        token.rugcheckReason = "RugCheck unavailable — continuing to monitor";
        logger.debug({ mint: mint.slice(0, 8) }, "Early discovery: RugCheck unavailable — keeping token in tracking");
      }
    } catch (err) {
      token.rugcheckStatus = "pending";
      token.rugcheckReason = "RugCheck error — retrying next poll";
      logger.debug({ mint: mint.slice(0, 8), err: (err as Error).message }, "Early discovery: rugcheck error — keeping in tracking");
    }
    token.lastUpdatedAt = Date.now();
    this.broadcast();
  }

  // ── Polling cycle ─────────────────────────────────────────────────────────
  private async pollCycle(): Promise<void> {
    this.pruneOldTokens();
    const active = [...this.tokens.values()].filter((t) => t.status === "tracking" || t.status === "eligible");
    for (const token of active) {
      if (token.rugcheckStatus === "pending" && token.pollCount > 0) {
        void this.runRugcheck(token.mint, token);
      }
      await this.pollToken(token);
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    this.checkPositions();
    this.broadcast();
  }

  private async pollToken(token: EDToken): Promise<void> {
    try {
      const dexData = await this.fetchDexData(token.mint);

      if (dexData) {
        token.prevUniqueBuyers = token.uniqueBuyers;
        token.uniqueBuyers     = Math.max(token.uniqueBuyers, dexData.uniqueBuyers);
        const buyerGain        = token.uniqueBuyers - token.prevUniqueBuyers;
        const elapsedMin       = POLL_INTERVAL_MS / 60_000;
        token.buyersPerMinute  = buyerGain > 0 ? buyerGain / elapsedMin : token.buyersPerMinute;
        token.buyerAcceleration = buyerGain;
        token.buyVolumeSol     = dexData.buyVolumeSol;
        token.sellVolumeSol    = dexData.sellVolumeSol;
        if (dexData.priceUsd > 0) {
          token.priceUsd = dexData.priceUsd;
          if (token.discoveryPrice === 0) token.discoveryPrice = dexData.priceUsd;
        }
        if (dexData.marketCapUsd > 0) token.marketCapUsd = dexData.marketCapUsd;
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
        token.scores,
        metrics,
        token.rugcheckStatus,  // FIX: pass status string, not boolean
        token.discoveryPrice,
        token.priceUsd,
        this.config.minScore,
        {
          minUniqueBuyers:   this.config.minUniqueBuyers,
          minBuyPressureRatio: this.config.minBuyPressureRatio,
          minBondingCurvePct:  this.config.minBondingCurvePct,
        },
      );

      // Store checklist for frontend display
      token.entryChecklist = entryCheck.checklist;

      // Log entry condition check for debugging
      logger.debug(
        {
          mint:          token.mint.slice(0, 8),
          symbol:        token.symbol,
          score:         token.scores.finalScore,
          buyers:        token.uniqueBuyers,
          bpRatio:       token.scores.buyPressureRatio.toFixed(2),
          bcPct:         token.bondingCurvePct.toFixed(1),
          rugcheck:      token.rugcheckStatus,
          creatorPct:    token.creatorHoldingsPct.toFixed(1),
          topHolder:     token.topHolderPct.toFixed(1),
          eligible:      entryCheck.eligible,
          blockers:      entryCheck.blockers,
        },
        "Early discovery: entry condition check",
      );

      if (entryCheck.eligible) {
        if (!token.firstEligibleAt) token.firstEligibleAt = Date.now();
        token.status = "eligible";

        const confirmMs = Date.now() - token.firstEligibleAt;
        logger.info(
          {
            mint: token.mint.slice(0, 8),
            symbol: token.symbol,
            confirmMs,
            requiredMs: ENTRY_CONFIRM_MS,
          },
          "Early discovery: token ELIGIBLE — waiting for confirmation window ✅",
        );

        if (confirmMs >= ENTRY_CONFIRM_MS) {
          this.enterPaperTrade(token);
        }
      } else {
        if (token.status === "eligible") {
          token.firstEligibleAt = null;
          token.status = "tracking";
          logger.info(
            { mint: token.mint.slice(0, 8), symbol: token.symbol, blockers: entryCheck.blockers },
            "Early discovery: token lost eligibility — back to tracking",
          );
        }
      }

      token.pollCount++;
      token.lastUpdatedAt = Date.now();
    } catch (err) {
      logger.warn({ mint: token.mint.slice(0, 8), err: (err as Error).message }, "Early discovery: poll failed");
    }
  }

  // ── Data fetching ─────────────────────────────────────────────────────────
  private async fetchDexData(mint: string): Promise<{
    buyVolumeSol: number; sellVolumeSol: number; uniqueBuyers: number; priceUsd: number; marketCapUsd: number;
  } | null> {
    try {
      type DexPair = {
        priceUsd?: string; dexId?: string; marketCap?: number; fdv?: number;
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
        marketCapUsd:  pair.marketCap ?? pair.fdv ?? 0,
      };
    } catch { return null; }
  }

  // ── On-chain bonding curve PDA derivation ─────────────────────────────────
  private computeBondingCurvePda(mint: string): string {
    if (this.pdaCache.has(mint)) return this.pdaCache.get(mint)!;

    const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    function b58Dec(s: string): Buffer {
      let n = 0n;
      for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad b58"); n = n * 58n + BigInt(i); }
      const out: number[] = [];
      while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
      const leading = s.match(/^1*/)?.[0]?.length ?? 0;
      return Buffer.concat([Buffer.alloc(leading), Buffer.from(out)]);
    }
    function b58Enc(buf: Buffer): string {
      if (buf.length === 0) return "";
      let n = BigInt("0x" + buf.toString("hex"));
      let s = "";
      while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
      const leading = buf.findIndex((b) => b !== 0);
      return "1".repeat(leading < 0 ? buf.length : leading) + s;
    }
    const P255 = (1n << 255n) - 19n;
    const D_ED = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
    function mpow(base: bigint, exp: bigint, mod: bigint): bigint {
      let r = 1n; base %= mod;
      for (; exp > 0n; exp >>= 1n) { if (exp & 1n) r = r * base % mod; base = base * base % mod; }
      return r;
    }
    function isOnCurve(bytes: Buffer): boolean {
      const y = BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")) & ((1n << 255n) - 1n);
      const y2 = y * y % P255;
      const u  = (y2 - 1n + P255) % P255;
      const v  = (D_ED * y2 + 1n) % P255;
      const x2 = u * mpow(v, P255 - 2n, P255) % P255;
      if (x2 === 0n) return u === 0n;
      return mpow(x2, (P255 - 1n) / 2n, P255) === 1n;
    }
    const mintBytes    = b58Dec(mint);
    const programBytes = b58Dec(PUMPFUN_PROGRAM);
    const marker       = Buffer.from("ProgramDerivedAddress");
    const seed         = Buffer.from("bonding-curve");
    for (let nonce = 255; nonce >= 0; nonce--) {
      const h = createHash("sha256");
      h.update(seed); h.update(mintBytes); h.update(Buffer.from([nonce]));
      h.update(programBytes); h.update(marker);
      const digest = h.digest();
      if (!isOnCurve(digest)) { const pda = b58Enc(digest); this.pdaCache.set(mint, pda); return pda; }
    }
    throw new Error(`PDA not found for mint ${mint}`);
  }

  // ── Batch on-chain bonding curve refresh (fallback when no accountSubscribe) ─
  private async refreshOnChainBondingCurves(): Promise<void> {
    const mints = [...this.tokens.values()]
      .filter((t) => t.status === "tracking" || t.status === "eligible")
      .map((t) => t.mint);
    if (mints.length === 0) return;

    const rpcUrl = HELIUS_API_KEY
      ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
      : SOLANA_PUBLIC_RPC;

    const pdaToMint = new Map<string, string>();
    for (const mint of mints) {
      try { pdaToMint.set(this.computeBondingCurvePda(mint), mint); } catch { /* skip */ }
    }
    const pdas = [...pdaToMint.keys()];
    let updated = 0;

    for (let i = 0; i < pdas.length; i += 100) {
      const batch = pdas.slice(i, i + 100);
      try {
        type RpcResp = { result?: { value?: (null | { data: [string, string] })[] } };
        const res = await axios.post<RpcResp>(
          rpcUrl,
          { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [batch, { encoding: "base64" }] },
          { timeout: 10_000 },
        );
        const values = res.data?.result?.value ?? [];
        for (let j = 0; j < batch.length; j++) {
          const mint  = pdaToMint.get(batch[j]!);
          const acct  = values[j];
          const token = mint ? this.tokens.get(mint) : undefined;
          if (!mint || !acct || !token) continue;

          const data = Buffer.from(acct.data[0], "base64");
          if (data.length < 49) continue;

          const virtualSolReservesLamports = data.readBigUInt64LE(32);
          const complete = data[48] === 1;

          const gradPct = complete
            ? 100
            : Math.min(Number(virtualSolReservesLamports * 100n / GRADUATION_TARGET_LAMPORTS), 99.9);

          const virtualSolReservesSol = Number(virtualSolReservesLamports) / 1e9;
          const targetSolReservesSol  = Number(GRADUATION_TARGET_LAMPORTS) / 1e9;

          logger.debug(
            {
              mint: mint.slice(0, 8),
              virtualSolReservesSol: virtualSolReservesSol.toFixed(4),
              targetSolReservesSol: targetSolReservesSol.toFixed(0),
              bondingCurvePct: gradPct.toFixed(2),
            },
            "Early discovery: on-chain BC read",
          );

          if (gradPct > token.bondingCurvePct || complete) {
            token.bondingCurvePct    = gradPct;
            token.virtualSolReserves = virtualSolReservesSol;
            token.targetSolReserves  = targetSolReservesSol;
            token.bcUpdatedAt        = Date.now();
            updated++;
          }
        }
      } catch (err) {
        logger.debug({ err: (err as Error).message }, "Early discovery: on-chain bonding curve refresh error");
      }
    }

    if (updated > 0) {
      logger.info({ updated, total: mints.length, rpc: HELIUS_API_KEY ? "helius" : "public" },
        "Early discovery: on-chain bonding curves refreshed ⛓️");
      this.broadcast();
    }
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

      if (currentPx <= pos.effectiveSlPrice) {
        this.closePaperPosition(pos, `Stop loss hit (${gainPct.toFixed(1)}%)`, currentPx);
        continue;
      }

      if (!pos.tp1Hit && gainPct >= this.config.tp1Pct) {
        const sellFrac     = this.config.tp1ClosePct / 100;
        const sellSol      = pos.sizeSol * pos.remainingFraction * sellFrac;
        const pnl          = sellSol * (gainPct / 100);
        pos.tp1RealizedSol = pnl;
        pos.realizedPnlSol += pnl;
        pos.remainingFraction *= (1 - sellFrac);
        pos.effectiveSlPrice  = pos.entryPrice;
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

      if (pos.tp2Hit) {
        const runnerSl = pos.trailingHigh * (1 - this.config.runnerTrailingPct / 100);
        if (currentPx <= runnerSl) {
          const remaining2 = pos.sizeSol * pos.remainingFraction;
          const pnl        = remaining2 * (gainPct / 100);
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

  // ── Public position management ────────────────────────────────────────────
  forceClosePosition(id: string): boolean {
    const pos = [...this.openPositions.values()].find((p) => p.id === id);
    if (!pos) {
      // Check closed positions
      const closed = this.closedPositions.find((p) => p.id === id);
      if (!closed) return false;
      return false; // already closed
    }
    const currentPx = pos.currentPrice > 0 ? pos.currentPrice : pos.entryPrice;
    this.closePaperPosition(pos, "Manually closed", currentPx);
    this.broadcast();
    return true;
  }

  deletePosition(id: string): boolean {
    // Try open positions first
    const openEntry = [...this.openPositions.entries()].find(([, p]) => p.id === id);
    if (openEntry) {
      const [mint, pos] = openEntry;
      // Refund the unrealized position back to balance
      this.virtualBalance += pos.sizeSol * pos.remainingFraction;
      this.openPositions.delete(mint);
      const token = this.tokens.get(mint);
      if (token) { token.status = "tracking"; token.positionId = null; }
      void this.persistBalance();
      void execute(`DELETE FROM ed_positions WHERE id=$1`, [id]).catch(() => {/* ok */});
      this.broadcast();
      return true;
    }

    // Try closed positions
    const closedIdx = this.closedPositions.findIndex((p) => p.id === id);
    if (closedIdx >= 0) {
      this.closedPositions.splice(closedIdx, 1);
      void execute(`DELETE FROM ed_positions WHERE id=$1`, [id]).catch(() => {/* ok */});
      this.broadcast();
      return true;
    }

    return false;
  }

  editPosition(id: string, patch: EDPositionPatch): EDPosition | null {
    // Try open positions
    const pos = [...this.openPositions.values()].find((p) => p.id === id)
      ?? this.closedPositions.find((p) => p.id === id);
    if (!pos) return null;

    // Apply allowed patches
    if (patch.entryPrice    !== undefined) pos.entryPrice = patch.entryPrice;
    if (patch.entryScore    !== undefined) pos.entryScore = patch.entryScore;
    if (patch.sizeSol       !== undefined) pos.sizeSol = patch.sizeSol;
    if (patch.effectiveSlPrice !== undefined) pos.effectiveSlPrice = patch.effectiveSlPrice;
    if (patch.trailingHigh  !== undefined) pos.trailingHigh = patch.trailingHigh;
    if (patch.tp1Hit        !== undefined) pos.tp1Hit = patch.tp1Hit;
    if (patch.tp2Hit        !== undefined) pos.tp2Hit = patch.tp2Hit;
    if (patch.closeReason   !== undefined) pos.closeReason = patch.closeReason;
    if (patch.closingScore  !== undefined) pos.closingScore = patch.closingScore;
    if (patch.exitPrice     !== undefined) pos.exitPrice = patch.exitPrice;
    if (patch.realizedPnlSol !== undefined) pos.realizedPnlSol = patch.realizedPnlSol;
    if (patch.tp1RealizedSol !== undefined) pos.tp1RealizedSol = patch.tp1RealizedSol;
    if (patch.tp2RealizedSol !== undefined) pos.tp2RealizedSol = patch.tp2RealizedSol;
    if (patch.runnerRealizedSol !== undefined) pos.runnerRealizedSol = patch.runnerRealizedSol;

    // Recalculate derived fields for open positions
    if (pos.status === "open" && pos.currentPrice > 0) {
      const gainPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      pos.pnlPct = gainPct;
      pos.unrealizedPnlSol = pos.sizeSol * pos.remainingFraction * (gainPct / 100);
      pos.totalPnlSol = pos.realizedPnlSol + pos.unrealizedPnlSol;
    } else if (pos.status === "closed") {
      pos.totalPnlSol = pos.realizedPnlSol;
      pos.pnlPct = pos.sizeSol > 0 ? (pos.totalPnlSol / pos.sizeSol) * 100 : 0;
    }

    void this.persistPosition(pos);
    this.broadcast();
    return pos;
  }

  // ── Token pruning ─────────────────────────────────────────────────────────
  private pruneOldTokens(): void {
    const now = Date.now();
    for (const [mint, token] of this.tokens) {
      if (token.status === "entered") continue;
      const age = now - token.launchAt;
      const ttl =
        token.status === "rejected" ? MAX_REJECTED_AGE_MS :
        token.status === "exited"   ? MAX_EXITED_AGE_MS :
        MAX_TRACK_AGE_MS;
      if (age > ttl) {
        this.tokens.delete(mint);
        // Clean up any WS subscription
        const subId = this.bcMintToSubId.get(mint);
        if (subId !== undefined) {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: ++this.wsReqId, method: "accountUnsubscribe", params: [subId] }));
          }
          this.bcSubIdToMint.delete(subId);
          this.bcMintToSubId.delete(mint);
        }
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
           closing_score=EXCLUDED.closing_score, entry_price=EXCLUDED.entry_price,
           entry_score=EXCLUDED.entry_score, size_sol=EXCLUDED.size_sol`,
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
    const connectionSource: EDStatus["connectionSource"] =
      this.ppConnected       ? "pumpportal" :
      this.wsConnected       ? "helius" :
      this.httpPollConnected ? "http-poll" : "offline";
    return {
      wsConnected: this.ppConnected || this.wsConnected || this.httpPollConnected,
      wsReconnects: this.wsReconnects,
      ppConnected: this.ppConnected,
      ppReconnects: this.ppReconnects,
      connectionSource,
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
    return [...this.tokens.values()]
      .sort((a, b) => b.launchAt - a.launchAt)
      .slice(0, MAX_TOKENS_UI);
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

  injectTestToken(mint: string): void {
    void this.onNewLaunch(mint);
  }
}

export const earlyDiscoveryService = new EarlyDiscoveryService();
