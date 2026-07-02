import { Router } from 'express';
import { getAllTokens, getScanStats } from '../services/scanner.service.js';
import { getSourceActivity } from '../services/trenches.service.js';
import { getMeteoraFeed } from '../services/helius-ws.service.js';
import { query } from '../lib/db.js';

const router = Router();

router.get('/', (_req, res) => {
  const tokens = getAllTokens();
  const stats = getScanStats();
  res.json({ tokens, stats });
});

router.get('/stats', (_req, res) => {
  res.json(getScanStats());
});

router.get('/sources', (_req, res) => {
  const activity = getSourceActivity();
  const meteoraFeed = getMeteoraFeed();
  const stats = getScanStats();
  res.json({
    ...activity,
    meteora: {
      total: stats.meteoraCount,
      recent: meteoraFeed.map((e) => ({
        mint: e.mint,
        ts: e.ts,
        txSig: e.txSig,
        source: e.source,
        instructionType: e.instructionType,
      })),
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
