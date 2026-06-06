import { Router, type IRouter } from "express";
import { rssMonitorService } from "../services/rss-monitor.service.js";

const router: IRouter = Router();

router.get("/rss-signals", (_req, res) => {
  const signals = rssMonitorService.getRssSignals();
  res.json({ success: true, count: signals.length, data: signals });
});

export default router;
