import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { broadcast } from '../websocket/server.js';
import { getBalance, adjustBalance, getSettings } from './settings.service.js';
import { notifyWhaleTrade, notifyWhaleSkip, notifyWhaleClose, notifyWhaleTP } from '../lib/telegram.js';
import { query } from '../lib/db.js';
import { withHeliusLimit, isHeliusCoolingDown } from '../lib/helius-limiter.js';
import { subscribeLogs, isHeliusWsConfigured } from '../lib/helius-ws-shared.js';

const MAX_TRACKING_MS       = 30 * 60 * 1_000;
const MAX_POSITIONS         = 10;
const POLL_INTERVAL_MS      = 2_000;   // reduced from 5s for faster detection
const PRICE_CHECK_MS        = 1_500;   // reduced from 3s for snappier live prices
const SOL_PRICE_TTL_MS      = 60_000;
const MAX_BUY_LOG           = 100;
const DEX_BASE              = 'https://api.dexscreener.com';
const WSOL_MINT             = 'So11111111111111111111111111111111111111112';

// Post-graduation pool wait settings
const POOL_WAIT_POLL_MS     = 3_000;   // check DexScreener every 3s (was 15s — too slow, misses early whale window)
const POOL_WAIT_TIMEOUT_MS  = 10 * 60_000; // give up after 10 min
const MIN_POOL_LIQUIDITY    = 1_000;   // require at least $1k liquidity (fresh pump.fun grads seed $1-3k; was $5k which kept most tokens pending)
const MIN_POOL_AGE_MS       = 10_000;  // pool must be confirmed live for 10s (was 30s — too slow for early entry)
// Server start time — used to filter genuinely pre-startup graduation events
// without rejecting real events that were slow to process due to rate limiting.
const SERVER_START_MS       = Date.now();
// Grace period: accept events that happened slightly before startup (clock skew / boot lag)
const STALE_GRAD_GRACE_MS   = 2 * 60_000; // 2 minutes before server start

const PRICE_SL_PCT          = 0.3;    // -30% price stop loss from entry

const WHALE_TIERS = [
  { minUsd: 2_000, sizePct: 1.0 },
  { minUsd: 1_000, sizePct: 0.75 },
  { minUsd:   500, sizePct: 0.5  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WhaleBuy {
  wallet: string;
  amountUsd: number;
  timestamp: number;
  txSig: string;
  priceAtDetection: number;
}

export interface TrackedToken {
  mint: string;
  name: string;
  symbol: string;
  poolAddress?: string;
  migrationTime: number;
  expiresAt: number;
  entryTriggered: boolean;
  whaleBuys: WhaleBuy[];
  // Live market data (refreshed every 30s)
  price?: number;
  mcap?: number;
  liquidity?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  volume5m?: number;
  lastMarketUpdate?: number;
}

export interface WhalePosition {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  entryPrice: number;
  entryMcap: number;
  entryTime: number;
  sizeSol: number;       // kept in sync with remainingSizeSol for display
  sizePct: number;
  peakPrice: number;
  lastPrice: number;
  lastLiquidity: number;
  baselineLiquidity: number;
  migrationTime: number;
  pnlPct: number;
  // Multi-stage TP
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  initialSizeSol: number;    // original allocation (immutable)
  remainingSizeSol: number;  // still-open portion (decreases at each TP)
  bankedSol: number;         // SOL returned to balance from partial closes
  tpTier: 1 | 2 | 3;
  triggerAmountUsd: number;
  currentSLPrice: number;    // hard SL → breakeven → trailing
}

// ── Tier config ───────────────────────────────────────────────────────────────

interface WhaleTierConfig {
  tp1Pct: number;   tp1Exit: number;
  tp2Pct: number;   tp2Exit: number;   tp2Trail: number;
  tp3Pct: number;   tp3Exit: number;   tp3Trail: number;
}

function determineTier(amountUsd: number): 1 | 2 | 3 {
  if (amountUsd >= 2_000) return 3;
  if (amountUsd >= 1_000) return 2;
  return 1;
}

function getTierConfig(tier: 1 | 2 | 3, s: { [k: string]: number }): WhaleTierConfig {
  if (tier === 3) return {
    tp1Pct: s['wt3Tp1Pct'] ?? 150, tp1Exit: s['wt3Tp1Exit'] ?? 30,
    tp2Pct: s['wt3Tp2Pct'] ?? 350, tp2Exit: s['wt3Tp2Exit'] ?? 30, tp2Trail: s['wt3Tp2Trail'] ?? 20,
    tp3Pct: s['wt3Tp3Pct'] ?? 550, tp3Exit: s['wt3Tp3Exit'] ?? 30, tp3Trail: s['wt3Tp3Trail'] ?? 10,
  };
  if (tier === 2) return {
    tp1Pct: s['wt2Tp1Pct'] ?? 100, tp1Exit: s['wt2Tp1Exit'] ?? 30,
    tp2Pct: s['wt2Tp2Pct'] ?? 250, tp2Exit: s['wt2Tp2Exit'] ?? 30, tp2Trail: s['wt2Tp2Trail'] ?? 25,
    tp3Pct: s['wt2Tp3Pct'] ?? 400, tp3Exit: s['wt2Tp3Exit'] ?? 30, tp3Trail: s['wt2Tp3Trail'] ?? 15,
  };
  return {
    tp1Pct: s['wt1Tp1Pct'] ?? 50,  tp1Exit: s['wt1Tp1Exit'] ?? 30,
    tp2Pct: s['wt1Tp2Pct'] ?? 125, tp2Exit: s['wt1Tp2Exit'] ?? 30, tp2Trail: s['wt1Tp2Trail'] ?? 30,
    tp3Pct: s['wt1Tp3Pct'] ?? 200, tp3Exit: s['wt1Tp3Exit'] ?? 30, tp3Trail: s['wt1Tp3Trail'] ?? 20,
  };
}

export interface ClosedWhalePosition extends WhalePosition {
  closeTime: number;
  closeReason: string;
  closePnlPct: number;
}

export interface WhaleBuyLog {
  mint: string;
  name: string;
  symbol: string;
  wallet: string;
  amountUsd: number;
  timestamp: number;
  txSig: string;
  entered: boolean;
  skipReason?: string;
  priceAtDetection?: number;
  entryPrice?: number;
  slippagePct?: number;
}

interface PendingSignal {
  mint: string;
  name: string;
  symbol: string;
  sizePct: number;
  triggerAmountUsd: number;
  queuedAt: number;
  priceAtDetection: number;
  whaleWallet: string;
}

// ── Pending graduation type ───────────────────────────────────────────────────

interface PendingGraduation {
  mint: string;
  poolAddress?: string;
  detectedAt: number;
}

// ── Helius WebSocket — instant whale-buy detection per tracked mint ───────────
// Uses the shared Helius WS connection (helius-ws-shared.ts) instead of a
// dedicated socket — Helius keys allow only one concurrent WS connection, so a
// separate socket per service caused a 429 reconnect storm across services.

const _mintUnsubscribe = new Map<string, () => void>(); // mint → unsubscribe fn

function wsSubscribeMint(mint: string): void {
  if (_mintUnsubscribe.has(mint)) return;
  const unsub = subscribeLogs([mint], (value) => {
    if (value.err !== null) return;
    if (!trackedTokens.has(mint)) return;

    logger.debug(
      { mint: mint.slice(0, 12), sig: (value.signature ?? '').slice(0, 12) },
      'Whale sniper: WS event — triggering instant poll',
    );
    void pollTokenBuys(mint);
  }, 'processed');
  _mintUnsubscribe.set(mint, unsub);
}

function wsUnsubscribeMint(mint: string): void {
  const unsub = _mintUnsubscribe.get(mint);
  if (unsub) {
    _mintUnsubscribe.delete(mint);
    unsub();
  }
}

function connectWhaleWs(): void {
  if (!isHeliusWsConfigured()) return;
  // Ensure the shared connection is started and (re)subscribe to all currently
  // tracked mints — subscribeLogs auto-resubscribes on reconnect internally,
  // but on first start we still need to register each tracked mint here.
  for (const mint of trackedTokens.keys()) wsSubscribeMint(mint);
  logger.info({ mints: trackedTokens.size }, 'Whale sniper: subscribed tracked mints via shared Helius WS');
}

// ── In-memory state ───────────────────────────────────────────────────────────

const pendingGraduations = new Map<string, PendingGraduation>();
const trackedTokens  = new Map<string, TrackedToken>();
const whalePositions = new Map<string, WhalePosition>();
const buyLog: WhaleBuyLog[] = [];
const signalQueue: PendingSignal[] = [];
const closedPositions: ClosedWhalePosition[] = [];

// Synchronous re-entrancy locks — prevent duplicate entries/closes when
// overlapping poll cycles (or concurrent buy detections for the same mint)
// race each other. Held for the entire duration of the async operation.
const entryLocks = new Set<string>();
const closeLocks = new Set<string>();
// Per-mint poll lock: prevents WS-triggered instant polls and the scheduled
// sweep from running pollTokenBuys concurrently for the same mint, which would
// process overlapping signature windows and could produce duplicate buy events.
const pollLocks  = new Set<string>();
const seenTxns = new Map<string, Set<string>>();
const mintCheckpointed = new Set<string>();

// SOL price cache
let cachedSolPrice    = 200;
let lastSolPriceFetch = 0;

// ── RPC ───────────────────────────────────────────────────────────────────────

let _conn: Connection | null = null;
function getConn(): Connection {
  if (!_conn) {
    const apiKey = process.env.HELIUS_API_KEY;
    const rpc    = process.env.RPC_ENDPOINT
      ?? (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : 'https://api.mainnet-beta.solana.com');
    _conn = new Connection(rpc, { commitment: 'confirmed' });
  }
  return _conn;
}

// ── SOL price ─────────────────────────────────────────────────────────────────
// Primary source: Jupiter Price API v2 (always accurate, reflects real-time AMM)
// Fallback: DexScreener (may lag 30-120s but better than nothing)

async function fetchSolPrice(): Promise<void> {
  if (Date.now() - lastSolPriceFetch < SOL_PRICE_TTL_MS) return;
  // Jupiter Price API v2 — most accurate for SOL
  try {
    const r     = await axios.get<any>(`https://lite-api.jup.ag/price/v2?ids=${WSOL_MINT}`, { timeout: 4_000 });
    const price = parseFloat(r.data?.data?.[WSOL_MINT]?.price ?? '0');
    if (price > 10) { cachedSolPrice = price; lastSolPriceFetch = Date.now(); return; }
  } catch { /* fall through */ }
  // DexScreener fallback
  try {
    const r     = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${WSOL_MINT}`, { timeout: 5_000 });
    const pairs: any[] = r.data?.pairs ?? [];
    const pair  = pairs.find((p: any) => ['USDC', 'USDT'].includes(p.quoteToken?.symbol)) ?? pairs[0];
    const price = parseFloat(pair?.priceUsd ?? '0');
    if (price > 10) { cachedSolPrice = price; lastSolPriceFetch = Date.now(); }
  } catch { /* keep cached value */ }
}

// ── Fetch token market data from DexScreener (liquidity, mcap, metadata) ──────

interface DexMarketData {
  price: number;
  liquidity: number;
  mcap: number;
  priceChange5m: number;
  priceChange1h: number;
  volume5m: number;
  name: string;
  symbol: string;
  pairAddress: string;
}

async function fetchTokenPrice(mint: string): Promise<DexMarketData> {
  const empty: DexMarketData = { price: 0, liquidity: 0, mcap: 0, priceChange5m: 0, priceChange1h: 0, volume5m: 0, name: '', symbol: '', pairAddress: '' };
  try {
    const r     = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 6_000 });
    const pairs: any[] = (r.data?.pairs ?? [])
      .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
      .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!pairs.length) return empty;
    const best  = pairs[0];
    return {
      price:          parseFloat(best?.priceUsd ?? '0'),
      liquidity:      best?.liquidity?.usd ?? 0,
      mcap:           best?.marketCap ?? best?.fdv ?? 0,
      priceChange5m:  best?.priceChange?.m5  ?? 0,
      priceChange1h:  best?.priceChange?.h1  ?? 0,
      volume5m:       best?.volume?.m5        ?? 0,
      name:           best?.baseToken?.name   ?? '',
      symbol:         best?.baseToken?.symbol ?? '',
      pairAddress:    best?.pairAddress        ?? '',
    };
  } catch {
    return empty;
  }
}

// ── Real-time spot price: Jupiter Quote (primary) → DexScreener (fallback) ────
//
// DexScreener caches data 30-120s for freshly-graduated tokens. Meme coins can
// pump 50-100%+ in that window, making DexScreener prices completely wrong at entry.
//
// Jupiter's Quote API reads on-chain pool reserve ratios directly — always real-time.
// Strategy: quote 0.01 SOL → token, derive price from swapUsdValue ÷ tokensReceived.
// All pump.fun tokens have 6 decimals, so tokensReceived = outAmount / 1e6.
//
const PUMP_TOKEN_DECIMALS = 6;
const WSOL_QUOTE_AMOUNT   = 10_000_000; // 0.01 SOL in lamports — small to avoid price impact

// fetchPriceFresh: Jupiter Quote API → derive price from outAmount × SOL/USD.
//
// WHY NOT swapUsdValue:
//   swapUsdValue is often 0 or null for freshly-graduated tokens on lite-api.jup.ag
//   because Jupiter's oracle hasn't indexed them yet. When that happens the old code
//   silently fell back to DexScreener (30-120s stale) and recorded a completely wrong
//   entry price.
//
// CORRECT approach:
//   1. Ensure SOL/USD is fresh (Jupiter Price API v2, < 60s TTL).
//   2. Quote 0.01 SOL → TOKEN on Jupiter to get the actual tokens received.
//   3. price = (0.01 SOL × SOL_USD) / tokens_received  ← always real on-chain
//   4. Only fall back to DexScreener if Jupiter quote itself fails (network/timeout).
async function fetchPriceFresh(mint: string, _pairAddress?: string): Promise<number> {
  // Always ensure a fresh SOL price before calculating token price.
  await fetchSolPrice();

  // 1. Jupiter Quote API — real on-chain reserve ratio, always current.
  try {
    const r = await axios.get<any>(
      `https://lite-api.jup.ag/swap/v1/quote` +
      `?inputMint=${WSOL_MINT}` +
      `&outputMint=${mint}` +
      `&amount=${WSOL_QUOTE_AMOUNT}` +
      `&slippageBps=1000`,
      { timeout: 5_000 },
    );
    const outAmount = parseInt(r.data?.outAmount ?? '0', 10);

    if (outAmount > 0 && cachedSolPrice > 0) {
      const tokensReceived = outAmount / Math.pow(10, PUMP_TOKEN_DECIMALS);
      const inputSolUsd    = (WSOL_QUOTE_AMOUNT / 1e9) * cachedSolPrice; // e.g. 0.01 SOL × $150 = $1.50
      const price          = inputSolUsd / tokensReceived;
      if (price > 0) {
        logger.info(
          { mint: mint.slice(0, 12), price, solPrice: cachedSolPrice,
            tokensReceived: tokensReceived.toFixed(2), source: 'jupiter-quote' },
          'Whale sniper: spot price',
        );
        return price;
      }
    }

    // Edge-case: SOL price not cached yet — try swapUsdValue as last resort
    const swapUsdValue = parseFloat(r.data?.swapUsdValue ?? '0');
    if (swapUsdValue > 0 && outAmount > 0) {
      const tokensReceived = outAmount / Math.pow(10, PUMP_TOKEN_DECIMALS);
      const price          = swapUsdValue / tokensReceived;
      if (price > 0) {
        logger.info(
          { mint: mint.slice(0, 12), price, swapUsdValue, source: 'jupiter-quote-swapUsd' },
          'Whale sniper: spot price (swapUsdValue fallback)',
        );
        return price;
      }
    }
  } catch { /* fall through to DexScreener */ }

  // 2. DexScreener — last resort only (may lag 30-120s for fresh tokens)
  try {
    const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 6_000 });
    const pairs: any[] = (r.data?.pairs ?? [])
      .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
      .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (pairs.length) {
      const price = parseFloat(pairs[0]?.priceUsd ?? '0');
      if (price > 0) {
        logger.warn({ mint: mint.slice(0, 12), price, source: 'dexscreener-fallback' }, 'Whale sniper: spot price (DexScreener fallback — may be stale)');
        return price;
      }
    }
  } catch { /* fall through */ }

  return 0;
}

// ── Buy detection from a parsed Solana transaction ───────────────────────────

interface BuyInfo { wallet: string; solSpent: number; }

function detectBuy(tx: any, targetMint: string): BuyInfo | null {
  const preTok: any[]     = tx.meta?.preTokenBalances  ?? [];
  const postTok: any[]    = tx.meta?.postTokenBalances ?? [];
  const preSol: number[]  = tx.meta?.preBalances  ?? [];
  const postSol: number[] = tx.meta?.postBalances ?? [];
  const keys: any[]       = (tx.transaction?.message as any)?.accountKeys ?? [];

  const gained = postTok.some((post: any) => {
    if (post.mint !== targetMint) return false;
    const pre      = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === targetMint);
    const preAmt   = pre?.uiTokenAmount?.uiAmount ?? 0;
    const postAmt  = post.uiTokenAmount?.uiAmount ?? 0;
    return postAmt > preAmt;
  });
  if (!gained) return null;

  // Method 1: native SOL decrease at fee payer (index 0) — works for native SOL buyers
  const nativeLamports = (preSol[0] ?? 0) - (postSol[0] ?? 0);

  // Method 2: WSOL decrease on fee-payer-owned accounts only — catches whale wallets
  // that fund swaps via pre-existing WSOL accounts. Restricting to fee-payer owner
  // prevents inflating spend from third-party WSOL movements in routed/multi-leg swaps.
  const feePayerAddr = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? '';
  let wsolLamports = 0;
  for (const pre of preTok) {
    if (pre.mint !== WSOL_MINT) continue;
    // Strict: only count WSOL from accounts provably owned by the fee payer.
    // Missing owner = unknown ownership → skip to avoid inflation.
    if (!pre.owner || pre.owner !== feePayerAddr) continue;
    const post   = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === WSOL_MINT);
    const preRaw = parseInt(pre.uiTokenAmount?.amount  ?? '0', 10);
    const postRaw= parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    if (preRaw > postRaw) wsolLamports += (preRaw - postRaw);
  }

  const spent = Math.max(nativeLamports, wsolLamports);
  if (spent < 10_000) return null;

  const wallet = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? 'unknown';
  return { wallet, solSpent: spent / 1e9 };
}

// ── DB persistence (survives Render free-tier spin-down / restarts) ───────────

async function saveWhalePosition(pos: WhalePosition): Promise<void> {
  try {
    await query(
      `INSERT INTO whale_positions
        (id, mint, name, symbol, entry_price, entry_mcap, entry_time, size_sol, size_pct,
         peak_price, last_price, last_liquidity, baseline_liquidity, migration_time, pnl_pct,
         tp1_hit, tp2_hit, tp3_hit, initial_size_sol, remaining_size_sol, banked_sol,
         tp_tier, trigger_amount_usd, current_sl_price, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'OPEN')
       ON CONFLICT (id) DO UPDATE SET
         peak_price        = EXCLUDED.peak_price,
         last_price        = EXCLUDED.last_price,
         last_liquidity    = EXCLUDED.last_liquidity,
         pnl_pct           = EXCLUDED.pnl_pct,
         size_sol          = EXCLUDED.size_sol,
         tp1_hit           = EXCLUDED.tp1_hit,
         tp2_hit           = EXCLUDED.tp2_hit,
         tp3_hit           = EXCLUDED.tp3_hit,
         remaining_size_sol = EXCLUDED.remaining_size_sol,
         banked_sol        = EXCLUDED.banked_sol,
         current_sl_price  = EXCLUDED.current_sl_price`,
      [pos.id, pos.mint, pos.name, pos.symbol, pos.entryPrice, pos.entryMcap ?? 0, pos.entryTime,
       pos.sizeSol, pos.sizePct, pos.peakPrice, pos.lastPrice, pos.lastLiquidity,
       pos.baselineLiquidity, pos.migrationTime, pos.pnlPct,
       pos.tp1Hit, pos.tp2Hit, pos.tp3Hit,
       pos.initialSizeSol, pos.remainingSizeSol, pos.bankedSol,
       pos.tpTier, pos.triggerAmountUsd, pos.currentSLPrice],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Whale sniper: failed to persist position');
  }
}

async function closeWhalePositionInDB(id: string, closeReason: string, closePnlPct: number): Promise<void> {
  try {
    await query(
      `UPDATE whale_positions SET status = 'CLOSED', close_time = $2, close_reason = $3, close_pnl_pct = $4 WHERE id = $1`,
      [id, Date.now(), closeReason, closePnlPct],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Whale sniper: failed to persist position close');
  }
}

export async function restoreWhalePositionsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT * FROM whale_positions WHERE status = 'OPEN' ORDER BY entry_time ASC`);
    for (const r of rows) {
      const rawSize   = Number(r.size_sol);
      const initSize  = Number(r.initial_size_sol ?? 0) || rawSize;
      const remSize   = Number(r.remaining_size_sol ?? 0) || rawSize;
      const entryP    = Number(r.entry_price);
      const storedSL  = Number(r.current_sl_price ?? 0);
      const pos: WhalePosition = {
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: entryP, entryMcap: Number(r.entry_mcap ?? 0),
        entryTime: Number(r.entry_time),
        sizeSol: remSize, sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
        tp1Hit:           Boolean(r.tp1_hit),
        tp2Hit:           Boolean(r.tp2_hit),
        tp3Hit:           Boolean(r.tp3_hit),
        initialSizeSol:   initSize,
        remainingSizeSol: remSize,
        bankedSol:        Number(r.banked_sol ?? 0),
        tpTier:           (Number(r.tp_tier ?? 1) as 1 | 2 | 3),
        triggerAmountUsd: Number(r.trigger_amount_usd ?? 0),
        currentSLPrice:   storedSL > 0 ? storedSL : entryP * (1 - PRICE_SL_PCT),
      };
      whalePositions.set(pos.mint, pos);
    }
    const closedRows = await query<any>(
      `SELECT * FROM whale_positions WHERE status = 'CLOSED' ORDER BY close_time DESC LIMIT 200`,
    );
    for (const r of closedRows) {
      const rawSize = Number(r.size_sol);
      closedPositions.push({
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: Number(r.entry_price), entryMcap: Number(r.entry_mcap ?? 0),
        entryTime: Number(r.entry_time),
        sizeSol: rawSize, sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
        closeTime: Number(r.close_time), closeReason: r.close_reason ?? '', closePnlPct: Number(r.close_pnl_pct ?? 0),
        tp1Hit: Boolean(r.tp1_hit), tp2Hit: Boolean(r.tp2_hit), tp3Hit: Boolean(r.tp3_hit),
        initialSizeSol: Number(r.initial_size_sol ?? 0) || rawSize,
        remainingSizeSol: Number(r.remaining_size_sol ?? 0) || rawSize,
        bankedSol: Number(r.banked_sol ?? 0),
        tpTier: (Number(r.tp_tier ?? 1) as 1 | 2 | 3),
        triggerAmountUsd: Number(r.trigger_amount_usd ?? 0),
        currentSLPrice: Number(r.current_sl_price ?? 0),
      });
    }
    logger.info({ open: rows.length, closed: closedRows.length }, 'Whale sniper: restored positions from DB after restart');
    // Push restored state to any frontend clients that connected before the DB
    // restore completed. Without this broadcast, the frontend sees empty
    // closedPositions on initial load and has no way to know it should refresh.
    broadcastWhaleStatus();
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Whale sniper: failed to restore positions from DB');
  }
}

// ── Position entry ────────────────────────────────────────────────────────────

async function enterWhalePosition(
  mint: string, name: string, symbol: string,
  sizePct: number, triggerAmountUsd: number,
  priceAtDetection: number, whaleWallet: string,
): Promise<void> {
  // Synchronous reservation — no `await` happens between the check and the
  // lock being taken, so two overlapping calls for the same mint (e.g. from
  // an overlapping poll cycle) cannot both pass this guard.
  if (whalePositions.has(mint) || entryLocks.has(mint)) return;
  entryLocks.add(mint);

  try {
    // Fetch market metadata (liquidity, mcap, name, symbol) from DexScreener
    const marketData = await fetchTokenPrice(mint);

    // Get accurate real-time spot price from Jupiter first, fall back to DexScreener
    // DexScreener can lag 30-120s for fresh meme coins — Jupiter reads on-chain reserves
    const tok = trackedTokens.get(mint);
    const pairAddr = tok?.poolAddress;
    const spotPrice = await fetchPriceFresh(mint, pairAddr);
    const entryPrice = spotPrice > 0 ? spotPrice : marketData.price;

    if (entryPrice === 0) {
      logger.warn({ mint }, 'Whale sniper: no price available at entry — skipped');
      return;
    }

    // Enrich name/symbol from DexScreener if still placeholder
    if (tok) {
      if (tok.name.endsWith('…') || !tok.symbol) {
        tok.name   = marketData.name   || tok.name;
        tok.symbol = marketData.symbol || tok.symbol;
        name   = tok.name;
        symbol = tok.symbol;
      }
    }

    // ── Slippage guard ─────────────────────────────────────────────────────────
    // If price has moved more than whaleSlippagePct% above the whale's detection
    // price, the opportunity has already pumped too much — skip it.
    let maxSlippage = 20;
    try {
      const s = await getSettings();
      maxSlippage = s.whaleSlippagePct ?? 20;
    } catch { /* use default */ }

    if (priceAtDetection > 0) {
      const slipPct = ((entryPrice - priceAtDetection) / priceAtDetection) * 100;
      if (slipPct > maxSlippage) {
        logger.warn(
          { mint: mint.slice(0, 12), symbol, slipPct: slipPct.toFixed(1), maxSlippage },
          'Whale sniper: slippage exceeded — skipped',
        );
        notifyWhaleSkip({
          name, symbol, mint, whaleAmountUsd: triggerAmountUsd,
          reason: `Slippage ${slipPct.toFixed(1)}% > ${maxSlippage}% max`,
          entryPrice, whalePriceAtDetection: priceAtDetection, maxSlippagePct: maxSlippage,
        }).catch(() => {});
        return;
      }
    }

    // Re-check after the async gaps above — belt-and-suspenders in case the
    // lock was somehow bypassed (e.g. process restart mid-flight).
    if (whalePositions.has(mint)) return;

    // ── 2-second execution delay ────────────────────────────────────────────
    // Simulates swap confirmation latency. Re-fetch price via Jupiter so the
    // fill price reflects the actual market state at execution time.
    await new Promise(r => setTimeout(r, 2000));
    if (whalePositions.has(mint)) return;   // re-check in case another trigger fired

    // Fill price: Jupiter again for accuracy (DexScreener still possibly stale)
    const fillPrice = await fetchPriceFresh(mint, pairAddr);
    const finalEntryPrice = fillPrice > 0 ? fillPrice : entryPrice;

    logger.info(
      { mint: mint.slice(0, 12), symbol,
        spotPrice: entryPrice, fillPrice: finalEntryPrice,
        priceMoveAfter2s: entryPrice > 0 ? (((finalEntryPrice - entryPrice) / entryPrice) * 100).toFixed(2) + '%' : 'n/a',
        priceSource: spotPrice > 0 ? 'jupiter' : 'dexscreener' },
      'Whale sniper: entry price confirmed',
    );

    const balance = await getBalance().catch(() => 10);
    const sizeSol = balance * (sizePct / 100);
    const tpTier  = determineTier(triggerAmountUsd);
    const liquidity = marketData.liquidity;

    const pos: WhalePosition = {
      id: `${mint}-${Date.now()}`,
      mint, name, symbol,
      entryPrice: finalEntryPrice, entryMcap: tok?.mcap ?? marketData.mcap ?? 0,
      entryTime: Date.now(),
      sizeSol, sizePct,
      peakPrice:   finalEntryPrice,   // FIX: was using stale pre-fill price
      lastPrice:   finalEntryPrice,   // FIX: same — ensures P&L starts at 0%
      lastLiquidity: liquidity,
      baselineLiquidity: liquidity > 0 ? liquidity : 1,
      migrationTime: tok?.migrationTime ?? Date.now(),
      pnlPct: 0,
      // Multi-stage TP
      tp1Hit: false, tp2Hit: false, tp3Hit: false,
      initialSizeSol:    sizeSol,
      remainingSizeSol:  sizeSol,
      bankedSol:         0,
      tpTier,
      triggerAmountUsd,
      currentSLPrice:    finalEntryPrice * (1 - PRICE_SL_PCT),  // FIX: was using stale price
    };

    whalePositions.set(mint, pos);
    void saveWhalePosition(pos);

    if (tok) tok.entryTriggered = true;

    await adjustBalance(-sizeSol).catch(() => {});

    logger.info(
      { mint, symbol, sizePct, sizeSol: sizeSol.toFixed(3), entryPrice: finalEntryPrice, trigger: triggerAmountUsd.toFixed(0) },
      'Whale sniper: ENTERED',
    );

    notifyWhaleTrade({
      name, symbol, mint,
      whaleAmountUsd: triggerAmountUsd,
      sizePct, sizeSol, entryPrice: finalEntryPrice,
      whalePriceAtDetection: priceAtDetection,
      slippagePct: maxSlippage,
      whaleWallet,
    }).catch(() => {});

    broadcastWhaleStatus();
  } finally {
    entryLocks.delete(mint);
  }
}

// ── Queue / slot management ───────────────────────────────────────────────────

function enqueueSignal(mint: string, name: string, symbol: string, sizePct: number, amountUsd: number, priceAtDetection: number, whaleWallet: string): void {
  if (signalQueue.find(s => s.mint === mint)) return;
  signalQueue.push({ mint, name, symbol, sizePct, triggerAmountUsd: amountUsd, queuedAt: Date.now(), priceAtDetection, whaleWallet });
  logger.info({ mint, symbol, sizePct, reason: 'max 10 positions' }, 'Whale sniper: signal queued');
}

async function processQueue(): Promise<void> {
  while (signalQueue.length > 0 && whalePositions.size < MAX_POSITIONS) {
    const sig = signalQueue.shift()!;
    const tok  = trackedTokens.get(sig.mint);
    if (!tok || Date.now() > tok.expiresAt) continue;
    if (whalePositions.has(sig.mint)) continue;
    await enterWhalePosition(sig.mint, sig.name, sig.symbol, sig.sizePct, sig.triggerAmountUsd, sig.priceAtDetection, sig.whaleWallet);
  }
}

// ── Whale buy handler ─────────────────────────────────────────────────────────

async function handleWhaleBuy(
  mint: string, wallet: string, amountUsd: number, txSig: string, priceAtDetection: number,
): Promise<void> {
  const tok = trackedTokens.get(mint);
  if (!tok) return;

  tok.whaleBuys.push({ wallet, amountUsd, timestamp: Date.now(), txSig, priceAtDetection });

  const tier = WHALE_TIERS.find(t => amountUsd >= t.minUsd);

  const entry: WhaleBuyLog = {
    mint, name: tok.name, symbol: tok.symbol,
    wallet, amountUsd, timestamp: Date.now(), txSig,
    entered: false, priceAtDetection,
  };

  if (!tier) {
    entry.skipReason = `${amountUsd.toFixed(0)} below $500 threshold`;
  } else if (whalePositions.has(mint) || tok.entryTriggered) {
    entry.skipReason = 'Already entered this token';
  } else if (whalePositions.size >= MAX_POSITIONS) {
    entry.skipReason = 'Max positions — queued';
    enqueueSignal(mint, tok.name, tok.symbol, tier.sizePct, amountUsd, priceAtDetection, wallet);
  } else {
    entry.entered = true;
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastWhaleStatus();
    await enterWhalePosition(mint, tok.name, tok.symbol, tier.sizePct, amountUsd, priceAtDetection, wallet);
    return;
  }

  buyLog.unshift(entry);
  if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
  broadcastWhaleStatus();
}

// ── Buy polling ───────────────────────────────────────────────────────────────

async function pollTokenBuys(mint: string): Promise<void> {
  // Per-mint concurrency guard — WS-triggered and scheduled polls must not
  // overlap for the same mint, or they'd both read the same "new" sigs before
  // either has had a chance to mark them seen.
  if (pollLocks.has(mint)) return;
  pollLocks.add(mint);

  if (isHeliusCoolingDown()) { pollLocks.delete(mint); return; }

  const conn = getConn();
  const pk   = new PublicKey(mint);

  if (!seenTxns.has(mint)) seenTxns.set(mint, new Set());
  const seen = seenTxns.get(mint)!;

  try {
    // First poll: fetch more sigs so we catch whales who bought in the first seconds
    // after graduation (before DexScreener even indexed the pool).
    const sigLimit = mintCheckpointed.has(mint) ? 30 : 100;
    const sigs = await withHeliusLimit(() => conn.getSignaturesForAddress(pk, { limit: sigLimit }));
    if (!sigs.length) return;

    // First poll: baseline.
    // Mark all existing sigs as seen so we don't re-process them on future polls.
    // Also scan any that are RECENT (≤10 min old, after migration) — catches whales
    // who bought in the seconds after graduation while DexScreener was still catching up.
    if (!mintCheckpointed.has(mint)) {
      mintCheckpointed.add(mint);
      for (const s of sigs) seen.add(s.signature);

      const tok            = trackedTokens.get(mint);
      const migrationSec   = tok ? Math.floor(tok.migrationTime / 1_000) : 0;
      const tenMinAgoSec   = Math.floor(Date.now() / 1_000) - 10 * 60;
      const earlyWhales    = sigs.filter(
        s => !s.err && s.blockTime != null && s.blockTime >= Math.max(migrationSec, tenMinAgoSec),
      );

      if (earlyWhales.length === 0) return;

      logger.info(
        { mint: mint.slice(0, 12), count: earlyWhales.length },
        'Whale sniper: baseline — scanning recent txns for early whale buys',
      );

      // Use Jupiter for priceAtDetection — DexScreener lags 30-120s for fresh tokens
      const currentPrice = await fetchPriceFresh(mint).catch(() => 0);

      // Process from oldest → newest to trigger on the FIRST qualifying buy.
      // Batch in groups of 5 (parallel) to maximise speed. Stop as soon as we enter.
      // Limit: Helius can handle 50 concurrent; public RPC saturates faster → cap at 20.
      const backfillDepth = process.env.HELIUS_API_KEY ? 50 : 20;
      const toFetchEarly  = earlyWhales.slice().reverse().slice(0, backfillDepth).map(s => s.signature);

      const BATCH = 5;
      outer:
      for (let i = 0; i < toFetchEarly.length; i += BATCH) {
        const batch = toFetchEarly.slice(i, i + BATCH);
        const txns  = await Promise.all(
          batch.map(sig =>
            withHeliusLimit(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })).catch(() => null),
          ),
        );
        for (let j = 0; j < txns.length; j++) {
          const tx = txns[j];
          if (!tx) continue;
          const buy = detectBuy(tx, mint);
          if (!buy) continue;
          const amountUsd = buy.solSpent * cachedSolPrice;
          if (amountUsd < 10) continue;
          logger.info(
            { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(0), sig: batch[j].slice(0, 12) },
            'Whale sniper: baseline — early whale buy found',
          );
          await handleWhaleBuy(mint, buy.wallet, amountUsd, batch[j], currentPrice);
          if (trackedTokens.get(mint)?.entryTriggered) break outer;
        }
        if (i + BATCH < toFetchEarly.length) await new Promise(r => setTimeout(r, 50)); // brief pause between batches
      }
      return;
    }

    const newSigs = sigs
      .filter(s => !seen.has(s.signature) && !s.err)
      .map(s => s.signature);

    for (const s of newSigs) seen.add(s);
    if (newSigs.length === 0) return;

    // Use Jupiter for priceAtDetection — DexScreener lags 30-120s for fresh tokens.
    // fetchPriceFresh internally calls fetchSolPrice() so no separate call needed.
    const currentPrice = await fetchPriceFresh(mint).catch(() => 0);

    // Fetch up to 5 new txns in parallel
    const toFetch = newSigs.slice(0, 5);
    const txns    = await Promise.all(
      toFetch.map(sig =>
        withHeliusLimit(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })).catch(() => null),
      ),
    );

    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      if (!tx) continue;
      const buy = detectBuy(tx, mint);
      if (!buy) continue;
      const amountUsd = buy.solSpent * cachedSolPrice;
      // Hard minimum: ignore dust/fee-only transactions (< $10) that are not
      // real buys — these are fee-payer deductions (~15k lamports) that happen
      // to touch the token account and pass the gained-token check.
      if (amountUsd < 10) {
        logger.debug(
          { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(2), sig: toFetch[i].slice(0, 12) },
          'Whale sniper: buy below $10 minimum — skipped',
        );
        continue;
      }
      logger.info(
        { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(0), sig: toFetch[i].slice(0, 12) },
        'Whale sniper: buy detected',
      );
      await handleWhaleBuy(mint, buy.wallet, amountUsd, toFetch[i], currentPrice);
    }
  } catch (err: any) {
    logger.debug({ mint: mint.slice(0, 12), err: err?.message }, 'Whale sniper: poll error');
  } finally {
    pollLocks.delete(mint);
  }
}

// ── Position exit monitoring ──────────────────────────────────────────────────

// ── Partial close at a TP level ───────────────────────────────────────────────

async function partialCloseWhaleTP(
  pos: WhalePosition,
  tpNum: 1 | 2 | 3,
  exitPct: number,       // % of initialSizeSol to sell (e.g. 30)
  currentPrice: number,
  newSLPrice: number,
  newSLDesc: string,
): Promise<void> {
  const chunkSol    = pos.initialSizeSol * (exitPct / 100);
  const returnedSol = chunkSol * (currentPrice / pos.entryPrice);
  const profitOnChunk = returnedSol - chunkSol;

  pos.bankedSol        += returnedSol;
  pos.remainingSizeSol -= chunkSol;
  pos.sizeSol           = pos.remainingSizeSol;  // keep UI field in sync
  pos.currentSLPrice    = newSLPrice;

  // Credit returned SOL to balance immediately
  await adjustBalance(returnedSol).catch(() => {});

  void saveWhalePosition(pos);
  broadcastWhaleStatus();

  const gainPct = (currentPrice / pos.entryPrice - 1) * 100;
  logger.info(
    { mint: pos.mint.slice(0, 12), symbol: pos.symbol, tpNum,
      gainPct: gainPct.toFixed(1), chunkSol: chunkSol.toFixed(4),
      returnedSol: returnedSol.toFixed(4), profitOnChunk: profitOnChunk.toFixed(4),
      remaining: pos.remainingSizeSol.toFixed(4), newSLPrice },
    `Whale sniper: TP${tpNum} partial close`,
  );

  notifyWhaleTP({
    name: pos.name, symbol: pos.symbol, mint: pos.mint,
    tpNum, gainPct,
    chunkSol, returnedSol,
    remainingSizeSol: pos.remainingSizeSol,
    initialSizeSol:   pos.initialSizeSol,
    newSLPrice, newSLDesc,
    entryPrice: pos.entryPrice, currentPrice,
    totalBanked: pos.bankedSol,
  }).catch(() => {});
}

// ── Full position close ───────────────────────────────────────────────────────

async function closeWhalePosition(pos: WhalePosition, reason: string): Promise<void> {
  // Synchronous reservation — prevents two overlapping monitor cycles from
  // both closing (and double-crediting balance for) the same position.
  if (closeLocks.has(pos.mint) || !whalePositions.has(pos.mint)) return;
  closeLocks.add(pos.mint);
  whalePositions.delete(pos.mint);

  try {
    const exitPrice = pos.lastPrice;

    // Runner return: value of the remaining open portion at exit price.
    // bankedSol was already credited to balance on each partial TP close.
    const runnerReturn = pos.remainingSizeSol * (exitPrice / pos.entryPrice);
    const totalReturn  = pos.bankedSol + runnerReturn;
    const initSize     = pos.initialSizeSol > 0.0001 ? pos.initialSizeSol : pos.sizeSol;
    const pnlSol       = totalReturn - initSize;
    const pnlPct       = (pnlSol / initSize) * 100;

    // Only add runner's return — banked portions already credited
    await adjustBalance(runnerReturn).catch(() => {});

    closedPositions.unshift({ ...pos, closeTime: Date.now(), closeReason: reason, closePnlPct: pnlPct });
    if (closedPositions.length > 200) closedPositions.pop();
    void closeWhalePositionInDB(pos.id, reason, pnlPct);

    logger.info({ mint: pos.mint, symbol: pos.symbol, pnlPct: pnlPct.toFixed(1), pnlSol: pnlSol.toFixed(4), reason }, 'Whale sniper: CLOSED');

    notifyWhaleClose({
      name: pos.name, symbol: pos.symbol, mint: pos.mint,
      pnlPct, pnlSol, reason,
      entryPrice: pos.entryPrice, exitPrice, sizeSol: initSize,
    }).catch(() => {});

    broadcastWhaleStatus();
    await processQueue();
  } finally {
    closeLocks.delete(pos.mint);
  }
}

async function monitorPositions(): Promise<void> {
  const mints = Array.from(whalePositions.keys());
  if (mints.length === 0) return;

  let settings: Awaited<ReturnType<typeof getSettings>>;
  try { settings = await getSettings(); } catch { return; }

  try {
    const r      = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mints.slice(0, 30).join(',')}`, { timeout: 8_000 });
    const pairs: any[] = r.data?.pairs ?? [];

    for (const pos of Array.from(whalePositions.values())) {
      const best = (pairs as any[])
        .filter((p: any) => p.baseToken?.address === pos.mint)
        .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

      if (!best) continue;
      const price        = parseFloat(best.priceUsd ?? '0');
      const liquidity    = best.liquidity?.usd ?? 0;
      const priceChange1h: number | null = best?.priceChange?.h1 ?? null;
      if (price <= 0) continue;

      // Update live price & peak
      pos.lastPrice     = price;
      pos.lastLiquidity = liquidity;
      if (price > pos.peakPrice) pos.peakPrice = price;

      // Live P&L: accounts for banked SOL from partial closes
      const initSize = pos.initialSizeSol > 0.0001 ? pos.initialSizeSol : pos.sizeSol;
      pos.pnlPct = initSize > 0
        ? ((pos.bankedSol + pos.remainingSizeSol * (price / pos.entryPrice) - initSize) / initSize) * 100
        : ((price - pos.entryPrice) / pos.entryPrice) * 100;

      void saveWhalePosition(pos);

      const cfg = getTierConfig(pos.tpTier, settings as unknown as Record<string, number>);
      let tpHitThisCycle = false;

      // ── Multi-stage TP checks (in order) ──────────────────────────────────

      // TP1
      if (!pos.tp1Hit && price >= pos.entryPrice * (1 + cfg.tp1Pct / 100)) {
        pos.tp1Hit = true;
        const newSL = pos.entryPrice;  // breakeven
        await partialCloseWhaleTP(pos, 1, cfg.tp1Exit, price, newSL, 'breakeven');
        tpHitThisCycle = true;
      }

      // TP2 (requires TP1)
      if (pos.tp1Hit && !pos.tp2Hit && price >= pos.entryPrice * (1 + cfg.tp2Pct / 100)) {
        pos.tp2Hit = true;
        const newSL = Math.max(pos.currentSLPrice, pos.peakPrice * (1 - cfg.tp2Trail / 100));
        await partialCloseWhaleTP(pos, 2, cfg.tp2Exit, price, newSL, `-${cfg.tp2Trail}% from peak`);
        tpHitThisCycle = true;
      }

      // TP3 (requires TP2)
      if (pos.tp2Hit && !pos.tp3Hit && price >= pos.entryPrice * (1 + cfg.tp3Pct / 100)) {
        pos.tp3Hit = true;
        const newSL = Math.max(pos.currentSLPrice, pos.peakPrice * (1 - cfg.tp3Trail / 100));
        await partialCloseWhaleTP(pos, 3, cfg.tp3Exit, price, newSL, `-${cfg.tp3Trail}% from peak (runner)`);
        tpHitThisCycle = true;
      }

      // ── Ratchet trailing SL upward as peak rises ──────────────────────────
      if (pos.tp3Hit) {
        const trail = pos.peakPrice * (1 - cfg.tp3Trail / 100);
        if (trail > pos.currentSLPrice) pos.currentSLPrice = trail;
      } else if (pos.tp2Hit) {
        const trail = pos.peakPrice * (1 - cfg.tp2Trail / 100);
        if (trail > pos.currentSLPrice) pos.currentSLPrice = trail;
      }

      // Grace period: suppress SL/liq/time exits for 90s post-entry.
      // Entry price (single-mint DexScreener) vs monitor price (multi-mint) can
      // diverge enough to trigger SL before the trade has developed.
      const posAgeMs = Date.now() - pos.entryTime;
      if (posAgeMs < 90_000) continue;

      // ── Exit conditions (skip if a TP just fired this cycle) ─────────────

      // SL hit
      if (!tpHitThisCycle && price <= pos.currentSLPrice) {
        let slReason: string;
        if (pos.tp3Hit)      slReason = `Runner SL (-${cfg.tp3Trail}% from peak)`;
        else if (pos.tp2Hit) slReason = `Trailing SL (-${cfg.tp2Trail}% from peak)`;
        else if (pos.tp1Hit) slReason = 'Breakeven SL';
        else                 slReason = `-${(PRICE_SL_PCT * 100).toFixed(0)}% hard stop loss`;
        await closeWhalePosition(pos, slReason);
        continue;
      }

      // Emergency: liquidity dropped >40%
      if (!tpHitThisCycle && pos.baselineLiquidity > 1 && liquidity > 0) {
        const drop = (pos.baselineLiquidity - liquidity) / pos.baselineLiquidity;
        if (drop > 0.4) {
          await closeWhalePosition(pos, `Liquidity -${(drop * 100).toFixed(0)}% emergency exit`);
          continue;
        }
      }

      // Emergency: liquidity went to zero
      if (!tpHitThisCycle && liquidity === 0 && pos.baselineLiquidity > 1) {
        await closeWhalePosition(pos, 'Liquidity $0 — emergency exit');
        continue;
      }

      // Stagnation exit: if price changed < whaleStagnationPct% in last 1h
      // and position has been open for at least 1h — no time limit otherwise.
      const stagnationPct = (settings as unknown as Record<string, number>)['whaleStagnationPct'] ?? 5;
      if (
        !tpHitThisCycle &&
        posAgeMs >= 3_600_000 &&
        priceChange1h !== null &&
        Math.abs(priceChange1h) < stagnationPct
      ) {
        await closeWhalePosition(pos, `Stagnation: ${Math.abs(priceChange1h).toFixed(1)}% move in 1h (< ${stagnationPct}% threshold)`);
        continue;
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message }, 'Whale sniper: position monitor error');
  }
}

// ── Prune expired tracking ────────────────────────────────────────────────────

function pruneExpiredTracking(): void {
  const now = Date.now();

  // Prune pending graduations that timed out
  for (const [mint, pg] of pendingGraduations) {
    if (now > pg.detectedAt + POOL_WAIT_TIMEOUT_MS) {
      pendingGraduations.delete(mint);
      logger.warn({ mint: mint.slice(0, 12) }, 'Whale sniper: pending graduation timed out — pool never went live');
    }
  }

  for (const [mint, tok] of trackedTokens) {
    if (now <= tok.expiresAt) continue;
    trackedTokens.delete(mint);
    seenTxns.delete(mint);
    mintCheckpointed.delete(mint);
    wsUnsubscribeMint(mint);
    // Do NOT close the position when tracking window expires — positions are
    // held indefinitely and exited only by TP/SL/liquidity/stagnation rules.
    // monitorPositions() continues to track the mint independently via whalePositions.
  }
  const keep = signalQueue.filter(s => trackedTokens.has(s.mint));
  signalQueue.splice(0, signalQueue.length, ...keep);
}

// ── Immediate tracking activation on graduation ───────────────────────────────
//
// Old flow: wait 30-120s for DexScreener to index the pool, then add a 10s
// stability delay → first poll fires ~2 minutes after graduation → whale window closed.
//
// New flow: activate tracking IMMEDIATELY using the mint + poolAddress from the
// graduation TX (already available). Kick off background DexScreener enrichment
// to fill in name/symbol/liquidity once DexScreener catches up. Polling starts
// within 2s of graduation, catching whales in the first block.

// Minimum post-grad pool liquidity required to keep a token tracked.
// Tokens that never reach this (micro/seeded grads, false detections) are pruned after
// VALIDATION_DELAY_MS. Real pump.fun grads seed ~$1-3k liquidity — $500 is conservative.
const MIN_POOL_LIQUIDITY_USD = 500;
const VALIDATION_DELAY_MS   = 20_000; // wait 20s before first quality check
const VALIDATION_TIMEOUT_MS = 60_000; // prune if not validated within 60s of activation
const VALIDATION_POLL_MS    = 5_000;  // retry DexScreener every 5s during validation

async function activateTrackingNow(mint: string): Promise<void> {
  const pending: PendingGraduation | undefined = pendingGraduations.get(mint);
  if (!pending) return;
  if (trackedTokens.has(mint)) { pendingGraduations.delete(mint); return; }

  // Activate immediately with placeholder metadata — DexScreener enriches these async
  pendingGraduations.delete(mint);
  trackedTokens.set(mint, {
    mint,
    name:          mint.slice(0, 6) + '…',
    symbol:        mint.slice(0, 4).toUpperCase(),
    poolAddress:   pending.poolAddress,
    migrationTime: pending.detectedAt,
    expiresAt:     pending.detectedAt + MAX_TRACKING_MS,
    entryTriggered: false,
    whaleBuys:     [],
  });
  seenTxns.set(mint, new Set());

  // Subscribe to Helius WS for instant whale-buy detection on this mint
  wsSubscribeMint(mint);

  logger.info(
    { mint: mint.slice(0, 12), pool: pending.poolAddress?.slice(0, 16) },
    'Whale sniper: tracking activated immediately on graduation (polling within 2s)',
  );
  broadcastWhaleStatus();

  // Background tasks — run in parallel, do NOT await
  void enrichTokenMetadataAsync(mint, pending.detectedAt);
  void validateOrPrune(mint, pending.detectedAt);
}

// Quality gate: after VALIDATION_DELAY_MS, check DexScreener for a real post-grad pool.
// If the pool has < MIN_POOL_LIQUIDITY_USD (e.g. micro/seeded grads, false detections),
// prune the token so it never shows on the UI or accepts entries.
// Real graduates (~$1-3k seed liquidity) clear the bar well within the timeout.
// Whale buys can still be detected and entered during the 20s window — in practice
// nobody can buy $500+ into a $2-liquidity pool, so no false entries occur.
async function validateOrPrune(mint: string, activatedAt: number): Promise<void> {
  // Wait before first check — real pools take ~5-15s to appear on DexScreener
  await new Promise(r => setTimeout(r, VALIDATION_DELAY_MS));

  const deadline = activatedAt + VALIDATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const tok = trackedTokens.get(mint);
    if (!tok) return; // already pruned externally

    // Never prune a token where we've already entered a position
    if (tok.entryTriggered || whalePositions.has(mint)) return;

    try {
      const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 8_000 });
      const allPairs: any[] = r.data?.pairs ?? [];
      const postGradPairs = allPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

      if (postGradPairs.length > 0) {
        const liq = postGradPairs[0]?.liquidity?.usd ?? 0;
        if (liq >= MIN_POOL_LIQUIDITY_USD) {
          // Pool qualifies — token is a real graduate
          logger.info(
            { mint: mint.slice(0, 12), liq: liq.toFixed(0) },
            'Whale sniper: pool quality validated — keeping token',
          );
          return; // enrichMetadataAsync will continue updating market data
        }
        // Pool exists but liquidity is too low → re-check entry state AFTER the await
        // before pruning (entry may have started while DexScreener responded)
        if (trackedTokens.get(mint)?.entryTriggered || whalePositions.has(mint)) return;
        logger.warn(
          { mint: mint.slice(0, 12), liq: liq.toFixed(0), minLiq: MIN_POOL_LIQUIDITY_USD },
          'Whale sniper: pool liquidity below minimum — pruning token (micro/seeded grad)',
        );
        pruneToken(mint);
        return;
      }
      // No post-grad pair yet — keep retrying until deadline
    } catch { /* non-fatal — retry */ }

    await new Promise(r => setTimeout(r, VALIDATION_POLL_MS));
  }

  // Deadline reached: no qualified pool found → re-check entry state before pruning
  if (!trackedTokens.get(mint)?.entryTriggered && !whalePositions.has(mint)) {
    logger.warn({ mint: mint.slice(0, 12) }, 'Whale sniper: no qualified post-grad pool within 60s — pruning token');
    pruneToken(mint);
  }
}

// pruneToken: remove a tracked token completely. Guards against pruning after entry
// so the invariant "never remove tracking state for an active position" is enforced
// centrally and not just at each call site.
function pruneToken(mint: string): void {
  // Final safety: never prune if a position is already open or entry has started
  if (whalePositions.has(mint) || trackedTokens.get(mint)?.entryTriggered) return;
  trackedTokens.delete(mint);
  seenTxns.delete(mint);
  mintCheckpointed.delete(mint);
  wsUnsubscribeMint(mint);
  broadcastWhaleStatus();
}

// Polls DexScreener until it has indexed the post-graduation pool, then updates
// the already-active tracked token's metadata (name, symbol, liquidity, price).
// Does NOT gate trading — polling is already running in parallel.
async function enrichTokenMetadataAsync(mint: string, activatedAt: number): Promise<void> {
  const deadline = activatedAt + POOL_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POOL_WAIT_POLL_MS));

    const tok = trackedTokens.get(mint);
    if (!tok) return; // token was pruned

    // Already enriched (name no longer a placeholder)
    if (!tok.name.endsWith('…') && tok.liquidity && tok.liquidity > 0) return;

    try {
      const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 8_000 });
      const allPairs: any[] = r.data?.pairs ?? [];
      const postGradPairs = allPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

      if (postGradPairs.length === 0) continue; // not indexed yet — keep retrying

      const best      = postGradPairs[0];
      const name      = best?.baseToken?.name   ?? '';
      const symbol    = best?.baseToken?.symbol ?? '';
      const liquidity = best?.liquidity?.usd    ?? 0;
      if (!name) continue; // metadata not populated yet

      // Re-read tok in case it was replaced while we were awaiting
      const tokNow = trackedTokens.get(mint);
      if (!tokNow) return;

      tokNow.name          = name;
      tokNow.symbol        = symbol;
      tokNow.poolAddress   = tokNow.poolAddress ?? best?.pairAddress;
      tokNow.price         = parseFloat(best?.priceUsd ?? '0');
      tokNow.mcap          = best?.marketCap ?? best?.fdv ?? 0;
      tokNow.liquidity     = liquidity;
      tokNow.priceChange5m = best?.priceChange?.m5 ?? 0;
      tokNow.priceChange1h = best?.priceChange?.h1 ?? 0;
      tokNow.volume5m      = best?.volume?.m5       ?? 0;
      tokNow.lastMarketUpdate = Date.now();

      logger.info(
        { mint: mint.slice(0, 12), symbol, dex: best?.dexId, liq: liquidity.toFixed(0),
          enrichSec: Math.round((Date.now() - activatedAt) / 1_000) },
        'Whale sniper: token metadata enriched from DexScreener',
      );
      broadcastWhaleStatus();
      return; // done
    } catch { /* non-fatal — keep retrying */ }
  }

  logger.warn({ mint: mint.slice(0, 12) }, 'Whale sniper: metadata enrichment timed out — token tracked with placeholder name (trading still active)');
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addGraduatedToken(ev: { mint: string; poolAddress?: string; ts: number }): void {
  // Filter genuinely pre-startup graduation events (e.g. historical backfill that
  // somehow leaked through). We do NOT use a fixed time window (the old 5-min limit)
  // because rate-limited polling retries can legitimately take many minutes to process
  // a real graduation — a fixed window would silently drop those real events.
  const cutoff = SERVER_START_MS - STALE_GRAD_GRACE_MS;
  if (ev.ts < cutoff) {
    logger.debug(
      { mint: ev.mint.slice(0, 12), ageMin: ((Date.now() - ev.ts) / 60_000).toFixed(1) },
      'Whale sniper: skipping pre-startup graduation — predates this server session',
    );
    return;
  }

  if (trackedTokens.has(ev.mint) || pendingGraduations.has(ev.mint)) return;

  // Use Date.now() as detectedAt (not the on-chain blockTime) so that the pool-wait
  // deadline and 30-min tracking window start from when WE detected it — not from when
  // the block was mined, which could be several minutes earlier after rate-limited retries.
  const detectedAt = Date.now();

  pendingGraduations.set(ev.mint, {
    mint:       ev.mint,
    poolAddress: ev.poolAddress,
    detectedAt,
  });

  logger.info(
    { mint: ev.mint.slice(0, 16), pool: ev.poolAddress?.slice(0, 16) },
    'Whale sniper: graduation detected — activating tracking immediately',
  );
  broadcastWhaleStatus();

  // Activate tracking immediately; metadata enriched from DexScreener in background
  void activateTrackingNow(ev.mint);
}

export function getWhaleStatus() {
  return {
    trackedTokens:    Array.from(trackedTokens.values()),
    openPositions:    Array.from(whalePositions.values()),
    closedPositions:  closedPositions.slice(0, 200),   // full history for accurate stats
    recentBuyLog:     buyLog.slice(0, 30),
    queuedSignals:    [...signalQueue],
    solPriceUsd:      cachedSolPrice,
    pendingCount:     pendingGraduations.size,
    stats: {
      tracking:  trackedTokens.size,
      positions: whalePositions.size,
      queued:    signalQueue.length,
      pending:   pendingGraduations.size,
    },
  };
}

function broadcastWhaleStatus(): void {
  try {
    broadcast({ type: 'whale_status' as any, data: getWhaleStatus() });
  } catch { /* non-fatal */ }
}

// ── Periodic market data refresh for active tracked tokens ────────────────────

const MARKET_REFRESH_MS     = 30_000; // refresh every 30s
const MARKET_REFRESH_STAGGER = 500;   // ms between each token to avoid rate-limit spikes

async function refreshTrackedTokensMarketData(): Promise<void> {
  const mints = Array.from(trackedTokens.keys());
  let updated = false;
  for (const mint of mints) {
    try {
      const d = await fetchTokenPrice(mint);
      // Re-read after await — token may have been pruned while we were fetching
      const tok = trackedTokens.get(mint);
      if (!tok) continue;
      // Always advance the timestamp so the UI doesn't show a frozen "Xm ago".
      // Only overwrite market values when DexScreener returned real data.
      tok.lastMarketUpdate = Date.now();
      if (d.price > 0) {
        tok.price          = d.price;
        tok.mcap           = d.mcap;
        tok.liquidity      = d.liquidity;
        tok.priceChange5m  = d.priceChange5m;
        tok.priceChange1h  = d.priceChange1h;
        tok.volume5m       = d.volume5m;
        // Backfill poolAddress from DexScreener if we didn't have it
        if (!tok.poolAddress && d.pairAddress) tok.poolAddress = d.pairAddress;
        // Backfill name/symbol if still on placeholder (enrichMetadataAsync may have timed out)
        if (tok.name.endsWith('…') && d.name) { tok.name = d.name; tok.symbol = d.symbol; }
      }
      updated = true;
    } catch { /* non-fatal — keep stale data */ }
    await new Promise(r => setTimeout(r, MARKET_REFRESH_STAGGER));
  }
  if (updated) broadcastWhaleStatus();
}

// Non-overlapping market refresh: waits for each run to finish before scheduling the next
function scheduleMarketRefresh(): void {
  setTimeout(async () => {
    try { await refreshTrackedTokensMarketData(); } catch { /* non-fatal */ }
    scheduleMarketRefresh();
  }, MARKET_REFRESH_MS);
}

// Non-overlapping buy-poll loop: waits for the full sweep (including the
// 300ms per-mint stagger) to finish before scheduling the next one. Using
// setInterval here previously allowed cycles to overlap when a sweep took
// longer than POLL_INTERVAL_MS, causing the same whale buy to be detected
// and entered/alerted twice.
function scheduleBuyPoll(): void {
  setTimeout(async () => {
    try {
      pruneExpiredTracking();
      for (const mint of Array.from(trackedTokens.keys())) {
        await pollTokenBuys(mint);
        await new Promise(r => setTimeout(r, 300));
      }
    } catch { /* non-fatal */ }
    scheduleBuyPoll();
  }, POLL_INTERVAL_MS);
}

// Non-overlapping position monitor loop — same rationale as scheduleBuyPoll.
function schedulePositionMonitor(): void {
  setTimeout(async () => {
    try {
      await monitorPositions();
      broadcastWhaleStatus();
    } catch { /* non-fatal */ }
    schedulePositionMonitor();
  }, PRICE_CHECK_MS);
}

// ── Manual management (called from HTTP routes) ───────────────────────────────

export function findWhalePositionById(id: string): WhalePosition | undefined {
  for (const pos of whalePositions.values()) {
    if (pos.id === id) return pos;
  }
  return undefined;
}

function findClosedByIdInternal(id: string): ClosedWhalePosition | undefined {
  return closedPositions.find(p => p.id === id);
}

/** Manually close an open whale position at its last known price */
export async function manualCloseWhalePosition(id: string, reason: string): Promise<boolean> {
  const pos = findWhalePositionById(id);
  if (!pos) return false;
  // If already being closed by concurrent monitor, report failure (position still exists)
  if (closeLocks.has(pos.mint)) return false;
  await closeWhalePosition(pos, reason);
  // Return true only if position was actually removed from the map
  return !whalePositions.has(pos.mint);
}

/** Edit fields of an open whale position */
export function editWhalePositionFields(id: string, updates: {
  entryPrice?: number; currentSLPrice?: number; triggerAmountUsd?: number;
}): WhalePosition | undefined {
  const pos = findWhalePositionById(id);
  if (!pos) return undefined;
  if (updates.entryPrice !== undefined && updates.entryPrice > 0) {
    pos.entryPrice = updates.entryPrice;
    // Recalculate hard SL if TP1 not yet hit
    if (!pos.tp1Hit) pos.currentSLPrice = updates.entryPrice * (1 - PRICE_SL_PCT);
  }
  if (updates.currentSLPrice !== undefined && updates.currentSLPrice > 0) {
    pos.currentSLPrice = updates.currentSLPrice;
  }
  if (updates.triggerAmountUsd !== undefined && updates.triggerAmountUsd > 0) {
    pos.triggerAmountUsd = updates.triggerAmountUsd;
    pos.tpTier = determineTier(updates.triggerAmountUsd);
  }
  void saveWhalePosition(pos);
  broadcastWhaleStatus();
  return pos;
}

/** Delete an open whale position and refund remaining SOL to balance */
export async function deleteWhalePositionById(id: string): Promise<boolean> {
  const pos = findWhalePositionById(id);
  if (!pos || closeLocks.has(pos.mint) || !whalePositions.has(pos.mint)) return false;
  closeLocks.add(pos.mint);
  whalePositions.delete(pos.mint);
  try {
    await adjustBalance(pos.remainingSizeSol).catch(() => {});
    await query(`DELETE FROM whale_positions WHERE id = $1`, [pos.id]).catch(() => {});
    broadcastWhaleStatus();
    await processQueue();
  } finally {
    closeLocks.delete(pos.mint);
  }
  return true;
}

/** Edit a closed whale position record */
export async function editClosedWhalePositionById(id: string, updates: {
  closeReason?: string; closePnlPct?: number;
}): Promise<ClosedWhalePosition | undefined> {
  const pos = findClosedByIdInternal(id);
  if (!pos) return undefined;
  if (updates.closeReason !== undefined) pos.closeReason = updates.closeReason;
  if (updates.closePnlPct !== undefined) pos.closePnlPct = updates.closePnlPct;
  await query(
    `UPDATE whale_positions SET close_reason = $2, close_pnl_pct = $3 WHERE id = $1`,
    [id, pos.closeReason, pos.closePnlPct],
  ).catch(() => {});
  broadcastWhaleStatus();
  return pos;
}

/** Delete a closed whale position record */
export async function deleteClosedWhalePositionById(id: string): Promise<boolean> {
  const idx = closedPositions.findIndex(p => p.id === id);
  if (idx === -1) return false;
  closedPositions.splice(idx, 1);
  await query(`DELETE FROM whale_positions WHERE id = $1`, [id]).catch(() => {});
  broadcastWhaleStatus();
  return true;
}

/** Reset all in-memory whale state — called on full data reset */
export function resetWhaleState(): void {
  pendingGraduations.clear();
  trackedTokens.clear();
  whalePositions.clear();
  buyLog.splice(0, buyLog.length);
  signalQueue.splice(0, signalQueue.length);
  closedPositions.splice(0, closedPositions.length);
  entryLocks.clear();
  closeLocks.clear();
  pollLocks.clear();
  seenTxns.clear();
  mintCheckpointed.clear();
  // Unsubscribe all Helius WS mints
  for (const mint of Array.from(_mintUnsubscribe.keys())) wsUnsubscribeMint(mint);
  broadcastWhaleStatus();
  logger.info('Whale sniper: state reset (all positions and tracking cleared)');
}

export function startWhaleSniper(): void {
  logger.info('Whale sniper: started (paper mode — following pump.fun graduations)');

  void restoreWhalePositionsFromDB();

  scheduleBuyPoll();
  schedulePositionMonitor();

  // Non-overlapping market data refresh for tracked tokens
  scheduleMarketRefresh();

  void fetchSolPrice();

  // Helius WS for near-instant whale buy detection (requires HELIUS_API_KEY)
  if (isHeliusWsConfigured()) {
    connectWhaleWs();
  } else {
    logger.info('Whale sniper: no HELIUS_API_KEY — using poll-only mode (2s interval)');
  }
}
