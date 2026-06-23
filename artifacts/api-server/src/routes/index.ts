import { Router } from 'express';
import positionsRouter from './positions.js';
import scannerRouter from './scanner.js';
import settingsRouter from './settings.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

router.use('/positions', positionsRouter);
router.use('/scanner', scannerRouter);
router.use('/settings', settingsRouter);

export default router;
