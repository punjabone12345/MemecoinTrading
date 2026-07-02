import { WebSocket } from 'ws';
import { Connection } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { addMintSource } from './trenches.service.js';

// ── Meteora program IDs ───────────────────────────────────────────────────────
const METEORA_DLMM  = 'LBUZKhRxPF3XUpBCjp4YzTKgLLjggiJmzeWAzdm2dvDk';
const METEORA_DAMM  = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const METEORA_DAMM2 = 'cpamdpZCGKUy9UkCFzViU6SKQqoNoEVhpzTzG6ypGVj'; // DAMM v2 / cpAMM

const STABLE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',   // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
]);

// ── Activity feed ─────────────────────────────────────────────────────────────
export interface MeteoraEvent {
  mint: string;
  ts: number;
  txSig: string;
  poolAddress?: string;
  instructionType?: string;
  source: 'meteora_dlmm' | 'meteora_damm' | 'meteora_damm2';
}

const meteoraMints = new Set<string>();
const meteoraFeed: MeteoraEvent[] = [];
const seenSigs = new Set<string>();

export function getMeteoraMintsCount(): number { return meteoraMints.size; }
export function getMeteoraMintsSet(): Set<string> { return meteoraMints; }
export function getMeteoraFeed(): MeteoraEvent[] { return meteoraFeed.slice(0, 20); }

// ── Concurrency limiter ───────────────────────────────────────────────────────
let inflight = 0;
const MAX_INFLIGHT = 8;
const sigQueue: Array<{ sig: string; source: MeteoraEvent['source']; onMint: (mint: string) => void }> = [];

function drainQueue(): void {
  while (sigQueue.length > 0 && inflight < MAX_INFLIGHT) {
    const item = sigQueue.shift()!;
    inflight++;
    processSignature(item.sig, item.source, item.onMint).finally(() => {
      inflight--;
      drainQueue();
    });
  }
}

function enqueue(sig: string, source: MeteoraEvent['source'], onMint: (mint: string) => void): void {
  if (seenSigs.has(sig)) return;
  seenSigs.add(sig);
  if (seenSigs.size > 10_000) {
    const arr = Array.from(seenSigs);
    arr.slice(0, 2000).forEach((s) => seenSigs.delete(s));
  }
  sigQueue.push({ sig, source, onMint });
  if (sigQueue.length > 200) sigQueue.splice(0, sigQueue.length - 200); // drop oldest if overloaded
  drainQueue();
}

// ── Extract instruction type specifically from a Meteora program's invoke block ──
// The naive approach (first "Instruction:" in logs) breaks because complex txs run
// SPL Token / System instructions before Meteora — returning "InitializeAccount" or
// "Transfer" instead of the actual Meteora instruction ("AddLiquidityByStrategy",
// "Swap", etc.).  We scan forward from the Meteora program's "invoke" log line.
function extractMeteoraInstructionType(logs: string[], programId: string): string | undefined {
  for (let i = 0; i < logs.length; i++) {
    if (logs[i].includes(programId) && logs[i].toLowerCase().includes('invoke')) {
      for (let j = i + 1; j < Math.min(i + 5, logs.length); j++) {
        if (logs[j].includes('Instruction:')) {
          const parts = logs[j].split('Instruction:');
          if (parts[1]) return parts[1].trim().split(/\s+/)[0];
        }
      }
    }
  }
  return undefined;
}

// ── Per-signature processor ───────────────────────────────────────────────────
let conn: Connection | null = null;
function getConn(): Connection {
  if (!conn) {
    // Prefer Helius HTTP RPC (same key as the WS) — avoids public RPC rate limits.
    // Falls back to explicit RPC_ENDPOINT, then public mainnet as last resort.
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpc = process.env.RPC_ENDPOINT
      ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com');
    conn = new Connection(rpc, { commitment: 'confirmed' });
    logger.info({ rpc: rpc.replace(/api-key=[^&?]+/, 'api-key=***') }, 'Helius WS: using RPC for tx fetch');
  }
  return conn;
}

async function processSignature(
  sig: string,
  source: MeteoraEvent['source'],
  onMint: (mint: string) => void,
): Promise<void> {
  try {
    const tx = await getConn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx) return;

    const accountKeys: any[] = (tx.transaction.message as any).accountKeys ?? [];
    const creatorWallet: string = accountKeys[0]?.pubkey?.toString() ?? accountKeys[0]?.toString() ?? '';

    // Pool address heuristic: first writable non-signer non-stable account
    let poolAddress: string | undefined;
    for (let i = 1; i < Math.min(accountKeys.length, 8); i++) {
      const addr = accountKeys[i]?.pubkey?.toString() ?? accountKeys[i]?.toString() ?? '';
      if (addr && addr !== creatorWallet && !STABLE_MINTS.has(addr) && addr.length > 30) {
        poolAddress = addr;
        break;
      }
    }

    // Detect pool-creation vs swap:
    // In a pool creation, new token accounts are initialized → mint appears in
    // postTokenBalances but NOT in preTokenBalances (account didn't exist before).
    // In a swap, both pre and post balances contain the same mints.
    const preBalances  = tx.meta?.preTokenBalances  ?? [];
    const postBalances = tx.meta?.postTokenBalances ?? [];
    const preMints = new Set(preBalances.map((b) => b.mint).filter(Boolean));

    const mints: string[] = [];
    for (const bal of postBalances) {
      const mint = bal.mint;
      if (!mint || STABLE_MINTS.has(mint)) continue;
      // Only include mints that are NEW in post (not present in pre) → pool creation
      if (preMints.has(mint)) continue;
      if (!mints.includes(mint)) mints.push(mint);
    }

    if (mints.length === 0) return; // no new token accounts (swap or unrelated tx)

    // Try to infer instruction type from inner instructions / logs
    const logMessages: string[] = (tx.meta as any)?.logMessages ?? [];

    // Determine which program ID fired this notification so we look at the right invoke block
    const programId = source === 'meteora_dlmm' ? METEORA_DLMM
      : source === 'meteora_damm2' ? METEORA_DAMM2 : METEORA_DAMM;
    const instructionType = extractMeteoraInstructionType(logMessages, programId);
    const allLogText = logMessages.join(' ').toLowerCase();

    if (instructionType) {
      const inst = instructionType.toLowerCase();
      // Known non-creation → always skip
      const isNonCreation =
        inst.startsWith('swap') ||
        inst.includes('addliq') ||
        inst.includes('add_liq') ||
        inst.includes('removeliq') ||
        inst.includes('remove_liq') ||
        inst.includes('claim') ||
        inst.includes('deposit') ||
        inst.includes('withdraw') ||
        inst.includes('transfer') ||
        inst.includes('position') ||   // InitializePosition, ClosePosition etc.
        inst.includes('close') ||
        inst.includes('fund') ||
        inst.includes('bootstrap') ||
        inst.includes('binarray') ||   // InitializeBinArray (internal book-keeping)
        inst.includes('bin_array');
      if (isNonCreation) {
        logger.debug({ sig: sig.slice(0, 16), instructionType, source }, 'Helius WS: skipping non-creation instruction');
        return;
      }
      // Known creation → allow through
      const isCreation =
        inst.includes('initialize') || inst.includes('create') || inst.includes('init');
      if (!isCreation) {
        // Unknown instruction for this program — skip conservatively
        logger.debug({ sig: sig.slice(0, 16), instructionType, source }, 'Helius WS: unknown instruction, skipping');
        return;
      }
    } else {
      // Could not locate Meteora invoke block in logs — use full-text scan as fallback
      const hasNonCreation =
        allLogText.includes('instruction: swap') ||
        allLogText.includes('instruction: addliquidity') ||
        allLogText.includes('instruction: removeliquidity') ||
        allLogText.includes('instruction: claimfee') ||
        allLogText.includes('instruction: closeposition');
      if (hasNonCreation) return;

      // If logs are substantial but have no pool-creation keyword, skip conservatively
      const hasCreation =
        allLogText.includes('initializelbpair') ||
        allLogText.includes('initialize_lb_pair') ||
        allLogText.includes('createpool') ||
        allLogText.includes('create_pool') ||
        allLogText.includes('createpermissionless') ||
        allLogText.includes('createpermissioned');
      if (logMessages.length > 5 && !hasCreation) {
        logger.debug({ sig: sig.slice(0, 16), source }, 'Helius WS: no creation keyword in logs, skipping');
        return;
      }
    }

    // Rough liquidity estimate
    let liquidity = 0;
    for (const bal of postBalances) {
      const uiAmt = bal.uiTokenAmount?.uiAmount ?? 0;
      if (uiAmt > 0 && !STABLE_MINTS.has(bal.mint ?? '')) liquidity += uiAmt;
    }

    for (const mint of mints) {
      if (meteoraMints.has(mint)) continue; // already seen from this source
      meteoraMints.add(mint);
      addMintSource(mint, 'meteora');
      onMint(mint);

      const ev: MeteoraEvent = { mint, ts: Date.now(), txSig: sig, poolAddress, instructionType, source };
      meteoraFeed.unshift(ev);
      if (meteoraFeed.length > 20) meteoraFeed.pop();

      logger.info(
        { mint, sig: sig.slice(0, 16), poolAddress: poolAddress?.slice(0, 16), instructionType, source },
        'Meteora: new token detected',
      );

      // Persist to DB (non-fatal)
      query(`
        INSERT INTO detected_migrations
          (source, instruction_type, tx_signature, pool_address, mint, liquidity, creator_wallet)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tx_signature) DO NOTHING
      `, [source, instructionType ?? null, sig, poolAddress ?? null, mint, liquidity, creatorWallet])
        .catch((e: any) => logger.debug({ msg: e?.message }, 'Helius WS: DB insert skipped'));
    }
  } catch (err: any) {
    logger.warn({ sig: sig.slice(0, 16), msg: err?.message }, 'Helius WS: tx fetch failed');
  }
}

// ── Main watcher ──────────────────────────────────────────────────────────────
export function startHeliusWatcher(onMint: (mint: string) => void): void {
  const apiKey = process.env.HELIUS_API_KEY;
  const wsUrl = process.env.HELIUS_WS_URL
    ?? (apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);

  if (!wsUrl) {
    logger.warn(
      'Helius WS: no HELIUS_API_KEY / HELIUS_WS_URL — Meteora watcher disabled (set key on Render to enable)',
    );
    return;
  }

  const safeUrl = wsUrl.replace(/api-key=[^&?]+/, 'api-key=***');
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reqId = 1;

  // Keep-alive ping every 30s
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function connect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }

    logger.info({ url: safeUrl }, 'Helius WS: connecting…');
    ws = new WebSocket(wsUrl!);

    ws.on('open', () => {
      logger.info('Helius WS: connected — subscribing to Meteora DLMM + DAMM + DAMM-v2');

      // Subscribe to all three Meteora programs
      for (const programId of [METEORA_DLMM, METEORA_DAMM, METEORA_DAMM2]) {
        ws!.send(JSON.stringify({
          jsonrpc: '2.0', id: reqId++,
          method: 'logsSubscribe',
          params: [{ mentions: [programId] }, { commitment: 'confirmed' }],
        }));
      }

      // Keep-alive ping
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99999, method: 'getHealth' }));
        }
      }, 30_000);
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Subscription confirmations
        if (msg.result !== undefined && typeof msg.result === 'number') {
          logger.info({ subId: msg.result, reqId: msg.id }, 'Helius WS: subscription confirmed');
          return;
        }

        if (msg.method !== 'logsNotification') return;
        const value = msg.params?.result?.value;
        // Skip failed transactions
        if (!value || value.err !== null) return;

        const sig: string = value.signature;
        const logs: string[] = value.logs ?? [];

        // Detect which program triggered this notification
        const isDlmm  = logs.some((l) => l.includes(METEORA_DLMM));
        const isDamm2 = logs.some((l) => l.includes(METEORA_DAMM2));
        const source: MeteoraEvent['source'] = isDlmm ? 'meteora_dlmm'
          : isDamm2 ? 'meteora_damm2' : 'meteora_damm';

        // Queue for async processing (no keyword filter — structural guard in processSignature)
        enqueue(sig, source, onMint);
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => {
      logger.warn({ msg: err.message }, 'Helius WS: connection error');
    });

    ws.on('close', () => {
      logger.info('Helius WS: disconnected — reconnecting in 10s');
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      ws = null;
      reconnectTimer = setTimeout(connect, 10_000);
    });
  }

  connect();
  logger.info('Helius WS watcher started (Meteora DLMM + DAMM + DAMM-v2)');
}
