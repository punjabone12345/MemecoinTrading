import { queueMintWithSource } from './scanner.service.js';
import { logger } from '../lib/logger.js';

const PUMP_MIGRATION_WALLET = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const PUMP_FUN_API = 'https://frontend-api-v3.pump.fun';

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

let lastSeenSignature: string | null = null;
let initialized = false;
let pumpV3Seen = new Set<string>();
let lastPumpV3Fetch = 0;

async function rpcPost(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await res.json() as { result?: unknown };
  return data.result;
}

// ── Pump.fun v3 REST: recently graduated tokens ──────────────────────────────
async function pollGraduatedTokens(): Promise<void> {
  const now = Date.now();
  if (now - lastPumpV3Fetch < 30_000) return;
  lastPumpV3Fetch = now;

  try {
    const res = await fetch(
      `${PUMP_FUN_API}/coins?offset=0&limit=30&sort=last_reply&order=DESC&complete=true`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) return;
    const coins = await res.json() as Array<{ mint?: string; created_timestamp?: number }>;
    if (!Array.isArray(coins)) return;

    const cutoffMs = now - 24 * 60 * 60 * 1000;
    let added = 0;
    for (const c of coins) {
      const mint = c.mint;
      if (!mint || typeof mint !== 'string') continue;
      if ((c.created_timestamp ?? 0) < cutoffMs) continue; // skip tokens older than 24h
      if (pumpV3Seen.has(mint)) continue;
      pumpV3Seen.add(mint);
      queueMintWithSource(mint, 'trenches');
      added++;
    }
    if (pumpV3Seen.size > 5_000) {
      const arr = Array.from(pumpV3Seen);
      pumpV3Seen = new Set(arr.slice(arr.length - 2_000));
    }
    if (added > 0) logger.info({ added }, 'Trenches: pump.fun graduated mints queued');
  } catch (err: unknown) {
    logger.debug({ msg: (err as Error).message }, 'Trenches: pump.fun v3 fetch failed (non-fatal)');
  }
}

// ── Solana RPC: migration wallet transaction watcher ─────────────────────────
async function pollMigrationWallet(): Promise<void> {
  try {
    const opts: Record<string, unknown> = { limit: initialized ? 10 : 1 };
    if (lastSeenSignature && initialized) opts.until = lastSeenSignature;

    const sigs = await rpcPost('getSignaturesForAddress', [PUMP_MIGRATION_WALLET, opts]) as Array<{ signature: string }> | null;
    if (!Array.isArray(sigs) || sigs.length === 0) return;

    if (!initialized) {
      lastSeenSignature = sigs[0].signature;
      initialized = true;
      logger.info({ sig: lastSeenSignature.slice(0, 20) + '…' }, 'Trenches: migration wallet initialized');
      return;
    }

    const newest = sigs[0].signature;
    if (newest === lastSeenSignature) return;
    lastSeenSignature = newest;

    const mints: string[] = [];
    for (const { signature } of sigs) {
      try {
        const tx = await rpcPost('getTransaction', [
          signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
        ]) as { meta?: { preTokenBalances?: Array<{ mint: string }>; postTokenBalances?: Array<{ mint: string }> } } | null;
        if (!tx?.meta) continue;

        const balances = [
          ...(tx.meta.preTokenBalances ?? []),
          ...(tx.meta.postTokenBalances ?? []),
        ];
        for (const bal of balances) {
          const m = bal.mint;
          if (!m) continue;
          if (m === SOL_MINT || m === USDC_MINT || m === USDT_MINT) continue;
          if (!m.endsWith('pump')) continue;
          mints.push(m);
        }
      } catch { /* ignore individual tx errors */ }
    }

    const unique = [...new Set(mints)];
    for (const mint of unique) {
      queueMintWithSource(mint, 'trenches');
      logger.info({ mint: mint.slice(0, 16) + '…' }, 'Trenches: migration wallet → new mint');
    }
  } catch (err: unknown) {
    logger.debug({ msg: (err as Error).message }, 'Trenches: RPC poll failed (non-fatal)');
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────
export function startTrenchesTracker(): void {
  // Graduated tokens from pump.fun REST every 30s
  setInterval(() => { void pollGraduatedTokens(); }, 30_000);
  void pollGraduatedTokens();

  // Migration wallet via Solana RPC every 10s
  setInterval(() => { void pollMigrationWallet(); }, 10_000);
  void pollMigrationWallet();

  logger.info('Trenches tracker started (migration wallet + pump.fun graduated API)');
}
