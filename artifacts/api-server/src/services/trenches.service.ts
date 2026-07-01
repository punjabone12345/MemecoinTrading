import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';

// ── Source registry ──────────────────────────────────────────────────────────
// Global map: mint → set of discovery sources
//   'pumpfun'  = spotted via the official Pump.fun migration wallet on-chain
//   'trenches' = spotted via Pump.fun v3 REST API (just-graduated tokens)
//   'bot'      = discovered by the existing scanner (Raydium/Gecko/DexScreener)
//
// Sources accumulate — a token can gain new labels after being found by one source.
const mintSources = new Map<string, Set<string>>();

export function getMintSources(mint: string): string[] {
  return Array.from(mintSources.get(mint) ?? []);
}

/** Adds a source to a mint. Returns true if this source was new for this mint. */
export function addMintSource(mint: string, source: string): boolean {
  let set = mintSources.get(mint);
  if (!set) { set = new Set(); mintSources.set(mint, set); }
  const isNew = !set.has(source);
  set.add(source);
  return isNew;
}

// Recent mints from each source — exposed so scanner can add them to freshMintQueue
const trenchesMints = new Set<string>();
const pumpfunMints  = new Set<string>();

export function getTrenchesMints(): Set<string> { return trenchesMints; }
export function getPumpfunMints():  Set<string> { return pumpfunMints; }

// ── Pump.fun v3 graduated-token poll ────────────────────────────────────────
// https://frontend-api-v3.pump.fun/coins?complete=true returns tokens that
// have recently graduated (migrated) from Pump.fun to Raydium.
// These are exactly what the "trenches" tab shows — high-momentum meme coins
// at the moment of migration, which is the best entry window.
const PUMPFUN_V3_URL = 'https://frontend-api-v3.pump.fun/coins?complete=true';

async function pollPumpfunGraduated(): Promise<void> {
  try {
    const res = await axios.get<Array<{ mint?: string; address?: string }>>(
      PUMPFUN_V3_URL,
      { timeout: 8000, headers: { 'Accept': 'application/json' } }
    );
    const items = Array.isArray(res.data) ? res.data : [];
    let added = 0;
    for (const item of items) {
      const mint = item.mint ?? item.address;
      if (!mint || mint.length < 20) continue;
      trenchesMints.add(mint);
      const isNew = addMintSource(mint, 'trenches');
      if (isNew) added++;
    }
    if (added > 0) logger.debug({ added, total: trenchesMints.size }, 'Trenches: new graduated tokens');
  } catch (err: any) {
    logger.debug({ msg: err?.message }, 'Trenches: pump.fun v3 poll failed (will retry)');
  }
}

// ── Migration wallet tracker ─────────────────────────────────────────────────
// When Pump.fun migrates a token to Raydium, the official migration wallet
// 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg signs the transaction.
// We poll getSignaturesForAddress every 5s and extract token mints from
// the postTokenBalances of each new transaction.
const MIGRATION_WALLET = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

let lastSeenSig: string | null = null;
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    const rpc = process.env.RPC_ENDPOINT ?? PUBLIC_RPC;
    connection = new Connection(rpc, { commitment: 'confirmed' });
  }
  return connection;
}

async function trackMigrationWallet(): Promise<void> {
  try {
    const conn = getConnection();
    const pk = new PublicKey(MIGRATION_WALLET);

    // Fetch last 15 signatures — fast and cheap
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 15 });
    if (!sigs.length) return;

    // Find the new ones (everything before the last seen signature)
    const newSigs: string[] = [];
    for (const sig of sigs) {
      if (sig.signature === lastSeenSig) break;
      if (!sig.err) newSigs.push(sig.signature);
    }
    // Update the cursor regardless so we don't re-process on next tick
    lastSeenSig = sigs[0].signature;

    if (!newSigs.length) return;

    // Fetch parsed transactions in parallel (cap at 5 to avoid RPC rate limits)
    const toFetch = newSigs.slice(0, 5);
    const txns = await Promise.all(
      toFetch.map((sig) =>
        conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })
          .catch(() => null)
      )
    );

    let added = 0;
    for (const tx of txns) {
      if (!tx) continue;
      // postTokenBalances contains all token accounts touched in the tx
      const balances = tx.meta?.postTokenBalances ?? [];
      for (const bal of balances) {
        const mint = bal.mint;
        if (!mint || mint.length < 20) continue;
        // Ignore common quote tokens (SOL wSOL, USDC, USDT)
        if (STABLE_MINTS.has(mint)) continue;
        pumpfunMints.add(mint);
        const isNew = addMintSource(mint, 'pumpfun');
        if (isNew) added++;
      }
    }
    if (added > 0) logger.info({ added, newTxns: newSigs.length }, 'Pumpfun wallet: new migration mints discovered');
  } catch (err: any) {
    logger.debug({ msg: err?.message }, 'Pumpfun wallet: RPC poll failed (will retry)');
  }
}

const STABLE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',    // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);

// ── Scanner lifecycle ────────────────────────────────────────────────────────
let started = false;

export function startTrenchesScanner(): void {
  if (started) return;
  started = true;

  // Immediate first polls
  void pollPumpfunGraduated();
  void trackMigrationWallet();

  // Pump.fun v3: every 5 seconds
  setInterval(() => { void pollPumpfunGraduated(); }, 5_000);

  // Migration wallet: every 5 seconds
  setInterval(() => { void trackMigrationWallet(); }, 5_000);

  logger.info('Trenches scanner started (pump.fun v3 + migration wallet)');
}
