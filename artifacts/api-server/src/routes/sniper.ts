import { Router } from 'express';
import { getAltcoinStatus } from '../services/altcoin-market.service.js';
import {
  closePaperPosition,
  getPaperPositions,
  getClosedPositions,
  resetPaperPortfolio,
} from '../services/altcoin-paper.service.js';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', async (_req, res) => {
  try {
    const status = await getAltcoinStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch status' });
  }
});

// ── Open position management ──────────────────────────────────────────────────

/** Close an open paper position at its last known price */
router.post('/:id/close', async (req, res) => {
  const { reason } = req.body as { reason?: string };
  const positionId = String(req.params.id || '');
  const ok = await closePaperPosition(positionId, reason?.trim() || 'Manual user close');
  if (!ok) {
    res.status(404).json({ error: 'Position not found or already closed' });
    return;
  }
  res.json({ success: true });
});

/** List open paper positions */
router.get('/positions', (_req, res) => {
  res.json(getPaperPositions());
});

/** List closed paper positions */
router.get('/positions/closed', (_req, res) => {
  res.json(getClosedPositions());
});

/** Reset paper portfolio back to initial state */
router.post('/reset', async (req, res) => {
  const { initialBalanceUsd } = req.body as { initialBalanceUsd?: number };
  const portfolio = await resetPaperPortfolio(initialBalanceUsd);
  res.json({ success: true, portfolio });
});

export default router;
