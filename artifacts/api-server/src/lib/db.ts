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
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  // Seed settings — DO NOTHING so user changes are preserved
  const seedDefaults: [string, string][] = [
    ['minMc', '500000'],
    ['maxMc', '7000000'],
    ['minVolume24h', '100000'],
    ['minAgeHours', '0'],
    ['maxAgeHours', '720'],
    ['scanFrequencyMs', '30000'],
    ['minBuySellRatio', '1.1'],
    ['maxTopHolder', '25'],
    ['maxCreatorPct', '15'],
    ['minLiquidity', '20000'],
    ['rugcheckEnabled', 'false'],
    ['minEntryScore', '50'],
    ['trendChecksRequired', '2'],
    ['maxOpenPositions', '5'],
    ['sizeScore90', '1'],
    ['sizeScore80', '0.75'],
    ['sizeScore70', '0.5'],
    ['slPct', '25'],
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
  ];

  for (const [key, value] of seedDefaults) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // Force-update the critical filter settings to lenient defaults
  // so old stale strict settings don't block the scanner
  const forceDefaults: [string, string][] = [
    ['minAgeHours', '0'],
    ['maxAgeHours', '720'],
    ['maxMc', '7000000'],
    ['minBuySellRatio', '1.1'],
    ['minLiquidity', '20000'],
    ['rugcheckEnabled', 'false'],
    ['minEntryScore', '50'],
  ];

  for (const [key, value] of forceDefaults) {
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }

  logger.info('Database initialized');
}
