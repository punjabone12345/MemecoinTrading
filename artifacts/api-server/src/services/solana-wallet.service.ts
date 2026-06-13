import { Keypair, Connection, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../lib/logger.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

// Public Solana mainnet RPC — used as fallback when Helius is unavailable or slow.
// Sending to both simultaneously ensures the TX lands even if one endpoint is degraded.
const PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";

class SolanaWalletService {
  private keypair: Keypair | null = null;
  readonly connection: Connection;
  private readonly connectionFallback: Connection;

  // Consecutive RPC failure tracking for health monitoring
  private rpcFailStreak = 0;
  private rpcFailStreakStart = 0;
  private readonly RPC_FAIL_ALERT_MS = 60_000; // 60s of consecutive failures → alert

  constructor() {
    const heliusKey = process.env["HELIUS_API_KEY"];
    const primaryRpc = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : PUBLIC_RPC_URL;

    this.connection = new Connection(primaryRpc, {
      commitment: "processed",
      confirmTransactionInitialTimeout: 60_000,
    });

    // Always keep a fallback connection to public endpoint for dual-submission
    this.connectionFallback = new Connection(PUBLIC_RPC_URL, {
      commitment: "processed",
      confirmTransactionInitialTimeout: 60_000,
    });

    const privKey = process.env["SOLANA_PRIVATE_KEY"];
    if (!privKey) {
      logger.warn("SolanaWalletService: SOLANA_PRIVATE_KEY not set — live trading disabled");
      return;
    }
    try {
      const decoded = bs58.decode(privKey);
      this.keypair = Keypair.fromSecretKey(decoded);
      logger.info({ pubkey: this.keypair.publicKey.toBase58() }, "SolanaWalletService: wallet loaded ✅");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "SolanaWalletService: invalid SOLANA_PRIVATE_KEY — must be base58 encoded");
    }
  }

  get isReady(): boolean {
    return this.keypair !== null;
  }

  get publicKey(): string {
    return this.keypair?.publicKey.toBase58() ?? "";
  }

  async getBalance(): Promise<number> {
    if (!this.keypair) return 0;
    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey, "confirmed");
      this.rpcFailStreak = 0;
      return lamports / LAMPORTS_PER_SOL;
    } catch (err) {
      this.trackRpcFailure("getBalance", (err as Error).message);
      try {
        const lamports = await this.connectionFallback.getBalance(this.keypair.publicKey, "confirmed");
        return lamports / LAMPORTS_PER_SOL;
      } catch {
        return 0;
      }
    }
  }

  /**
   * Fetch a recommended priority fee from Helius's `getRecentPrioritizationFees`
   * method, taking the 75th-percentile of the last 20 slots for competitive landing.
   * Falls back to the provided `defaultLamports` if Helius is unavailable.
   *
   * Pass `accountKeys` of the programs involved in the swap (e.g. Raydium CPMM)
   * to get fees scoped to that specific program instead of global slot averages.
   */
  async getOptimalPriorityFee(defaultLamports: number, accountKeys?: string[]): Promise<number> {
    const heliusKey = process.env["HELIUS_API_KEY"];
    if (!heliusKey) return defaultLamports;

    try {
      const axios = (await import("axios")).default;
      const res = await axios.post(
        `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getRecentPrioritizationFees",
          params: accountKeys ? [accountKeys] : [],
        },
        { timeout: 4_000 },
      );

      const fees: Array<{ prioritizationFee: number }> = res.data?.result ?? [];
      if (fees.length === 0) return defaultLamports;

      // Sort ascending and take 75th percentile — aggressive enough to land quickly
      // without wasting funds, better than a plain average which is dragged down by
      // zero-fee slots.
      const sorted   = [...fees].sort((a, b) => a.prioritizationFee - b.prioritizationFee);
      const p75index = Math.floor(sorted.length * 0.75);
      const p75fee   = sorted[p75index]?.prioritizationFee ?? defaultLamports;

      // Never go below the caller's default (0.0005 SOL for graduation sniping)
      // and cap at 5_000_000 lamports (0.005 SOL) to avoid runaway fees.
      const optimal = Math.max(defaultLamports, Math.min(p75fee, 5_000_000));
      logger.info({ p75fee, optimal, defaultLamports, sampleSize: fees.length }, "SolanaWalletService: Helius priority fee estimated ✅");
      return optimal;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "SolanaWalletService: getRecentPrioritizationFees failed — using default priority fee");
      return defaultLamports;
    }
  }

  /**
   * Fetch the exact raw (smallest-unit) token balance for a specific mint.
   * Uses `uiTokenAmount.amount` (the integer string), NOT uiAmount (float).
   * Returns null on failure — callers should fall back to stored value.
   */
  async getRawTokenBalance(mint: string): Promise<number | null> {
    if (!this.keypair) return null;
    try {
      const mintPubkey = new PublicKey(mint);
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: mintPubkey },
        "confirmed",
      );
      let total = 0;
      for (const acc of accounts.value) {
        const parsed = acc.account.data as {
          parsed?: { info?: { tokenAmount?: { amount?: string } } };
        };
        const rawStr = parsed.parsed?.info?.tokenAmount?.amount;
        if (rawStr) total += Number(rawStr);
      }
      return total;
    } catch (err) {
      logger.warn({ mint, err: (err as Error).message }, "SolanaWalletService: getRawTokenBalance failed");
      return null;
    }
  }

  /**
   * Fetch token decimals directly from the mint account.
   * Never assumes — always reads from chain so the value is exact.
   * Returns null on failure.
   */
  async getTokenDecimals(mint: string): Promise<number | null> {
    try {
      const mintPubkey = new PublicKey(mint);
      const info = await this.connection.getParsedAccountInfo(mintPubkey, "confirmed");
      if (info.value && "parsed" in info.value.data) {
        const data = info.value.data as { parsed?: { info?: { decimals?: number } } };
        const decimals = data.parsed?.info?.decimals;
        if (typeof decimals === "number") return decimals;
      }
      return null;
    } catch (err) {
      logger.warn({ mint, err: (err as Error).message }, "SolanaWalletService: getTokenDecimals failed");
      return null;
    }
  }

  /**
   * Fetch all token accounts owned by the wallet.
   * Returns a map of mint → uiAmount for reconciliation against open positions.
   */
  async getTokenAccounts(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!this.keypair) return result;
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
        "confirmed",
      );
      for (const acc of accounts.value) {
        const parsed = acc.account.data as {
          parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } };
        };
        const mint = parsed.parsed?.info?.mint;
        const uiAmount = parsed.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        if (mint && uiAmount > 0) {
          result.set(mint, (result.get(mint) ?? 0) + uiAmount);
        }
      }
      this.rpcFailStreak = 0;
    } catch (err) {
      this.trackRpcFailure("getTokenAccounts", (err as Error).message);
    }
    return result;
  }

  private trackRpcFailure(method: string, errMsg: string): void {
    const now = Date.now();
    if (this.rpcFailStreak === 0) this.rpcFailStreakStart = now;
    this.rpcFailStreak++;
    const duration = now - this.rpcFailStreakStart;
    logger.warn({ method, errMsg, failStreak: this.rpcFailStreak, durationMs: duration }, "SolanaWalletService: RPC failure");
    if (duration >= this.RPC_FAIL_ALERT_MS && this.rpcFailStreak % 5 === 0) {
      // Emit a critical log — the sniper service picks this up in its health check
      logger.error({ method, failStreak: this.rpcFailStreak, durationMs: duration }, "SolanaWalletService: CRITICAL — RPC failures for 60s+ ❌");
    }
  }

  /**
   * Safely decode a Jupiter-returned base64 transaction.
   */
  private decodeTxBase64(txBase64: string): VersionedTransaction {
    const clean  = txBase64.replace(/\s+/g, "");
    const std    = clean.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std.padEnd(std.length + (4 - (std.length % 4)) % 4, "=");
    const txBuf  = Buffer.from(padded, "base64");
    try {
      return VersionedTransaction.deserialize(txBuf);
    } catch (err) {
      throw new Error(`Jupiter TX deserialization failed (${(err as Error).message}) — will retry with fresh quote`);
    }
  }

  async signAndSend(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");
    const tx = this.decodeTxBase64(txBase64);
    tx.sign([this.keypair]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 5, preflightCommitment: "processed",
    });
    logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx sent ⚡ (confirming in background)");
    void this.confirmInBackground(signature);
    return signature;
  }

  /**
   * Sign + send and WAIT for on-chain confirmation.
   * Submits to BOTH Helius + public endpoint simultaneously for maximum reliability.
   *
   * IMPORTANT: Uses signature-polling confirmation instead of blockhash-strategy.
   *
   * The old approach fetched a NEW blockhash AFTER Jupiter had already embedded
   * its own blockhash in the transaction. When Jupiter's blockhash expired, the
   * confirmation code was using the wrong `lastValidBlockHeight` and threw a
   * timeout error — even though the sell TX had actually landed on-chain. This
   * caused the bot to think the sell failed, retry, and accumulate duplicate
   * pending TXs, eventually hitting MAX_SELL_FAILS on perfectly liquid tokens.
   *
   * Polling `getSignatureStatuses` is blockhash-agnostic: it confirms exactly
   * when the signature appears on-chain regardless of which blockhash was used.
   */
  async signAndSendAndConfirm(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const tx = this.decodeTxBase64(txBase64);
    tx.sign([this.keypair]);
    const serialized = tx.serialize();

    const sendOpts = { skipPreflight: true, maxRetries: 5, preflightCommitment: "processed" as const };

    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(serialized, sendOpts);
      logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx sent to primary RPC — polling for confirmation ⏳");
      // Also blast to fallback in background — doubles landing probability
      void this.connectionFallback.sendRawTransaction(serialized, sendOpts).catch(() => {});
    } catch (primaryErr) {
      logger.warn({ err: (primaryErr as Error).message }, "SolanaWalletService: primary RPC send failed — trying fallback");
      signature = await this.connectionFallback.sendRawTransaction(serialized, sendOpts);
      logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx sent via fallback RPC — polling ⏳");
    }

    // Poll getSignatureStatuses — no blockhash dependency, works regardless of
    // which RPC submitted and which blockhash Jupiter embedded in the tx.
    const deadline  = Date.now() + 90_000; // 90 s — covers slow slots and congestion
    const pollMs    = 500;   // was 1500 — tighter poll saves ~1s avg on confirmation
    let resubmitted = false;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        const res    = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
        const status = res.value[0];

        if (status) {
          if (status.err) {
            const errMsg = JSON.stringify(status.err);
            logger.error({ sig: signature.slice(0, 20), err: errMsg }, "SolanaWalletService: tx FAILED on-chain ❌");
            throw new Error(`Transaction rejected on-chain: ${errMsg}`);
          }
          if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            this.rpcFailStreak = 0;
            logger.info({ sig: signature.slice(0, 20), status: status.confirmationStatus }, "SolanaWalletService: tx confirmed on-chain ✅");
            return signature;
          }
          // status is "processed" — still propagating, keep polling
        } else if (!resubmitted && Date.now() > deadline - 60_000) {
          // Not found after 30 s — resubmit to both RPCs to recover from dropped TXs
          resubmitted = true;
          logger.warn({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx not seen after 30s — resubmitting to both RPCs");
          void this.connection.sendRawTransaction(serialized, sendOpts).catch(() => {});
          void this.connectionFallback.sendRawTransaction(serialized, sendOpts).catch(() => {});
        }
      } catch (pollErr) {
        const msg = (pollErr as Error).message ?? String(pollErr);
        if (msg.includes("rejected on-chain") || msg.includes("Transaction rejected")) throw pollErr;
        // Transient network error — log and continue polling
        logger.warn({ sig: signature.slice(0, 20), err: msg }, "SolanaWalletService: status poll error — retrying");
      }
    }

    throw new Error(`Transaction confirmation timeout after 90s — tx may still land. Sig: ${signature.slice(0, 20)}`);
  }

  private async confirmInBackground(signature: string): Promise<void> {
    try {
      const latest = await this.connection.getLatestBlockhash("confirmed");
      const result = await this.connection.confirmTransaction(
        { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        "confirmed",
      );
      if (result.value.err) {
        logger.error({ sig: signature.slice(0, 20), err: result.value.err }, "SolanaWalletService: tx FAILED on-chain ❌");
      } else {
        logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx confirmed ✅");
      }
    } catch (err) {
      logger.warn({ sig: signature.slice(0, 20), err: (err as Error).message }, "SolanaWalletService: confirmation timeout (tx may still confirm)");
    }
  }
}

export const solanaWalletService = new SolanaWalletService();
