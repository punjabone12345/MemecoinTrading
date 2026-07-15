import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { withHeliusLimit, isHeliusCoolingDown, isRateLimitedError } from '../lib/helius-limiter.js';
import { subscribeLogs, isHeliusWsConfigured } from '../lib/helius-ws-shared.js';

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
let sessionStartMs = 0; // set to Date.now() each time the scanner starts — graduations older than this are ignored
let lastPollError: string | null = null; // last error message for diagnostics
let connection: Connection | null = null;

// ── Poll backoff state ────────────────────────────────────────────────────────
// Dynamic scheduling: backs off on 429/failures, resets to 5s on success.
const POLL_NORMAL_MS = 5_000;
const POLL_MAX_MS    = 120_000;
let   pollDelayMs    = POLL_NORMAL_MS;
let   pollTimer: ReturnType<typeof setTimeout> | null = null;

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

// Callback invoked with full graduation context (for sniper engine)
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

// Direct JSON-RPC fetch for getSignaturesForAddress.
// Uses direct fetch() (bypasses @solana/web3.js Connection bugs on Render).
// Tries Helius first; on 429 / credit exhaustion falls back to public RPC
// so the trenches poll still works even if the Helius key is rate-limited.
// This call is very light (1 request every ~5s on a single address), so the
// public RPC can handle it without trouble.
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

async function rpcGetSignaturesOnce(
  endpoint: string,
  opts: { limit: number; until?: string },
): Promise<Array<{ signature: string; err: unknown; blockTime?: number | null }>> {
  const params: any[] = [MIGRATION_WALLET, { limit: opts.limit, commitment: 'confirmed' }];
  if (opts.until) params[1].until = opts.until;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error(`429: ${text}`), { code: -32429 });
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json: any = await res.json();
  if (json.error) {
    const msg = String(json.error.message ?? '');
    if (json.error.code === -32429 || msg.includes('429') || msg.includes('max usage')) {
      throw Object.assign(new Error(`RPC 429: ${msg}`), { code: -32429 });
    }
    throw new Error(`RPC error ${json.error.code}: ${msg}`);
  }

  return json.result ?? [];
}

async function rpcGetSignatures(
  opts: { limit: number; until?: string },
): Promise<Array<{ signature: string; err: unknown; blockTime?: number | null }>> {
  const heliusKey = process.env.HELIUS_API_KEY;
  const primary   = process.env.RPC_ENDPOINT
    ?? (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : PUBLIC_RPC);

  try {
    return await rpcGetSignaturesOnce(primary, opts);
  } catch (err: any) {
    // On 429 / credit exhaustion from Helius, fall back to public RPC.
    // This keeps the graduation poll running even when the Helius key is
    // consumed by other services (sniper engine, Meteora watcher).
    const is429 = (e: any) =>
      e?.code === -32429 ||
      String(e?.message ?? '').includes('429') ||
      String(e?.message ?? '').toLowerCase().includes('max usage');

    if (is429(err) && primary !== PUBLIC_RPC) {
      logger.warn(
        { msg: err?.message?.slice(0, 80) },
        'PumpFun poll: Helius 429 — falling back to public RPC for getSignaturesForAddress',
      );
      return rpcGetSignaturesOnce(PUBLIC_RPC, opts);
    }
    throw err;
  }
}

async function trackMigrationWallet(): Promise<void> {
  // Watchdog: if poll has been failing for >90s, reset cursor.
  if (consecutivePollFailures > 0 && Date.now() - lastPollSuccess > 90_000) {
    logger.warn(
      { failures: consecutivePollFailures, staleSec: Math.round((Date.now() - lastPollSuccess) / 1_000) },
      'PumpFun wallet: poll stalled — resetting cursor to force full refetch',
    );
    lastSeenSig = null;
    connection = null;
  }

  // Helpers to detect Helius rate-limit responses
  const is429 = (err: any): boolean =>
    isRateLimitedError(err) ||
    String(err?.message ?? '').includes('429') ||
    err?.code === -32429;

  // Skip this cycle entirely while the shared Helius cooldown is active.
  if (isHeliusCoolingDown()) return;

  try {
    // Fetch sigs since the last checkpoint via direct fetch() (more reliable
    // than @solana/web3.js Connection on some Render deployments).
    // When we have a cursor (lastSeenSig), use `until` so we get EVERY sig since
    // then — AMM: Buy bursts cannot push migrate_v2 out of a fixed window.
    const sigOpts = lastSeenSig
      ? { until: lastSeenSig, limit: 200 }
      : { limit: 50 };
    // Wrap in withHeliusLimit so a 429 from this call triggers the shared
    // global cooldown and pauses all other Helius HTTP calls too.
    const sigs = await withHeliusLimit(() => rpcGetSignatures(sigOpts));

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

    // ── Normal poll: all returned sigs are newer than lastSeenSig (until param) ─
    // When using `until`, the RPC never includes lastSeenSig itself, so every
    // entry in `sigs` is guaranteed to be a new transaction.
    const newSigs: string[] = sigs.filter(s => !s.err).map(s => s.signature);

    if (!newSigs.length) {
      // No new non-errored sigs — advance cursor to the current head so the
      // next poll uses `until: sigs[0]` and doesn't re-scan the same window.
      if (sigs.length) lastSeenSig = sigs[0].signature;
      return;
    }

    // newSigs is newest-first. Reverse to oldest-first so we can advance the
    // cursor through a contiguous block starting from the oldest new sig.
    // Process ALL new sigs (not just 5) so overflow from burst activity or
    // post-restart catch-up is never silently dropped.
    // If sig[i] returns null, sig[i] and everything newer is retried next poll.
    const toFetch = [...newSigs].reverse(); // oldest-first, full batch (no slice limit)

    const conn = getConnection();
    const txns = await Promise.all(
      toFetch.map((sig) =>
        withHeliusLimit(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }))
          .catch(() => null),
      ),
    );

    // Advance cursor through the contiguous leading block of successful fetches
    // (oldest-first). Stop at the first null — that sig and every newer sig in
    // this batch will be retried on the next poll because the cursor stops
    // *before* them. Setting lastSeenSig to an older sig keeps those newer sigs
    // in the "newer than cursor" window on the next getSignaturesForAddress call.
    for (let i = 0; i < toFetch.length; i++) {
      if (txns[i] === null) {
        logger.debug(
          { sig: toFetch[i].slice(0, 16), stoppedAt: i },
          'PumpFun poll: tx fetch null (rate-limited?) — cursor held before this sig, will retry',
        );
        break;
      }
      lastSeenSig = toFetch[i]; // oldest-first → cursor advances toward newest
    }

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
        // Use actual on-chain blockTime so the sniper engine can filter stale backfill events
        const txTs = (tx.blockTime ?? 0) > 0 ? (tx.blockTime! * 1_000) : Date.now();
        pushFeed(pumpfunFeed, { mint, ts: txTs, txSig: sig, instructionType, poolAddress, creatorWallet });
        if (onNewMint) onNewMint(mint);
        if (txTs < sessionStartMs) {
          logger.debug({ mint, txTs, sessionStartMs }, 'PumpFun poll: skipping pre-session graduation');
        } else {
          if (onGraduation) onGraduation({ mint, poolAddress, ts: txTs });
        }

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
    // On success: reset poll delay to normal cadence
    pollDelayMs = POLL_NORMAL_MS;
  } catch (err: any) {
    consecutivePollFailures++;
    lastPollError = String(err?.message ?? err ?? 'unknown');
    const staleSec = Math.round((Date.now() - lastPollSuccess) / 1_000);

    // Detect Helius 429 / rate-limit and back off aggressively.
    // Normal failures use a gentler exponential ramp.
    if (is429(err)) {
      pollDelayMs = Math.min(pollDelayMs * 2, POLL_MAX_MS);
      logger.warn(
        { msg: err?.message, failures: consecutivePollFailures, staleSec, nextPollSec: Math.round(pollDelayMs / 1_000) },
        'PumpFun wallet: RPC 429 rate-limited — backing off poll',
      );
    } else {
      // Log EVERY failure (not just 1st and every 6th) so we can diagnose
      pollDelayMs = Math.min(pollDelayMs * 2, POLL_MAX_MS);
      logger.warn(
        { msg: err?.message, failures: consecutivePollFailures, staleSec, nextPollSec: Math.round(pollDelayMs / 1_000) },
        'PumpFun wallet: RPC poll failed — backing off',
      );
    }
  }
}

function schedulePoll(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!started) return; // don't reschedule after stopTrenchesScanner()
  pollTimer = setTimeout(async () => {
    await trackMigrationWallet();
    schedulePoll(); // reschedule after each run (uses current pollDelayMs)
  }, pollDelayMs);
}

// ── Scanner lifecycle ─────────────────────────────────────────────────────────
let started = false;
let wsUnsubMigration: (() => void) | null = null;

// ── Real-time Helius WebSocket subscription to the migration wallet ───────────
// Subscribes to logsSubscribe for the migration wallet so we get notified
// immediately when it signs a transaction, instead of waiting for the 5s poll.
// On notification, we enqueue the tx signature for async processing — the same
// path used by the HTTP poller, so deduplication (lastSeenSig) still works.

const wsSeen = new Set<string>();

function startMigrationWalletWS(): void {
  if (!isHeliusWsConfigured()) {
    logger.info('PumpFun WS: no HELIUS_API_KEY — real-time migration wallet subscription disabled (polling only)');
    return;
  }

  async function processMigrationSig(sig: string): Promise<void> {
    if (wsSeen.has(sig)) return;
    wsSeen.add(sig);
    if (wsSeen.size > 5_000) {
      const arr = Array.from(wsSeen);
      arr.slice(0, 1000).forEach(s => wsSeen.delete(s));
    }

    try {
      if (isHeliusCoolingDown()) { wsSeen.delete(sig); return; }
      const conn = getConnection();
      const tx   = await withHeliusLimit(() => conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }));
      if (!tx) {
        // null means the RPC couldn't return the tx yet (rate-limited or not yet propagated).
        // Remove from wsSeen so the 5s poll fallback can retry it on the next tick.
        wsSeen.delete(sig);
        return;
      }
      if (tx.meta?.err) return;

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
        if (wsTxTs >= sessionStartMs) {
          if (onGraduation) onGraduation({ mint, poolAddress, ts: wsTxTs });
        }

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

  // Subscribe to migration-wallet logs via the shared Helius WS connection
  // (avoids opening a second dedicated socket that competes for the single
  // concurrent-connection slot Helius allows per API key).
  wsUnsubMigration = subscribeLogs([MIGRATION_WALLET], (value) => {
    if (value.err !== null) return;

    const sig: string = value.signature;

    // No keyword pre-filter here — the migration wallet is dedicated to
    // migrations and we must not silently drop events whose log format
    // differs from what we expect (e.g. new PumpSwap instruction names).
    // processMigrationSig already validates the tx content before emitting.
    processMigrationSig(sig).catch(() => {});
  }, 'confirmed');

  logger.info('PumpFun WS: subscribed to migration wallet logs via shared connection');
}

// ── Diagnostics (for /api/debug) ─────────────────────────────────────────────
export function getTrenchesDiagnostics() {
  return {
    isBootstrap,
    lastSeenSig: lastSeenSig ? lastSeenSig.slice(0, 16) + '…' : null,
    lastPollSuccessMs: lastPollSuccess,
    lastPollAgoSec: Math.round((Date.now() - lastPollSuccess) / 1_000),
    consecutivePollFailures,
    lastPollError,
    pollDelayMs,
    pumpfunMintsTotal: pumpfunMints.size,
    heliusWsConfigured: isHeliusWsConfigured(),
    heliusApiKeySet: !!process.env.HELIUS_API_KEY,
    rpcEndpoint: process.env.RPC_ENDPOINT ?? (process.env.HELIUS_API_KEY ? 'helius-http' : 'public-mainnet'),
    recentFeed: pumpfunFeed.slice(0, 5).map(e => ({ mint: e.mint.slice(0, 12), instructionType: e.instructionType, ts: e.ts })),
  };
}

export function stopTrenchesScanner(): void {
  if (!started) return;
  started = false;
  // Stop polling loop
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  // Unsubscribe from Helius WS
  if (wsUnsubMigration) { wsUnsubMigration(); wsUnsubMigration = null; }
  logger.info('PumpFun migration wallet tracker stopped');
}

export function startTrenchesScanner(): void {
  if (started) return;
  started = true;

  // Record when this session started — used to drop graduations whose on-chain
  // blockTime predates the session start (old coins that slip through the cursor).
  sessionStartMs = Date.now();

  // Real-time WebSocket subscription (primary, instant)
  startMigrationWalletWS();

  // Polling fallback — dynamic scheduling with exponential backoff on failures.
  // pollDelayMs starts at 5s, backs off to 120s on repeated 429s, resets on success.
  const runFirstPoll = async () => { await trackMigrationWallet(); schedulePoll(); };
  void runFirstPoll();

  logger.info('PumpFun migration wallet tracker started (real-time WS + dynamic-poll fallback)');
}
