import { Router } from "express";
import { paperSniperService } from "../services/paper-sniper.service.js";

const router = Router();

router.get("/paper-sniper/status", (_req, res) => {
  res.json(paperSniperService.getStatus());
});

router.get("/paper-sniper/positions", (_req, res) => {
  res.json(paperSniperService.getOpenPositions());
});

router.get("/paper-sniper/history", (_req, res) => {
  res.json(paperSniperService.getHistory());
});

router.get("/paper-sniper/events", (_req, res) => {
  res.json(paperSniperService.getEvents());
});

router.get("/paper-sniper/config", (_req, res) => {
  res.json(paperSniperService.getConfig());
});

router.patch("/paper-sniper/config", async (req, res) => {
  try {
    const updated = await paperSniperService.updateConfig(req.body as object);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/paper-sniper/positions/:id/close", (req, res) => {
  const closed = paperSniperService.closePositionById(req.params.id);
  if (closed) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Position not found or already closed" });
  }
});

router.patch("/paper-sniper/history/:id", async (req, res) => {
  try {
    const updated = await paperSniperService.updateHistoryPosition(req.params.id, req.body as object);
    if (!updated) return res.status(404).json({ error: "Trade not found in history" });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.delete("/paper-sniper/history/:id", async (req, res) => {
  const deleted = await paperSniperService.deleteHistoryPosition(req.params.id);
  if (deleted) res.json({ success: true });
  else res.status(404).json({ error: "Trade not found in history" });
});

router.post("/paper-sniper/reset", async (_req, res) => {
  await paperSniperService.reset();
  res.json({ success: true });
});

export default router;
