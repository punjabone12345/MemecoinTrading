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
   * Confirmation is tracked in the background — caller gets signature immediately.
   * outAmount from Jupiter quote is used for P&L; actual confirmation is async.
   */
  async signAndSend(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const txBuf = Buffer.from(txBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    // skipPreflight = skip tx simulation on RPC node — saves ~200ms per tx
    // processed commitment = accept tx as soon as it reaches the leader, don't wait for block
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5,
      preflightCommitment: "processed",
    });

    logger.info({ sig: signature.slice(0, 20) }, "SolanaWalletService: tx sent ⚡ (confirming in background)");

    // Confirm asynchronously — we don't block the trade loop
    void this.confirmInBackground(signature);

    return signature;
  }

  /**
   * Background confirmation tracker. Logs success/failure; caller already moved on.
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
      // confirmTransaction can time out if the block window expires — tx may still have landed
      logger.warn({ sig: signature.slice(0, 20), err: (err as Error).message }, "SolanaWalletService: confirmation timeout (tx may still confirm)");
    }
  }
}

export const solanaWalletService = new SolanaWalletService();
