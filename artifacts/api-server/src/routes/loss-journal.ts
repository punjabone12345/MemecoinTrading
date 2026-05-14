import { Router, type IRouter } from "express";
import { lossJournalService } from "../services/loss-journal.service.js";

const router: IRouter = Router();

router.get("/loss-journal", (_req, res) => {
  const insights = lossJournalService.getInsights();
  res.json({ success: true, data: insights });
});

router.get("/loss-journal/entries", (_req, res) => {
  const entries = lossJournalService.getEntries();
  res.json({ success: true, count: entries.length, data: entries });
});

export default router;
