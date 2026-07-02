import { Router } from 'express';
import { getAllTokens, getScanStats } from '../services/scanner.service.js';
import { getSourceActivity, getPumpfunMints, getPumpfunFeed } from '../services/trenches.service.js';
import { getMeteoraFeed, getMeteoraMintsCount } from '../services/helius-ws.service.js';
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
  // Use the same counters as the dashboard tiles (getPumpfunMints().size and
  // getMeteoraMintsCount()) so live-feed totals always match the tile numbers.
  const pumpfunTotal = getPumpfunMints().size;
  let pumpfunFeedItems = getPumpfunFeed();
  const meteoraFeed  = getMeteoraFeed();
  const meteoraTotal = getMeteoraMintsCount();

  // Fallback: if the in-memory feed is empty but mints exist (e.g. after an
  // incomplete restart cycle), synthesise placeholder entries from the mint set
  // so the live-feed panel always matches the counter tile.
  if (pumpfunFeedItems.length === 0 && pumpfunTotal > 0) {
    const now = Date.now();
    pumpfunFeedItems = Array.from(getPumpfunMints())
      .slice(0, 20)
      .map((mint) => ({ mint, ts: now, instructionType: 'migrate' }));
  }

  res.json({
    pumpfun: {
      total: pumpfunTotal,
      recent: pumpfunFeedItems,
    },
    meteora: {
      total: meteoraTotal,
      recent: meteoraFeed.map((e) => ({
        mint: e.mint,
        ts: e.ts,
        txSig: e.txSig,
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
