// ── Smart Wallet Consensus — entry decision engine ───────────────────────────
//
// Replaces the previous 10s net-buy-volume entry trigger. A tracked token is
// bought when either:
//
//   Option A (consensus): at least TWO distinct wallets with a GMGN score
//     >= 65 buy the same token within a 5-minute window.
//   Option B (solo conviction): a single wallet with a GMGN score >= 85 buys
//     the token — enter immediately, no need to wait for a second wallet.
//
// Position sizing (risk %) is derived from which option fired:
//   score >= 85            → 1%    risk, tpTier 3 (highest-conviction TP ladder)
//   consensus (2x >= 65)   → 0.75% risk, tpTier 2
//
// Wallet score lookups (wallet-score.service.ts) are async and GMGN-backed;
// this module only holds lightweight in-memory bookkeeping of qualifying
// buys per mint so it never blocks the real-time transaction-detection loop.

import { getWalletScore } from './wallet-score.service.js';
import { logger } from '../lib/logger.js';

const CONSENSUS_WINDOW_MS = 5 * 60_000; // 5 minutes
export const SOLO_SCORE_THRESHOLD = 85;       // was 95 — easier to hit with relaxed criteria
export const CONSENSUS_SCORE_THRESHOLD = 65;  // was 80 — win rate (30) + ROI (25) + hold (15) = 70
export const SOLO_RISK_PCT = 1.0;
export const CONSENSUS_RISK_PCT = 0.75;

interface QualifyingBuy {
  wallet: string;
  score: number;
  timestamp: number;
}

// mint → qualifying (score >= 80) buys seen in the last 5 minutes
const qualifyingBuys = new Map<string, QualifyingBuy[]>();

export type ConsensusMode = 'solo' | 'consensus' | 'tracking' | 'none';

export interface ConsensusResult {
  trigger: boolean;
  mode: ConsensusMode;
  sizePct: number;
  tpTier: 1 | 2 | 3;
  score: number;
  wallet: string;
  qualifyingWallets: string[];
}

function pruneWindow(mint: string, now: number): QualifyingBuy[] {
  const list = qualifyingBuys.get(mint) ?? [];
  const fresh = list.filter(b => now - b.timestamp <= CONSENSUS_WINDOW_MS);
  qualifyingBuys.set(mint, fresh);
  return fresh;
}

/**
 * Evaluate a single detected buy transaction against the Smart Wallet
 * Consensus rules. Looks up the buyer's GMGN score (cached, async) and
 * returns whether this buy should trigger an entry.
 */
export async function evaluateBuy(mint: string, wallet: string, timestamp: number): Promise<ConsensusResult> {
  const { score } = await getWalletScore(wallet);

  if (score >= SOLO_SCORE_THRESHOLD) {
    logger.info({ mint: mint.slice(0, 12), wallet: wallet.slice(0, 12), score }, 'Wallet consensus: solo trigger (score >= 85)');
    return { trigger: true, mode: 'solo', sizePct: SOLO_RISK_PCT, tpTier: 3, score, wallet, qualifyingWallets: [wallet] };
  }

  if (score >= CONSENSUS_SCORE_THRESHOLD) {
    const now = Date.now();
    const fresh = pruneWindow(mint, now);
    if (!fresh.some(b => b.wallet === wallet)) fresh.push({ wallet, score, timestamp });
    qualifyingBuys.set(mint, fresh);

    const distinctWallets = Array.from(new Set(fresh.map(b => b.wallet)));
    if (distinctWallets.length >= 2) {
      logger.info(
        { mint: mint.slice(0, 12), wallets: distinctWallets.map(w => w.slice(0, 12)) },
        'Wallet consensus: consensus trigger (2+ wallets score >= 65 within 5 min)',
      );
      return { trigger: true, mode: 'consensus', sizePct: CONSENSUS_RISK_PCT, tpTier: 2, score, wallet, qualifyingWallets: distinctWallets };
    }

    return { trigger: false, mode: 'tracking', sizePct: 0, tpTier: 1, score, wallet, qualifyingWallets: distinctWallets };
  }

  return { trigger: false, mode: 'none', sizePct: 0, tpTier: 1, score, wallet, qualifyingWallets: [] };
}

/** Drop bookkeeping for a mint once it's no longer tracked (expired, entered, or reset). */
export function clearMintConsensus(mint: string): void {
  qualifyingBuys.delete(mint);
}

/** Reset all in-memory consensus state — called on full data reset. */
export function resetConsensusState(): void {
  qualifyingBuys.clear();
}
