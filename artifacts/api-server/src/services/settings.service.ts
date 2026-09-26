import { query } from '../lib/db.js';
import { Settings } from '../types/index.js';

let settingsCache: Settings | null = null;
let settingsCacheAt = 0;
const SETTINGS_CACHE_TTL = 8_000;

let balanceCache: number | null = null;
let balanceCacheAt = 0;
const BALANCE_CACHE_TTL = 5_000;

export function invalidateSettingsCache(): void {
  settingsCache = null;
  settingsCacheAt = 0;
  balanceCache = null;
  balanceCacheAt = 0;
}

export async function getSettings(): Promise<Settings> {
  const now = Date.now();
  if (settingsCache && now - settingsCacheAt < SETTINGS_CACHE_TTL) {
    return settingsCache;
  }

  const rows = await query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;

  const num = (k: string, def: number) => parseFloat(map[k] ?? String(def));
  const bool = (k: string, def: boolean) => (map[k] ?? String(def)) === 'true';

  const settings: Settings = {
    botEnabled: bool('botEnabled', true),
    startingBalanceUsd: num('startingBalanceUsd', 100),
    currentBalanceUsd: num('currentBalanceUsd', 100),
    riskPerTradePct: num('riskPerTradePct', 0.5),
    maxOpenPositions: num('maxOpenPositions', 5),
    minAiScore: num('minAiScore', 75),
    minRiskRewardRatio: num('minRiskRewardRatio', 2.0),
    universeSize: num('universeSize', 100),
    paperTradingOnly: bool('paperTradingOnly', true),
    liveTradingEnabled: false,
  };

  settingsCache = settings;
  settingsCacheAt = Date.now();
  return settings;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
  invalidateSettingsCache();
}

export async function updateSettings(updates: Partial<Record<string, string>>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) await updateSetting(key, value);
  }
  invalidateSettingsCache();
}

export async function getBalance(): Promise<number> {
  const now = Date.now();
  if (balanceCache !== null && now - balanceCacheAt < BALANCE_CACHE_TTL) {
    return balanceCache;
  }
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'currentBalanceUsd'`);
  const balance = parseFloat(rows[0]?.value ?? '100');
  balanceCache = balance;
  balanceCacheAt = now;
  return balance;
}

export async function setBalance(usd: number): Promise<void> {
  balanceCache = usd;
  balanceCacheAt = Date.now();
  await updateSetting('currentBalanceUsd', String(usd));
}

let balanceMutex: Promise<unknown> = Promise.resolve();

function withBalanceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = balanceMutex.then(fn, fn);
  balanceMutex = run.catch(() => undefined);
  return run;
}

export async function adjustBalance(deltaUsd: number, floorAtZero = true): Promise<number> {
  return withBalanceLock(async () => {
    const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'currentBalanceUsd'`);
    const current = parseFloat(rows[0]?.value ?? '100');
    let next = current + deltaUsd;
    if (floorAtZero) next = Math.max(0, next);
    balanceCache = next;
    balanceCacheAt = Date.now();
    await updateSetting('currentBalanceUsd', String(next));
    return next;
  });
}

export async function resetAllData(): Promise<void> {
  await query(`DELETE FROM paper_positions`).catch(() => {});
  const rows = await query<{ value: string }>(`SELECT value FROM settings WHERE key = 'startingBalanceUsd'`);
  const start = parseFloat(rows[0]?.value ?? '100');
  balanceCache = start;
  balanceCacheAt = Date.now();
  await updateSetting('currentBalanceUsd', String(start));
}
