import { Router } from 'express';
import { getDiscoveryFeed, getDiscoveryTotal, getSourceActivity, getTrenchesDiagnostics } from '../services/trenches.service.js';
import { query } from '../lib/db.js';

const router = Router();

router.get('/sources', (_req, res) => {
  const total = getDiscoveryTotal();
  const feed  = getDiscoveryFeed();
  const diag  = getTrenchesDiagnostics();

  res.json({
    // Legacy field kept for frontend compatibility
    dexscreener: {
      total,
      recent: feed,
    },
    // GMGN-first discovery stats
    gmgn: {
      total,
      recent: feed,
      pollers: diag.pollers,
      avgDiscoveryDelaySec: diag.avgDiscoveryDelaySec,
      gmgnApiKeySet: diag.gmgnApiKeySet,
      gmgnBanned: diag.gmgnBanned,
    },
  });
});

router.get('/migrations', async (_req, res) => {
  try {
    const rows = await query<{
      id: string;
      source: string;
      instruction_type: string | null;
      tx_signature: string;
      pool_address: string | null;
      mint: string | null;
      symbol: string | null;
      liquidity: string;
      creator_wallet: string | null;
      detected_at: string;
    }>(`
      SELECT id, source, instruction_type, tx_signature, pool_address,
             mint, symbol, liquidity, creator_wallet, detected_at
      FROM detected_migrations
      ORDER BY detected_at DESC
      LIMIT 100
    `);
    res.json({ migrations: rows, total: rows.length });
  } catch (err: any) {
    res.json({ migrations: [], total: 0, error: err?.message });
  }
});

export default router;
