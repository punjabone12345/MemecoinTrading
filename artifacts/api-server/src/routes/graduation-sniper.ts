import { Router } from "express";
import { graduationSniperService } from "../services/graduation-sniper.service.js";

const router = Router();

router.get("/sniper/status", (_req, res) => {
  res.json({ success: true, data: graduationSniperService.getStatus() });
});

router.get("/sniper/positions", (_req, res) => {
  res.json({ success: true, data: graduationSniperService.getOpenPositions() });
});

router.get("/sniper/history", (_req, res) => {
  res.json({ success: true, data: graduationSniperService.getClosedPositions() });
});

router.get("/sniper/events", (_req, res) => {
  res.json({ success: true, data: graduationSniperService.getEvents() });
});

router.get("/sniper/config", (_req, res) => {
  res.json({ success: true, data: graduationSniperService.getConfig() });
});

router.patch("/sniper/config", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const allowed = [
      "enabled", "positionSizeSol", "maxOpenPositions", "slPct",
      "tp1Pct", "tp1ClosePct", "tp2Pct", "tp2ClosePct",
      "trailingStopPct", "waitBeforeEntryMs", "virtualBalanceSol",
    ];
    const patch: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in body) patch[k] = body[k];
    }
    const updated = await graduationSniperService.updateConfig(patch as never);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
