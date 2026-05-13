import { Router, type IRouter } from "express";
import { autoTraderService } from "../services/auto-trader.service.js";
import { sendTelegram, isTelegramConfigured } from "../lib/telegram.js";
import type { AutoTraderConfig } from "../services/auto-trader.service.js";

const router: IRouter = Router();

router.get("/auto-trader/status", (_req, res) => {
  res.json({ success: true, data: autoTraderService.getStatus() });
});

router.post("/auto-trader/pause", async (_req, res) => {
  if (autoTraderService.isPaused()) {
    res.json({ success: false, error: "Auto-trader is already paused" });
    return;
  }
  autoTraderService.pause();
  res.json({ success: true, message: "Auto-trader paused" });
  if (isTelegramConfigured()) {
    const { toIST } = await import("../lib/telegram.js");
    void sendTelegram(
      `⏸️ <b>BOT PAUSED</b>\n` +
      `──────────────────────\n` +
      `The auto-trader has been paused from the app.\n` +
      `No new trades will be opened until resumed.\n` +
      `🕐 ${toIST(new Date())}`,
    );
  }
});

router.post("/auto-trader/resume", async (_req, res) => {
  if (!autoTraderService.isPaused()) {
    res.json({ success: false, error: "Auto-trader is already running" });
    return;
  }
  autoTraderService.resume();
  res.json({ success: true, message: "Auto-trader resumed" });
  if (isTelegramConfigured()) {
    const { toIST } = await import("../lib/telegram.js");
    const cfg = autoTraderService.getConfig();
    void sendTelegram(
      `▶️ <b>BOT RESUMED</b>\n` +
      `──────────────────────\n` +
      `The auto-trader is running again and scanning for trades.\n` +
      `🤖 Min AI Score: <b>${cfg.minAiScore}</b> | Max Slots: <b>${cfg.maxConcurrentTrades}</b>\n` +
      `🕐 ${toIST(new Date())}`,
    );
  }
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
    "solPerTrade",
    "maxConcurrentTrades",
    "minAiScore",
    "minConfidence",
    "minLiquidityUsd",
    "minVolume24hUsd",
    "minVolume1hUsd",
    "minBuyRatio1h",
    "minPriceChange1h",
    "minTransactions24h",
    "minMcapUsd",
    "maxMcapUsd",
    "minPairAgeMinutes",
    "maxPairAgeHours",
    "minLiquidityMcapRatio",
    "maxFdvMcapRatio",
    "maxPriceDropH6Pct",
    "maxPriceDropH24Pct",
  ];

  const validated: Partial<AutoTraderConfig> = {};
  for (const key of numericKeys) {
    const val = (patch as Record<string, unknown>)[key];
    if (val !== undefined) {
      if (typeof val !== "number" || isNaN(val)) {
        res.status(400).json({ success: false, error: `Invalid value for ${key}: must be a number` });
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
  const cfg = autoTraderService.getConfig();
  await sendTelegram(
    `✅ <b>Apex Meme Trader AI — Connected!</b>\n\n` +
    `🤖 Strict quality filters active:\n` +
    `• Min AI Score: <b>${cfg.minAiScore}/100</b>\n` +
    `• Min Liquidity: <b>$${cfg.minLiquidityUsd.toLocaleString()}</b>\n` +
    `• Min Vol 24h: <b>$${cfg.minVolume24hUsd.toLocaleString()}</b>\n` +
    `• Min Buy Ratio 1h: <b>${(cfg.minBuyRatio1h * 100).toFixed(0)}%</b>\n` +
    `• Mcap Range: <b>$${(cfg.minMcapUsd / 1000).toFixed(0)}k – $${(cfg.maxMcapUsd / 1_000_000).toFixed(0)}M</b>\n` +
    `• Pair Age: <b>${cfg.minPairAgeMinutes}m – ${cfg.maxPairAgeHours}h</b>\n` +
    `• Liq/MCap ≥ <b>${(cfg.minLiquidityMcapRatio * 100).toFixed(0)}%</b> (rug guard)\n\n` +
    `<i>${new Date().toUTCString()}</i>`,
  );
  res.json({ success: true, message: "Test message sent to Telegram" });
});

export default router;
