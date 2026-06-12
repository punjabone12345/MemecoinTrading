import axios, { AxiosError } from "axios";
import { solanaWalletService } from "./solana-wallet.service.js";
import { logger } from "../lib/logger.js";

// Jupiter Lite API — free, no auth, current as of 2025
// NEVER use quote-api.jup.ag — that domain is dead (ENOTFOUND)
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://lite-api.jup.ag/swap/v1/swap";
const SOL_MINT          = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL  = 1_000_000_000;

// Slippage tolerance written into the swap instruction's otherAmountThreshold.
// This is NOT the slippage you actually experience — it is the worst-case floor
// the transaction will accept. The quoted price already reflects the real pool
// state, so fills are always much closer to the quote. The wide floor ensures
// that concurrent bot activity between quote and execution cannot cause Custom:1.
//
// Example: 0.1 SOL buy on a 79 SOL graduation pool has ~0.13% price impact.
// Even if 20 bots each buy 0.1 SOL before us, cumulative impact ≈ 2.5%.
// With SWAP_SLIPPAGE_BPS=5000, threshold = quoteOutput * 0.50, so the TX
// succeeds as long as we receive ≥50% of the quoted amount (we always do).
//
// WHY NOT dynamicSlippage:
// dynamicSlippage simulates at quote time and selects a tight value (e.g. 5%).
// When other bots buy between simulation and our tx landing, that 5% is easily
// breached → Custom:1. Fixed high slippage is simpler and more reliable here.
const SWAP_SLIPPAGE_BPS           = 5000; // normal buy/sell: 50% worst-case floor
const EMERGENCY_SWAP_SLIPPAGE_BPS = 7000; // emergency sell: 70% — last-resort exit

// ── Jupiter request rate limiter ──────────────────────────────────────────────
// Jupiter Lite has a rate limit of ~60 req/min on lite-api.jup.ag.
// This limiter enforces a minimum gap between consecutive requests so we never
// exceed ~40 req/min (well under the limit), even during multi-position activity.
// A paused flag is set when a 429 is detected, blocking all requests until the
// cool-off period expires (respects Retry-After header or defaults to 15s).
//
// NOTE: This only throttles SWAP requests (quote + swap).
// Price monitoring has been moved to DexScreener and no longer hits this API.
class JupiterRateLimiter {
  private lastRequestAt  = 0;
  private pausedUntil    = 0;
  private readonly minGapMs = 400; // max ~40 req/min (conservative under 60 limit)

  async throttle(): Promise<void> {
    const now = Date.now();
    if (now < this.pausedUntil) {
      const wait = this.pausedUntil - now;
      logger.warn({ wait }, "Jupiter rate limiter: paused — waiting out cool-off");
      await new Promise(r => setTimeout(r, wait));
    }
    const gap = Date.now() - this.lastRequestAt;
    if (gap < this.minGapMs) {
      await new Promise(r => setTimeout(r, this.minGapMs - gap));
    }
    this.lastRequestAt = Date.now();
  }

  pause429(retryAfterSeconds?: number): void {
    const pauseMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 15_000;
    this.pausedUntil = Date.now() + pauseMs;
    logger.warn({ pauseMs }, "Jupiter rate limiter: 429 received — all requests paused");
  }
}

const jupiterRateLimiter = new JupiterRateLimiter();

export interface BuyResult {
  txSignature: string;
  tokenAmount: number;
  solSpent: number;
  attempt: number;
}

export interface SellResult {
  txSignature: string;
  solReceived: number;
  attempt: number;
}

// ── Pre-flight validation ─────────────────────────────────────────────────────
// Catches invalid params BEFORE hitting the Jupiter API, preventing confusing
// "amount too small" or "NaN" errors that waste retries.
function validateBuyParams(tokenMint: string, solAmount: number, slippageBps: number, priorityFeeLamports: number): void {
  if (!tokenMint || tokenMint.length < 32) {
    throw new Error(`Pre-flight: invalid tokenMint "${tokenMint}"`);
  }
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    throw new Error(`Pre-flight: invalid solAmount ${solAmount} — must be a positive number`);
  }
  if (solAmount < 0.0001) {
    throw new Error(`Pre-flight: solAmount ${solAmount} SOL is below minimum (0.0001 SOL)`);
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 50 || slippageBps > 5000) {
    throw new Error(`Pre-flight: slippageBps ${slippageBps} out of range [50, 5000]`);
  }
  if (!Number.isFinite(priorityFeeLamports) || priorityFeeLamports < 0) {
    throw new Error(`Pre-flight: invalid priorityFeeLamports ${priorityFeeLamports}`);
  }
}

function validateSellParams(tokenMint: string, tokenAmount: number, slippageBps: number, priorityFeeLamports: number): void {
  if (!tokenMint || tokenMint.length < 32) {
    throw new Error(`Pre-flight: invalid tokenMint "${tokenMint}"`);
  }
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    throw new Error(`Pre-flight: invalid tokenAmount ${tokenAmount} — must be a positive number`);
  }
  if (!Number.isFinite(slippageBps) || slippageBps < 50 || slippageBps > 10000) {
    throw new Error(`Pre-flight: slippageBps ${slippageBps} out of range [50, 10000]`);
  }
  if (!Number.isFinite(priorityFeeLamports) || priorityFeeLamports < 0) {
    throw new Error(`Pre-flight: invalid priorityFeeLamports ${priorityFeeLamports}`);
  }
}

// ── Slippage error detection ──────────────────────────────────────────────────
// Two different Raydium programs surface ExceededSlippage under different codes:
//   Custom:6024 — Raydium AMM v4 (sell-side, most common on established pools)
//   Custom:1    — Raydium CPMM (buy AND sell; pump.fun graduates use CPMM)
// Both are recoverable by widening slippage on retry.
function classifyError(err: unknown): { isSlippageError: boolean; isDeadPool: boolean; msg: string } {
  const msg = String((err as Error).message ?? err ?? "unknown");
  // Custom:6024 = Raydium AMM v4 ExceededSlippage
  // Custom:1 in a Raydium CPMM instruction = ExceededSlippage (buy or sell)
  // Match {"Custom":1} or {"Custom":1, ...} but NOT Custom:10/100/1000/6024 etc.
  const hasCustom1 = /"Custom"\s*:\s*1[^0-9]/.test(msg) || /\bCustom:1\b/.test(msg);
  const isSlippageError = msg.includes("Custom:6024") || msg.includes("ExceededSlippage") || msg.includes("6024") || hasCustom1;
  // Dead pool = slippage + multiple fails + "insufficient liquidity" hints
  const isDeadPool = isSlippageError && (msg.includes("liquidity") || msg.includes("pool"));
  return { isSlippageError, isDeadPool, msg };
}

// ── Retry helper ──────────────────────────────────────────────────────────────
async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 5,
  baseDelayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const axErr = err as AxiosError;
      const status = axErr.response?.status ?? 0;
      const { isSlippageError, msg } = classifyError(err);

      if (isSlippageError) {
        logger.warn({ label, attempt, maxAttempts, msg },
          `Jupiter: Custom:6024 ExceededSlippage — attempt ${attempt}/${maxAttempts} (widening slippage on retry)`);
      } else {
        logger.warn({ label, attempt, maxAttempts, status, msg },
          `Jupiter: attempt ${attempt}/${maxAttempts} failed — ${msg}`);
      }

      if (attempt < maxAttempts) {
        let delay: number;
        if (status === 429) {
          const retryAfter = Number(axErr.response?.headers?.["retry-after"] ?? 0);
          jupiterRateLimiter.pause429(retryAfter > 0 ? retryAfter : undefined);
          delay = retryAfter > 0
            ? retryAfter * 1000
            : Math.min(baseDelayMs * Math.pow(2, attempt - 1), 30_000);
          logger.warn({ label, delay, retryAfter }, `Jupiter: 429 rate limit — waiting ${delay}ms`);
        } else {
          delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), 15_000);
          logger.info({ label, delay, isSlippageError }, `Jupiter: waiting ${delay}ms before retry`);
        }
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

class JupiterSwapService {
  private async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number,
  ): Promise<unknown> {
    await jupiterRateLimiter.throttle();
    const res = await axios.get(JUPITER_QUOTE_URL, {
      params: {
        inputMint,
        outputMint,
        amount,
        slippageBps,
        // NOTE: maxAccounts removed — the hard limit of 50 forced Jupiter to
        // pick sub-optimal routes on new CPMM pools, causing failed swaps.
        // Jupiter handles tx-size limits internally; trust it to pick a valid route.
      },
      timeout: 10_000,
    });
    return res.data;
  }

  private async getSwapTx(
    quoteResponse: unknown,
    priorityFeeLamports: number,
    swapSlippageBps = SWAP_SLIPPAGE_BPS,
  ): Promise<string> {
    await jupiterRateLimiter.throttle();
    // slippageBps here sets otherAmountThreshold = quoteOutput * (1 - bps/10000).
    // We use a fixed 50% floor so concurrent bot buys between quote and execution
    // can't breach the threshold. In practice fills are always near the quote price.
    //
    // DO NOT add dynamicSlippage — it simulates at call time and picks a tight
    // value (~5%). Other bots buying between simulation and landing breach that
    // tight threshold → Custom:1 again. Fixed wide slippage eliminates this.
    //
    // DO NOT add skipUserAccountsRpcCalls — it skips ATA creation for tokens the
    // wallet has never held, producing "encoding overruns Uint8Array" on first buy.
    const body: Record<string, unknown> = {
      quoteResponse,
      userPublicKey:             solanaWalletService.publicKey,
      wrapAndUnwrapSol:          true,
      dynamicComputeUnitLimit:   true,
      prioritizationFeeLamports: priorityFeeLamports,
      slippageBps:               swapSlippageBps,
    };
    const res = await axios.post(JUPITER_SWAP_URL, body, { timeout: 15_000 });
    return res.data.swapTransaction as string;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  // Retries quote+build up to 5 times (fresh graduates take 2-5s to appear in Jupiter).
  // Uses signAndSendAndConfirm so the position is ONLY recorded after the TX lands on-chain.
  //
  // Quote slippageBps is only for route-finding (wider = more routes considered).
  // The swap body uses SWAP_SLIPPAGE_BPS (50%) as a fixed floor for
  // otherAmountThreshold — eliminates Custom:1 from bot race conditions.
  async buy(
    tokenMint: string,
    solAmount: number,
    slippageBps: number,
    priorityFeeLamports: number,
  ): Promise<BuyResult> {
    if (!solanaWalletService.isReady) {
      throw new Error("Wallet not configured — set SOLANA_PRIVATE_KEY env var");
    }

    // Pre-flight: validate all params before touching Jupiter API
    validateBuyParams(tokenMint, solAmount, slippageBps, priorityFeeLamports);

    const amountLamports = Math.round(solAmount * LAMPORTS_PER_SOL);

    // Use Helius-estimated priority fee if available (p75 of recent slots).
    // Falls back to caller's value when Helius is not configured.
    const optimalFee = await solanaWalletService.getOptimalPriorityFee(priorityFeeLamports);

    return withRetry(`buy:${tokenMint.slice(0, 8)}`, async (attempt) => {
      // Quote slippage is only for route-finding — Jupiter finds more routes with
      // wider values. The actual threshold is set in getSwapTx via SWAP_SLIPPAGE_BPS.
      const wideningBps       = (attempt - 1) * 1000;
      const effectiveSlippage = Math.min(slippageBps + wideningBps, 9000);
      logger.info({
        tokenMint, solAmount,
        quoteSlippageBps:  effectiveSlippage,
        swapSlippageBps:   SWAP_SLIPPAGE_BPS,
        optimalFee,
        attempt,
      }, `Jupiter: buy attempt ${attempt} — quoting at ${effectiveSlippage} bps, swap threshold at ${SWAP_SLIPPAGE_BPS} bps`);

      const quote = await this.getQuote(SOL_MINT, tokenMint, amountLamports, effectiveSlippage);
      const q = quote as Record<string, string | number>;
      logger.info({
        tokenMint, attempt,
        priceImpactPct: q["priceImpactPct"],
        outAmount:      q["outAmount"],
      }, "Jupiter: buy quote received");

      const swapTx      = await this.getSwapTx(quote, optimalFee);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const tokenAmount = Number(q["outAmount"]);
      const solSpent    = Number(q["inAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, solSpent, tokenAmount, txSignature, attempt, optimalFee }, "Jupiter: buy confirmed on-chain ✅");
      return { txSignature, tokenAmount, solSpent, attempt };
    }, 5, 800);
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // Retries up to 3 times with widening quote slippage for route-finding.
  // Swap body uses SWAP_SLIPPAGE_BPS (50%) fixed floor — no dynamicSlippage.
  async sell(
    tokenMint: string,
    tokenAmount: number,
    slippageBps: number,
    priorityFeeLamports: number,
  ): Promise<SellResult> {
    if (!solanaWalletService.isReady) {
      throw new Error("Wallet not configured — set SOLANA_PRIVATE_KEY env var");
    }

    const amountRaw = Math.floor(tokenAmount);
    if (amountRaw <= 0) throw new Error("Nothing to sell — token amount is zero");

    validateSellParams(tokenMint, amountRaw, slippageBps, priorityFeeLamports);

    const optimalFee = await solanaWalletService.getOptimalPriorityFee(priorityFeeLamports);

    return withRetry(`sell:${tokenMint.slice(0, 8)}`, async (attempt) => {
      const wideningBps       = (attempt - 1) * 1500;
      const effectiveSlippage = Math.min(slippageBps + wideningBps, 9000);
      logger.info({
        tokenMint, tokenAmount: amountRaw,
        quoteSlippageBps: effectiveSlippage,
        swapSlippageBps:  SWAP_SLIPPAGE_BPS,
        optimalFee,
        attempt,
      }, `Jupiter: sell attempt ${attempt} — quoting at ${effectiveSlippage} bps, swap threshold at ${SWAP_SLIPPAGE_BPS} bps`);

      const quote = await this.getQuote(tokenMint, SOL_MINT, amountRaw, effectiveSlippage);
      const q     = quote as Record<string, string | number>;
      logger.info({
        tokenMint, attempt,
        priceImpactPct: q["priceImpactPct"],
        outAmount:      q["outAmount"],
      }, "Jupiter: sell quote received");

      const swapTx      = await this.getSwapTx(quote, optimalFee);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const solReceived = Number(q["outAmount"]) / LAMPORTS_PER_SOL;
      logger.info({ tokenMint, tokenAmount: amountRaw, solReceived, txSignature, attempt, optimalFee }, "Jupiter: sell ✅");
      return { txSignature, solReceived, attempt };
    }, 3, 1000);
  }

  // ── EMERGENCY SELL ────────────────────────────────────────────────────────
  // Used for stuck positions — EMERGENCY_SWAP_SLIPPAGE_BPS (70%) floor + elevated priority fee.
  async emergencySell(
    tokenMint: string,
    tokenAmount: number,
    priorityFeeLamports: number,
  ): Promise<SellResult> {
    if (!solanaWalletService.isReady) {
      throw new Error("Wallet not configured — set SOLANA_PRIVATE_KEY env var");
    }

    const amountRaw = Math.floor(tokenAmount);
    if (amountRaw <= 0) throw new Error("Nothing to sell — token amount is zero");

    const emergencyQuoteSlippage = 9000; // wide quote slippage so Jupiter finds ANY route
    const emergencyPriorityFee   = Math.max(priorityFeeLamports, 2_000_000); // min 0.002 SOL

    logger.warn({ tokenMint, amountRaw, emergencyQuoteSlippage, emergencyPriorityFee, swapSlippageBps: EMERGENCY_SWAP_SLIPPAGE_BPS }, "Jupiter: EMERGENCY SELL — 70% swap threshold floor");

    return withRetry(`emergency-sell:${tokenMint.slice(0, 8)}`, async (attempt) => {
      const quote       = await this.getQuote(tokenMint, SOL_MINT, amountRaw, emergencyQuoteSlippage);
      const swapTx      = await this.getSwapTx(quote, emergencyPriorityFee, EMERGENCY_SWAP_SLIPPAGE_BPS);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const q           = quote as Record<string, string>;
      const solReceived = Number(q["outAmount"]) / LAMPORTS_PER_SOL;
      logger.info({ tokenMint, amountRaw, solReceived, txSignature, attempt }, "Jupiter: emergency sell confirmed ✅");
      return { txSignature, solReceived, attempt };
    }, 2, 3000);
  }
}

export const jupiterSwapService = new JupiterSwapService();
