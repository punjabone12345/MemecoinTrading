import { Router } from 'express';
import { getWhaleStatus } from '../services/whale-sniper.service.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(getWhaleStatus());
});

export default router;
