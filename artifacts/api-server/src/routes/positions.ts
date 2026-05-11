import { Router, type IRouter } from "express";
import { paperTradingService } from "../services/paper-trading.service.js";

const router: IRouter = Router();

router.get("/positions", (_req, res) => {
  const positions = paperTradingService.getOpenTradesWithLivePnl();
  const portfolio = paperTradingService.getPortfolio();
  res.json({ success: true, data: { positions, portfolio } });
});

router.get("/positions/all", (_req, res) => {
  const all = paperTradingService.getAllTrades();
  res.json({ success: true, count: all.length, data: all });
});

router.get("/positions/closed", (_req, res) => {
  const closed = paperTradingService.getClosedTrades();
  res.json({ success: true, count: closed.length, data: closed });
});

router.get("/positions/portfolio", (_req, res) => {
  const portfolio = paperTradingService.getPortfolio();
  res.json({ success: true, data: portfolio });
});

router.get("/positions/:id", (req, res) => {
  const trade = paperTradingService.getTradeById(req.params.id);
  if (!trade) {
    res.status(404).json({ success: false, error: "Trade not found" });
    return;
  }
  const live = paperTradingService.getLiveTrade(req.params.id);
  res.json({ success: true, data: live ?? trade });
});

export default router;
