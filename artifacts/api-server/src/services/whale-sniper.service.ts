import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { broadcast } from '../websocket/server.js';
import { getBalance, setBalance, getSettings } from './settings.service.js';
import { notifyWhaleTrade, notifyWhaleSkip } from '../lib/telegram.js';
import { query } from '../lib/db.js';

const MAX_TRACKING_MS       = 30 * 60 * 1_000;
const MAX_POSITIONS         = 10;
const POLL_INTERVAL_MS      = 5_000;
const PRICE_CHECK_MS        = 3_000;
const SOL_PRICE_TTL_MS      = 60_000;
const MAX_BUY_LOG           = 100;
const DEX_BASE              = 'https://api.dexscreener.com';
const WSOL_MINT             = 'So11111111111111111111111111111111111111112';

// Post-graduation pool wait settings
const POOL_WAIT_POLL_MS     = 15_000;  // check DexScreener every 15s
const POOL_WAIT_TIMEOUT_MS  = 10 * 60_000; // give up after 10 min
const MIN_POOL_LIQUIDITY    = 1_000;   // require at least $1k liquidity to activate

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
  entryTime: number;
  sizeSol: number;
  sizePct: number;
  peakPrice: number;
  lastPrice: number;
  lastLiquidity: number;
  baselineLiquidity: number;
  migrationTime: number;
  pnlPct: number;
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

// ── In-memory state ───────────────────────────────────────────────────────────

const pendingGraduations = new Map<string, PendingGraduation>();
const trackedTokens  = new Map<string, TrackedToken>();
const whalePositions = new Map<string, WhalePosition>();
const buyLog: WhaleBuyLog[] = [];
const signalQueue: PendingSignal[] = [];
const closedPositions: ClosedWhalePosition[] = [];
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

async function fetchSolPrice(): Promise<void> {
  if (Date.now() - lastSolPriceFetch < SOL_PRICE_TTL_MS) return;
  try {
    const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${WSOL_MINT}`, { timeout: 5_000 });
    const pairs: any[] = r.data?.pairs ?? [];
    const pair  = pairs.find((p: any) => ['USDC', 'USDT'].includes(p.quoteToken?.symbol)) ?? pairs[0];
    const price = parseFloat(pair?.priceUsd ?? '0');
    if (price > 10) { cachedSolPrice = price; lastSolPriceFetch = Date.now(); }
  } catch { /* keep cached value */ }
}

// ── Fetch token price from DexScreener ────────────────────────────────────────

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

  const spent = (preSol[0] ?? 0) - (postSol[0] ?? 0);
  if (spent < 10_000) return null;

  const wallet = keys[0]?.pubkey?.toString() ?? keys[0]?.toString() ?? 'unknown';
  return { wallet, solSpent: spent / 1e9 };
}

// ── DB persistence (survives Render free-tier spin-down / restarts) ───────────

async function saveWhalePosition(pos: WhalePosition): Promise<void> {
  try {
    await query(
      `INSERT INTO whale_positions
        (id, mint, name, symbol, entry_price, entry_time, size_sol, size_pct,
         peak_price, last_price, last_liquidity, baseline_liquidity, migration_time, pnl_pct, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'OPEN')
       ON CONFLICT (id) DO UPDATE SET
         peak_price = EXCLUDED.peak_price,
         last_price = EXCLUDED.last_price,
         last_liquidity = EXCLUDED.last_liquidity,
         pnl_pct = EXCLUDED.pnl_pct`,
      [pos.id, pos.mint, pos.name, pos.symbol, pos.entryPrice, pos.entryTime, pos.sizeSol, pos.sizePct,
       pos.peakPrice, pos.lastPrice, pos.lastLiquidity, pos.baselineLiquidity, pos.migrationTime, pos.pnlPct],
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
      const pos: WhalePosition = {
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: Number(r.entry_price), entryTime: Number(r.entry_time),
        sizeSol: Number(r.size_sol), sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
      };
      whalePositions.set(pos.mint, pos);
    }
    const closedRows = await query<any>(
      `SELECT * FROM whale_positions WHERE status = 'CLOSED' ORDER BY close_time DESC LIMIT 20`,
    );
    for (const r of closedRows) {
      closedPositions.push({
        id: r.id, mint: r.mint, name: r.name, symbol: r.symbol,
        entryPrice: Number(r.entry_price), entryTime: Number(r.entry_time),
        sizeSol: Number(r.size_sol), sizePct: Number(r.size_pct),
        peakPrice: Number(r.peak_price), lastPrice: Number(r.last_price),
        lastLiquidity: Number(r.last_liquidity), baselineLiquidity: Number(r.baseline_liquidity),
        migrationTime: Number(r.migration_time), pnlPct: Number(r.pnl_pct),
        closeTime: Number(r.close_time), closeReason: r.close_reason ?? '', closePnlPct: Number(r.close_pnl_pct ?? 0),
      });
    }
    if (rows.length > 0 || closedRows.length > 0) {
      logger.info({ open: rows.length, closed: closedRows.length }, 'Whale sniper: restored positions from DB after restart');
    }
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
  if (whalePositions.has(mint)) return;

  // Fetch current price & liquidity
  const { price: entryPrice, liquidity, name: dexName, symbol: dexSymbol } = await fetchTokenPrice(mint);

  if (entryPrice === 0) {
    logger.warn({ mint }, 'Whale sniper: no price available at entry — skipped');
    return;
  }

  // Enrich name/symbol from DexScreener if still placeholder
  const tok = trackedTokens.get(mint);
  if (tok) {
    if (tok.name.endsWith('…') || !tok.symbol) {
      tok.name   = dexName   || tok.name;
      tok.symbol = dexSymbol || tok.symbol;
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

  const balance = await getBalance().catch(() => 10);
  const sizeSol = balance * (sizePct / 100);

  const pos: WhalePosition = {
    id: `${mint}-${Date.now()}`,
    mint, name, symbol,
    entryPrice, entryTime: Date.now(),
    sizeSol, sizePct,
    peakPrice: entryPrice,
    lastPrice: entryPrice,
    lastLiquidity: liquidity,
    baselineLiquidity: liquidity > 0 ? liquidity : 1,
    migrationTime: trackedTokens.get(mint)?.migrationTime ?? Date.now(),
    pnlPct: 0,
  };

  whalePositions.set(mint, pos);
  void saveWhalePosition(pos);

  if (tok) tok.entryTriggered = true;

  await setBalance(Math.max(0, balance - sizeSol)).catch(() => {});

  logger.info(
    { mint, symbol, sizePct, sizeSol: sizeSol.toFixed(3), entryPrice, trigger: triggerAmountUsd.toFixed(0) },
    'Whale sniper: ENTERED',
  );

  notifyWhaleTrade({
    name, symbol, mint,
    whaleAmountUsd: triggerAmountUsd,
    sizePct, sizeSol, entryPrice,
    whalePriceAtDetection: priceAtDetection,
    slippagePct: maxSlippage,
    whaleWallet,
  }).catch(() => {});

  broadcastWhaleStatus();
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
  const conn = getConn();
  const pk   = new PublicKey(mint);

  if (!seenTxns.has(mint)) seenTxns.set(mint, new Set());
  const seen = seenTxns.get(mint)!;

  try {
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 20 });
    if (!sigs.length) return;

    // First poll: baseline — mark all existing sigs as seen
    if (!mintCheckpointed.has(mint)) {
      mintCheckpointed.add(mint);
      for (const s of sigs) seen.add(s.signature);
      return;
    }

    const newSigs = sigs
      .filter(s => !seen.has(s.signature) && !s.err)
      .map(s => s.signature);

    for (const s of newSigs) seen.add(s);
    if (newSigs.length === 0) return;

    await fetchSolPrice();

    // Fetch current token price for slippage reference
    let currentPrice = 0;
    try {
      const r     = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 5_000 });
      const pairs: any[] = (r.data?.pairs ?? []).sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      currentPrice = parseFloat(pairs[0]?.priceUsd ?? '0');
    } catch { /* use 0 as fallback */ }

    // Fetch up to 5 new txns in parallel
    const toFetch = newSigs.slice(0, 5);
    const txns    = await Promise.all(
      toFetch.map(sig =>
        conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }).catch(() => null),
      ),
    );

    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      if (!tx) continue;
      const buy = detectBuy(tx, mint);
      if (!buy) continue;
      const amountUsd = buy.solSpent * cachedSolPrice;
      logger.info(
        { mint: mint.slice(0, 12), wallet: buy.wallet.slice(0, 8), usd: amountUsd.toFixed(0), sig: toFetch[i].slice(0, 12) },
        'Whale sniper: buy detected',
      );
      await handleWhaleBuy(mint, buy.wallet, amountUsd, toFetch[i], currentPrice);
    }
  } catch (err: any) {
    logger.debug({ mint: mint.slice(0, 12), err: err?.message }, 'Whale sniper: poll error');
  }
}

// ── Position exit monitoring ──────────────────────────────────────────────────

async function closeWhalePosition(pos: WhalePosition, reason: string): Promise<void> {
  whalePositions.delete(pos.mint);

  const pnlPct  = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const pnlSol  = pos.sizeSol * (pnlPct / 100);
  const newBal  = (await getBalance().catch(() => 0)) + pos.sizeSol + pnlSol;
  await setBalance(Math.max(0, newBal)).catch(() => {});

  closedPositions.unshift({ ...pos, closeTime: Date.now(), closeReason: reason, closePnlPct: pnlPct });
  if (closedPositions.length > 100) closedPositions.pop();
  void closeWhalePositionInDB(pos.id, reason, pnlPct);

  logger.info({ mint: pos.mint, symbol: pos.symbol, pnlPct: pnlPct.toFixed(1), reason }, 'Whale sniper: CLOSED');
  broadcastWhaleStatus();
  await processQueue();
}

async function monitorPositions(): Promise<void> {
  const mints = Array.from(whalePositions.keys());
  if (mints.length === 0) return;

  try {
    const r      = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mints.slice(0, 30).join(',')}`, { timeout: 8_000 });
    const pairs: any[] = r.data?.pairs ?? [];

    for (const pos of Array.from(whalePositions.values())) {
      const best = (pairs as any[])
        .filter((p: any) => p.baseToken?.address === pos.mint)
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

      if (!best) continue;
      const price     = parseFloat(best.priceUsd ?? '0');
      const liquidity = best.liquidity?.usd ?? 0;
      if (price <= 0) continue;

      pos.lastPrice     = price;
      pos.lastLiquidity = liquidity;
      pos.pnlPct        = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (price > pos.peakPrice) pos.peakPrice = price;
      void saveWhalePosition(pos);

      // TP: +100%
      if (price >= pos.entryPrice * 2) {
        await closeWhalePosition(pos, '+100% take profit');
        continue;
      }

      // SL: price dropped -30% from entry
      if (price <= pos.entryPrice * (1 - PRICE_SL_PCT)) {
        await closeWhalePosition(pos, `-${(PRICE_SL_PCT * 100).toFixed(0)}% stop loss`);
        continue;
      }

      // Emergency: liq dropped >40%
      if (pos.baselineLiquidity > 1 && liquidity > 0) {
        const drop = (pos.baselineLiquidity - liquidity) / pos.baselineLiquidity;
        if (drop > 0.4) {
          await closeWhalePosition(pos, `Liquidity -${(drop * 100).toFixed(0)}% emergency exit`);
          continue;
        }
      }

      // Emergency: liq at zero
      if (liquidity === 0 && pos.baselineLiquidity > 1) {
        await closeWhalePosition(pos, 'Liquidity $0 — emergency exit');
        continue;
      }

      // Time exit: 30min from migration
      if (pos.migrationTime && Date.now() - pos.migrationTime > MAX_TRACKING_MS) {
        await closeWhalePosition(pos, '30min from migration — time exit');
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
    const pos = whalePositions.get(mint);
    if (pos) {
      pos.lastPrice = pos.lastPrice || pos.entryPrice;
      closeWhalePosition(pos, '30min window expired').catch(() => {});
    }
  }
  const keep = signalQueue.filter(s => trackedTokens.has(s.mint));
  signalQueue.splice(0, signalQueue.length, ...keep);
}

// ── Wait for post-graduation pool to go live, then activate tracking ──────────

async function waitForPoolAndActivate(mint: string): Promise<void> {
  // Capture identity reference — used to detect if this mint was re-added after removal.
  // Assigned to a typed non-optional local so TypeScript can narrow it inside closures.
  const pending: PendingGraduation | undefined = pendingGraduations.get(mint);
  if (!pending) return;
  const capturedPending: PendingGraduation = pending;

  const deadline = capturedPending.detectedAt + POOL_WAIT_TIMEOUT_MS;

  // Helper: check DexScreener once and activate if pool is live; returns true if activated
  async function checkAndActivate(): Promise<boolean> {
    // Guard: bail if this specific pending entry was replaced or removed
    if (pendingGraduations.get(mint) !== capturedPending) return false;
    if (trackedTokens.has(mint)) { pendingGraduations.delete(mint); return true; }

    try {
      const r = await axios.get<any>(`${DEX_BASE}/latest/dex/tokens/${mint}`, { timeout: 8_000 });
      const allPairs: any[] = r.data?.pairs ?? [];

      // Exclude only the pump.fun bonding-curve pair itself — "pumpswap" IS the
      // post-graduation AMM and must NOT be filtered out (its dexId also contains "pump").
      const postGradPairs = allPairs
        .filter((p: any) => (p.dexId ?? '').toLowerCase() !== 'pumpfun')
        .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

      if (postGradPairs.length === 0) {
        logger.debug({ mint: mint.slice(0, 12) }, 'Whale sniper: no post-grad pairs yet — retrying');
        return false;
      }

      const best      = postGradPairs[0];
      const liquidity = best?.liquidity?.usd ?? 0;

      if (liquidity < MIN_POOL_LIQUIDITY) {
        logger.debug(
          { mint: mint.slice(0, 12), dex: best?.dexId, liq: liquidity.toFixed(0) },
          'Whale sniper: pool found but liquidity too low — retrying',
        );
        return false;
      }

      // Pool is confirmed live — activate tracking with real metadata
      const poolAddress    = best?.pairAddress ?? capturedPending.poolAddress;
      const name           = best?.baseToken?.name   || mint.slice(0, 6) + '…';
      const symbol         = best?.baseToken?.symbol || mint.slice(0, 5).toUpperCase();

      // Final identity check before mutation
      if (pendingGraduations.get(mint) !== capturedPending) return false;
      pendingGraduations.delete(mint);

      trackedTokens.set(mint, {
        mint,
        name,
        symbol,
        poolAddress,
        migrationTime:  capturedPending.detectedAt,
        expiresAt:      capturedPending.detectedAt + MAX_TRACKING_MS,
        entryTriggered: false,
        whaleBuys:      [],
        // Market data from the activation fetch
        price:          parseFloat(best?.priceUsd ?? '0'),
        mcap:           best?.marketCap ?? best?.fdv ?? 0,
        liquidity,
        priceChange5m:  best?.priceChange?.m5 ?? 0,
        priceChange1h:  best?.priceChange?.h1 ?? 0,
        volume5m:       best?.volume?.m5       ?? 0,
        lastMarketUpdate: Date.now(),
      });
      seenTxns.set(mint, new Set());

      logger.info(
        {
          mint:    mint.slice(0, 12),
          symbol,
          dex:     best?.dexId,
          pool:    poolAddress?.slice(0, 16),
          liq:     liquidity.toFixed(0),
          waitSec: Math.round((Date.now() - capturedPending.detectedAt) / 1_000),
        },
        'Whale sniper: post-grad pool confirmed — tracking activated',
      );
      broadcastWhaleStatus();
      return true;
    } catch (err: any) {
      logger.debug({ mint: mint.slice(0, 12), err: err?.message }, 'Whale sniper: pool-ready check error');
      return false;
    }
  }

  // First check immediately (pool may already be live if graduation was slightly delayed)
  if (await checkAndActivate()) return;

  // Then poll every POOL_WAIT_POLL_MS until deadline
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POOL_WAIT_POLL_MS));
    // Guard: entry was removed by pruner or re-added (different identity)
    if (pendingGraduations.get(mint) !== capturedPending) return;
    if (await checkAndActivate()) return;
  }

  // Timed out without finding a live pool
  if (pendingGraduations.get(mint) === capturedPending) {
    pendingGraduations.delete(mint);
    logger.warn({ mint: mint.slice(0, 12) }, 'Whale sniper: no live pool found within timeout — discarding');
    broadcastWhaleStatus();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function addGraduatedToken(ev: { mint: string; poolAddress?: string; ts: number }): void {
  if (trackedTokens.has(ev.mint) || pendingGraduations.has(ev.mint)) return;

  pendingGraduations.set(ev.mint, {
    mint:       ev.mint,
    poolAddress: ev.poolAddress,
    detectedAt: ev.ts,
  });

  logger.info(
    { mint: ev.mint.slice(0, 16), pool: ev.poolAddress?.slice(0, 16) },
    'Whale sniper: graduation detected — waiting for post-grad pool to go live',
  );
  broadcastWhaleStatus();

  // Start background wait — activates trackedTokens only once pool is live
  void waitForPoolAndActivate(ev.mint);
}

export function getWhaleStatus() {
  return {
    trackedTokens:    Array.from(trackedTokens.values()),
    openPositions:    Array.from(whalePositions.values()),
    closedPositions:  closedPositions.slice(0, 20),
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
      if (d.price > 0) {
        tok.price            = d.price;
        tok.mcap             = d.mcap;
        tok.liquidity        = d.liquidity;
        tok.priceChange5m    = d.priceChange5m;
        tok.priceChange1h    = d.priceChange1h;
        tok.volume5m         = d.volume5m;
        tok.lastMarketUpdate = Date.now();
        // Backfill poolAddress from DexScreener if we didn't have it
        if (!tok.poolAddress && d.pairAddress) tok.poolAddress = d.pairAddress;
        updated = true;
      }
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

export function startWhaleSniper(): void {
  logger.info('Whale sniper: started (paper mode — following pump.fun graduations)');

  void restoreWhalePositionsFromDB();

  setInterval(async () => {
    pruneExpiredTracking();
    for (const mint of Array.from(trackedTokens.keys())) {
      await pollTokenBuys(mint);
      await new Promise(r => setTimeout(r, 300));
    }
  }, POLL_INTERVAL_MS);

  setInterval(async () => {
    await monitorPositions();
    broadcastWhaleStatus();
  }, PRICE_CHECK_MS);

  // Non-overlapping market data refresh for tracked tokens
  scheduleMarketRefresh();

  void fetchSolPrice();
}
