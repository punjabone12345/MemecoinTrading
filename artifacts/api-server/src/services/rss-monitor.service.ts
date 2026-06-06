import axios from "axios";
import { logger } from "../lib/logger.js";
import { mapPairToToken } from "./scanner.service.js";
import { checkTokenSafety } from "./rugcheck.service.js";
import { paperTradingService } from "./paper-trading.service.js";
import { blacklistService } from "./blacklist.service.js";
import type { DexScreenerPair } from "../types/index.js";

// Multiple public rsshub mirrors — tried in order until one returns 200
const RSS_FEED_URLS: string[] = [
  "https://rsshub.rssforever.com/telegram/channel/shitcoingemsalert",
  "https://rss.shab.fun/telegram/channel/shitcoingemsalert",
  "https://hub.slarker.me/telegram/channel/shitcoingemsalert",
  "https://rsshub.app/telegram/channel/shitcoingemsalert",
];
const POLL_INTERVAL_MS = 60_000;
const MAX_SIGNALS      = 20;
const DEDUP_SIZE       = 50;
const DEXSCREENER_BASE = "https://api.dexscreener.com";

const RSS_SIZE_SOL      = 0.35;
const RSS_HALF_SIZE_SOL = 0.25;   // reduced entry when MCap drifted 30–60% since signal
const RSS_SL_PCT        = 28;
const RSS_TP1_PCT       = 80;
const RSS_TP1_SELL_PCT  = 50;
const RSS_TP2_PCT       = 150;
const RSS_TP2_SELL_PCT  = 30;
const RSS_TP3_PCT       = 300;
const RSS_TP3_SELL_PCT  = 15;
const RSS_TP_PERCENT    = 300;

// ── Signal freshness & MCap drift thresholds ──────────────────────────────────
const SIGNAL_MAX_AGE_MS   = 15 * 60 * 1_000; // 15 min — stale signals are exit liquidity traps
const MCAP_HALF_THRESHOLD = 0.30;             // 30–60% above signal MCap → half size entry
const MCAP_SKIP_THRESHOLD = 0.60;             // >60% above signal MCap → skip entirely

const MIN_BUY_RATIO          = 0.58;
const MIN_LIQUIDITY_USD      = 15_000;
const MAX_TOKEN_AGE_HOURS    = 24;
const MAX_PRICE_CHANGE_5M    = 50;   // skip if +50%+ in 5m (already pumped)

export interface RssSignal {
  id: string;
  receivedAt: number;
  rawText: string;
  tokenName: string | null;
  pumpMultiple: string | null;
  contractAddress: string | null;
  decision: "pending" | "entered" | "skipped" | "error";
  skipReason?: string;
  positionId?: string;
  pairAddress?: string;
  symbol?: string;
  entryPrice?: number;
  entryAt?: number;
  livePnlPct?: number | null;
  livePnlSol?: number | null;
  positionStatus?: "open" | "closed" | "expired";
}

// ── RSS XML parsing ────────────────────────────────────────────────────────────

function extractTag(xml: string, tag: string): string | null {
  const cdataRe = new RegExp(`<${tag}>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?<\\/${tag}>`);
  const cdataM  = xml.match(cdataRe);
  if (cdataM) return cdataM[1].trim();
  const plainRe = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const plainM  = xml.match(plainRe);
  if (plainM) return plainM[1].trim();
  return null;
}

function parseRssItems(xml: string): Array<{ guid: string; title: string; description: string; pubDate: string }> {
  const out: Array<{ guid: string; title: string; description: string; pubDate: string }> = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const body = m[1];
    out.push({
      guid:        extractTag(body, "guid")        ?? `rss-${Date.now()}-${Math.random()}`,
      title:       extractTag(body, "title")       ?? "",
      description: extractTag(body, "description") ?? "",
      pubDate:     extractTag(body, "pubDate")     ?? "",
    });
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ── Text extraction helpers ────────────────────────────────────────────────────

function extractTokenName(text: string): string | null {
  const gemM = text.match(/GEM\s+UPDATES?\s+\$([A-Z0-9]{1,15})/i);
  if (gemM) return gemM[1].toUpperCase();
  const dollarM = text.match(/\$([A-Z]{2,12})\b/);
  if (dollarM) return dollarM[1].toUpperCase();
  return null;
}

function extractPumpMultiple(text: string): string | null {
  const m = text.match(/\b([2-9]x|[1-9][0-9]+x)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function extractSolanaCA(text: string): string | null {
  // pump.fun/coin/CA  or  pump.fun/CA
  const pumpM = text.match(/pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (pumpM) return pumpM[1];
  // dexscreener.com/solana/…/CA
  const dexM = text.match(/dexscreener\.com\/solana\/[^\s/]*\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (dexM) return dexM[1];
  // bullx.io/terminal?chainId=solana&address=CA
  const bullxM = text.match(/bullx\.io\/[^\s]*address=([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (bullxM) return bullxM[1];
  // photon-sol.tinyastro.io/…/CA
  const photonM = text.match(/photon-sol\.tinyastro\.io\/[^\s/]*\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (photonM) return photonM[1];
  // /sol/ path segments
  const solM = text.match(/\/sol\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (solM) return solM[1];
  // Bare 43-44 char base58 (most Solana pubkeys)
  const b58M = text.match(/\b([1-9A-HJ-NP-Za-km-z]{43,44})\b/);
  if (b58M) return b58M[1];
  // Fallback: 40-44 chars
  const b58S = text.match(/\b([1-9A-HJ-NP-Za-km-z]{40,44})\b/);
  if (b58S) return b58S[1];
  return null;
}

/**
 * Extracts the market cap mentioned in a Telegram signal message.
 * Handles patterns like "50k mcap", "60k→120k", "from 50K", "$1.2M", "50,000".
 * Returns the MCap in USD, or null if none found.
 */
function extractSignalMcap(text: string): number | null {
  const parse = (num: string, suffix: string): number => {
    const n = parseFloat(num);
    const s = suffix.toLowerCase();
    if (s === "k") return n * 1_000;
    if (s === "m") return n * 1_000_000;
    if (s === "b") return n * 1_000_000_000;
    return n;
  };

  // 1. Explicitly labelled: "50k mcap" / "mcap: $50k" / "50k market cap"
  let m = text.match(/\$?(\d+(?:\.\d+)?)\s*([kmb])\s*(?:mc(?:ap)?|market\s*cap)/i);
  if (m) return parse(m[1], m[2]);
  m = text.match(/(?:mc(?:ap)?|market\s*cap)\s*[:\-]?\s*\$?(\d+(?:\.\d+)?)\s*([kmb])/i);
  if (m) return parse(m[1], m[2]);

  // 2. Arrow pattern — first number is the signal MCap: "60k→120k"
  m = text.match(/\$?(\d+(?:\.\d+)?)\s*([kmb])\s*(?:→|->)/i);
  if (m) return parse(m[1], m[2]);

  // 3. Contextual: "from 50k" / "at 50k" / "@ 50k"
  m = text.match(/(?:from|at|@)\s*\$?(\d+(?:\.\d+)?)\s*([kmb])/i);
  if (m) return parse(m[1], m[2]);

  // 4. Comma-formatted full number: "50,000"
  m = text.match(/\$?(\d{1,3}(?:,\d{3})+)/);
  if (m) return parseFloat(m[1].replace(/,/g, ""));

  // 5. First bare "Nk" / "N.Nk" in text as last resort
  m = text.match(/\$?(\d+(?:\.\d+)?)\s*([kmb])\b/i);
  if (m) return parse(m[1], m[2]);

  return null;
}

// ── Service ───────────────────────────────────────────────────────────────────

class RssMonitorService {
  private signals: RssSignal[]        = [];
  private seenIds: string[]           = [];   // FIFO queue for dedup
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.intervalId) return;
    logger.info({ mirrors: RSS_FEED_URLS.length, intervalMs: POLL_INTERVAL_MS }, "RSS monitor: started");
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
  }

  getRssSignals(): RssSignal[] {
    const livePosMap = new Map(
      paperTradingService.getOpenPositionsWithLivePnl().map(p => [p.positionId, p])
    );
    return this.signals.map(s => {
      if (!s.positionId || s.positionStatus !== "open") return s;
      const live = livePosMap.get(s.positionId);
      if (live) return { ...s, livePnlPct: live.livePnlPercent, livePnlSol: live.livePnlSol };
      return { ...s, positionStatus: "closed" as const };
    });
  }

  // ── Polling ──────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    let xml: string | null = null;
    let usedUrl = "";

    for (const url of RSS_FEED_URLS) {
      try {
        const resp = await axios.get<string>(url, {
          timeout: 10_000,
          headers: {
            "Accept":     "application/rss+xml, application/xml, text/xml, */*",
            "User-Agent": "Mozilla/5.0 (compatible; FeedFetcher/1.0; +https://github.com/DIYgod/RSSHub)",
          },
          responseType: "text",
        });
        xml    = String(resp.data);
        usedUrl = url;
        break;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        logger.warn({ url, status }, "RSS monitor: mirror failed, trying next");
      }
    }

    if (!xml) {
      logger.warn("RSS monitor: all mirrors failed this poll");
      return;
    }

    const items = parseRssItems(xml);
    logger.info({ count: items.length, url: usedUrl }, "RSS monitor: feed fetched");

    for (const item of items) {
      if (this.seenIds.includes(item.guid)) continue;
      this.seenIds.push(item.guid);
      if (this.seenIds.length > DEDUP_SIZE) this.seenIds.shift();
      void this.processItem(item);
    }
  }

  // ── Per-item processing ───────────────────────────────────────────────────────

  private async processItem(item: { guid: string; title: string; description: string; pubDate: string }): Promise<void> {
    const combined = `${item.title} ${stripHtml(item.description)}`;
    const rawText  = combined.replace(/\s+/g, " ").trim().slice(0, 500);

    const signal: RssSignal = {
      id:               item.guid,
      receivedAt:       item.pubDate ? (new Date(item.pubDate).getTime() || Date.now()) : Date.now(),
      rawText,
      tokenName:        extractTokenName(rawText),
      pumpMultiple:     extractPumpMultiple(rawText),
      contractAddress:  extractSolanaCA(rawText),
      decision:         "pending",
    };
    this.addSignal(signal);

    logger.info(
      { tokenName: signal.tokenName, pumpMultiple: signal.pumpMultiple, ca: signal.contractAddress },
      "RSS monitor: new message received"
    );

    try {
      if (!signal.pumpMultiple) {
        this.skip(signal.id, "No pump multiple found in message"); return;
      }
      if (signal.pumpMultiple !== "2x") {
        this.skip(signal.id, `Target is ${signal.pumpMultiple} — only 2x signals accepted`); return;
      }
      if (!signal.contractAddress) {
        this.skip(signal.id, "No Solana CA found in message"); return;
      }

      // ── Signal age check ─────────────────────────────────────────────────────
      // Skip signals older than 15 minutes — momentum window has closed and
      // late entries are exit liquidity for those who got in early.
      const signalAgeMs = Date.now() - signal.receivedAt;
      if (signalAgeMs > SIGNAL_MAX_AGE_MS) {
        const ageMin = Math.round(signalAgeMs / 60_000);
        this.skip(signal.id, `Signal ${ageMin} minutes old — momentum window passed`); return;
      }

      const pair = await this.fetchPairByCa(signal.contractAddress);
      if (!pair) {
        this.skip(signal.id, "Token not found on DexScreener (Solana)"); return;
      }

      // ── MCap drift check ──────────────────────────────────────────────────────
      // Compare current MCap vs the MCap mentioned in the signal message.
      // If the token has already run too far, reduce size or skip entirely.
      const signalMcap  = extractSignalMcap(signal.rawText);
      const currentMcap = pair.marketCap || pair.fdv || 0;
      let entrySizeSol  = RSS_SIZE_SOL;

      if (signalMcap && signalMcap > 0 && currentMcap > 0) {
        const drift    = (currentMcap - signalMcap) / signalMcap;
        const driftPct = Math.round(drift * 100);
        const fmtK     = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${(v / 1_000).toFixed(1)}K`;

        if (drift > MCAP_SKIP_THRESHOLD) {
          this.skip(signal.id, `Skipped: MCap moved ${driftPct}% since signal (signal ${fmtK(signalMcap)}, now ${fmtK(currentMcap)}) — entry too late`); return;
        }
        if (drift > MCAP_HALF_THRESHOLD) {
          entrySizeSol = RSS_HALF_SIZE_SOL;
          logger.info(
            { signalMcap: fmtK(signalMcap), currentMcap: fmtK(currentMcap), driftPct, entrySizeSol },
            "RSS monitor: MCap drifted 30–60% — entering at half size"
          );
        } else {
          logger.info(
            { signalMcap: fmtK(signalMcap), currentMcap: fmtK(currentMcap), driftPct, entrySizeSol },
            "RSS monitor: MCap within 30% of signal — entering at full size"
          );
        }
      } else {
        logger.info({ signalMcap, currentMcap }, "RSS monitor: no signal MCap found in text — entering at full size");
      }

      // ── Validation ────────────────────────────────────────────────────────────
      const buys1h   = pair.txns?.h1?.buys  ?? 0;
      const sells1h  = pair.txns?.h1?.sells ?? 0;
      const total1h  = buys1h + sells1h;
      const buyRatio = total1h > 0 ? buys1h / total1h : 0;
      const liq      = pair.liquidity?.usd ?? 0;
      const ageMs    = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageHours = ageMs / 3_600_000;
      const pc5m     = pair.priceChange?.m5 ?? 0;
      const vol5m    = pair.volume?.m5  ?? 0;
      const vol1h    = pair.volume?.h1  ?? 0;
      const vol5mAvg = vol1h / 12;  // expected 5m volume if uniform
      const volAccel = vol5m >= vol5mAvg * 0.75; // 5m must be ≥75% of average 5m slice

      if (!volAccel) {
        this.skip(signal.id, `Volume slowing — 5m $${Math.round(vol5m)} vs avg $${Math.round(vol5mAvg)}`); return;
      }
      if (buyRatio < MIN_BUY_RATIO) {
        this.skip(signal.id, `Buy ratio too low: ${(buyRatio * 100).toFixed(0)}% (min ${(MIN_BUY_RATIO * 100).toFixed(0)}%)`); return;
      }
      if (liq < MIN_LIQUIDITY_USD) {
        this.skip(signal.id, `Liquidity too low: $${Math.round(liq).toLocaleString()} (min $${MIN_LIQUIDITY_USD.toLocaleString()})`); return;
      }
      if (ageHours > MAX_TOKEN_AGE_HOURS) {
        this.skip(signal.id, `Token too old: ${ageHours.toFixed(1)}h (max ${MAX_TOKEN_AGE_HOURS}h)`); return;
      }
      if (pc5m > MAX_PRICE_CHANGE_5M) {
        this.skip(signal.id, `Already up ${pc5m.toFixed(1)}% in 5m — entry too late`); return;
      }

      // ── RugCheck ─────────────────────────────────────────────────────────────
      const rug = await checkTokenSafety(pair.baseToken.address);
      if (!rug.pass) {
        this.skip(signal.id, `RugCheck failed: ${rug.reason}`); return;
      }

      // ── Permanent blacklist check ─────────────────────────────────────────────
      if (blacklistService.isBlacklisted(pair.baseToken.address)) {
        this.skip(signal.id, `Permanently blacklisted CA ${pair.baseToken.address.slice(0, 8)}… — already traded once, no re-entry ever`); return;
      }

      // ── Duplicate / history check ──────────────────────────────────────────────
      // Covers both open positions AND closed trade history — no re-entry ever
      if (paperTradingService.hasEverTradedContract(pair.baseToken.address)) {
        const closed = paperTradingService.getClosedTrades().find(t => t.contractAddress === pair.baseToken.address);
        const open   = paperTradingService.getOpenPositions().find(
          p => p.contractAddress === pair.baseToken.address || p.pairAddress === pair.pairAddress
        );
        const detail = closed
          ? `previously closed on ${new Date(closed.closedAt!).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })} IST (PnL: ${(closed.pnlSol ?? 0) >= 0 ? "+" : ""}${(closed.pnlSol ?? 0).toFixed(4)} SOL)`
          : open ? "currently in open position" : "found in trade history";
        logger.info(
          { symbol: pair.baseToken.symbol, ca: pair.baseToken.address.slice(0, 8) + "…", detail },
          "RSS monitor: skipping — already traded this token"
        );
        this.skip(signal.id, `Already traded ${pair.baseToken.symbol} (${pair.baseToken.address.slice(0, 8)}…) — ${detail}`); return;
      }

      // ── Open trade ────────────────────────────────────────────────────────────
      const token = mapPairToToken(pair);
      const position = await paperTradingService.buyDirect(
        token,
        entrySizeSol,
        RSS_SL_PCT,
        undefined,
        rug,
        { tp1Pct: RSS_TP1_PCT, tp1SellPct: RSS_TP1_SELL_PCT, tp2Pct: RSS_TP2_PCT, tp2SellPct: RSS_TP2_SELL_PCT, tp3Pct: RSS_TP3_PCT, tp3SellPct: RSS_TP3_SELL_PCT, tpPercent: RSS_TP_PERCENT },
        "rss",
      );

      const now = Date.now();
      this.update(signal.id, {
        decision:      "entered",
        positionId:    position.positionId,
        pairAddress:   pair.pairAddress,
        symbol:        pair.baseToken.symbol,
        entryPrice:    position.entryPrice,
        entryAt:       now,
        positionStatus: "open",
      });
      logger.info(
        { symbol: pair.baseToken.symbol, positionId: position.positionId, entryPrice: position.entryPrice, sizeSol: entrySizeSol },
        "RSS monitor: trade entered"
      );

    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      logger.error({ err, signalId: signal.id }, "RSS monitor: processItem error");
      this.update(signal.id, { decision: "error", skipReason: `Error: ${msg}` });
    }
  }

  // ── DexScreener lookup ────────────────────────────────────────────────────────
  // Tries /tokens/{ca} first, then /search?q={ca} as fallback.
  // Both are retried up to 3× on 429 with exponential backoff.

  private async fetchPairByCa(ca: string): Promise<DexScreenerPair | null> {
    const bestSolana = (pairs: DexScreenerPair[]): DexScreenerPair | null => {
      const sol = pairs.filter(p => p.chainId === "solana");
      if (sol.length === 0) return null;
      return sol.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    };

    const getWithRetry = async (url: string): Promise<DexScreenerPair[] | null> => {
      const delays = [500, 1500, 3000];
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const resp = await axios.get<{ pairs?: DexScreenerPair[] | null }>(url, { timeout: 10_000 });
          return resp.data?.pairs ?? [];
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } })?.response?.status;
          if (status === 404) return [];   // not found — fall through to next endpoint
          if (status === 429 && attempt < delays.length) {
            logger.warn({ url, attempt, delay: delays[attempt] }, "RSS DexScreener: rate limited, retrying");
            await new Promise(r => setTimeout(r, delays[attempt]));
            continue;
          }
          logger.warn({ url, status, attempt }, "RSS DexScreener: lookup failed");
          return null;
        }
      }
      return null;
    };

    logger.info({ ca: ca.slice(0, 12) + "…" }, "RSS DexScreener: looking up token");

    // 1️⃣ Primary: tokens endpoint (indexed by mint address)
    const tokenPairs = await getWithRetry(`${DEXSCREENER_BASE}/latest/dex/tokens/${ca}`);
    if (tokenPairs && tokenPairs.length > 0) {
      const best = bestSolana(tokenPairs);
      if (best) { logger.info({ ca: ca.slice(0, 8) + "…", source: "tokens" }, "RSS DexScreener: found via tokens endpoint"); return best; }
    }

    // 2️⃣ Fallback: pairs endpoint (CA might be the pair/pool address, not the token mint)
    logger.info({ ca: ca.slice(0, 8) + "…" }, "RSS DexScreener: trying pairs endpoint");
    const pairPairs = await getWithRetry(`${DEXSCREENER_BASE}/latest/dex/pairs/solana/${ca}`);
    if (pairPairs && pairPairs.length > 0) {
      const best = bestSolana(pairPairs);
      if (best) { logger.info({ ca: ca.slice(0, 8) + "…", source: "pairs" }, "RSS DexScreener: found via pairs endpoint"); return best; }
    }

    // 3️⃣ Fallback: search endpoint (catches very new tokens, different address formats)
    logger.info({ ca: ca.slice(0, 8) + "…" }, "RSS DexScreener: trying search endpoint");
    const searchPairs = await getWithRetry(`${DEXSCREENER_BASE}/latest/dex/search?q=${ca}`);
    if (searchPairs && searchPairs.length > 0) {
      const best = bestSolana(searchPairs);
      if (best) { logger.info({ ca: ca.slice(0, 8) + "…", source: "search" }, "RSS DexScreener: found via search endpoint"); return best; }
    }

    logger.warn({ ca }, "RSS DexScreener: token not found via tokens, pairs, or search endpoints");
    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private skip(id: string, reason: string): void {
    this.update(id, { decision: "skipped", skipReason: reason });
    logger.info({ signalId: id, reason }, "RSS monitor: signal skipped");
  }

  private addSignal(s: RssSignal): void {
    this.signals.unshift(s);
    if (this.signals.length > MAX_SIGNALS) this.signals.pop();
  }

  private update(id: string, patch: Partial<RssSignal>): void {
    const i = this.signals.findIndex(s => s.id === id);
    if (i !== -1) this.signals[i] = { ...this.signals[i], ...patch };
  }
}

export const rssMonitorService = new RssMonitorService();
