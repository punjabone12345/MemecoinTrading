// ── GMGN wallet scoring (Smart Wallet Consensus strategy) ────────────────────
//
// Scores a Solana wallet 0-100 from its GMGN trading history:
//   Win rate    > 60%        → 30 pts
//   Wallet age  > 10 days    → 15 pts
//   Completed trades >= 20   → 15 pts
//   Average ROI > 30%        → 25 pts
//   Avg hold time > 2 min    → 15 pts
//
// GMGN's public API does not expose "wallet age" or "average hold time" as
// direct fields, so both are approximated from the closest available data
// (documented inline below) rather than blocking the strategy on missing
// fields, per product spec.
//
// Results are cached in-memory with a TTL so the same wallet isn't re-queried
// on every buy it makes across different tokens, and lookups are de-duplicated
// so concurrent buys from the same wallet only trigger one GMGN round-trip.

import { getWalletStats, getWalletActivity, isGmgnConfigured, GmgnWalletActivityItem } from '../lib/gmgn-client.js';
import { logger } from '../lib/logger.js';

const CHAIN = 'sol';
const SCORE_CACHE_TTL_MS = 10 * 60_000; // 10 min — dynamic enough to reflect fresh trading, cheap enough to avoid hammering GMGN
const LOOKUP_TIMEOUT_MS = 3_500;        // hard cap so a slow/hanging GMGN call never blocks the entry pipeline for long

export interface WalletScoreBreakdown {
  wallet: string;
  score: number;
  winRate: number | null;
  avgRoiPct: number | null;
  completedTrades: number | null;
  walletAgeDays: number | null;
  avgHoldMinutes: number | null;
  computedAt: number;
}

const scoreCache = new Map<string, WalletScoreBreakdown>();
const inFlight = new Map<string, Promise<WalletScoreBreakdown>>();

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** Approximate wallet age from the oldest transaction timestamp seen in the fetched activity page. */
function estimateWalletAgeDays(activities: GmgnWalletActivityItem[]): number | null {
  const timestamps = activities.map(a => a.timestamp).filter((t): t is number => typeof t === 'number' && t > 0);
  if (timestamps.length === 0) return null;
  const oldest = Math.min(...timestamps);
  const ageMs = Date.now() - oldest * (oldest < 1e12 ? 1000 : 1); // GMGN timestamps are unix seconds
  return ageMs / (24 * 60 * 60 * 1000);
}

/** Approximate average hold time by pairing each buy with the next sell of the same token in the fetched window. */
function estimateAvgHoldMinutes(activities: GmgnWalletActivityItem[]): number | null {
  const byToken = new Map<string, GmgnWalletActivityItem[]>();
  for (const a of activities) {
    const addr = a.token?.address;
    if (!addr || (a.type !== 'buy' && a.type !== 'sell') || typeof a.timestamp !== 'number') continue;
    if (!byToken.has(addr)) byToken.set(addr, []);
    byToken.get(addr)!.push(a);
  }
  const holdMinutes: number[] = [];
  for (const events of byToken.values()) {
    events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    let openBuyTs: number | null = null;
    for (const e of events) {
      if (e.type === 'buy') {
        if (openBuyTs === null) openBuyTs = e.timestamp!;
      } else if (e.type === 'sell' && openBuyTs !== null) {
        const deltaSeconds = (e.timestamp! - openBuyTs) * (openBuyTs < 1e12 ? 1 : 1);
        if (deltaSeconds > 0) holdMinutes.push(deltaSeconds / 60);
        openBuyTs = null;
      }
    }
  }
  if (holdMinutes.length === 0) return null;
  return holdMinutes.reduce((a, b) => a + b, 0) / holdMinutes.length;
}

async function computeScore(wallet: string): Promise<WalletScoreBreakdown> {
  const zero: WalletScoreBreakdown = {
    wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
    walletAgeDays: null, avgHoldMinutes: null, computedAt: Date.now(),
  };

  if (!isGmgnConfigured()) return zero;

  const [stats, activity] = await Promise.all([
    getWalletStats(CHAIN, wallet, '30d').catch(() => null),
    getWalletActivity(CHAIN, wallet, 50).catch(() => null),
  ]);

  if (!stats && !activity) return zero;

  const winRate = typeof stats?.winrate === 'number' ? stats.winrate : null; // 0-1
  // pnl (realized_profit / total_cost) is the closest available "average ROI" metric.
  const avgRoiPct = typeof stats?.pnl === 'number' ? stats.pnl * 100 : null;
  const completedTrades = typeof stats?.sell_count === 'number'
    ? stats.sell_count
    : (typeof stats?.buy_count === 'number' && typeof stats?.sell_count === 'number'
        ? stats.buy_count + stats.sell_count
        : null);

  const activities = activity?.activities ?? [];
  const walletAgeDays = estimateWalletAgeDays(activities);
  const avgHoldMinutes = estimateAvgHoldMinutes(activities);

  let score = 0;
  if (winRate !== null && winRate > 0.6) score += 30;
  if (walletAgeDays !== null && walletAgeDays > 10) score += 15;
  if (completedTrades !== null && completedTrades >= 20) score += 15;
  if (avgRoiPct !== null && avgRoiPct > 30) score += 25;
  if (avgHoldMinutes !== null && avgHoldMinutes > 2) score += 15;

  return {
    wallet, score, winRate, avgRoiPct, completedTrades, walletAgeDays, avgHoldMinutes,
    computedAt: Date.now(),
  };
}

/**
 * Returns a wallet's smart-money score (0-100), using the cache when fresh.
 * Never throws and never blocks longer than LOOKUP_TIMEOUT_MS — on timeout or
 * error it returns the best available data (stale cache, or a 0 score) so the
 * real-time buy-detection pipeline is never stalled by a slow GMGN call.
 */
export async function getWalletScore(wallet: string): Promise<WalletScoreBreakdown> {
  const cached = scoreCache.get(wallet);
  if (cached && Date.now() - cached.computedAt < SCORE_CACHE_TTL_MS) {
    return cached;
  }

  let pending = inFlight.get(wallet);
  if (!pending) {
    pending = computeScore(wallet)
      .then((result) => {
        scoreCache.set(wallet, result);
        return result;
      })
      .catch((err) => {
        logger.debug({ wallet: wallet.slice(0, 12), err: err?.message }, 'Wallet score: compute failed');
        const fallback: WalletScoreBreakdown = cached ?? {
          wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
          walletAgeDays: null, avgHoldMinutes: null, computedAt: Date.now(),
        };
        return fallback;
      })
      .finally(() => { inFlight.delete(wallet); });
    inFlight.set(wallet, pending);
  }

  // Stale-while-revalidate: if we already have a (stale) score, return it
  // immediately and let the refresh finish in the background — dynamic
  // updates then land on the NEXT lookup for this wallet.
  if (cached) return cached;

  return withTimeout(pending, LOOKUP_TIMEOUT_MS, {
    wallet, score: 0, winRate: null, avgRoiPct: null, completedTrades: null,
    walletAgeDays: null, avgHoldMinutes: null, computedAt: Date.now(),
  });
}

export function clearWalletScoreCache(): void {
  scoreCache.clear();
  inFlight.clear();
}
