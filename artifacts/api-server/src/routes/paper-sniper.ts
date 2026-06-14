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

router.post("/paper-sniper/reset", async (_req, res) => {
  await paperSniperService.reset();
  res.json({ success: true });
});

export default router;
