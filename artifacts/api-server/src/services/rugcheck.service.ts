import axios from 'axios';
import { logger } from '../lib/logger.js';

const cache = new Map<string, { ok: boolean; ts: number }>();
const CACHE_TTL = 10 * 60_000; // 10 min

export async function checkRugcheck(mint: string): Promise<boolean> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.ok;

  try {
    const res = await axios.get<{
      score?: number;
      risks?: Array<{ level: string }>;
      tokenMeta?: { mutable?: boolean };
      topHolders?: Array<{ pct: number; insider?: boolean }>;
      freezeAuthority?: string | null;
      mintAuthority?: string | null;
    }>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { timeout: 8000 });

    const data = res.data;
    const score = data?.score ?? 100;

    // Check critical risks
    const hasCritical = (data?.risks ?? []).some((r) => r.level === 'danger' || r.level === 'critical');
    const hasFreezeAuth = !!data?.freezeAuthority;
    const hasMintAuth = !!data?.mintAuthority;

    // Top holder check
    const topHolders = data?.topHolders ?? [];
    const topHolderPct = topHolders[0]?.pct ?? 0;
    const creatorPct = topHolders.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0);

    const ok =
      score >= 500 &&
      !hasCritical &&
      !hasFreezeAuth &&
      !hasMintAuth &&
      topHolderPct < 20 &&
      creatorPct < 10;

    cache.set(mint, { ok, ts: Date.now() });
    return ok;
  } catch (err) {
    logger.debug({ err, mint }, 'Rugcheck API error — defaulting to pass');
    cache.set(mint, { ok: true, ts: Date.now() });
    return true;
  }
}
