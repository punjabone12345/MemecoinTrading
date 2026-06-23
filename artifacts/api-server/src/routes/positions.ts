import { Router } from 'express';
import {
  getOpenPositions,
  getClosedPositions,
  closePosition,
  editPosition,
  deletePosition,
  getAnalytics,
} from '../services/position.service.js';
import { getBalance } from '../services/settings.service.js';

const router = Router();

router.get('/', async (_req, res) => {
  const [open, closed] = await Promise.all([getOpenPositions(), getClosedPositions()]);
  res.json({ open, closed });
});

router.get('/open', async (_req, res) => {
  const positions = await getOpenPositions();
  res.json(positions);
});

router.get('/closed', async (_req, res) => {
  const positions = await getClosedPositions();
  res.json(positions);
});

router.get('/analytics', async (_req, res) => {
  const [analytics, balance] = await Promise.all([getAnalytics(), getBalance()]);
  res.json({ ...analytics, balance });
});

router.post('/:id/close', async (req, res) => {
  const { id } = req.params;
  const { currentPrice } = req.body as { currentPrice?: number };
  if (!currentPrice) return res.status(400).json({ error: 'currentPrice required' });

  const position = await closePosition(id, currentPrice, 'Manual close');
  if (!position) return res.status(404).json({ error: 'Position not found or already closed' });
  res.json(position);
});

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body as {
    entryPrice?: number; sizeSol?: number; slCurrent?: number;
    tp1Hit?: boolean; tp2Hit?: boolean; tp3Hit?: boolean; notes?: string;
  };
  const position = await editPosition(id, updates);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  res.json(position);
});

router.delete('/:id', async (req, res) => {
  await deletePosition(req.params.id);
  res.json({ success: true });
});

export default router;
