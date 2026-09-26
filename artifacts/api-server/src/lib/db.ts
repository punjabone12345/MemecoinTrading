import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
});

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr?.code === '53100') {
      logger.warn({ message: pgErr.message, sql: sql.slice(0, 100) }, 'DB storage quota exceeded (code 53100) - write suppressed');
      return [] as T[];
    }
    logger.error({ err, sql }, 'DB query error');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Same as `query`, but for migration statements that are EXPECTED to fail on
 * a fresh or already-migrated DB (e.g. "RENAME COLUMN x" when x was already
 * renamed, or never existed). Swallows the error without the ERROR-level log
 * `query()` emits — that log made every normal boot look like a crash and
 * risked masking real errors (e.g. GMGN API failures) in the same log stream.
 */
async function queryQuiet(sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch {
    // Expected: legacy table/column may not exist. No-op.
  } finally {
    client.release();
  }
}

export async function initDB(): Promise<void> {
  // ── Storage quota recovery ────────────────────────────────────────────────
  // Neon 512MB limit recovery: clear historical diagnostic dumps and migrations
  await queryQuiet(`TRUNCATE TABLE diag_transactions CASCADE;`);
  await queryQuiet(`TRUNCATE TABLE detected_migrations CASCADE;`);
  await queryQuiet(`TRUNCATE TABLE diag_errors CASCADE;`);
  await queryQuiet(`TRUNCATE TABLE diag_tokens CASCADE;`);
  // ── Legacy schema detection ───────────────────────────────────────────────
  // Old Render DBs have a `position_id SERIAL PRIMARY KEY` column which makes
  // every INSERT fail (can't drop NOT NULL from a PK). Since no trade has ever
  // successfully completed under that schema, we drop and recreate cleanly.
  const legacyCols = await query<{ column_name: string }>(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'positions'
      AND column_name = 'position_id'
  `);
  if (legacyCols.length > 0) {
    logger.warn('Legacy positions table detected (position_id PK) — dropping and recreating');
    await query(`DROP TABLE IF EXISTS positions CASCADE`);
  }

  // Guard: if a stale pg_type entry for 'positions' exists without a matching table
  // (can happen from a previous failed CREATE TABLE), drop the orphaned type first.
  {
    const tableExists = await query<{ exists: string }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'positions'
       )::text AS exists`,
    );
    if (tableExists[0]?.exists !== 'true') {
      await query(`DROP TYPE IF EXISTS positions CASCADE`).catch(() => {});
    }
  }

  await query(`
    CREATE TABLE IF NOT EXISTS positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mint TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      entry_mc NUMERIC NOT NULL,
      entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      exit_price NUMERIC,
      exit_mc NUMERIC,
      exit_time TIMESTAMPTZ,
      size_sol NUMERIC NOT NULL,
      pnl_sol NUMERIC,
      pnl_pct NUMERIC,
      score_at_entry INTEGER NOT NULL,
      peak_price NUMERIC NOT NULL,
      sl_current NUMERIC NOT NULL,
      tp1_hit BOOLEAN DEFAULT FALSE,
      tp2_hit BOOLEAN DEFAULT FALSE,
      tp3_hit BOOLEAN DEFAULT FALSE,
      close_reason TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      mode TEXT NOT NULL DEFAULT 'paper',
      tx_signature TEXT,
      dex_url TEXT,
      notes TEXT,
      discovery_source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS discovery_source TEXT
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Rename legacy whale-branded tables/columns to the sniper-engine schema ──
  // No-ops if the old names don't exist (fresh DB) or the rename already happened.
  await queryQuiet(`ALTER TABLE IF EXISTS whale_positions RENAME TO sniper_positions`);
  await queryQuiet(`ALTER TABLE IF EXISTS whale_traded_mints RENAME TO traded_mints`);
  await queryQuiet(`ALTER TABLE IF EXISTS whale_slippage_skipped_mints RENAME TO slippage_skipped_mints`);
  await queryQuiet(`ALTER TABLE IF EXISTS sniper_positions RENAME COLUMN whale_buy_timestamp TO buy_detected_timestamp`);
  await queryQuiet(`UPDATE settings SET key = 'sniperStagnationPct' WHERE key = 'whaleStagnationPct'`);

  await query(`
    CREATE TABLE IF NOT EXISTS sniper_positions (
      id TEXT PRIMARY KEY,
      mint TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_price NUMERIC NOT NULL,
      entry_mcap NUMERIC NOT NULL DEFAULT 0,
      entry_time BIGINT NOT NULL,
      size_sol NUMERIC NOT NULL,
      size_pct NUMERIC NOT NULL,
      peak_price NUMERIC NOT NULL,
      last_price NUMERIC NOT NULL,
      last_liquidity NUMERIC NOT NULL,
      baseline_liquidity NUMERIC NOT NULL,
      migration_time BIGINT NOT NULL,
      pnl_pct NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'OPEN',
      close_time BIGINT,
      close_reason TEXT,
      close_pnl_pct NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migration: add entry_mcap column for existing DBs
  await query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS entry_mcap NUMERIC NOT NULL DEFAULT 0`).catch(() => {});
  // Migration: add timing columns (buy-detection timestamp + how long after detection we entered)
  await query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS buy_detected_timestamp BIGINT`).catch(() => {});
  await query(`ALTER TABLE sniper_positions ADD COLUMN IF NOT EXISTS entry_delay_ms BIGINT`).catch(() => {});

  await query(`
    CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      market_cap NUMERIC DEFAULT 0,
      volume_24h NUMERIC DEFAULT 0,
      buy_sell_ratio NUMERIC DEFAULT 1,
      rugcheck BOOLEAN DEFAULT FALSE,
      top_holder NUMERIC DEFAULT 0,
      creator_pct NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'SCANNING',
      reject_reason TEXT,
      last_updated TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Schema migrations: safely add any columns that may be missing
  //    in older production databases (Render, etc.) ──────────────────
  const migrations = [
    // positions table
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS mint         TEXT         NOT NULL DEFAULT ''`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS name         TEXT         NOT NULL DEFAULT ''`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS symbol       TEXT         NOT NULL DEFAULT '???'`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS entry_price  NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS entry_mc      NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS entry_time    TIMESTAMPTZ  NOT NULL DEFAULT NOW()`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS exit_price    NUMERIC`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS exit_mc       NUMERIC`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS exit_time     TIMESTAMPTZ`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS size_sol      NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS pnl_sol       NUMERIC`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS pnl_pct       NUMERIC`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS score_at_entry INTEGER    NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS peak_price    NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS sl_current    NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS tp1_hit       BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS tp2_hit       BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS tp3_hit       BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS close_reason  TEXT`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS status        TEXT         NOT NULL DEFAULT 'OPEN'`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS mode          TEXT         NOT NULL DEFAULT 'paper'`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS tx_signature  TEXT`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS dex_url       TEXT`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS notes         TEXT`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS created_at    TIMESTAMPTZ   DEFAULT NOW()`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS initial_size_sol NUMERIC`,
    `ALTER TABLE IF EXISTS positions ADD COLUMN IF NOT EXISTS banked_profit_sol NUMERIC DEFAULT 0`,
    // ── Legacy schema heal (whitelist approach) ──────────────────────────────
    // Drop NOT NULL from ANY column not in our known required set.
    // This catches 'position_id' (and any other legacy columns) regardless of
    // whether they have a DEFAULT — the old filter (column_default IS NULL)
    // was skipping columns that had a DEFAULT but were still NOT NULL.
    `DO $$
     DECLARE r RECORD;
     BEGIN
       FOR r IN
         SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name   = 'positions'
           AND is_nullable  = 'NO'
           AND column_name NOT IN (
             'id','mint','name','symbol',
             'entry_price','entry_mc','entry_time',
             'size_sol','score_at_entry','peak_price',
             'sl_current','status','mode'
           )
       LOOP
         EXECUTE 'ALTER TABLE positions ALTER COLUMN ' || quote_ident(r.column_name) || ' DROP NOT NULL';
       END LOOP;
     END $$`,
    // tokens table
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS score          INTEGER  DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS market_cap     NUMERIC  DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS volume_24h     NUMERIC  DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS buy_sell_ratio NUMERIC  DEFAULT 1`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS rugcheck       BOOLEAN  DEFAULT FALSE`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS top_holder     NUMERIC  DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS creator_pct    NUMERIC  DEFAULT 0`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS status         TEXT     DEFAULT 'SCANNING'`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS reject_reason  TEXT`,
    `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_updated   TIMESTAMPTZ DEFAULT NOW()`,
    // Source labels: comma-separated list of discovery sources ('bot', 'trenches', 'pumpfun')
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS sources TEXT DEFAULT '[]'`,
    // sniper_positions TP tier columns (multi-stage exits)
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS tp1_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS tp2_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS tp3_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS initial_size_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS remaining_size_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS banked_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS tp_tier INTEGER DEFAULT 1`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS trigger_amount_usd NUMERIC DEFAULT 0`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS current_sl_price NUMERIC DEFAULT 0`,
    // Entry checklist columns — capture WHICH filters/conditions fired at entry so
    // closed trades can be sliced by entry mode/score/price-source/slippage later.
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS entry_mode TEXT`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS entry_score NUMERIC`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS qualifying_wallets_count INTEGER`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS buyer_wallet TEXT`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS price_source TEXT`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS price_at_detection NUMERIC`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS actual_slippage_pct NUMERIC`,
    `ALTER TABLE IF EXISTS sniper_positions ADD COLUMN IF NOT EXISTS max_slippage_pct NUMERIC`,
    // Ensure sniperStagnationPct seed exists (no-op if already set by user)
    `INSERT INTO settings (key, value) VALUES ('sniperStagnationPct', '5') ON CONFLICT (key) DO NOTHING`,
    // ── Discovery pipeline lifecycle columns (diag_tokens) ─────────────────
    // Track when each key milestone was first reached during validation.
    // COALESCE in write queries preserves the first-ever value across rediscoveries.
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS first_dexscreener_pair_at BIGINT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS first_nonzero_liq_at      BIGINT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS liq_min_crossed_at        BIGINT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS validation_outcome         TEXT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS rediscovery_count         INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS initial_reserve_usd       NUMERIC`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS sustain_started_at        BIGINT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS sustain_attempts          INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS last_reset_reason         TEXT`,
    `ALTER TABLE IF EXISTS diag_tokens ADD COLUMN IF NOT EXISTS expires_at                 BIGINT`,
  ];

  for (const sql of migrations) {
    try {
      await query(sql);
    } catch (err: unknown) {
      // Log but never crash — a missing column is worse than a failed ALTER
      logger.warn({ err, sql }, 'Migration skipped (non-fatal)');
    }
  }

  // ── Past trade sanitization & normalization migration ──────────────────────
  // Normalizes all historical trade sizes to 0.1 SOL and cleans up corrupted
  // entry prices / fake +50000% PnLs in database tables so stats are realistic.
  try {
    await query(`
      UPDATE sniper_positions
      SET
        size_sol = 0.1,
        initial_size_sol = 0.1,
        remaining_size_sol = CASE WHEN status = 'OPEN' THEN 0.1 ELSE 0 END
      WHERE size_sol != 0.1 OR initial_size_sol != 0.1 OR initial_size_sol IS NULL
    `);

    await query(`
      UPDATE positions
      SET
        size_sol = 0.1,
        initial_size_sol = 0.1
      WHERE size_sol != 0.1 OR initial_size_sol != 0.1 OR initial_size_sol IS NULL
    `);

    // Clean up corrupted near-zero entry prices (< 1e-8) or unreal PnLs (> 300%) in sniper_positions
    await query(`
      UPDATE sniper_positions
      SET
        entry_price = CASE
          WHEN entry_price < 0.00000001 AND last_price > 0 THEN last_price * 0.95
          ELSE entry_price
        END,
        close_pnl_pct = CASE
          WHEN close_pnl_pct > 300 OR close_pnl_pct < -100 THEN
            LEAST(300, GREATEST(-100, CASE WHEN entry_price > 0 AND last_price > 0 THEN ((last_price - entry_price) / entry_price * 100) ELSE 0 END))
          ELSE close_pnl_pct
        END,
        pnl_pct = CASE
          WHEN pnl_pct > 300 OR pnl_pct < -100 THEN
            LEAST(300, GREATEST(-100, CASE WHEN entry_price > 0 AND last_price > 0 THEN ((last_price - entry_price) / entry_price * 100) ELSE 0 END))
          ELSE pnl_pct
        END
      WHERE entry_price < 0.00000001 OR close_pnl_pct > 300 OR pnl_pct > 300 OR close_pnl_pct < -100 OR pnl_pct < -100
    `);

    logger.info('DB migration: past trades normalized to 0.1 SOL fixed size and unreal stats sanitized');
  } catch (err) {
    logger.warn({ err }, 'Past trade sanitization migration skipped (non-fatal)');
  }

  // Seed settings — DO NOTHING so user changes are preserved
  const seedDefaults: [string, string][] = [
    ['positionSizeSol', '0.10'],
    ['maxTrackingDurationMin', '120'],
    ['emaPeriodMinutes', '20'],
    ['pumpTargetPct', '50'],
    ['rugcheckRetryDelayMin', '5'],
    ['fakeSetupSpikeCapUsd', '200000'],
    ['tp1Pct', '100'],      ['tp1ExitPct', '30'],
    ['tp2Pct', '250'],      ['tp2ExitPct', '40'],     ['trailingSLPct', '30'],
    ['tp3Pct', '400'],      ['tp3ExitPct', '30'],
    ['minMc', '30000'],
    ['maxMc', '5000000'],
    ['minVolume24h', '15000'],
    ['minAgeHours', '0'],
    ['maxAgeHours', '720'],
    ['scanFrequencyMs', '15000'],
    ['minBuySellRatio', '1.1'],
    ['maxTopHolder', '25'],
    ['maxCreatorPct', '15'],
    ['minLiquidity', '15000'],
    ['sustainDurationSec', '600'],
    ['rugcheckEnabled', 'true'],
    ['minEntryScore', '50'],
    ['trendChecksRequired', '2'],
    ['maxOpenPositions', '5'],
    ['slPct', '20'],
    ['maxDailyLossPct', '5'],
    ['startingBalanceSol', '10'],
    ['currentBalanceSol', '10'],
    ['rpcEndpoint', 'https://api.mainnet-beta.solana.com'],
    ['slippagePct', '1'],
    ['priorityFeeSol', '0.001'],
    ['walletPublicKey', ''],
    // Sniper TP tier configs
    ['wt1Tp1Pct', '100'],  ['wt1Tp1Exit', '30'],
    ['wt1Tp2Pct', '250'],  ['wt1Tp2Exit', '40'],  ['wt1Tp2Trail', '30'],
    ['wt1Tp3Pct', '400'],  ['wt1Tp3Exit', '30'],  ['wt1Tp3Trail', '30'],
    ['wt2Tp1Pct', '100'],  ['wt2Tp1Exit', '30'],
    ['wt2Tp2Pct', '250'],  ['wt2Tp2Exit', '40'],  ['wt2Tp2Trail', '30'],
    ['wt2Tp3Pct', '400'],  ['wt2Tp3Exit', '30'],  ['wt2Tp3Trail', '30'],
    ['wt3Tp1Pct', '100'],  ['wt3Tp1Exit', '30'],
    ['wt3Tp2Pct', '250'],  ['wt3Tp2Exit', '40'],  ['wt3Tp2Trail', '30'],
    ['wt3Tp3Pct', '400'],  ['wt3Tp3Exit', '30'],  ['wt3Tp3Trail', '30'],
    // Trading window
    ['tradingWindowEnabled', 'false'],
    ['tradingWindowStart', '17:00'],
    ['tradingWindowEnd', '00:00'],
  ];

  for (const [key, value] of seedDefaults) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // ── Force-migrate specific settings that changed between versions ──────────
  // Uses exact-old-value guards so user edits above the threshold are preserved.
  const forceMigrations: [string, string, string][] = [
    // [key, old-value, new-value]
    ['minLiquidity',   '25000',   '15000'],  // updated strategy liquidity floor
    ['minLiquidity',   '20000',   '15000'],
    ['minMc',          '50000',   '30000'],  // updated strategy MC floor
    ['minMc',          '500000',  '30000'],
    ['slPct',          '25',      '20'],     // reduced hard SL
    ['sizeScore80',    '0.75',    '1'],      // flat sizing: remove score tiers
    ['sizeScore70',    '0.5',     '1'],      // flat sizing: remove score tiers
    ['tradingWindowEnabled', 'true', 'false'],
  ];
  for (const [key, oldVal, newVal] of forceMigrations) {
    await query(
      `UPDATE settings SET value = $1 WHERE key = $2 AND value = $3`,
      [newVal, key, oldVal]
    );
  }
  logger.info('Settings migrations applied');

  // ── One-time backfill: fix historical positions that predate banked_profit_sol ──
  // Detects by banked_profit_sol IS NULL. Runs once; afterwards every row has the column set.
  // For positions with TP hits: reconstructs initial_size_sol from runner + TP fractions,
  // approximates banked profit using the TP threshold prices, then corrects pnl_sol / pnl_pct.
  try {
    // Use initial_size_sol IS NULL as the sentinel — it has no DEFAULT so existing
    // rows are NULL until this backfill runs. banked_profit_sol had DEFAULT 0 so
    // it is already 0 for old rows (not NULL), making it an unreliable sentinel.
    const unpatched = await query<{
      id: string; size_sol: string; tp1_hit: boolean; tp2_hit: boolean; tp3_hit: boolean;
      pnl_sol: string | null; pnl_pct: string | null; status: string;
    }>(`SELECT id, size_sol, tp1_hit, tp2_hit, tp3_hit, pnl_sol, pnl_pct, status
        FROM positions WHERE initial_size_sol IS NULL`);

    if (unpatched.length > 0) {
      // Read TP settings from DB (avoids circular dep with settings.service)
      const sRows = await query<{ key: string; value: string }>(
        `SELECT key, value FROM settings WHERE key IN ('tp1Pct','tp1ClosePct','tp2Pct','tp2ClosePct','tp3Pct','tp3ClosePct')`
      );
      const s: Record<string, number> = {};
      for (const r of sRows) s[r.key] = parseFloat(r.value);
      const tp1Pct     = s['tp1Pct']     ?? 70;
      const tp1Close   = (s['tp1ClosePct'] ?? 30) / 100;
      const tp2Pct     = s['tp2Pct']     ?? 150;
      const tp2Close   = (s['tp2ClosePct'] ?? 30) / 100;
      const tp3Pct     = s['tp3Pct']     ?? 300;
      const tp3Close   = (s['tp3ClosePct'] ?? 20) / 100;

      for (const row of unpatched) {
        const runnerSize = parseFloat(row.size_sol);
        const tp1Hit = Boolean(row.tp1_hit);
        const tp2Hit = Boolean(row.tp2_hit);
        const tp3Hit = Boolean(row.tp3_hit);

        // Reverse the partial-close reductions to recover initial_size_sol.
        // e.g. if TP1 (30%) hit: runner = initial × 0.70  → initial = runner / 0.70
        let remainFactor = 1.0;
        if (tp1Hit) remainFactor *= (1 - tp1Close);
        if (tp2Hit) remainFactor *= (1 - tp2Close);
        if (tp3Hit) remainFactor *= (1 - tp3Close);
        const initialSizeSol = remainFactor > 0.001 ? runnerSize / remainFactor : runnerSize;

        // Estimate banked profit at each TP using the threshold price as trigger price.
        // Real trigger price ≥ threshold, so this is a conservative (lower-bound) estimate.
        let bankdProfit = 0;
        let stageSize = initialSizeSol;
        if (tp1Hit) { const sold = stageSize * tp1Close; bankdProfit += sold * (tp1Pct / 100); stageSize -= sold; }
        if (tp2Hit) { const sold = stageSize * tp2Close; bankdProfit += sold * (tp2Pct / 100); stageSize -= sold; }
        if (tp3Hit) { const sold = stageSize * tp3Close; bankdProfit += sold * (tp3Pct / 100); stageSize -= sold; }

        if (row.status === 'CLOSED' && row.pnl_sol !== null) {
          // Correct pnl_sol to include the previously-missing TP profits
          const correctedPnlSol = parseFloat(row.pnl_sol) + bankdProfit;
          const correctedPnlPct = initialSizeSol > 0.0001
            ? (correctedPnlSol / initialSizeSol) * 100
            : (row.pnl_pct !== null ? parseFloat(row.pnl_pct) : 0);
          await query(
            `UPDATE positions SET initial_size_sol=$1, banked_profit_sol=$2, pnl_sol=$3, pnl_pct=$4 WHERE id=$5`,
            [initialSizeSol, bankdProfit, correctedPnlSol, correctedPnlPct, row.id]
          );
        } else {
          // Open positions or positions with no stored pnl: set columns but don't touch pnl_sol
          await query(
            `UPDATE positions SET initial_size_sol=$1, banked_profit_sol=$2 WHERE id=$3`,
            [initialSizeSol, bankdProfit, row.id]
          );
        }
      }

      logger.info({ count: unpatched.length }, 'Historical positions backfilled: initial_size_sol + banked_profit_sol corrected');
    }
  } catch (err) {
    logger.warn({ err }, 'Historical backfill skipped (non-fatal)');
  }

  // ── Close-reason backfill ────────────────────────────────────────────────
  // Rewrites the old generic 'Stop Loss (-20%)' label to the accurate reason:
  //   • Hard SL (-N%)      — peak never reached +50%
  //   • Trailing SL T1–T5  — peaked past a tier threshold, locked in gain
  // Safe to run on every boot: only touches rows with the old generic label.
  try {
    const backfillResult = await query<{ count: string }>(`
      WITH updated AS (
        UPDATE positions
        SET close_reason = CASE
          WHEN peak_price IS NULL OR entry_price IS NULL OR entry_price = 0
            THEN 'Hard SL (-20%)'
          WHEN ((peak_price - entry_price) / entry_price * 100) >= 400
            THEN 'Trailing SL T5 (peak +' || ROUND((peak_price - entry_price) / entry_price * 100) || '%, locked +' || ROUND((peak_price - entry_price) / entry_price * 100 * 0.90) || '%)'
          WHEN ((peak_price - entry_price) / entry_price * 100) >= 300
            THEN 'Trailing SL T4 (peak +' || ROUND((peak_price - entry_price) / entry_price * 100) || '%, locked +' || ROUND((peak_price - entry_price) / entry_price * 100 * 0.85) || '%)'
          WHEN ((peak_price - entry_price) / entry_price * 100) >= 200
            THEN 'Trailing SL T3 (peak +' || ROUND((peak_price - entry_price) / entry_price * 100) || '%, locked +' || ROUND((peak_price - entry_price) / entry_price * 100 * 0.80) || '%)'
          WHEN ((peak_price - entry_price) / entry_price * 100) >= 100
            THEN 'Trailing SL T2 (peak +' || ROUND((peak_price - entry_price) / entry_price * 100) || '%, locked +' || ROUND((peak_price - entry_price) / entry_price * 100 * 0.70) || '%)'
          WHEN ((peak_price - entry_price) / entry_price * 100) >= 50
            THEN 'Trailing SL T1 (peak +' || ROUND((peak_price - entry_price) / entry_price * 100) || '%, locked +' || ROUND((peak_price - entry_price) / entry_price * 100 * 0.60) || '%)'
          ELSE 'Hard SL (-20%)'
        END
        WHERE close_reason = 'Stop Loss (-20%)' AND status = 'CLOSED'
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM updated
    `);
    const n = parseInt(backfillResult[0]?.count ?? '0', 10);
    if (n > 0) logger.info({ count: n }, 'Close-reason backfill: rewrote legacy Stop Loss labels');
  } catch (err) {
    logger.warn({ err }, 'Close-reason backfill skipped (non-fatal)');
  }

  // ── detected_migrations: all pool creation events from both discovery methods ──
  await query(`
    CREATE TABLE IF NOT EXISTS detected_migrations (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source       TEXT NOT NULL,
      instruction_type TEXT,
      tx_signature TEXT NOT NULL,
      pool_address TEXT,
      mint         TEXT,
      symbol       TEXT,
      liquidity    NUMERIC DEFAULT 0,
      creator_wallet TEXT,
      detected_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tx_signature)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_migrations_detected_at ON detected_migrations (detected_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_migrations_mint ON detected_migrations (mint)`);

  // ── traded_mints: permanent lifetime record of every mint that has ever
  // been entered by the sniper engine. Checked BEFORE every entry so a mint can
  // never be traded more than once, even across restarts, re-detected
  // graduations, or re-tracking after the 30-min window expires.
  await query(`
    CREATE TABLE IF NOT EXISTS traded_mints (
      mint       TEXT PRIMARY KEY,
      traded_at  BIGINT NOT NULL
    )
  `);

  // ── slippage_skipped_mints: permanent record of mints that were skipped
  // due to post-delay slippage exceeding the configured threshold. Once a mint
  // lands here it is blocked from every entry gate permanently — we already
  // know it pumped hard before we could enter, so we will never get a fair fill.
  await query(`
    CREATE TABLE IF NOT EXISTS slippage_skipped_mints (
      mint        TEXT PRIMARY KEY,
      skipped_at  BIGINT NOT NULL,
      slip_pct    NUMERIC(10,2)
    )
  `);

  // ── Diagnostic tables ─────────────────────────────────────────────────────
  // One record per mint — updated incrementally, never duplicated.

  await query(`
    CREATE TABLE IF NOT EXISTS diag_tokens (
      mint                      TEXT PRIMARY KEY,
      name                      TEXT NOT NULL DEFAULT '',
      symbol                    TEXT NOT NULL DEFAULT '',
      first_seen_at             BIGINT NOT NULL,
      discovery_source          TEXT NOT NULL DEFAULT '',
      -- Snapshot at first discovery
      initial_mc                NUMERIC DEFAULT 0,
      initial_liquidity         NUMERIC DEFAULT 0,
      initial_volume            NUMERIC DEFAULT 0,
      initial_buy_sell_ratio    NUMERIC DEFAULT 0,
      -- Current values (refreshed on every scan)
      current_mc                NUMERIC DEFAULT 0,
      current_liquidity         NUMERIC DEFAULT 0,
      current_volume            NUMERIC DEFAULT 0,
      current_buy_sell_ratio    NUMERIC DEFAULT 0,
      current_wallet_score      NUMERIC DEFAULT 0,
      current_qualifying_wallets INTEGER DEFAULT 0,
      current_age_minutes       NUMERIC DEFAULT 0,
      -- Peak values reached at any point during tracking
      highest_mc                NUMERIC DEFAULT 0,
      highest_liquidity         NUMERIC DEFAULT 0,
      highest_volume            NUMERIC DEFAULT 0,
      highest_buy_sell_ratio    NUMERIC DEFAULT 0,
      highest_wallet_score      NUMERIC DEFAULT 0,
      highest_qualifying_wallets INTEGER DEFAULT 0,
      -- Scan counter
      scan_count                INTEGER NOT NULL DEFAULT 0,
      -- First-ever timestamp each filter was passed (NULL = never passed)
      passed_mc_at              BIGINT,
      passed_liquidity_at       BIGINT,
      passed_volume_at          BIGINT,
      passed_rugcheck_at        BIGINT,
      passed_holder_at          BIGINT,
      passed_creator_at         BIGINT,
      passed_wallet_at          BIGINT,
      passed_entry_at           BIGINT,
      -- Final status
      status                    TEXT NOT NULL DEFAULT 'DISCOVERED',
      reject_reason             TEXT,
      -- Trade details (populated when status = TRADED)
      entry_time                BIGINT,
      entry_price               NUMERIC,
      entry_mc                  NUMERIC,
      entry_wallet_score        NUMERIC,
      entry_qualifying_wallets  INTEGER,
      entry_mode                TEXT,
      entry_risk_tier           TEXT,
      entry_reason              TEXT,
      -- Timestamps
      last_updated              BIGINT NOT NULL DEFAULT 0,
      created_at                BIGINT NOT NULL,
      -- Discovery pipeline lifecycle milestones (added via migration; included here for fresh DBs)
      first_dexscreener_pair_at BIGINT,
      first_nonzero_liq_at      BIGINT,
      liq_min_crossed_at        BIGINT,
      validation_outcome        TEXT,
      rediscovery_count         INTEGER NOT NULL DEFAULT 0,
      initial_reserve_usd       NUMERIC
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_diag_tokens_status      ON diag_tokens (status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_diag_tokens_created_at  ON diag_tokens (created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_diag_tokens_last_updated ON diag_tokens (last_updated DESC)`);

  // Technical error log — separate table, one row per error event
  await query(`
    CREATE TABLE IF NOT EXISTS diag_errors (
      id           BIGSERIAL PRIMARY KEY,
      error_type   TEXT NOT NULL,
      message      TEXT NOT NULL,
      mint         TEXT,
      details      JSONB,
      occurred_at  BIGINT NOT NULL
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_diag_errors_occurred_at ON diag_errors (occurred_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_diag_errors_type        ON diag_errors (error_type)`);

  // One durable audit row per detected on-chain transaction. Unlike the
  // per-token funnel, this preserves the wallet, signature, GMGN score
  // calculation, and exact decision for every buy and sell.
  await query(`
    CREATE TABLE IF NOT EXISTS diag_transactions (
      tx_signature       TEXT PRIMARY KEY,
      mint               TEXT NOT NULL,
      tx_type            TEXT NOT NULL,
      wallet             TEXT NOT NULL,
      amount_usd         NUMERIC DEFAULT 0,
      tx_timestamp       BIGINT NOT NULL,
      detected_at        BIGINT NOT NULL,
      price_at_detection NUMERIC DEFAULT 0,
      decision            TEXT NOT NULL,
      decision_reason    TEXT NOT NULL DEFAULT '',
      wallet_score       NUMERIC DEFAULT 0,
      win_rate           NUMERIC,
      avg_roi_pct        NUMERIC,
      completed_trades   INTEGER,
      wallet_age_days    NUMERIC,
      avg_hold_minutes   NUMERIC,
      score_points       JSONB NOT NULL DEFAULT '{}'::jsonb,
      score_source       TEXT NOT NULL DEFAULT 'unavailable',
      score_status       TEXT NOT NULL DEFAULT 'unavailable',
      consensus_mode     TEXT,
      qualifying_wallets INTEGER DEFAULT 0,
      created_at         BIGINT NOT NULL
    )
  `);
  // ── Altcoin Paper Balance Reset & 1% Risk Configuration ──
  await queryQuiet("UPDATE settings SET value = '100' WHERE key = 'currentBalanceUsd'");
  await queryQuiet("UPDATE settings SET value = '100' WHERE key = 'startingBalanceUsd'");
  await queryQuiet("UPDATE settings SET value = '1.0' WHERE key = 'riskPerTradePct'");
  await queryQuiet("UPDATE settings SET value = '2' WHERE key = 'maxOpenPositions'");
  await queryQuiet("UPDATE settings SET value = '88' WHERE key = 'minAiScore'");
  await queryQuiet("UPDATE settings SET value = '2.0' WHERE key = 'minRiskRewardRatio'");
  await queryQuiet("UPDATE positions SET status = 'CLOSED', close_reason = 'RESET_BALANCE' WHERE status = 'OPEN'");

  logger.info('Database initialized and paper portfolio reset to clean $100 USD (1% risk)');
}
