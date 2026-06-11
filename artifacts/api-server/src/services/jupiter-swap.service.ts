import axios, { AxiosError } from "axios";
import { solanaWalletService } from "./solana-wallet.service.js";
import { logger } from "../lib/logger.js";

// Jupiter Lite API — free, no auth, current as of 2025
// NEVER use quote-api.jup.ag — that domain is dead (ENOTFOUND)
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://lite-api.jup.ag/swap/v1/swap";
const SOL_MINT          = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL  = 1_000_000_000;

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

// ── Retry helper ──────────────────────────────────────────────────────────────
// Retries any async fn up to maxAttempts times with linear back-off.
// For buy: fresh graduates may take 2-5s to appear in Jupiter routing — retries fix that.
// For sell: escalating slippage is passed in; caller controls it per attempt.
async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const axErr = err as AxiosError;
      const status = axErr.response?.status ?? 0;
      const msg    = axErr.message ?? String(err);
      logger.warn({ label, attempt, maxAttempts, status, msg },
        `Jupiter: attempt ${attempt}/${maxAttempts} failed — ${msg}`);

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;       // 1.5s, 3s
        logger.info({ label, delay }, `Jupiter: waiting ${delay}ms before retry`);
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
    const res = await axios.get(JUPITER_QUOTE_URL, {
      params: { inputMint, outputMint, amount, slippageBps },
      timeout: 10_000,
    });
    return res.data;
  }

  private async getSwapTx(
    quoteResponse: unknown,
    priorityFeeLamports: number,
  ): Promise<string> {
    const res = await axios.post(JUPITER_SWAP_URL, {
      quoteResponse,
      userPublicKey:            solanaWalletService.publicKey,
      wrapAndUnwrapSol:         true,
      dynamicComputeUnitLimit:  true,
      // Lite API: plain number (NOT the nested v6 priorityLevelWithMaxLamports object)
      prioritizationFeeLamports: priorityFeeLamports,
    }, { timeout: 15_000 });
    return res.data.swapTransaction as string;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  // Retries up to 3 times with 1.5s / 3s delays.
  // Common failure: fresh pump.fun graduate not yet indexed by Jupiter (takes 2-5s).
  async buy(
    tokenMint: string,
    solAmount: number,
    slippageBps: number,
    priorityFeeLamports: number,
  ): Promise<BuyResult> {
    if (!solanaWalletService.isReady) {
      throw new Error("Wallet not configured — set SOLANA_PRIVATE_KEY env var");
    }

    const amountLamports = Math.round(solAmount * LAMPORTS_PER_SOL);

    return withRetry(`buy:${tokenMint.slice(0, 8)}`, async (attempt) => {
      logger.info({ tokenMint, solAmount, slippageBps, attempt }, "Jupiter: getting buy quote");

      const quote = await this.getQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);
      const swapTx      = await this.getSwapTx(quote, priorityFeeLamports);
      const txSignature  = await solanaWalletService.signAndSend(swapTx);

      const q = quote as Record<string, string>;
      const tokenAmount = Number(q["outAmount"]);
      const solSpent    = Number(q["inAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, solSpent, tokenAmount, txSignature, attempt }, "Jupiter: buy ✅");
      return { txSignature, tokenAmount, solSpent, attempt };
    }, 3, 1500);
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // Retries up to 3 times. Each retry adds 500 bps of slippage (tokens are volatile;
  // if the first quote slippage-fails on execution, a wider band will succeed).
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

    return withRetry(`sell:${tokenMint.slice(0, 8)}`, async (attempt) => {
      // Widen slippage on each retry so a volatile exit still lands
      const effectiveSlippage = slippageBps + (attempt - 1) * 500;
      logger.info({ tokenMint, tokenAmount: amountRaw, effectiveSlippage, attempt }, "Jupiter: getting sell quote");

      const quote = await this.getQuote(tokenMint, SOL_MINT, amountRaw, effectiveSlippage);
      const swapTx      = await this.getSwapTx(quote, priorityFeeLamports);
      // Use signAndSendAndConfirm for sells — we MUST verify the tx landed on-chain
      // before the caller marks the position as closed. signAndSend (fire-and-forget)
      // would let a failed tx silently close the position while tokens stay in wallet.
      const txSignature  = await solanaWalletService.signAndSendAndConfirm(swapTx);

      const q = quote as Record<string, string>;
      const solReceived = Number(q["outAmount"]) / LAMPORTS_PER_SOL;

      logger.info({ tokenMint, tokenAmount: amountRaw, solReceived, txSignature, attempt }, "Jupiter: sell ✅");
      return { txSignature, solReceived, attempt };
    }, 3, 1500);
  }
}

export const jupiterSwapService = new JupiterSwapService();
