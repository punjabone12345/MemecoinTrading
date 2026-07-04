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
  } catch (err) {
    logger.error({ err, sql }, 'DB query error');
    throw err;
  } finally {
    client.release();
  }
}

export async function initDB(): Promise<void> {
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

  await query(`
    CREATE TABLE IF NOT EXISTS whale_positions (
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
  await query(`ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS entry_mcap NUMERIC NOT NULL DEFAULT 0`).catch(() => {});

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
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS mint         TEXT         NOT NULL DEFAULT ''`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS name         TEXT         NOT NULL DEFAULT ''`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS symbol       TEXT         NOT NULL DEFAULT '???'`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_price  NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_mc     NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_time   TIMESTAMPTZ  NOT NULL DEFAULT NOW()`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_price   NUMERIC`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_mc      NUMERIC`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_time    TIMESTAMPTZ`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS size_sol     NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS pnl_sol      NUMERIC`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS pnl_pct      NUMERIC`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS score_at_entry INTEGER    NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS peak_price   NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS sl_current   NUMERIC      NOT NULL DEFAULT 0`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp1_hit      BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp2_hit      BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp3_hit      BOOLEAN       DEFAULT FALSE`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS close_reason TEXT`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS status       TEXT         NOT NULL DEFAULT 'OPEN'`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS mode         TEXT         NOT NULL DEFAULT 'paper'`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS tx_signature TEXT`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS dex_url      TEXT`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS notes              TEXT`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ   DEFAULT NOW()`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS initial_size_sol   NUMERIC`,
    `ALTER TABLE positions ADD COLUMN IF NOT EXISTS banked_profit_sol  NUMERIC       DEFAULT 0`,
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
    // whale_positions TP tier columns (multi-stage exits)
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS tp1_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS tp2_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS tp3_hit BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS initial_size_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS remaining_size_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS banked_sol NUMERIC DEFAULT 0`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS tp_tier INTEGER DEFAULT 1`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS trigger_amount_usd NUMERIC DEFAULT 0`,
    `ALTER TABLE whale_positions ADD COLUMN IF NOT EXISTS current_sl_price NUMERIC DEFAULT 0`,
  ];

  for (const sql of migrations) {
    try {
      await query(sql);
    } catch (err: unknown) {
      // Log but never crash — a missing column is worse than a failed ALTER
      logger.warn({ err, sql }, 'Migration skipped (non-fatal)');
    }
  }

  // Seed settings — DO NOTHING so user changes are preserved
  const seedDefaults: [string, string][] = [
    ['minMc', '500000'],
    ['maxMc', '7000000'],
    ['minVolume24h', '100000'],
    ['minAgeHours', '0'],
    ['maxAgeHours', '720'],
    ['scanFrequencyMs', '15000'],
    ['minBuySellRatio', '1.1'],
    ['maxTopHolder', '25'],
    ['maxCreatorPct', '15'],
    ['minLiquidity', '25000'],
    ['rugcheckEnabled', 'false'],
    ['minEntryScore', '50'],
    ['trendChecksRequired', '2'],
    ['maxOpenPositions', '5'],
    ['sizeScore90', '1'],
    ['sizeScore80', '1'],
    ['sizeScore70', '1'],
    ['slPct', '20'],
    ['tp1Pct', '70'],
    ['tp1ClosePct', '30'],
    ['tp2Pct', '150'],
    ['tp2ClosePct', '30'],
    ['tp3Pct', '300'],
    ['tp3ClosePct', '20'],
    ['trailingSLPct', '20'],
    ['maxDailyLossPct', '5'],
    ['startingBalanceSol', '10'],
    ['currentBalanceSol', '10'],
    ['rpcEndpoint', 'https://api.mainnet-beta.solana.com'],
    ['slippagePct', '1'],
    ['priorityFeeSol', '0.001'],
    ['walletPublicKey', ''],
    // Whale TP tier configs
    ['wt1Tp1Pct', '50'],   ['wt1Tp1Exit', '30'],
    ['wt1Tp2Pct', '125'],  ['wt1Tp2Exit', '30'],  ['wt1Tp2Trail', '30'],
    ['wt1Tp3Pct', '200'],  ['wt1Tp3Exit', '30'],  ['wt1Tp3Trail', '20'],
    ['wt2Tp1Pct', '100'],  ['wt2Tp1Exit', '30'],
    ['wt2Tp2Pct', '250'],  ['wt2Tp2Exit', '30'],  ['wt2Tp2Trail', '25'],
    ['wt2Tp3Pct', '400'],  ['wt2Tp3Exit', '30'],  ['wt2Tp3Trail', '15'],
    ['wt3Tp1Pct', '150'],  ['wt3Tp1Exit', '30'],
    ['wt3Tp2Pct', '350'],  ['wt3Tp2Exit', '30'],  ['wt3Tp2Trail', '20'],
    ['wt3Tp3Pct', '550'],  ['wt3Tp3Exit', '30'],  ['wt3Tp3Trail', '10'],
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
    ['minLiquidity',   '20000',   '25000'],  // raised liquidity floor
    ['slPct',          '25',      '20'],     // reduced hard SL
    ['sizeScore80',    '0.75',    '1'],      // flat sizing: remove score tiers
    ['sizeScore70',    '0.5',     '1'],      // flat sizing: remove score tiers
    // ── v2: fix factory defaults that were too strict for fresh graduation events ──
    // PumpFun tokens graduate at ~$69K MC; minMc=$500K blocked 100% of them.
    // minVolume24h=$100K blocked tokens seconds after graduation (24h vol is tiny).
    // Only migrate if still at the bad default — user edits above these are kept.
    ['minMc',          '500000',  '50000'],  // $500K → $50K: catches $69K graduation MC
    ['maxMc',          '7000000', '5000000'],// $7M  → $5M : focus on small-mid caps
    ['minVolume24h',   '100000',  '15000'],  // $100K→ $15K: fresh tokens have low 24h vol
    ['maxAgeHours',    '720',     '48'],     // 30 days → 48h: ignore stale tokens
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

  logger.info('Database initialized');
}
