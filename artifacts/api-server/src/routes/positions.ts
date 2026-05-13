import { Router, type IRouter } from "express";
import { paperTradingService } from "../services/paper-trading.service.js";

const router: IRouter = Router();

router.get("/positions", (_req, res) => {
  const positions = paperTradingService.getOpenPositionsWithLivePnl();
  const portfolio = paperTradingService.getPortfolio();
  res.json({
    success: true,
    data: {
      positions,
      portfolio: {
        solBalance: portfolio.solBalance,
        totalPnlSol: portfolio.totalPnlSol,
        totalPnlPercent: portfolio.totalPnlPercent,
        openPositionsCount: portfolio.openPositionsCount,
        openPositionsValueSol: portfolio.openPositionsValueSol,
        initialBalance: portfolio.initialBalance,
      },
    },
  });
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

router.delete("/positions/history/:id", (req, res) => {
  try {
    paperTradingService.deleteClosedTrade(req.params.id);
    res.json({ success: true, message: "Trade deleted and balance restored" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(404).json({ success: false, error: message });
  }
});

router.get("/positions/:id", (req, res) => {
  const position = paperTradingService.getPositionById(req.params.id);
  if (!position) {
    res.status(404).json({ success: false, error: "Position not found" });
    return;
  }
  res.json({ success: true, data: position });
});

export default router;
