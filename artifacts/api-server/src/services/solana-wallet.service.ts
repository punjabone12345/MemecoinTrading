import { Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../lib/logger.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

class SolanaWalletService {
  private keypair: Keypair | null = null;
  readonly connection: Connection;

  constructor() {
    const heliusKey = process.env["HELIUS_API_KEY"];
    // Use Helius for low-latency RPC; fallback to public mainnet
    const rpcUrl = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, {
      commitment: "processed",       // fastest confirmation level
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
      return lamports / LAMPORTS_PER_SOL;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "SolanaWalletService: getBalance failed");
      return 0;
    }
  }

  /**
   * Sign + send with skipPreflight for maximum speed (~300ms).
   * Used for BUY orders — confirmation is tracked in the background.
   * outAmount from Jupiter quote is used for P&L; actual confirmation is async.
   */
  /**
   * Safely decode a Jupiter-returned base64 transaction.
   * Jupiter Lite sometimes embeds whitespace / newlines or uses URL-safe chars
   * (-/_) instead of standard (+/=). Stripping whitespace and normalising the
   * alphabet before decoding prevents the "encoding overruns Uint8Array" error
   * thrown by VersionedTransaction.deserialize on malformed buffers.
   */
  private decodeTxBase64(txBase64: string): VersionedTransaction {
    // Strip all whitespace (newlines, spaces, tabs that sneak in from HTTP bodies)
    const clean = txBase64.replace(/\s+/g, "");
    // Normalise URL-safe base64 → standard base64
    const std   = clean.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if stripped
    const padded = std.padEnd(std.length + (4 - (std.length % 4)) % 4, "=");
    const txBuf = Buffer.from(padded, "base64");
    try {
      return VersionedTransaction.deserialize(txBuf);
    } catch (err) {
      // Surface a clear message so the caller's withRetry re-fetches a fresh quote
      throw new Error(`Jupiter TX deserialization failed (${(err as Error).message}) — will retry with fresh quote`);
    }
  }

  async signAndSend(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const tx = this.decodeTxBase64(txBase64);
    tx.sign([this.keypair]);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: "processed",
    });

    logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx sent ⚡ (confirming in background)");

    void this.confirmInBackground(signature);

    return signature;
  }

  /**
   * Sign + send and WAIT for on-chain confirmation before returning.
   * Used for BOTH BUY and SELL orders — position is only recorded / closed
   * after this resolves successfully.
   * Throws if the transaction fails or is rejected on-chain.
   */
  async signAndSendAndConfirm(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const tx = this.decodeTxBase64(txBase64);
    tx.sign([this.keypair]);

    const latest = await this.connection.getLatestBlockhash("confirmed");

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: "processed",
    });

    logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: sell tx sent — waiting for on-chain confirmation ⏳");

    const result = await this.connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    );

    if (result.value.err) {
      const errMsg = JSON.stringify(result.value.err);
      logger.error({ sig: signature.slice(0, 20), err: errMsg }, "SolanaWalletService: sell tx FAILED on-chain ❌");
      throw new Error(`Sell transaction rejected on-chain: ${errMsg}`);
    }

    logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: sell tx confirmed on-chain ✅");
    return signature;
  }

  /**
   * Background confirmation tracker for buys. Logs success/failure; caller already moved on.
   */
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
