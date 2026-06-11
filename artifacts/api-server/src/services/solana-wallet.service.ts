import { Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../lib/logger.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

class SolanaWalletService {
  private keypair: Keypair | null = null;
  readonly connection: Connection;

  constructor() {
    const heliusKey = process.env["HELIUS_API_KEY"];
    const rpcUrl = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : "https://api.mainnet-beta.solana.com";
    this.connection = new Connection(rpcUrl, "confirmed");

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
      logger.error({ err: (err as Error).message }, "SolanaWalletService: invalid SOLANA_PRIVATE_KEY — check it is base58 encoded");
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

  async signAndSend(txBase64: string): Promise<string> {
    if (!this.keypair) throw new Error("Wallet not ready — SOLANA_PRIVATE_KEY not set");

    const txBuf = Buffer.from(txBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.keypair]);

    const raw = tx.serialize();
    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });

    const latestBlock = await this.connection.getLatestBlockhash("confirmed");
    await this.connection.confirmTransaction(
      { signature, blockhash: latestBlock.blockhash, lastValidBlockHeight: latestBlock.lastValidBlockHeight },
      "confirmed",
    );

    return signature;
  }
}

export const solanaWalletService = new SolanaWalletService();
