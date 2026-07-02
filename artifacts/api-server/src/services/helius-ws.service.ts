import { WebSocket } from 'ws';
import { Connection } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { addMintSource } from './trenches.service.js';

// ── Meteora program IDs ───────────────────────────────────────────────────────
const METEORA_DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJmzeWAzdm2dvDk';
const METEORA_DAMM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';

// Pool-creation instruction keywords we look for in transaction logs
const POOL_CREATE_KEYWORDS = [
  'InitializeLbPair',
  'InitializePermissionlessLbPair',
  'InitializeCustomizablePermissionlessLbPair',
  'CreatePool',
  'InitializePool',
  'InitializePermissionlessPool',
  'initializeLbPair',
  'createPool',
];

const STABLE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// ── Activity feed ─────────────────────────────────────────────────────────────
export interface MeteoraEvent {
  mint: string;
  ts: number;
  txSig: string;
  poolAddress?: string;
  instructionType?: string;
  source: 'meteora_dlmm' | 'meteora_damm';
}

const meteoraMints = new Set<string>();
const meteoraFeed: MeteoraEvent[] = [];
const seenSigs = new Set<string>();

export function getMeteoraMintsCount(): number { return meteoraMints.size; }
export function getMeteoraFeed(): MeteoraEvent[] { return meteoraFeed.slice(0, 20); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectInstructionType(logs: string[]): string | undefined {
  for (const log of logs) {
    for (const kw of POOL_CREATE_KEYWORDS) {
      if (log.includes(kw)) return kw;
    }
  }
  return undefined;
}

function isPoolCreation(logs: string[]): boolean {
  return !!detectInstructionType(logs);
}

let conn: Connection | null = null;
function getConn(): Connection {
  if (!conn) {
    const rpc = process.env.RPC_ENDPOINT ?? 'https://api.mainnet-beta.solana.com';
    conn = new Connection(rpc, { commitment: 'confirmed' });
  }
  return conn;
}

// ── Per-signature processor ───────────────────────────────────────────────────
async function processSignature(
  sig: string,
  logs: string[],
  onMint: (mint: string) => void,
): Promise<void> {
  if (seenSigs.has(sig)) return;
  seenSigs.add(sig);
  // Cap seenSigs to prevent unbounded growth
  if (seenSigs.size > 10_000) {
    const arr = Array.from(seenSigs);
    arr.slice(0, 2000).forEach((s) => seenSigs.delete(s));
  }

  const instructionType = detectInstructionType(logs);
  const isDlmm = logs.some((l) => l.includes(METEORA_DLMM));
  const source: MeteoraEvent['source'] = isDlmm ? 'meteora_dlmm' : 'meteora_damm';

  try {
    const tx = await getConn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) return;

    // Extract accounts
    const accountKeys: any[] = (tx.transaction.message as any).accountKeys ?? [];
    const creatorWallet: string = accountKeys[0]?.pubkey?.toString() ?? accountKeys[0]?.toString() ?? '';

    // Pool address: first writable non-signer non-stable account (usually the pool PDA)
    let poolAddress: string | undefined;
    for (let i = 1; i < Math.min(accountKeys.length, 8); i++) {
      const addr = accountKeys[i]?.pubkey?.toString() ?? accountKeys[i]?.toString() ?? '';
      if (addr && addr !== creatorWallet && !STABLE_MINTS.has(addr) && addr.length > 30) {
        poolAddress = addr;
        break;
      }
    }

    // Collect new token mints from postTokenBalances
    const postBalances = tx.meta?.postTokenBalances ?? [];
    const mints: string[] = [];
    for (const bal of postBalances) {
      const mint = bal.mint;
      if (!mint || STABLE_MINTS.has(mint)) continue;
      if (!mints.includes(mint)) mints.push(mint);
    }

    // Rough liquidity estimate from postTokenBalances
    let liquidity = 0;
    for (const bal of postBalances) {
      const uiAmt = bal.uiTokenAmount?.uiAmount ?? 0;
      if (uiAmt > 0 && !STABLE_MINTS.has(bal.mint ?? '')) liquidity += uiAmt;
    }

    if (mints.length === 0) return;

    for (const mint of mints) {
      if (meteoraMints.has(mint)) continue;
      meteoraMints.add(mint);
      addMintSource(mint, 'meteora');
      onMint(mint);

      const ev: MeteoraEvent = {
        mint, ts: Date.now(), txSig: sig,
        poolAddress, instructionType, source,
      };
      meteoraFeed.unshift(ev);
      if (meteoraFeed.length > 20) meteoraFeed.pop();

      logger.info(
        { mint, sig: sig.slice(0, 16), poolAddress, instructionType, source },
        'Meteora: new pool detected',
      );

      // Persist to DB
      try {
        await query(`
          INSERT INTO detected_migrations
            (source, instruction_type, tx_signature, pool_address, mint, liquidity, creator_wallet)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (tx_signature) DO NOTHING
        `, [source, instructionType ?? null, sig, poolAddress ?? null, mint, liquidity, creatorWallet]);
      } catch (dbErr: any) {
        logger.debug({ msg: dbErr?.message }, 'Helius WS: DB insert skipped (non-fatal)');
      }
    }
  } catch (err: any) {
    logger.debug({ sig: sig.slice(0, 16), msg: err?.message }, 'Helius WS: tx fetch failed (non-fatal)');
  }
}

// ── Main watcher ──────────────────────────────────────────────────────────────
export function startHeliusWatcher(onMint: (mint: string) => void): void {
  const apiKey = process.env.HELIUS_API_KEY;
  const wsUrl = process.env.HELIUS_WS_URL
    ?? (apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);

  if (!wsUrl) {
    logger.warn('Helius WS: no HELIUS_API_KEY / HELIUS_WS_URL — Meteora watcher disabled (set key on Render to enable)');
    return;
  }

  const safeUrl = wsUrl.replace(/api-key=[^&?]+/, 'api-key=***');
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reqId = 1;

  function connect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }

    logger.info({ url: safeUrl }, 'Helius WS: connecting…');
    ws = new WebSocket(wsUrl!);

    ws.on('open', () => {
      logger.info('Helius WS: connected — subscribing to Meteora DLMM + DAMM');
      // Subscribe to DLMM pool creation logs
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: reqId++,
        method: 'logsSubscribe',
        params: [{ mentions: [METEORA_DLMM] }, { commitment: 'confirmed' }],
      }));
      // Subscribe to DAMM pool creation logs
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: reqId++,
        method: 'logsSubscribe',
        params: [{ mentions: [METEORA_DAMM] }, { commitment: 'confirmed' }],
      }));
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Subscription confirmation
        if (msg.result !== undefined && typeof msg.result === 'number') {
          logger.info({ subId: msg.result, reqId: msg.id }, 'Helius WS: subscription confirmed');
          return;
        }

        if (msg.method !== 'logsNotification') return;
        const value = msg.params?.result?.value;
        if (!value || value.err !== null) return;

        const sig: string = value.signature;
        const logs: string[] = value.logs ?? [];

        if (!isPoolCreation(logs)) return;
        void processSignature(sig, logs, onMint);
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => {
      logger.debug({ msg: err.message }, 'Helius WS: connection error');
    });

    ws.on('close', () => {
      logger.info('Helius WS: disconnected — reconnecting in 10s');
      ws = null;
      reconnectTimer = setTimeout(connect, 10_000);
    });
  }

  connect();
  logger.info('Helius WS watcher started (Meteora DLMM + DAMM)');
}
