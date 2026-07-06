import { Router } from 'express';
import { getSettings, updateSettings, resetAllData, getBalance } from '../services/settings.service.js';
import { broadcastBalance, broadcastSettings } from '../websocket/server.js';
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

  // Push updated settings to every connected WS client.
  broadcastSettings().catch(() => { /* non-fatal */ });

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
