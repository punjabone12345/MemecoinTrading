import axios from "axios";
import { solanaWalletService } from "./solana-wallet.service.js";
import { logger } from "../lib/logger.js";

// Jupiter Lite API — free, no auth, current as of 2025
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP_URL  = "https://lite-api.jup.ag/swap/v1/swap";
const SOL_MINT          = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL  = 1_000_000_000;

export interface BuyResult {
  txSignature: string;
  tokenAmount: number;
  solSpent: number;
}

export interface SellResult {
  txSignature: string;
  solReceived: number;
}

class JupiterSwapService {
  private async getSwapTx(
    quoteResponse: unknown,
    priorityFeeLamports: number,
  ): Promise<string> {
    const res = await axios.post(JUPITER_SWAP_URL, {
      quoteResponse,
      userPublicKey:          solanaWalletService.publicKey,
      wrapAndUnwrapSol:       true,
      dynamicComputeUnitLimit: true,
      // Lite API accepts a plain number for priority fee (not the nested v6 object)
      prioritizationFeeLamports: priorityFeeLamports,
    }, { timeout: 15_000 });
    // Lite API returns "swapTransaction" (same field as v6)
    return res.data.swapTransaction as string;
  }

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

    logger.info({ tokenMint, solAmount, slippageBps }, "Jupiter: getting buy quote");

    const quoteRes = await axios.get(JUPITER_QUOTE_URL, {
      params: {
        inputMint:   SOL_MINT,
        outputMint:  tokenMint,
        amount:      amountLamports,
        slippageBps,
      },
      timeout: 10_000,
    });
    const quote = quoteRes.data;

    const swapTx     = await this.getSwapTx(quote, priorityFeeLamports);
    const txSignature = await solanaWalletService.signAndSend(swapTx);

    const tokenAmount = Number(quote.outAmount);
    const solSpent    = Number(quote.inAmount) / LAMPORTS_PER_SOL;

    logger.info({ tokenMint, solSpent, tokenAmount, txSignature }, "Jupiter: buy executed ✅");

    return { txSignature, tokenAmount, solSpent };
  }

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

    logger.info({ tokenMint, tokenAmount: amountRaw, slippageBps }, "Jupiter: getting sell quote");

    const quoteRes = await axios.get(JUPITER_QUOTE_URL, {
      params: {
        inputMint:  tokenMint,
        outputMint: SOL_MINT,
        amount:     amountRaw,
        slippageBps,
      },
      timeout: 10_000,
    });
    const quote = quoteRes.data;

    const swapTx      = await this.getSwapTx(quote, priorityFeeLamports);
    const txSignature  = await solanaWalletService.signAndSend(swapTx);
    const solReceived  = Number(quote.outAmount) / LAMPORTS_PER_SOL;

    logger.info({ tokenMint, tokenAmount: amountRaw, solReceived, txSignature }, "Jupiter: sell executed ✅");

    return { txSignature, solReceived };
  }
}

export const jupiterSwapService = new JupiterSwapService();
