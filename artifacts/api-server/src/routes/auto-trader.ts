import { Router, type IRouter } from "express";
import { autoTraderService } from "../services/auto-trader.service.js";

const router: IRouter = Router();

router.get("/auto-trader/status", (_req, res) => {
  const status = autoTraderService.getStatus();
  res.json({ success: true, data: status });
});

export default router;
