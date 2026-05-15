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

router.delete("/loss-journal/entries/:positionId", (req, res) => {
  const { positionId } = req.params;
  const deleted = lossJournalService.deleteEntry(positionId);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: "Entry not found" });
  }
});

router.delete("/loss-journal/entries", (_req, res) => {
  lossJournalService.clear();
  res.json({ success: true, message: "Trade journal cleared" });
});

export default router;
