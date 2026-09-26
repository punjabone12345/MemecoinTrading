import { Router } from 'express';
import { getAltcoinStatus, getAltcoinAssets } from '../services/altcoin-market.service.js';
import {
  getPaperPortfolio,
  getPaperPositions,
  getClosedPositions,
  closePaperPosition,
  resetPaperPortfolio,
  getLearningMetrics,
} from '../services/altcoin-paper.service.js';

const router = Router();

/** GET /api/altcoin/status - Complete altcoin market status, signals, portfolio, health */
router.get('/status', async (_req, res) => {
  try {
    const status = await getAltcoinStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch status' });
  }
});

/** GET /api/altcoin/assets - List of tracked top ~100 liquid altcoins */
router.get('/assets', (_req, res) => {
  res.json({ assets: getAltcoinAssets() });
});

/** GET /api/altcoin/signals - Active trading signals */
router.get('/signals', async (_req, res) => {
  try {
    const status = await getAltcoinStatus();
    res.json({ signals: status.signals, stats: status.stats });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch signals' });
  }
});

/** GET /api/altcoin/portfolio - Current paper trading portfolio */
router.get('/portfolio', async (_req, res) => {
  try {
    const portfolio = await getPaperPortfolio();
    res.json(portfolio);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch portfolio' });
  }
});

/** GET /api/altcoin/positions - Open positions */
router.get('/positions', (_req, res) => {
  res.json({ open: getPaperPositions(), closed: getClosedPositions() });
});

/** POST /api/altcoin/close/:id - Close open position */
router.post('/close/:id', async (req, res) => {
  const { reason } = req.body as { reason?: string };
  const positionId = String(req.params.id || '');
  const ok = await closePaperPosition(positionId, reason?.trim() || 'Manual user close');
  if (!ok) {
    res.status(404).json({ error: 'Position not found or already closed' });
    return;
  }
  const portfolio = await getPaperPortfolio();
  res.json({ success: true, portfolio });
});

/** POST /api/altcoin/reset - Reset paper account balance */
router.post('/reset', async (req, res) => {
  const { initialBalanceUsd } = req.body as { initialBalanceUsd?: number };
  const portfolio = await resetPaperPortfolio(initialBalanceUsd);
  res.json({ success: true, portfolio });
});

/** GET /api/altcoin/learning - AI learning metrics */
router.get('/learning', (_req, res) => {
  res.json(getLearningMetrics());
});

/** GET /api/altcoin/health - System health diagnostic */
router.get('/health', async (_req, res) => {
  try {
    const status = await getAltcoinStatus();
    res.json(status.health);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch health' });
  }
});

export default router;
