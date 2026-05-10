import { Router, type IRouter } from "express";
import { paperTradingService } from "../services/paper-trading.service.js";
import type { BuyOrderRequest } from "../types/index.js";

const router: IRouter = Router();

router.post("/paper-buy", async (req, res) => {
  const { pairAddress, solAmount, stopLoss, takeProfit, trailingStop } =
    req.body as BuyOrderRequest;

  if (!pairAddress || typeof pairAddress !== "string") {
    res.status(400).json({ success: false, error: "pairAddress is required" });
    return;
  }
  if (!solAmount || typeof solAmount !== "number" || solAmount <= 0) {
    res
      .status(400)
      .json({ success: false, error: "solAmount must be a positive number" });
    return;
  }

  try {
    const trade = await paperTradingService.buy({
      pairAddress,
      solAmount,
      stopLoss,
      takeProfit,
      trailingStop,
    });
    res.json({ success: true, data: trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ success: false, error: message });
  }
});

router.post("/paper-sell", async (req, res) => {
  const { tradeId } = req.body as { tradeId: string };

  if (!tradeId || typeof tradeId !== "string") {
    res.status(400).json({ success: false, error: "tradeId is required" });
    return;
  }

  try {
    const trade = await paperTradingService.sell(tradeId);
    res.json({ success: true, data: trade });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ success: false, error: message });
  }
});

router.post("/reset", (_req, res) => {
  paperTradingService.reset();
  res.json({ success: true, message: "Account reset to 100 SOL" });
});

export default router;
