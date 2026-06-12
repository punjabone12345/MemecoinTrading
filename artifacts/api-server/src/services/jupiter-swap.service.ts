import axios, { AxiosError } from "axios";
import { solanaWalletService } from "./solana-wallet.service.js";
import { logger } from "../lib/logger.js";

// Jupiter Lite API — free, no auth, current as of 2025
// NEVER use quote-api.jup.ag — that domain is dead (ENOTFOUND)
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://lite-api.jup.ag/swap/v1/swap";
const SOL_MINT          = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL  = 1_000_000_000;

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

// ── Custom:6024 detection ─────────────────────────────────────────────────────
// Custom program error 6024 on Raydium = "ExceededSlippage" — the swap failed
// because the market moved beyond the slippage tolerance. This is recoverable by
// widening slippage on retry (which withRetry does). We surface it clearly.
function classifyError(err: unknown): { isSlippageError: boolean; isDeadPool: boolean; msg: string } {
  const msg = String((err as Error).message ?? err ?? "unknown");
  const isSlippageError = msg.includes("Custom:6024") || msg.includes("ExceededSlippage") || msg.includes("6024");
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
      params: { inputMint, outputMint, amount, slippageBps },
      timeout: 10_000,
    });
    return res.data;
  }

  private async getSwapTx(
    quoteResponse: unknown,
    priorityFeeLamports: number,
    slippageBps?: number,
  ): Promise<string> {
    await jupiterRateLimiter.throttle();
    // slippageBps is passed explicitly so Jupiter's /swap endpoint uses it to
    // recompute otherAmountThreshold from the WIDENED value, not from whatever
    // is baked into the quoteResponse or a server-side default.
    const body: Record<string, unknown> = {
      quoteResponse,
      userPublicKey:             solanaWalletService.publicKey,
      wrapAndUnwrapSol:          true,
      dynamicComputeUnitLimit:   true,
      prioritizationFeeLamports: priorityFeeLamports,
    };
    if (slippageBps !== undefined) {
      body["slippageBps"] = slippageBps;
    }
    const res = await axios.post(JUPITER_SWAP_URL, body, { timeout: 15_000 });
    return res.data.swapTransaction as string;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  // Retries quote+build up to 3 times (fresh graduates take 2-5s to appear in Jupiter).
  // Uses signAndSendAndConfirm so the position is ONLY recorded after the TX lands on-chain.
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

    return withRetry(`buy:${tokenMint.slice(0, 8)}`, async (attempt) => {
      logger.info({ tokenMint, solAmount, slippageBps, attempt }, "Jupiter: getting buy quote");

      const quote       = await this.getQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);
      const q = quote as Record<string, string | number>;
      logger.info({
        tokenMint, attempt, slippageBps,
        priceImpactPct:       q["priceImpactPct"],
        otherAmountThreshold: q["otherAmountThreshold"],
        outAmount:            q["outAmount"],
      }, "Jupiter: buy quote received");

      const swapTx      = await this.getSwapTx(quote, priorityFeeLamports, slippageBps);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const tokenAmount = Number(q["outAmount"]);
      const solSpent    = Number(q["inAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, solSpent, tokenAmount, txSignature, attempt }, "Jupiter: buy confirmed on-chain ✅");
      return { txSignature, tokenAmount, solSpent, attempt };
    }, 3, 2000);
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // Retries up to 3 times with escalating slippage.
  // Custom:6024 (ExceededSlippage) is handled specifically — each retry adds 500 bps.
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

    // Pre-flight: validate sell params
    validateSellParams(tokenMint, amountRaw, slippageBps, priorityFeeLamports);

    return withRetry(`sell:${tokenMint.slice(0, 8)}`, async (attempt) => {
      // Widen slippage on each retry so a volatile exit still lands.
      // Custom:6024 (ExceededSlippage) is the most common sell failure.
      // effectiveSlippage is passed explicitly to BOTH getQuote AND getSwapTx so
      // Jupiter's /swap endpoint uses it to recompute otherAmountThreshold from
      // the WIDENED value — not from whatever is baked into the quoteResponse.
      const effectiveSlippage = Math.min(slippageBps + (attempt - 1) * 500, 5000);
      logger.info({
        tokenMint, tokenAmount: amountRaw,
        baseSlippageBps: slippageBps,
        effectiveSlippageBps: effectiveSlippage,
        attempt,
        wideningApplied: (attempt - 1) * 500,
      }, `Jupiter: sell attempt ${attempt} — slippage ${slippageBps} + ${(attempt - 1) * 500} = ${effectiveSlippage} bps`);

      const quote = await this.getQuote(tokenMint, SOL_MINT, amountRaw, effectiveSlippage);
      const q = quote as Record<string, string | number>;

      // Diagnostic: log quote details so we can verify priceImpactPct and
      // confirm otherAmountThreshold reflects the widened slippage.
      logger.info({
        tokenMint, attempt,
        effectiveSlippageBps:   effectiveSlippage,
        priceImpactPct:         q["priceImpactPct"],
        outAmount:              q["outAmount"],
        otherAmountThreshold:   q["otherAmountThreshold"],
        slippageBpsInQuote:     q["slippageBps"],
      }, "Jupiter: sell quote received — verifying otherAmountThreshold uses widened slippage");

      // Pass effectiveSlippage explicitly so /swap recomputes the minimum-output
      // constraint from the widened value, not a stale or default one.
      const swapTx      = await this.getSwapTx(quote, priorityFeeLamports, effectiveSlippage);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const solReceived = Number(q["outAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, tokenAmount: amountRaw, solReceived, txSignature, attempt, effectiveSlippage }, "Jupiter: sell ✅");
      return { txSignature, solReceived, attempt };
    }, 3, 1500);
  }

  // ── EMERGENCY SELL ────────────────────────────────────────────────────────
  // Used for stuck positions — forces max slippage (5000 bps = 50%).
  // Higher priority fee to ensure the TX lands in congested conditions.
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

    // Emergency: use max slippage 50% (5000 bps) and higher priority fee
    const emergencySlippage    = 5000;
    const emergencyPriorityFee = Math.max(priorityFeeLamports, 2_000_000); // min 0.002 SOL for emergency

    logger.warn({ tokenMint, amountRaw, emergencySlippage, emergencyPriorityFee }, "Jupiter: EMERGENCY SELL — max slippage 50%");

    return withRetry(`emergency-sell:${tokenMint.slice(0, 8)}`, async (attempt) => {
      const quote       = await this.getQuote(tokenMint, SOL_MINT, amountRaw, emergencySlippage);
      const swapTx      = await this.getSwapTx(quote, emergencyPriorityFee);
      const txSignature = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const q = quote as Record<string, string>;
      const solReceived = Number(q["outAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, amountRaw, solReceived, txSignature, attempt }, "Jupiter: emergency sell confirmed ✅");
      return { txSignature, solReceived, attempt };
    }, 2, 3000);
  }
}

export const jupiterSwapService = new JupiterSwapService();
