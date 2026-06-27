import { query } from '../lib/db.js';
import { Settings } from '../types/index.js';

export async function getSettings(): Promise<Settings> {
  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  const num = (k: string, def: number) => parseFloat(map[k] ?? String(def));
  const bool = (k: string, def: boolean) => (map[k] ?? String(def)) === 'true';
  const str = (k: string, def: string) => map[k] ?? def;

  return {
    minMc: num('minMc', 500000),
    maxMc: num('maxMc', 7000000),
    minVolume24h: num('minVolume24h', 100000),
    minAgeHours: num('minAgeHours', 1),
    maxAgeHours: num('maxAgeHours', 168),
    scanFrequencyMs: num('scanFrequencyMs', 30000),
    minBuySellRatio: num('minBuySellRatio', 1.2),
    maxTopHolder: num('maxTopHolder', 20),
    maxCreatorPct: num('maxCreatorPct', 10),
    minLiquidity: num('minLiquidity', 25000),
    rugcheckEnabled: bool('rugcheckEnabled', true),
    minEntryScore: num('minEntryScore', 70),
    trendChecksRequired: num('trendChecksRequired', 3),
    maxOpenPositions: num('maxOpenPositions', 5),
    sizeScore90: num('sizeScore90', 1),
    sizeScore80: num('sizeScore80', 0.75),
    sizeScore70: num('sizeScore70', 0.5),
    slPct: num('slPct', 20),
    tp1Pct: num('tp1Pct', 70),
    tp1ClosePct: num('tp1ClosePct', 30),
    tp2Pct: num('tp2Pct', 150),
    tp2ClosePct: num('tp2ClosePct', 30),
    tp2TrailPct: num('tp2TrailPct', 30),
    tp3Pct: num('tp3Pct', 300),
    tp3ClosePct: num('tp3ClosePct', 20),
    trailingSLPct: num('trailingSLPct', 20),
    trailActivatePct: num('trailActivatePct', 70),
    maxDailyLossPct: num('maxDailyLossPct', 3),
    startingBalanceSol: num('startingBalanceSol', 10),
    currentBalanceSol: num('currentBalanceSol', 10),
    rpcEndpoint: str('rpcEndpoint', 'https://api.mainnet-beta.solana.com'),
    slippagePct: num('slippagePct', 1),
    priorityFeeSol: num('priorityFeeSol', 0.001),
    walletPublicKey: str('walletPublicKey', ''),
  };
}

export async function updateSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

export async function updateSettings(updates: Partial<Record<string, string>>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) await updateSetting(key, value);
  }
}

export async function getBalance(): Promise<number> {
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'currentBalanceSol'`);
  return parseFloat(rows[0]?.value ?? '10');
}

export async function setBalance(sol: number): Promise<void> {
  await updateSetting('currentBalanceSol', String(sol));
}

export async function resetAllData(): Promise<void> {
  await query(`DELETE FROM positions`);
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'startingBalanceSol'`);
  const start = parseFloat(rows[0]?.value ?? '10');
  await updateSetting('currentBalanceSol', String(start));
}
