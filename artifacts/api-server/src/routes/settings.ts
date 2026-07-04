import { Router } from 'express';
import { getSettings, updateSettings, resetAllData, getBalance } from '../services/settings.service.js';
import { broadcastBalance, broadcastSettings, broadcastTokens } from '../websocket/server.js';
import { reEvaluateCachedTokens } from '../services/scanner.service.js';
import { resetWhaleState } from '../services/whale-sniper.service.js';

const router = Router();

router.get('/', async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

router.patch('/', async (req, res) => {
  const updates = req.body as Record<string, string>;
  const stringified: Record<string, string> = {};
  for (const [k, v] of Object.entries(updates)) {
    stringified[k] = String(v);
  }
  await updateSettings(stringified);
  const settings = await getSettings();

  // Immediately re-evaluate all cached tokens with the new settings,
  // then push updated tokens + settings to every connected WS client.
  // This ensures filter changes (e.g. minMc) take effect right away
  // without waiting for the next full scan cycle.
  reEvaluateCachedTokens()
    .then(() => Promise.all([broadcastTokens(), broadcastSettings()]))
    .catch(() => { /* non-fatal — next scan will pick up the changes */ });

  res.json(settings);
});

router.post('/reset', async (_req, res) => {
  await resetAllData();
  resetWhaleState();
  await broadcastBalance();
  const balance = await getBalance();
  res.json({ success: true, balance });
});

export default router;
