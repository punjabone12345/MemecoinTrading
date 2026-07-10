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
const ENTRY_DELAY_MS        = 2_000;   // wait 2s after whale detection before entering
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
  // Vault addresses extracted directly from the whale's buy transaction.
  // These are the pool's actual token vault (base) and WSOL vault (quote).
  // Populated the moment a whale buy is detected — no DexScreener pool resolution needed.
  poolBaseVault?: string;
  poolQuoteVault?: string;
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
  // Timing: when the whale bought vs when we entered
  whaleBuyTimestamp?: number;  // ms since epoch — when whale tx was detected
  entryDelayMs?: number;       // how many ms after whale detection we entered
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
  whaleBuyTimestamp: number;
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

// Permanent, DB-backed lifetime registry of every mint ever traded by the
// whale sniper. `whalePositions` only reflects currently-OPEN positions, so
// once a position closes the mint would otherwise become tradeable again if
// the same graduation got re-detected (backfill re-scan, restart, duplicate
// WS event, etc). This set is checked before EVERY entry and is never
// cleared for a mint once it's added — a token can be entered at most once
// for the lifetime of the bot.
const everTradedMints = new Set<string>();

async function loadTradedMintsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT mint FROM whale_traded_mints`);
    for (const r of rows) everTradedMints.add(r.mint);
    logger.info({ count: everTradedMints.size }, 'Whale sniper: loaded lifetime traded-mint registry');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Whale sniper: failed to load traded-mint registry');
  }
}

async function markMintTraded(mint: string): Promise<void> {
  everTradedMints.add(mint);
  try {
    await query(
      `INSERT INTO whale_traded_mints (mint, traded_at) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING`,
      [mint, Date.now()],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, mint }, 'Whale sniper: failed to persist traded-mint record');
  }
}

// ── Slippage-skipped mints registry ──────────────────────────────────────────
// Once a mint is skipped due to post-delay slippage it is permanently blocked
// at every entry gate. The token already pumped past our threshold before we
// could get a fill — subsequent whale buys on the same mint will face the same
// or worse slippage, so we never attempt it again.
const slippageSkippedMints = new Set<string>();

async function loadSlippageSkippedMintsFromDB(): Promise<void> {
  try {
    const rows = await query<any>(`SELECT mint FROM whale_slippage_skipped_mints`);
    for (const r of rows) slippageSkippedMints.add(r.mint);
    logger.info({ count: slippageSkippedMints.size }, 'Whale sniper: loaded slippage-skipped mint registry');
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'Whale sniper: failed to load slippage-skipped mint registry');
  }
}

async function markMintSlippageSkipped(mint: string, slipPct: number): Promise<void> {
  slippageSkippedMints.add(mint);
  try {
    await query(
      `INSERT INTO whale_slippage_skipped_mints (mint, skipped_at, slip_pct) VALUES ($1, $2, $3) ON CONFLICT (mint) DO NOTHING`,
      [mint, Date.now(), slipPct],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, mint }, 'Whale sniper: failed to persist slippage-skipped mint record');
  }
}

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
      .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
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

// ── On-chain PumpSwap pool reserve-ratio price (ground truth) ────────────────
//
// PumpSwap pool accounts are keypair-based (NOT PDAs) — the pool address must
// come from the migration tx or DexScreener's `pairAddress`, never derived.
// Layout (confirmed against live pools):
//   [139-170] pool_base_token_account  (32 bytes) — token vault
//   [171-202] pool_quote_token_account (32 bytes) — WSOL vault
// price = (wsolVaultBalance * solPriceUsd) / baseVaultBalance
//
// This reads the ACTUAL on-chain reserves at the moment of the call — it is
// not a heuristic/estimate like Jupiter quotes (which can lag pool-cache
// refreshes) or DexScreener (which lags 30-120s for fresh pools).
const POOL_BASE_VAULT_OFFSET  = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_VAULT_LEN          = 32;
const POOL_MIN_ACCOUNT_BYTES  = 203;

const pumpswapVaultCache = new Map<string, { baseVault: PublicKey; quoteVault: PublicKey }>();

async function fetchOnChainReservePrice(poolAddress: string, solPriceUsd: number): Promise<number> {
  if (!poolAddress || solPriceUsd <= 0) return 0;
  try {
    const conn = getConn();
    let vaults = pumpswapVaultCache.get(poolAddress);

    if (!vaults) {
      const poolPk = new PublicKey(poolAddress);
      const info = await withHeliusLimit(() => conn.getAccountInfo(poolPk));
      if (!info || info.data.length < POOL_MIN_ACCOUNT_BYTES) return 0;
      const baseVault  = new PublicKey(info.data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + POOL_VAULT_LEN));
      const quoteVault = new PublicKey(info.data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + POOL_VAULT_LEN));
      vaults = { baseVault, quoteVault };
      pumpswapVaultCache.set(poolAddress, vaults);
    }

    const [baseBal, quoteBal] = await Promise.all([
      withHeliusLimit(() => conn.getTokenAccountBalance(vaults!.baseVault)).catch(() => null),
      withHeliusLimit(() => conn.getTokenAccountBalance(vaults!.quoteVault)).catch(() => null),
    ]);

    const baseAmount  = baseBal?.value?.uiAmount ?? 0;
    const quoteAmount = quoteBal?.value?.uiAmount ?? 0; // WSOL reserve
    if (baseAmount <= 0 || quoteAmount <= 0) return 0;

    const price = (quoteAmount * solPriceUsd) / baseAmount;
    return price > 0 ? price : 0;
  } catch {
    // Wrong/stale pool address (e.g. heuristic-extracted from migration tx) — invalidate cache
    // entry so a later call with a corrected pairAddress can retry cleanly.
    pumpswapVaultCache.delete(poolAddress);
    return 0;
  }
}

// fetchPriceFresh: genuine on-chain reserve-ratio price is the SOURCE OF TRUTH.
//
// WHY on-chain, not Jupiter/DexScreener max():
//   The previous approach quoted Jupiter and DexScreener in parallel and took
//   whichever was higher. That is a heuristic guess, not a calculation — it
//   produced entry prices 10-60% off the real market because Jupiter can return
//   a stale cached route and DexScreener can lag 30-120s on freshly-graduated
//   pools. Reading the pool's actual token vault balances and computing
//   quoteReserve/baseReserve directly is unambiguous ground truth — it cannot
//   be stale because it *is* the current reserve state.
//
// Fallback order (only used when the on-chain read is unavailable, e.g. pool
// address not yet known / RPC hiccup):
//   1. On-chain reserve ratio via the confirmed PumpSwap pool account (best).
//   2. Jupiter Quote API (reads live routes, still on-chain-derived).
//   3. DexScreener priceUsd (last resort — may lag).
async function fetchPriceFresh(mint: string, pairAddress?: string): Promise<number> {
  // Always ensure a fresh SOL price before calculating token price.
  await fetchSolPrice();

  if (pairAddress) {
    const onChainPrice = await fetchOnChainReservePrice(pairAddress, cachedSolPrice);
    if (onChainPrice > 0) {
      logger.info(
        { mint: mint.slice(0, 12), price: onChainPrice, pairAddress: pairAddress.slice(0, 12), source: 'onchain-reserve-ratio' },
        'Whale sniper: spot price (on-chain reserve ratio)',
      );
      return onChainPrice;
    }
  }

  // ── Fallback: Jupiter Quote API ─────────────────────────────────────────
  const jupiterPrice = await (async (): Promise<number> => {
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
        const decimals       = parseInt(r.data?.outputDecimals ?? String(PUMP_TOKEN_DECIMALS), 10);
        const tokensReceived = outAmount / Math.pow(10, decimals);
        const inputSolUsd    = (WSOL_QUOTE_AMOUNT / 1e9) * cachedSolPrice;
        const price          = inputSolUsd / tokensReceived;
        if (price > 0) return price;
      }

      const swapUsdValue = parseFloat(r.data?.swapUsdValue ?? '0');
      if (swapUsdValue > 0 && parseInt(r.data?.outAmount ?? '0', 10) > 0) {
        const decimals       = parseInt(r.data?.outputDecimals ?? String(PUMP_TOKEN_DECIMALS), 10);
        const tokensReceived = parseInt(r.data.outAmount, 10) / Math.pow(10, decimals);
        const price          = swapUsdValue / tokensReceived;
        if (price > 0) return price;
      }
    } catch { /* non-fatal */ }
    return 0;
  })();

  if (jupiterPrice > 0) {
    logger.info({ mint: mint.slice(0, 12), price: jupiterPrice, source: 'jupiter-fallback' }, 'Whale sniper: spot price (jupiter fallback)');
    return jupiterPrice;
  }

  // DexScreener is intentionally NOT used here. For freshly-graduated tokens,
  // DexScreener caches its price 30-120s — reading it during entry returns the
  // pre-whale-pump price, which can be 10-30% below the real pool price.
  // Use fetchPriceFromVaults() directly when on-chain data is needed.
  return 0;
}

// ── Direct vault-balance price (most accurate for fresh tokens) ───────────────
//
// Reads the pool's ACTUAL token vault and WSOL vault balances at this moment.
// Vault addresses are extracted from the whale's buy tx (detectBuy), so this
// requires no pool-account lookup, no DexScreener pair resolution, and no
// Jupiter routing — just two getTokenAccountBalance calls.
//
// price = (wsolVaultBalance × solPriceUsd) / baseVaultBalance
//
async function fetchPriceFromVaults(baseVault: string, quoteVault: string, solPriceUsd: number): Promise<number> {
  if (!baseVault || !quoteVault || solPriceUsd <= 0) return 0;
  try {
    const conn = getConn();
    const [baseBal, quoteBal] = await Promise.all([
      withHeliusLimit(() => conn.getTokenAccountBalance(new PublicKey(baseVault))).catch(() => null),
      withHeliusLimit(() => conn.getTokenAccountBalance(new PublicKey(quoteVault))).catch(() => null),
    ]);
    const baseAmount  = baseBal?.value?.uiAmount  ?? 0;
    const quoteAmount = quoteBal?.value?.uiAmount ?? 0;
    if (baseAmount <= 0 || quoteAmount <= 0) return 0;
    const price = (quoteAmount * solPriceUsd) / baseAmount;
    logger.info(
      { baseVault: baseVault.slice(0, 12), quoteVault: quoteVault.slice(0, 12),
        base: baseAmount.toFixed(0), quote: quoteAmount.toFixed(4), price, source: 'tx-vault-balances' },
      'Whale sniper: spot price (tx vault balances — ground truth)',
    );
    return price > 0 ? price : 0;
  } catch {
    return 0;
  }
}

// ── Buy detection from a parsed Solana transaction ───────────────────────────

interface BuyInfo {
  wallet: string;
  solSpent: number;
  tokensReceived: number;
  poolBaseVault: string | null;  // pool's token vault — decreasing side of the swap
  poolQuoteVault: string | null; // pool's WSOL vault — increasing side of the swap
}

function detectBuy(tx: any, targetMint: string): BuyInfo | null {
  const preTok: any[]     = tx.meta?.preTokenBalances  ?? [];
  const postTok: any[]    = tx.meta?.postTokenBalances ?? [];
  const preSol: number[]  = tx.meta?.preBalances  ?? [];
  const postSol: number[] = tx.meta?.postBalances ?? [];
  const keys: any[]       = (tx.transaction?.message as any)?.accountKeys ?? [];

  // Sum all token balance increases for this mint — the total tokens the buyer received.
  // Use raw integer amounts (uiTokenAmount.amount) divided by 10^decimals rather than
  // uiAmount to avoid floating-point rounding errors on large token quantities.
  let tokensReceived = 0;
  for (const post of postTok) {
    if (post.mint !== targetMint) continue;
    const pre      = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === targetMint);
    const decimals = parseInt(post.uiTokenAmount?.decimals ?? '6', 10);
    const divisor  = Math.pow(10, decimals);
    const preRaw   = parseInt(pre?.uiTokenAmount?.amount  ?? '0', 10);
    const postRaw  = parseInt(post.uiTokenAmount?.amount  ?? '0', 10);
    if (postRaw > preRaw) tokensReceived += (postRaw - preRaw) / divisor;
  }
  if (tokensReceived <= 0) return null;

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

  // ── Extract pool vault addresses from this tx ────────────────────────────
  // Pool's BASE vault: the target-mint account that DECREASED (pool gave tokens to buyer)
  let poolBaseVault: string | null = null;
  for (const pre of preTok) {
    if (pre.mint !== targetMint) continue;
    const post   = postTok.find((p: any) => p.accountIndex === pre.accountIndex && p.mint === targetMint);
    const preRaw = parseInt(pre.uiTokenAmount?.amount ?? '0', 10);
    const postRaw= parseInt(post?.uiTokenAmount?.amount ?? '0', 10);
    if (preRaw > postRaw) {
      const addr = keys[pre.accountIndex]?.pubkey?.toString() ?? keys[pre.accountIndex]?.toString() ?? null;
      if (addr) { poolBaseVault = addr; break; }
    }
  }

  // Pool's QUOTE vault (WSOL): pick the WSOL account with the LARGEST lamport increase.
  //
  // Why largest-increase instead of first-match with owner filter:
  //   • In a direct PumpSwap buy, the pool's WSOL vault receives all the SOL the buyer paid.
  //   • In multi-leg or routed transactions, intermediate accounts may also gain WSOL, but
  //     the pool vault always shows the dominant increase.
  //   • The owner field is sometimes absent from getParsedTransaction results, making
  //     owner-based exclusion unreliable. The buyer's WSOL account DECREASES (they spend SOL),
  //     so any WSOL account that increases is either the pool or an intermediate account.
  //     Taking the largest increase almost always gives us the pool vault.
  //   • Explicitly skip fee-payer-owned accounts when owner IS available.
  let poolQuoteVault: string | null = null;
  let maxWsolIncrease = 0;
  for (const post of postTok) {
    if (post.mint !== WSOL_MINT) continue;
    if (post.owner && post.owner === feePayerAddr) continue; // buyer's WSOL — skip when owner known
    const pre     = preTok.find((p: any) => p.accountIndex === post.accountIndex && p.mint === WSOL_MINT);
    const preRaw  = parseInt(pre?.uiTokenAmount?.amount ?? '0', 10);
    const postRaw = parseInt(post.uiTokenAmount?.amount ?? '0', 10);
    const delta   = postRaw - preRaw;
    if (delta > maxWsolIncrease) {
      const addr = keys[post.accountIndex]?.pubkey?.toString() ?? keys[post.accountIndex]?.toString() ?? null;
      if (addr) { poolQuoteVault = addr; maxWsolIncrease = delta; }
    }
  }

  const wallet = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? 'unknown';
  return { wallet, solSpent: spent / 1e9, tokensReceived, poolBaseVault, poolQuoteVault };
}

// ── DB persistence (survives Render free-tier spin-down / restarts) ───────────

async function saveWhalePosition(pos: WhalePosition): Promise<void> {
  try {
    await query(
      `INSERT INTO whale_positions
        (id, mint, name, symbol, entry_price, entry_mcap, entry_time, size_sol, size_pct,
         peak_price, last_price, last_liquidity, baseline_liquidity, migration_time, pnl_pct,
         tp1_hit, tp2_hit, tp3_hit, initial_size_sol, remaining_size_sol, banked_sol,
         tp_tier, trigger_amount_usd, current_sl_price, whale_buy_timestamp, entry_delay_ms, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,'OPEN')
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
       pos.tpTier, pos.triggerAmountUsd, pos.currentSLPrice,
       pos.whaleBuyTimestamp ?? null, pos.entryDelayMs ?? null],
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
        whaleBuyTimestamp: r.whale_buy_timestamp ? Number(r.whale_buy_timestamp) : undefined,
        entryDelayMs:      r.entry_delay_ms ? Number(r.entry_delay_ms) : undefined,
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
        whaleBuyTimestamp: r.whale_buy_timestamp ? Number(r.whale_buy_timestamp) : undefined,
        entryDelayMs:      r.entry_delay_ms ? Number(r.entry_delay_ms) : undefined,
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
  whaleBuyTimestamp: number,
): Promise<void> {
  // Synchronous reservation — no `await` happens between the check and the
  // lock being taken, so two overlapping calls for the same mint (e.g. from
  // an overlapping poll cycle) cannot both pass this guard.
  // `everTradedMints` is the lifetime gate: a mint that has EVER been entered
  // (open or closed, this session or a previous one) can never be entered again.
  if (whalePositions.has(mint) || entryLocks.has(mint) || everTradedMints.has(mint) || slippageSkippedMints.has(mint)) return;
  entryLocks.add(mint);

  try {
    // Fetch market metadata (liquidity, mcap, name, symbol) from DexScreener
    const marketData = await fetchTokenPrice(mint);

    // Enrich name/symbol from DexScreener if still placeholder
    const tok = trackedTokens.get(mint);
    if (tok) {
      if (tok.name.endsWith('…') || !tok.symbol) {
        tok.name   = marketData.name   || tok.name;
        tok.symbol = marketData.symbol || tok.symbol;
        name   = tok.name;
        symbol = tok.symbol;
      }
    }

    // ── Slippage guard ─────────────────────────────────────────────────────────
    let maxSlippage = 20;
    try {
      const s = await getSettings();
      maxSlippage = s.whaleSlippagePct ?? 20;
    } catch { /* use default */ }

    // Re-check after the async gaps above — belt-and-suspenders.
    if (whalePositions.has(mint)) return;

    // Mark entryTriggered BEFORE the delay so validateOrPrune cannot prune
    // this token during the wait window.
    if (tok) tok.entryTriggered = true;

    // ── 2-second entry delay ─────────────────────────────────────────────────
    // We do NOT fetch price before this delay:
    //   • the pool address may not yet be resolved (enrichTokenMetadataAsync is
    //     async and takes 5-15s);
    //   • on-chain reserve reads would return the stale pre-whale pool state
    //     if RPC is lagging or rate-limited;
    //   • DexScreener lags 30-120s and would return an even older price.
    // Instead we wait, then fetch ONCE — by that time Jupiter has the token,
    // DexScreener has often updated, and the pool address is more likely set.
    // If the fetch still fails, we fall back to priceAtDetection (the whale's
    // verified on-chain avg price from the tx), which is far more accurate than
    // any stale cached value.
    await new Promise(r => setTimeout(r, ENTRY_DELAY_MS));
    if (whalePositions.has(mint)) return;

    // Read the latest state of trackedTokens — enrichment may have run during the delay.
    const tok2 = trackedTokens.get(mint);

    // ── Price fetch priority after the 2s wait ───────────────────────────────
    // 1. Direct vault read from whale's tx (ground truth — no pool addr resolution needed)
    // 2. On-chain reserve ratio via DexScreener pool address (if enrichment has resolved it)
    // 3. Jupiter quote (no pool address needed)
    // If all fail: skip entry — never fall back to DexScreener priceUsd (it's 30-120s stale)
    await fetchSolPrice().catch(() => {}); // ensure SOL price is fresh for all paths

    let delayedPrice = 0;

    // Path 1: direct vault balance read — extracted from whale's buy tx
    if (tok2?.poolBaseVault && tok2?.poolQuoteVault) {
      delayedPrice = await fetchPriceFromVaults(tok2.poolBaseVault, tok2.poolQuoteVault, cachedSolPrice).catch(() => 0);
    }

    // Path 2: on-chain reserve ratio via pool account (requires DexScreener pool addr)
    if (delayedPrice === 0 && tok2?.poolAddress) {
      delayedPrice = await fetchOnChainReservePrice(tok2.poolAddress, cachedSolPrice).catch(() => 0);
      if (delayedPrice > 0) logger.info({ mint: mint.slice(0, 12), price: delayedPrice, source: 'pool-account' }, 'Whale sniper: spot price (pool account fallback)');
    }

    // Path 3: Jupiter quote (on-chain-derived, no pool address needed)
    if (delayedPrice === 0) {
      delayedPrice = await fetchPriceFresh(mint, undefined).catch(() => 0); // pairAddress=undefined → skips on-chain read, goes straight to Jupiter
    }

    // Do NOT fall back to DexScreener priceUsd — it's 30-120s stale on fresh tokens
    // and will return the pre-whale-pump price, making our entry price completely wrong.
    if (delayedPrice === 0) {
      logger.warn({ mint: mint.slice(0, 12), symbol }, 'Whale sniper: all price sources failed — skipping entry (will retry on next whale buy)');
      if (tok) tok.entryTriggered = false; // allow future qualifying buys to trigger
      return;
    }

    const finalEntryPrice = delayedPrice;

    const entryTimestamp = Date.now();
    const entryDelayMs   = entryTimestamp - whaleBuyTimestamp;

    // ── Slippage check (single, post-delay) ──────────────────────────────────
    // Compare our actual entry price against the whale's on-chain avg price.
    // If the token pumped more than maxSlippage% in the wait window, skip.
    if (priceAtDetection > 0) {
      const finalSlipPct = ((finalEntryPrice - priceAtDetection) / priceAtDetection) * 100;
      if (finalSlipPct > maxSlippage) {
        logger.warn(
          { mint: mint.slice(0, 12), symbol, finalSlipPct: finalSlipPct.toFixed(1), maxSlippage },
          'Whale sniper: post-delay slippage exceeded — skipped',
        );
        notifyWhaleSkip({
          name, symbol, mint, whaleAmountUsd: triggerAmountUsd,
          reason: `Slippage ${finalSlipPct.toFixed(1)}% > ${maxSlippage}% max`,
          entryPrice: finalEntryPrice, whalePriceAtDetection: priceAtDetection, maxSlippagePct: maxSlippage,
        }).catch(() => {});
        // Permanently block this mint — it already pumped past our threshold
        // before we could enter; future whale buys on the same token would face
        // the same or worse slippage so we never attempt it again.
        markMintSlippageSkipped(mint, finalSlipPct).catch(() => {});
        if (tok) tok.entryTriggered = false;
        return;
      }
    }

    logger.info(
      { mint: mint.slice(0, 12), symbol,
        whalePrice: priceAtDetection, ourEntryPrice: finalEntryPrice,
        priceDeltaPct: priceAtDetection > 0
          ? (((finalEntryPrice - priceAtDetection) / priceAtDetection) * 100).toFixed(2) + '%'
          : 'n/a',
        whaleBuyAt: new Date(whaleBuyTimestamp).toISOString(),
        ourEntryAt: new Date(entryTimestamp).toISOString(),
        entryDelayMs },
      'Whale sniper: entering after delay — price fetched post-delay',
    );

    const balance = await getBalance().catch(() => 10);
    const sizeSol = balance * (sizePct / 100);
    const tpTier  = determineTier(triggerAmountUsd);
    const liquidity = marketData.liquidity;

    const pos: WhalePosition = {
      id: `${mint}-${Date.now()}`,
      mint, name, symbol,
      entryPrice: finalEntryPrice, entryMcap: tok?.mcap ?? marketData.mcap ?? 0,
      entryTime: entryTimestamp,
      sizeSol, sizePct,
      peakPrice:   finalEntryPrice,
      lastPrice:   finalEntryPrice,
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
      currentSLPrice:    finalEntryPrice * (1 - PRICE_SL_PCT),
      // Timing
      whaleBuyTimestamp,
      entryDelayMs,
    };

    whalePositions.set(mint, pos);
    void saveWhalePosition(pos);
    void markMintTraded(mint);

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

// ── Trading window (IST) ─────────────────────────────────────────────────────

/**
 * Returns true if the current IST time is within the configured trading window.
 * When tradingWindowEnabled is false, always returns true (no restriction).
 *
 * "00:00" as an end time is treated as midnight = end of calendar day (1440 min).
 * Supports cross-midnight windows like 22:00→06:00 automatically.
 */
/** Returns the current time-of-day in IST as total minutes since midnight (0–1439). */
function getISTMinutes(): number {
  // Intl.DateTimeFormat with timeZone:'Asia/Kolkata' is the only correct way to
  // get IST regardless of the host server's local timezone setting.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  // Intl may return hour=24 for midnight in some environments; normalise to 0.
  return (h % 24) * 60 + m;
}

function isInTradingWindow(settings: { tradingWindowEnabled: boolean; tradingWindowStart: string; tradingWindowEnd: string }): boolean {
  if (!settings.tradingWindowEnabled) return true;

  const currentMin = getISTMinutes();

  const [sh, sm] = (settings.tradingWindowStart || '17:00').split(':').map(Number);
  const [eh, em] = (settings.tradingWindowEnd   || '00:00').split(':').map(Number);

  const startMin = sh * 60 + (sm || 0);
  // "00:00" end → treat as 1440 (end of calendar day = just-before-midnight)
  const endMin   = (eh === 0 && (em || 0) === 0) ? 1440 : eh * 60 + (em || 0);

  if (startMin < endMin) {
    // Normal same-day window: e.g. 17:00→00:00 (→1440), 09:00→17:00
    return currentMin >= startMin && currentMin < endMin;
  } else {
    // Cross-midnight window: e.g. 22:00→06:00
    return currentMin >= startMin || currentMin < endMin;
  }
}

// ── Queue / slot management ───────────────────────────────────────────────────

function enqueueSignal(mint: string, name: string, symbol: string, sizePct: number, amountUsd: number, priceAtDetection: number, whaleWallet: string, whaleBuyTimestamp: number): void {
  if (everTradedMints.has(mint) || slippageSkippedMints.has(mint)) return;
  if (signalQueue.find(s => s.mint === mint)) return;
  signalQueue.push({ mint, name, symbol, sizePct, triggerAmountUsd: amountUsd, queuedAt: Date.now(), priceAtDetection, whaleWallet, whaleBuyTimestamp });
  logger.info({ mint, symbol, sizePct, reason: 'max 10 positions' }, 'Whale sniper: signal queued');
}

async function processQueue(): Promise<void> {
  // Don't dequeue if we're outside the trading window
  try {
    const s = await getSettings();
    if (!isInTradingWindow(s)) return;
  } catch { return; }

  while (signalQueue.length > 0 && whalePositions.size < MAX_POSITIONS) {
    const sig = signalQueue.shift()!;
    const tok  = trackedTokens.get(sig.mint);
    if (!tok || Date.now() > tok.expiresAt) continue;
    if (whalePositions.has(sig.mint) || everTradedMints.has(sig.mint) || slippageSkippedMints.has(sig.mint)) continue;
    await enterWhalePosition(sig.mint, sig.name, sig.symbol, sig.sizePct, sig.triggerAmountUsd, sig.priceAtDetection, sig.whaleWallet, sig.whaleBuyTimestamp);
  }
}

// ── Whale buy handler ─────────────────────────────────────────────────────────

async function handleWhaleBuy(
  mint: string, wallet: string, amountUsd: number, txSig: string, priceAtDetection: number,
): Promise<void> {
  const tok = trackedTokens.get(mint);
  if (!tok) return;

  // ── Trading window gate ───────────────────────────────────────────────────
  try {
    const s = await getSettings();
    if (!isInTradingWindow(s)) {
      logger.info({ mint, symbol: tok.symbol }, 'Whale sniper: outside trading window — entry skipped');
      return;
    }
  } catch { /* if settings unavailable, block entry to be safe */ return; }

  const whaleBuyTimestamp = Date.now();
  tok.whaleBuys.push({ wallet, amountUsd, timestamp: whaleBuyTimestamp, txSig, priceAtDetection });

  const tier = WHALE_TIERS.find(t => amountUsd >= t.minUsd);

  const entry: WhaleBuyLog = {
    mint, name: tok.name, symbol: tok.symbol,
    wallet, amountUsd, timestamp: whaleBuyTimestamp, txSig,
    entered: false, priceAtDetection,
  };

  if (!tier) {
    entry.skipReason = `${amountUsd.toFixed(0)} below $500 threshold`;
  } else if (whalePositions.has(mint) || tok.entryTriggered || everTradedMints.has(mint) || slippageSkippedMints.has(mint)) {
    entry.skipReason = slippageSkippedMints.has(mint)
      ? 'Slippage-skipped token (permanently blocked — pumped too fast before entry)'
      : 'Already traded this token (lifetime — never re-entered)';
  } else if (whalePositions.size >= MAX_POSITIONS) {
    entry.skipReason = 'Max positions — queued';
    enqueueSignal(mint, tok.name, tok.symbol, tier.sizePct, amountUsd, priceAtDetection, wallet, whaleBuyTimestamp);
  } else {
    entry.entered = true;
    buyLog.unshift(entry);
    if (buyLog.length > MAX_BUY_LOG) buyLog.pop();
    broadcastWhaleStatus();
    await enterWhalePosition(mint, tok.name, tok.symbol, tier.sizePct, amountUsd, priceAtDetection, wallet, whaleBuyTimestamp);
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

  const tok = trackedTokens.get(mint);
  const pairAddr = tok?.poolAddress;

  try {
    // First poll: fetch a much larger window of sigs so we never truncate before
    // reaching the graduation moment — a delayed first poll (e.g. after Helius
    // rate-limit backoff) can otherwise have >100 sigs already posted, silently
    // hiding the earliest (and most important) whale buys beyond the fetch window.
    // 1000 is the RPC's max per-call limit for getSignaturesForAddress.
    const sigLimit = mintCheckpointed.has(mint) ? 30 : 1_000;
    const sigs = await withHeliusLimit(() => conn.getSignaturesForAddress(pk, { limit: sigLimit }));
    if (!sigs.length) return;

    // First poll: baseline.
    // Mark all existing sigs as seen so we don't re-process them on future polls.
    // Also scan any that are RECENT (≤10 min old, after migration) — catches whales
    // who bought in the seconds after graduation while DexScreener was still catching up.
    if (!mintCheckpointed.has(mint)) {
      mintCheckpointed.add(mint);
      for (const s of sigs) seen.add(s.signature);

      const migrationSec   = tok ? Math.floor(tok.migrationTime / 1_000) : 0;
      const tenMinAgoSec   = Math.floor(Date.now() / 1_000) - 10 * 60;
      const earlyWhales    = sigs.filter(
        s => !s.err && s.blockTime != null && s.blockTime >= Math.max(migrationSec, tenMinAgoSec),
      );

      // Fetch signatures may have hit the RPC page limit without reaching the
      // migration timestamp — that means there is unseen history further back.
      // Rather than silently missing it, page backwards with `before` until we
      // reach the migration time or run out of history.
      if (sigs.length === sigLimit) {
        let before = sigs[sigs.length - 1].signature;
        for (let page = 0; page < 5; page++) {
          const older = await withHeliusLimit(() => conn.getSignaturesForAddress(pk, { limit: 1_000, before })).catch(() => []);
          if (!older.length) break;
          for (const s of older) seen.add(s.signature);
          const olderEarly = older.filter(
            s => !s.err && s.blockTime != null && s.blockTime >= migrationSec,
          );
          earlyWhales.push(...olderEarly);
          const oldestBlockTime = older[older.length - 1]?.blockTime ?? 0;
          before = older[older.length - 1].signature;
          if (oldestBlockTime > 0 && oldestBlockTime < migrationSec) break; // reached pre-migration history
          if (older.length < 1_000) break; // no more pages
        }
      }

      if (earlyWhales.length === 0) return;

      logger.info(
        { mint: mint.slice(0, 12), count: earlyWhales.length },
        'Whale sniper: baseline — scanning recent txns for early whale buys',
      );

      // Ensure SOL price is fresh so we can compute whale's avg entry price from tx data.
      await fetchSolPrice().catch(() => {});

      // Process from oldest → newest to trigger on the FIRST qualifying buy.
      // Batch in groups of 5 (parallel) to maximise speed. Stop as soon as we enter.
      // NOTE: no artificial depth cap here — capping silently dropped candidate
      // whale buys that occurred after the cutoff, which could BE the first
      // qualifying buy. The loop already breaks out immediately on entry, so the
      // real-world cost is bounded by however many non-qualifying buys preceded
      // the first whale buy, not by an arbitrary constant.
      const toFetchEarly = earlyWhales.slice().reverse().map(s => s.signature);

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
          // Whale's TRUE average entry price from the transaction:
          // SOL they spent ÷ tokens they received × SOL/USD.
          // This is always < the post-buy pool price because their buy moved the price up.
          const whaleTxPrice = buy.tokensReceived > 0 && cachedSolPrice > 0
            ? (buy.solSpent * cachedSolPrice) / buy.tokensReceived
            : 0;
          // Store vault addresses from this tx so enterWhalePosition can read
          // the actual on-chain pool reserves without needing DexScreener pool resolution.
          // Update missing fields independently — a later buy can backfill a missing quoteVault.
          const tokEntry = trackedTokens.get(mint);
          if (tokEntry) {
            if (buy.poolBaseVault  && !tokEntry.poolBaseVault)  tokEntry.poolBaseVault  = buy.poolBaseVault;
            if (buy.poolQuoteVault && !tokEntry.poolQuoteVault) tokEntry.poolQuoteVault = buy.poolQuoteVault;
          }
          logger.info(
            { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(0),
              whaleTxPrice, vaults: !!(buy.poolBaseVault && buy.poolQuoteVault), sig: batch[j].slice(0, 12) },
            'Whale sniper: baseline — early whale buy found',
          );
          await handleWhaleBuy(mint, buy.wallet, amountUsd, batch[j], whaleTxPrice);
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

    // Ensure SOL price is fresh before computing whale avg entry price from tx data.
    await fetchSolPrice().catch(() => {});

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
      // Whale's TRUE average entry price from the transaction:
      // SOL they spent ÷ tokens they received × SOL/USD.
      // This is always < the post-buy pool price because their buy moved the price up.
      const whaleTxPrice = buy.tokensReceived > 0 && cachedSolPrice > 0
        ? (buy.solSpent * cachedSolPrice) / buy.tokensReceived
        : 0;
      // Store vault addresses from this tx so enterWhalePosition can read
      // the actual on-chain pool reserves without needing DexScreener pool resolution.
      // Update missing fields independently — a later buy can backfill a missing quoteVault.
      const tokLive = trackedTokens.get(mint);
      if (tokLive) {
        if (buy.poolBaseVault  && !tokLive.poolBaseVault)  tokLive.poolBaseVault  = buy.poolBaseVault;
        if (buy.poolQuoteVault && !tokLive.poolQuoteVault) tokLive.poolQuoteVault = buy.poolQuoteVault;
      }
      logger.info(
        { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(0), whaleTxPrice, sig: toFetch[i].slice(0, 12) },
        'Whale sniper: buy detected',
      );
      await handleWhaleBuy(mint, buy.wallet, amountUsd, toFetch[i], whaleTxPrice);
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
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
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
const VALIDATION_DELAY_MS   = 20_000;      // wait 20s before first quality check
const VALIDATION_TIMEOUT_MS = 5 * 60_000;  // prune if not validated within 5 min of activation (was 60s — too short for PumpSwap pools which take 2-5 min to index on DexScreener)
const VALIDATION_POLL_MS    = 5_000;       // retry DexScreener every 5s during validation

async function activateTrackingNow(mint: string): Promise<void> {
  const pending: PendingGraduation | undefined = pendingGraduations.get(mint);
  if (!pending) return;
  if (trackedTokens.has(mint)) { pendingGraduations.delete(mint); return; }
  // Lifetime guard: never re-track (let alone re-enter) a mint that has ever
  // been traded before, even if it "graduates" again due to a duplicate or
  // re-detected on-chain event.
  if (everTradedMints.has(mint) || slippageSkippedMints.has(mint)) {
    pendingGraduations.delete(mint);
    logger.info({ mint: mint.slice(0, 12) }, 'Whale sniper: ignoring re-graduation of already-traded/slippage-skipped mint');
    return;
  }

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
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
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
        .filter((p: any) => (p.dexId ?? '').toLowerCase() === 'pumpswap')
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
  if (everTradedMints.has(ev.mint) || slippageSkippedMints.has(ev.mint)) {
    logger.debug({ mint: ev.mint.slice(0, 12) }, 'Whale sniper: ignoring graduation of already-traded/slippage-skipped mint');
    return;
  }

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
// ── Session on/off flag + generation token ────────────────────────────────────
// _whaleSniperRunning gates rescheduling. _loopGen is a monotonic counter that
// increments on every stop(); each loop captures its generation at start time
// and bails if the generation has changed — preventing stale callbacks from a
// previous run from spawning a new chain after a resume().
let _whaleSniperRunning = false;
let _loopGen = 0;

function scheduleMarketRefresh(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_whaleSniperRunning || _loopGen !== gen) return;
    try { await refreshTrackedTokensMarketData(); } catch { /* non-fatal */ }
    if (_whaleSniperRunning && _loopGen === gen) scheduleMarketRefresh(gen);
  }, MARKET_REFRESH_MS);
}

// Non-overlapping buy-poll loop: waits for the full sweep (including the
// 300ms per-mint stagger) to finish before scheduling the next one. Using
// setInterval here previously allowed cycles to overlap when a sweep took
// longer than POLL_INTERVAL_MS, causing the same whale buy to be detected
// and entered/alerted twice.
function scheduleBuyPoll(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_whaleSniperRunning || _loopGen !== gen) return;
    try {
      // Skip scanning entirely when outside the trading window
      const s = await getSettings();
      if (isInTradingWindow(s)) {
        pruneExpiredTracking();
        for (const mint of Array.from(trackedTokens.keys())) {
          await pollTokenBuys(mint);
          await new Promise(r => setTimeout(r, 300));
        }
      }
    } catch { /* non-fatal */ }
    if (_whaleSniperRunning && _loopGen === gen) scheduleBuyPoll(gen);
  }, POLL_INTERVAL_MS);
}

// Non-overlapping position monitor loop — same rationale as scheduleBuyPoll.
function schedulePositionMonitor(gen = _loopGen): void {
  setTimeout(async () => {
    if (!_whaleSniperRunning || _loopGen !== gen) return;
    try {
      await monitorPositions();
      broadcastWhaleStatus();
    } catch { /* non-fatal */ }
    if (_whaleSniperRunning && _loopGen === gen) schedulePositionMonitor(gen);
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
  // Only cleared here because this is invoked by the explicit "reset all data"
  // admin action (which also wipes the DB tables) — a real fresh start.
  // Neither set is cleared as a side effect of normal trading.
  everTradedMints.clear();
  slippageSkippedMints.clear();
  // Unsubscribe all Helius WS mints
  for (const mint of Array.from(_mintUnsubscribe.keys())) wsUnsubscribeMint(mint);
  broadcastWhaleStatus();
  logger.info('Whale sniper: state reset (all positions and tracking cleared)');
}

/** Stop all background polling loops. In-flight cycles finish gracefully. */
export function stopWhaleSniper(): void {
  if (!_whaleSniperRunning) return;
  _whaleSniperRunning = false;
  _loopGen++; // invalidate any pending setTimeout callbacks from the old generation
  // Unsubscribe all per-mint Helius WS watchers
  for (const mint of Array.from(_mintUnsubscribe.keys())) wsUnsubscribeMint(mint);
  logger.info('Whale sniper: stopped (polling loops will not reschedule)');
}

/** Resume polling loops after a stopWhaleSniper() call. Does NOT reload DB state. */
export function resumeWhaleSniper(): void {
  if (_whaleSniperRunning) return;
  _whaleSniperRunning = true;
  scheduleBuyPoll();
  schedulePositionMonitor();
  scheduleMarketRefresh();
  void fetchSolPrice();
  if (isHeliusWsConfigured()) {
    connectWhaleWs();
  }
  logger.info('Whale sniper: resumed');
}

export async function startWhaleSniper(): Promise<void> {
  logger.info('Whale sniper: started (paper mode — following pump.fun graduations)');

  // Await both lifetime-block registries before enabling any entry flow so there
  // is no window where a previously blocked mint could slip through on startup.
  await Promise.all([
    loadTradedMintsFromDB(),
    loadSlippageSkippedMintsFromDB(),
  ]);
  void restoreWhalePositionsFromDB();

  _whaleSniperRunning = true;
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
