import { Router, type IRouter } from "express";
import { paperTradingService } from "../services/paper-trading.service.js";
import { lossJournalService } from "../services/loss-journal.service.js";

const router: IRouter = Router();

router.post("/paper-buy", async (req, res) => {
  const { pairAddress, solAmount } = req.body as { pairAddress: string; solAmount?: number };

  if (!pairAddress || typeof pairAddress !== "string") {
    res.status(400).json({ success: false, error: "pairAddress is required" });
    return;
  }

  try {
    const position = await paperTradingService.buy(pairAddress, solAmount ?? 0.5);
    res.json({ success: true, data: position });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ success: false, error: message });
  }
});

router.post("/paper-sell", async (req, res) => {
  const { positionId, tradeId } = req.body as { positionId?: string; tradeId?: string };
  const id = positionId ?? tradeId;

  if (!id || typeof id !== "string") {
    res.status(400).json({ success: false, error: "positionId is required" });
    return;
  }

  try {
    const position = await paperTradingService.close(id, "manual");
    res.json({ success: true, data: position });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(400).json({ success: false, error: message });
  }
});

router.post("/reset", (_req, res) => {
  paperTradingService.reset();
  lossJournalService.clear();
  res.json({ success: true, message: "Account reset to 100 SOL and trade journal cleared" });
});

export default router;
