import { Router, type IRouter } from "express";
import { alertsService } from "../services/alerts.service.js";

const router: IRouter = Router();

router.get("/alerts", (_req, res) => {
  const alerts = alertsService.getAll();
  res.json({ success: true, count: alerts.length, data: alerts });
});

router.get("/alerts/unread", (_req, res) => {
  const alerts = alertsService.getUnread();
  res.json({ success: true, count: alerts.length, data: alerts });
});

router.patch("/alerts/:id/read", (req, res) => {
  const marked = alertsService.markRead(req.params.id);
  if (!marked) {
    res.status(404).json({ success: false, error: "Alert not found" });
    return;
  }
  res.json({ success: true, message: "Alert marked as read" });
});

router.post("/alerts/read-all", (_req, res) => {
  alertsService.markAllRead();
  res.json({ success: true, message: "All alerts marked as read" });
});

router.delete("/alerts", (_req, res) => {
  alertsService.clear();
  res.json({ success: true, message: "All alerts cleared" });
});

export default router;
