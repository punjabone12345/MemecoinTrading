import { Connection, PublicKey } from '@solana/web3.js';
import { WebSocket } from 'ws';
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
export function getPumpfunFeed(): DiscoveryEvent[] { return pumpfunFeed.slice(0, MAX_FEED); }

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

// Keywords that identify migration-related instructions in transaction logs
const MIGRATION_KEYWORDS = ['migrate', 'Migrate', 'MigrateV2', 'migrateV2', 'migrate_v2', 'PoolCreate', 'pool_create', 'CreatePool'];

let lastSeenSig: string | null = null;
let lastPollSuccess = Date.now();
let consecutivePollFailures = 0;
let isBootstrap = true; // only true on first server start — never set back to true
let connection: Connection | null = null;

function getConnection(): Connection {
  if (!connection) {
    // Prefer Helius HTTP RPC to avoid public RPC rate limits.
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpc = process.env.RPC_ENDPOINT
      ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : 'https://api.mainnet-beta.solana.com');
    connection = new Connection(rpc, { commitment: 'confirmed' });
  }
  return connection;
}

// Callback invoked whenever a new mint is discovered from the migration wallet
let onNewMint: ((mint: string) => void) | null = null;
export function setOnNewMint(cb: (mint: string) => void): void {
  onNewMint = cb;
}

// Callback invoked with full graduation context (for whale sniper)
let onGraduation: ((ev: { mint: string; poolAddress?: string; ts: number }) => void) | null = null;
export function setOnGraduation(cb: (ev: { mint: string; poolAddress?: string; ts: number }) => void): void {
  onGraduation = cb;
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
  // Watchdog: if poll has been failing for >90s, reset cursor + Connection.
  // NOTE: isBootstrap is intentionally NOT reset here — after a watchdog recovery
  // we want to PROCESS any migrations we missed, not skip them.
  if (consecutivePollFailures > 0 && Date.now() - lastPollSuccess > 90_000) {
    logger.warn(
      { failures: consecutivePollFailures, staleSec: Math.round((Date.now() - lastPollSuccess) / 1_000) },
      'PumpFun wallet: poll stalled — resetting cursor to force full refetch',
    );
    lastSeenSig = null;
    connection = null;
  }

  try {
    const conn = getConnection();
    const pk = new PublicKey(MIGRATION_WALLET);

    // Always fetch the latest 20 sigs — no `until` param (unreliable on public RPC,
    // causes 429 errors immediately after startup on free-tier endpoints).
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 20 });

    // Mark poll as successful regardless of whether there are new sigs
    lastPollSuccess = Date.now();
    consecutivePollFailures = 0;

    if (!sigs.length) return;

    // ── Bootstrap: first call after server startup ────────────────────────────
    // Set the cursor to "now" without processing any historical migrations.
    // Only new migrations that arrive AFTER startup will be tracked.
    if (isBootstrap) {
      isBootstrap = false;
      lastSeenSig = sigs[0].signature;
      logger.info(
        { cursor: lastSeenSig.slice(0, 16) },
        'PumpFun wallet: cursor initialised — tracking new migrations from this point forward',
      );
      return;
    }

    // ── Normal poll: find sigs newer than our last checkpoint ─────────────────
    const newSigs: string[] = [];
    for (const sig of sigs) {
      if (sig.signature === lastSeenSig) break; // reached already-seen boundary
      if (!sig.err) newSigs.push(sig.signature);
    }
    lastSeenSig = sigs[0].signature; // advance cursor to newest

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
        // Use actual on-chain blockTime so the whale sniper can filter stale backfill events
        const txTs = (tx.blockTime ?? 0) > 0 ? (tx.blockTime! * 1_000) : Date.now();
        pushFeed(pumpfunFeed, { mint, ts: txTs, txSig: sig, instructionType, poolAddress, creatorWallet });
        if (onNewMint) onNewMint(mint);
        if (onGraduation) onGraduation({ mint, poolAddress, ts: txTs });

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
    consecutivePollFailures++;
    const staleSec = Math.round((Date.now() - lastPollSuccess) / 1_000);
    if (consecutivePollFailures === 1 || consecutivePollFailures % 6 === 0) {
      // Log immediately on first failure, then every ~30s (6 × 5s interval)
      logger.warn(
        { msg: err?.message, failures: consecutivePollFailures, staleSec },
        'PumpFun wallet: RPC poll failed — migration detection paused',
      );
    }
  }
}

// ── Scanner lifecycle ─────────────────────────────────────────────────────────
let started = false;

// ── Real-time Helius WebSocket subscription to the migration wallet ───────────
// Subscribes to logsSubscribe for the migration wallet so we get notified
// immediately when it signs a transaction, instead of waiting for the 5s poll.
// On notification, we enqueue the tx signature for async processing — the same
// path used by the HTTP poller, so deduplication (lastSeenSig) still works.

const wsSeen = new Set<string>();

function startMigrationWalletWS(): void {
  const apiKey = process.env.HELIUS_API_KEY;
  const wsUrl  = process.env.HELIUS_WS_URL
    ?? (apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);

  if (!wsUrl) {
    logger.info('PumpFun WS: no HELIUS_API_KEY — real-time migration wallet subscription disabled (polling only)');
    return;
  }

  let ws: WebSocket | null  = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reqId = 1;

  async function processMigrationSig(sig: string): Promise<void> {
    if (wsSeen.has(sig)) return;
    wsSeen.add(sig);
    if (wsSeen.size > 5_000) {
      const arr = Array.from(wsSeen);
      arr.slice(0, 1000).forEach(s => wsSeen.delete(s));
    }

    try {
      const conn = getConnection();
      const tx   = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx || tx.meta?.err) return;

      const logs            = tx.meta?.logMessages ?? [];
      const instructionType = detectMigrationInstructionType(logs);

      // Only process genuine migration/pool-create instructions
      const lowerLogs = logs.join(' ').toLowerCase();
      const isMigration =
        lowerLogs.includes('migrate') ||
        lowerLogs.includes('pool_create') ||
        lowerLogs.includes('createpool') ||
        lowerLogs.includes('poolcreate');
      if (!isMigration) return;

      const accountKeys: any[] = (tx.transaction.message as any).accountKeys ?? [];
      const creatorWallet: string = accountKeys[0]?.pubkey?.toString() ?? accountKeys[0]?.toString() ?? '';

      let poolAddress: string | undefined;
      for (let j = 1; j < Math.min(accountKeys.length, 8); j++) {
        const addr = accountKeys[j]?.pubkey?.toString() ?? accountKeys[j]?.toString() ?? '';
        if (addr && addr !== creatorWallet && !STABLE_MINTS.has(addr) && addr.length > 30) {
          poolAddress = addr;
          break;
        }
      }

      const balances = tx.meta?.postTokenBalances ?? [];
      for (const bal of balances) {
        const mint = bal.mint;
        if (!mint || mint.length < 20 || STABLE_MINTS.has(mint)) continue;

        pumpfunMints.add(mint);
        const isNew = addMintSource(mint, 'pumpfun');
        if (!isNew) continue;

        const wsTxTs = (tx.blockTime ?? 0) > 0 ? (tx.blockTime! * 1_000) : Date.now();
        pushFeed(pumpfunFeed, { mint, ts: wsTxTs, txSig: sig, instructionType, poolAddress, creatorWallet });
        if (onNewMint) onNewMint(mint);
        if (onGraduation) onGraduation({ mint, poolAddress, ts: wsTxTs });

        logger.info(
          { mint, sig: sig.slice(0, 16), instructionType, poolAddress: poolAddress?.slice(0, 16), source: 'helius_ws' },
          'PumpFun WS: real-time migration detected',
        );

        query(`
          INSERT INTO detected_migrations
            (source, instruction_type, tx_signature, pool_address, mint, creator_wallet)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tx_signature) DO NOTHING
        `, ['pumpfun_ws', instructionType, sig, poolAddress ?? null, mint, creatorWallet])
          .catch((e: any) => logger.debug({ msg: e?.message }, 'PumpFun WS: DB insert skipped'));
      }
    } catch (err: any) {
      logger.debug({ sig: sig.slice(0, 16), msg: err?.message }, 'PumpFun WS: tx fetch failed');
    }
  }

  function connect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pingTimer)      { clearInterval(pingTimer); pingTimer = null; }
    if (ws)             { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }

    logger.info('PumpFun WS: connecting to Helius for real-time migration wallet monitoring…');
    ws = new WebSocket(wsUrl!);

    ws.on('open', () => {
      // Subscribe to logs for the migration wallet
      ws!.send(JSON.stringify({
        jsonrpc: '2.0', id: reqId++,
        method: 'logsSubscribe',
        params: [{ mentions: [MIGRATION_WALLET] }, { commitment: 'confirmed' }],
      }));

      // Keep-alive ping
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99998, method: 'getHealth' }));
        }
      }, 30_000);

      logger.info('PumpFun WS: subscribed to migration wallet logs');
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.result !== undefined && typeof msg.result === 'number') {
          logger.info({ subId: msg.result }, 'PumpFun WS: subscription confirmed');
          return;
        }
        if (msg.method !== 'logsNotification') return;
        const value = msg.params?.result?.value;
        if (!value || value.err !== null) return;

        const sig: string  = value.signature;
        const logs: string[] = value.logs ?? [];

        // Quick pre-filter: skip if no migration keyword in raw logs
        const logText = logs.join(' ').toLowerCase();
        const hasMigration =
          logText.includes('migrate') ||
          logText.includes('pool_create') ||
          logText.includes('poolcreate') ||
          logText.includes('createpool');
        if (!hasMigration) return;

        processMigrationSig(sig).catch(() => {});
      } catch { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => {
      logger.warn({ msg: err.message }, 'PumpFun WS: connection error');
    });

    ws.on('close', () => {
      logger.info('PumpFun WS: disconnected — reconnecting in 15s');
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      ws = null;
      reconnectTimer = setTimeout(connect, 15_000);
    });
  }

  connect();
}

export function startTrenchesScanner(): void {
  if (started) return;
  started = true;

  // Real-time WebSocket subscription (primary, instant)
  startMigrationWalletWS();

  // Polling fallback (catches any WS gaps)
  void trackMigrationWallet();
  setInterval(() => { void trackMigrationWallet(); }, 5_000);

  logger.info('PumpFun migration wallet tracker started (real-time WS + 5s poll fallback)');
}
