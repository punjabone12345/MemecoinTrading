import { Router, type IRouter } from "express";
import { computeAnalytics } from "../services/analytics.service.js";

const router: IRouter = Router();

router.get("/analytics", (_req, res) => {
  const analytics = computeAnalytics();
  res.json({ success: true, data: analytics });
});

export default router;
