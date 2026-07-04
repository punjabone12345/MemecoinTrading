import { Router } from 'express';
import {
  getWhaleStatus,
  manualCloseWhalePosition,
  editWhalePositionFields,
  deleteWhalePositionById,
  editClosedWhalePositionById,
  deleteClosedWhalePositionById,
} from '../services/whale-sniper.service.js';

const router = Router();

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  res.json(getWhaleStatus());
});

// ── Open position management ──────────────────────────────────────────────────

/** Close an open whale position at its last known price */
router.post('/:id/close', async (req, res) => {
  const { reason } = req.body as { reason?: string };
  const ok = await manualCloseWhalePosition(req.params.id, reason?.trim() || 'Manual close');
  if (!ok) { res.status(404).json({ error: 'Position not found or already closed' }); return; }
  res.json({ success: true });
});

/** Edit fields of an open whale position (entryPrice, currentSLPrice, triggerAmountUsd) */
router.patch('/:id', (req, res) => {
  const updates = req.body as { entryPrice?: number; currentSLPrice?: number; triggerAmountUsd?: number };
  const pos = editWhalePositionFields(req.params.id, updates);
  if (!pos) { res.status(404).json({ error: 'Position not found' }); return; }
  res.json(pos);
});

/** Delete an open whale position and refund remaining SOL to balance */
router.delete('/:id', async (req, res) => {
  const ok = await deleteWhalePositionById(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Position not found' }); return; }
  res.json({ success: true });
});

// ── Closed position management ────────────────────────────────────────────────

/** Edit a closed whale position (closeReason, closePnlPct) */
router.patch('/closed/:id', async (req, res) => {
  const updates = req.body as { closeReason?: string; closePnlPct?: number };
  const pos = await editClosedWhalePositionById(req.params.id, updates);
  if (!pos) { res.status(404).json({ error: 'Closed position not found' }); return; }
  res.json(pos);
});

/** Delete a closed whale position record */
router.delete('/closed/:id', async (req, res) => {
  const ok = await deleteClosedWhalePositionById(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Closed position not found' }); return; }
  res.json({ success: true });
});

export default router;
