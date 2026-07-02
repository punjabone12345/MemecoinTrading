import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';

// ── Source registry ───────────────────────────────────────────────────────────
// Global map: mint → set of discovery sources
//   'pumpfun'  = spotted via the official Pump.fun migration wallet on-chain
//   'meteora'  = spotted via Helius WebSocket Meteora DLMM/DAMM program logs
//   'bot'      = discovered by the scanner
const mintSources = new Map<string, Set<string>>();

let onMintSourceUpdated: ((mint: string, sources: string[]) => Promise<void>) | null = null;

export function setOnMintSourceUpdated(
  cb: (mint: string, sources: string[]) => Promise<void>,
): void {
  onMintSourceUpdated = cb;
}

export function getMintSources(mint: string): string[] {
  return Array.from(mintSources.get(mint) ?? []);
}

export function addMintSource(mint: string, source: string): boolean {
  let set = mintSources.get(mint);
  if (!set) { set = new Set(); mintSources.set(mint, set); }
  const isNew = !set.has(source);
  set.add(source);
  if (isNew && onMintSourceUpdated) {
    const sources = Array.from(set);
    onMintSourceUpdated(mint, sources).catch(() => {});
  }
  return isNew;
}

// ── PumpFun migration wallet discovery ───────────────────────────────────────
const pumpfunMints = new Set<string>();

export function getPumpfunMints(): Set<string> { return pumpfunMints; }

// ── Activity feed ─────────────────────────────────────────────────────────────
export interface DiscoveryEvent {
  mint: string;
  ts: number;
  txSig?: string;
  instructionType?: string;
  poolAddress?: string;
  creatorWallet?: string;
}

const MAX_FEED = 20;
const pumpfunFeed: DiscoveryEvent[] = [];

function pushFeed(feed: DiscoveryEvent[], ev: DiscoveryEvent): void {
  feed.unshift(ev);
  if (feed.length > MAX_FEED) feed.pop();
}

export function getSourceActivity() {
  return {
    pumpfun: {
      total: pumpfunMints.size,
      recent: pumpfunFeed.slice(0, MAX_FEED),
    },
  };
}

// ── Stable mints to ignore ────────────────────────────────────────────────────
const STABLE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',    // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);

// ── Migration wallet tracker ──────────────────────────────────────────────────
// When Pump.fun migrates a token, the official migration wallet
// 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg signs the transaction.
// We detect: migrate, migrate_v2, and pool_create instruction types.
const MIGRATION_WALLET = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

// Keywords that identify migration-related instructions in transaction logs
const MIGRATION_KEYWORDS = ['migrate', 'Migrate', 'MigrateV2', 'migrateV2', 'migrate_v2', 'PoolCreate', 'pool_create', 'CreatePool'];

let lastSeenSig: string | null = null;
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    const rpc = process.env.RPC_ENDPOINT ?? PUBLIC_RPC;
    connection = new Connection(rpc, { commitment: 'confirmed' });
  }
  return connection;
}

// Callback invoked whenever a new mint is discovered from the migration wallet
let onNewMint: ((mint: string) => void) | null = null;
export function setOnNewMint(cb: (mint: string) => void): void {
  onNewMint = cb;
}

function detectMigrationInstructionType(logs: string[]): string {
  for (const log of logs) {
    if (log.includes('MigrateV2') || log.includes('migrateV2') || log.includes('migrate_v2')) return 'migrate_v2';
    if (log.includes('Migrate') || log.includes('migrate')) return 'migrate';
    if (log.includes('PoolCreate') || log.includes('pool_create') || log.includes('CreatePool')) return 'pool_create';
  }
  return 'migration';
}

async function trackMigrationWallet(): Promise<void> {
  try {
    const conn = getConnection();
    const pk = new PublicKey(MIGRATION_WALLET);

    // Fetch the latest 15 signatures for this wallet
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 15 });
    if (!sigs.length) return;

    // Find new signatures since our last checkpoint
    const newSigs: string[] = [];
    for (const sig of sigs) {
      if (sig.signature === lastSeenSig) break;
      if (!sig.err) newSigs.push(sig.signature);
    }
    lastSeenSig = sigs[0].signature;

    if (!newSigs.length) return;

    // Fetch up to 5 parsed transactions in parallel
    const toFetch = newSigs.slice(0, 5);
    const txns = await Promise.all(
      toFetch.map((sig) =>
        conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
          .catch(() => null),
      ),
    );

    let added = 0;
    for (let i = 0; i < txns.length; i++) {
      const tx = txns[i];
      if (!tx) continue;

      const sig = toFetch[i];
      const logs = tx.meta?.logMessages ?? [];
      const instructionType = detectMigrationInstructionType(logs);

      // Extract creator wallet (fee payer = first account key)
      const accountKeys: any[] = (tx.transaction.message as any).accountKeys ?? [];
      const creatorWallet: string = accountKeys[0]?.pubkey?.toString() ?? accountKeys[0]?.toString() ?? '';

      // Extract pool address (first non-signer non-stable writable account)
      let poolAddress: string | undefined;
      for (let j = 1; j < Math.min(accountKeys.length, 8); j++) {
        const addr = accountKeys[j]?.pubkey?.toString() ?? accountKeys[j]?.toString() ?? '';
        if (addr && addr !== creatorWallet && !STABLE_MINTS.has(addr) && addr.length > 30) {
          poolAddress = addr;
          break;
        }
      }

      // Extract mints from postTokenBalances
      const balances = tx.meta?.postTokenBalances ?? [];
      for (const bal of balances) {
        const mint = bal.mint;
        if (!mint || mint.length < 20 || STABLE_MINTS.has(mint)) continue;

        pumpfunMints.add(mint);
        const isNew = addMintSource(mint, 'pumpfun');
        if (!isNew) continue;

        added++;
        pushFeed(pumpfunFeed, { mint, ts: Date.now(), txSig: sig, instructionType, poolAddress, creatorWallet });
        if (onNewMint) onNewMint(mint);

        logger.info(
          { mint, sig: sig.slice(0, 16), instructionType, poolAddress, creatorWallet: creatorWallet.slice(0, 16) },
          'PumpFun wallet: migration detected',
        );

        // Persist to DB
        try {
          await query(`
            INSERT INTO detected_migrations
              (source, instruction_type, tx_signature, pool_address, mint, creator_wallet)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tx_signature) DO NOTHING
          `, ['pumpfun_wallet', instructionType, sig, poolAddress ?? null, mint, creatorWallet]);
        } catch (dbErr: any) {
          logger.debug({ msg: dbErr?.message }, 'PumpFun wallet: DB insert skipped (non-fatal)');
        }
      }
    }

    if (added > 0) logger.info({ added, newTxns: newSigs.length, total: pumpfunMints.size }, 'PumpFun wallet: new migration mints');
  } catch (err: any) {
    logger.debug({ msg: err?.message }, 'PumpFun wallet: RPC poll failed (will retry)');
  }
}

// ── Scanner lifecycle ─────────────────────────────────────────────────────────
let started = false;

export function startTrenchesScanner(): void {
  if (started) return;
  started = true;

  // Immediate first poll
  void trackMigrationWallet();

  // Poll every 5 seconds
  setInterval(() => { void trackMigrationWallet(); }, 5_000);

  logger.info('PumpFun migration wallet tracker started (polls every 5s)');
}
