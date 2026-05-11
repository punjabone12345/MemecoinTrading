import { Router, type IRouter } from "express";
import { autoTraderService } from "../services/auto-trader.service.js";
import { sendTelegram, isTelegramConfigured } from "../lib/telegram.js";
import type { AutoTraderConfig } from "../services/auto-trader.service.js";

const router: IRouter = Router();

router.get("/auto-trader/status", (_req, res) => {
  res.json({ success: true, data: autoTraderService.getStatus() });
});

router.post("/auto-trader/pause", (_req, res) => {
  if (autoTraderService.isPaused()) {
    res.json({ success: false, error: "Auto-trader is already paused" });
    return;
  }
  autoTraderService.pause();
  res.json({ success: true, message: "Auto-trader paused" });
});

router.post("/auto-trader/resume", (_req, res) => {
  if (!autoTraderService.isPaused()) {
    res.json({ success: false, error: "Auto-trader is already running" });
    return;
  }
  autoTraderService.resume();
  res.json({ success: true, message: "Auto-trader resumed" });
});

router.get("/auto-trader/history", (_req, res) => {
  const history = autoTraderService.getHistory();
  res.json({ success: true, count: history.length, data: history });
});

router.get("/auto-trader/config", (_req, res) => {
  res.json({ success: true, data: autoTraderService.getConfig() });
});

router.patch("/auto-trader/config", (req, res) => {
  const patch = req.body as Partial<AutoTraderConfig>;
  const numericKeys: (keyof AutoTraderConfig)[] = [
    "solPerTrade", "minAiScore", "maxConcurrentTrades",
  ];
  const validated: Partial<AutoTraderConfig> = {};
  for (const key of numericKeys) {
    const val = patch[key];
    if (val !== undefined) {
      if (typeof val !== "number" || isNaN(val) || val < 0) {
        res.status(400).json({ success: false, error: `Invalid value for ${key}` });
        return;
      }
      (validated as Record<string, number>)[key] = val;
    }
  }
  const updated = autoTraderService.updateConfig(validated);
  res.json({ success: true, data: updated });
});

router.post("/auto-trader/test-telegram", async (_req, res) => {
  if (!isTelegramConfigured()) {
    res.status(400).json({ success: false, error: "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
    return;
  }
  await sendTelegram(
    `✅ <b>Apex Meme Trader AI — Connected!</b>\n\n` +
    `🤖 Your bot is live and monitoring Solana meme coins.\n` +
    `⚡ Auto-trader fires every 30 seconds.\n` +
    `📊 You'll receive alerts here for every trade.\n\n` +
    `<i>Time: ${new Date().toUTCString()}</i>`,
  );
  res.json({ success: true, message: "Test message sent to Telegram" });
});

export default router;
