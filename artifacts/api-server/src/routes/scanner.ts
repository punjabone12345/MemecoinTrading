import { Router } from 'express';
import { getAllTokens, getScanStats } from '../services/scanner.service.js';
import { getSourceActivity } from '../services/trenches.service.js';

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
  res.json(getSourceActivity());
});

export default router;
