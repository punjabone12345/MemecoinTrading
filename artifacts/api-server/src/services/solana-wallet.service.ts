import { Keypair, Connection, VersionedTransaction, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import axios from "axios";
import { logger } from "../lib/logger.js";

// ── Jito Bundle Engine ─────────────────────────────────────────────────────────
// Submitting as a Jito bundle skips the standard mempool and lands in the next
// block the Jito validator produces — typically 1-2 slots (~400-800ms).
// A tip transaction to a Jito tip account is required; the tip is the incentive
// for Jito block-builders to include the bundle.
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Well-known Jito tip accounts — pick one at random to distribute load.
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvB6pKYRS27jkJMfK2vVjMooN4aZK5WX5K",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9gy7Mp2bfXPVtVNT8CkC4GWBzeXJDnFnFSXHt",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

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
   * @param acceptProcessed  When true (buy path): return as soon as the TX reaches
   *   "processed" status (~2-5s) and upgrade to "confirmed" in the background.
   *   When false (sell path, default): wait for full "confirmed" status before
   *   returning — critical for sells where we must know tokens left the wallet.
   *
   * WHY acceptProcessed for buys:
   *   "confirmed" can take 30-40s on a congested RPC.  The TX is effectively
   *   on-chain at "processed" (<5s) and <0.1% of processed TXs are ever rolled
   *   back.  Recording the position at "processed" cuts msDetectionToFill from
   *   ~40s to ~5s.  The background upgrade check catches the rare failure.
   */
  async signAndSendAndConfirm(txBase64: string, acceptProcessed = false): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const tx = this.decodeTxBase64(txBase64);
    tx.sign([this.keypair]);
    const serialized = tx.serialize();

    const sendOpts = { skipPreflight: true, maxRetries: 5, preflightCommitment: "processed" as const };

    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(serialized, sendOpts);
      logger.info({ sig: signature.slice(0, 20), acceptProcessed }, "SolanaWalletService: tx sent to primary RPC — polling ⏳");
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
    const pollMs    = 400;
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

          const lvl = status.confirmationStatus;

          // Fast path for buys: "processed" means the TX is in a block.
          // Return immediately and upgrade to "confirmed" in the background.
          if (acceptProcessed && (lvl === "processed" || lvl === "confirmed" || lvl === "finalized")) {
            this.rpcFailStreak = 0;
            logger.info({ sig: signature.slice(0, 20), status: lvl },
              "SolanaWalletService: tx processed on-chain ✅ (buy recorded — upgrading to confirmed in background)");
            void this.upgradeToConfirmedInBackground(signature);
            return signature;
          }

          if (lvl === "confirmed" || lvl === "finalized") {
            this.rpcFailStreak = 0;
            logger.info({ sig: signature.slice(0, 20), status: lvl }, "SolanaWalletService: tx confirmed on-chain ✅");
            return signature;
          }
          // status is "processed" and we need "confirmed" — keep polling
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

  /**
   * Background upgrade: poll until "processed" TX reaches "confirmed".
   * Called after a fast-path buy so we know the TX fully settled.
   * Does not block the entry pipeline — runs entirely in the background.
   */
  private async upgradeToConfirmedInBackground(signature: string): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const res    = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
        const status = res.value[0];
        if (!status) continue;
        if (status.err) {
          logger.error({ sig: signature.slice(0, 20), err: JSON.stringify(status.err) },
            "SolanaWalletService: buy TX FAILED at confirmed level ❌ (position may be invalid — check wallet)");
          return;
        }
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
          logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: buy TX upgraded to confirmed ✅");
          return;
        }
      } catch { /* transient — keep polling */ }
    }
    logger.warn({ sig: signature.slice(0, 20) }, "SolanaWalletService: buy TX upgrade-to-confirmed timed out (tx likely confirmed, RPC slow)");
  }

  /**
   * Submit a signed Jupiter swap TX as a Jito bundle with a tip transaction.
   * Returns the swap TX signature immediately after bundle acceptance (~200ms).
   * Background verification polls for "confirmed" status without blocking.
   *
   * Falls back to standard signAndSendAndConfirm(acceptProcessed=true) if:
   *   - tipLamports === 0 (Jito disabled)
   *   - Jito endpoint returns an error or times out
   *   - Building the tip TX fails
   *
   * @param label  "buy" or "sell" — used in log messages only
   */
  async sendAsJitoBundleOrFallback(
    txBase64: string,
    tipLamports: number,
    label: string,
  ): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    // ── Jito disabled ──────────────────────────────────────────────────────────
    if (tipLamports <= 0) {
      return this.signAndSendAndConfirm(txBase64, true);
    }

    const tStart = Date.now();

    try {
      // ── 1. Sign the swap TX and extract its signature ──────────────────────
      const swapTx = this.decodeTxBase64(txBase64);
      swapTx.sign([this.keypair]);
      const swapTxBase64 = Buffer.from(swapTx.serialize()).toString("base64");
      const signature    = bs58.encode(swapTx.signatures[0]);

      // ── 2. Build tip TX (legacy Transaction — simple SOL transfer) ──────────
      const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
      const { blockhash } = await this.connection.getLatestBlockhash("processed");

      const tipTx     = new Transaction();
      tipTx.add(SystemProgram.transfer({
        fromPubkey: this.keypair.publicKey,
        toPubkey:   new PublicKey(tipAccount),
        lamports:   tipLamports,
      }));
      tipTx.recentBlockhash = blockhash;
      tipTx.feePayer        = this.keypair.publicKey;
      tipTx.sign(this.keypair);
      const tipTxBase64 = tipTx.serialize().toString("base64");

      const tBuildMs = Date.now() - tStart;

      // ── 3. Submit bundle ─────────────────────────────────────────────────────
      // Bundle order: [swap, tip] — tip last is fine for Jito.
      const res = await axios.post(
        JITO_BUNDLE_URL,
        { jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[swapTxBase64, tipTxBase64]] },
        { timeout: 4_000 },
      );

      const bundleId   = (res.data?.result ?? "unknown") as string;
      const tSubmitMs  = Date.now() - tStart;

      logger.info({
        label, sig: signature.slice(0, 20), bundleId: bundleId.slice(0, 16),
        tipLamports, tipSol: (tipLamports / 1e9).toFixed(6),
        tBuildMs, tSubmitMs,
      }, `Jito: ${label} bundle submitted ⚡ — verifying in background`);

      // ── 4. Background verify (does not block the caller) ────────────────────
      void this.upgradeToConfirmedInBackground(signature);

      return signature;

    } catch (jitoErr) {
      const msg = (jitoErr as Error).message ?? String(jitoErr);
      logger.warn({ label, tipLamports, err: msg, tElapsedMs: Date.now() - tStart },
        `Jito: ${label} bundle failed — falling back to standard send`);

      // Fallback: standard send, acceptProcessed=true for speed
      return this.signAndSendAndConfirm(txBase64, true);
    }
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
