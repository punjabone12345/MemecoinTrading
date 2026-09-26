import { Router } from 'express';
import scannerRouter from './scanner.js';
import settingsRouter from './settings.js';
import sniperRouter from './sniper.js';
import diagnosticsRouter from './diagnostics.js';
import altcoinRouter from './altcoin.js';
import { getTrenchesDiagnostics } from '../services/trenches.service.js';
import { isHeliusCoolingDown, heliusCooldownRemainingMs } from '../lib/helius-limiter.js';
import { resetPaperPortfolio } from '../services/altcoin-paper.service.js';

const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

router.get('/debug', (_req, res) => {
  const d = getTrenchesDiagnostics();
  res.json({
    serverTime: new Date().toISOString(),
    heliusApiKeySet: d.heliusApiKeySet,
    rpcEndpoint: d.rpcEndpoint,
    discovery: {
      source:             d.source,
      pollCount:          d.pollCount,
      lastPollAgoSec:     d.lastPollAgoSec,
      consecutiveFailures: d.consecutiveFailures,
      lastError:          d.lastPollError,
      pollIntervalMs:     d.pollIntervalMs,
      totalDiscovered:    d.totalDiscovered,
      activeMints:        d.activeMints,
      recent:             d.recentFeed,
    },
    heliusCooldown: {
      active: isHeliusCoolingDown(),
      remainingMs: heliusCooldownRemainingMs(),
    },
  });
});

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

router.post('/portfolio/reset', async (req, res) => {
  const { initialBalanceUsd } = req.body as { initialBalanceUsd?: number };
  const portfolio = await resetPaperPortfolio(initialBalanceUsd);
  res.json({ success: true, portfolio });
});

router.use('/altcoin', altcoinRouter);
router.use('/scanner', scannerRouter);
router.use('/settings', settingsRouter);
router.use('/sniper', sniperRouter);
router.use('/diagnostics', diagnosticsRouter);

export default router;
