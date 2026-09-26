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
    riskPerTradePct: num('riskPerTradePct', 1.0),
    maxOpenPositions: num('maxOpenPositions', 2),
    minAiScore: num('minAiScore', 88),
    minRiskRewardRatio: num('minRiskRewardRatio', 2.0),
    universeSize: num('universeSize', 100),
    paperTradingOnly: bool('paperTradingOnly', true),
    liveTradingEnabled: false,

    startingBalanceSol: num('startingBalanceSol', 10),
    currentBalanceSol: num('currentBalanceSol', 10),
    positionSizeSol: num('positionSizeSol', 0.10),
    sniperSlippagePct: num('sniperSlippagePct', 20),
    sniperStagnationPct: num('sniperStagnationPct', 5),
    tradingWindowEnabled: bool('tradingWindowEnabled', false),
    tradingWindowStart: map['tradingWindowStart'] ?? '17:00',
    tradingWindowEnd: map['tradingWindowEnd'] ?? '00:00',
    emaPeriodMinutes: num('emaPeriodMinutes', 20),
    pumpTargetPct: num('pumpTargetPct', 50),
    rugcheckRetryDelayMin: num('rugcheckRetryDelayMin', 5),
    fakeSetupSpikeCapUsd: num('fakeSetupSpikeCapUsd', 200000),
    maxTrackingDurationMin: num('maxTrackingDurationMin', 120),
    rpcEndpoint: map['rpcEndpoint'] ?? 'https://api.mainnet-beta.solana.com',
    slippagePct: num('slippagePct', 1),
    priorityFeeSol: num('priorityFeeSol', 0.001),
    walletPublicKey: map['walletPublicKey'] ?? '',
    tp1Pct: num('tp1Pct', 100),
    tp1ExitPct: num('tp1ExitPct', 30),
    tp2Pct: num('tp2Pct', 250),
    tp2ExitPct: num('tp2ExitPct', 40),
    tp3Pct: num('tp3Pct', 400),
    tp3ExitPct: num('tp3ExitPct', 30),
    trailingSLPct: num('trailingSLPct', 30),
    wt1Tp1Pct: num('wt1Tp1Pct', 100),
    wt1Tp1Exit: num('wt1Tp1Exit', 30),
    wt1Tp2Pct: num('wt1Tp2Pct', 250),
    wt1Tp2Exit: num('wt1Tp2Exit', 40),
    wt1Tp2Trail: num('wt1Tp2Trail', 30),
    wt1Tp3Pct: num('wt1Tp3Pct', 400),
    wt1Tp3Exit: num('wt1Tp3Exit', 30),
    wt1Tp3Trail: num('wt1Tp3Trail', 30),
    wt2Tp1Pct: num('wt2Tp1Pct', 100),
    wt2Tp1Exit: num('wt2Tp1Exit', 30),
    wt2Tp2Pct: num('wt2Tp2Pct', 250),
    wt2Tp2Exit: num('wt2Tp2Exit', 40),
    wt2Tp2Trail: num('wt2Tp2Trail', 30),
    wt2Tp3Pct: num('wt2Tp3Pct', 400),
    wt2Tp3Exit: num('wt2Tp3Exit', 30),
    wt2Tp3Trail: num('wt2Tp3Trail', 30),
    wt3Tp1Pct: num('wt3Tp1Pct', 100),
    wt3Tp1Exit: num('wt3Tp1Exit', 30),
    wt3Tp2Pct: num('wt3Tp2Pct', 250),
    wt3Tp2Exit: num('wt3Tp2Exit', 40),
    wt3Tp2Trail: num('wt3Tp2Trail', 30),
    wt3Tp3Pct: num('wt3Tp3Pct', 400),
    wt3Tp3Exit: num('wt3Tp3Exit', 30),
    wt3Tp3Trail: num('wt3Tp3Trail', 30),
    minLiquidity: num('minLiquidity', 15000),
    minMc: num('minMc', 30000),
    sustainDurationSec: num('sustainDurationSec', 600),
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
