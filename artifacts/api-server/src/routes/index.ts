import { Router } from 'express';
import positionsRouter from './positions.js';
import scannerRouter from './scanner.js';
import settingsRouter from './settings.js';
import whaleSniperRouter from './whale-sniper.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Returns the correct WebSocket URL so Vercel-hosted frontends can
// connect directly to Render's WS endpoint instead of going through
// Vercel (which cannot proxy WebSocket connections).
router.get('/config', (_req, res) => {
  const renderHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  // Only return an explicit wsUrl when running on Render.
  // In dev, return null so the frontend falls back to window.location.host
  // (which goes through the Vite WebSocket proxy correctly).
  const wsUrl = renderHost ? `wss://${renderHost}/ws` : null;
  res.json({ wsUrl });
});

router.use('/positions', positionsRouter);
router.use('/scanner', scannerRouter);
router.use('/settings', settingsRouter);
router.use('/whale', whaleSniperRouter);

export default router;
