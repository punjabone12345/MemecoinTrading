import { Router, type IRouter } from "express";
import { watchlistService } from "../services/watchlist.service.js";
import { scannerService } from "../services/scanner.service.js";

const router: IRouter = Router();

router.get("/watchlist", async (_req, res) => {
  const entries = watchlistService.getAll();
  const enriched = await Promise.all(
    entries.map(async (entry) => {
      const token = await scannerService.getOrFetchToken(entry.pairAddress);
      return { ...entry, token };
    }),
  );
  res.json({ success: true, count: enriched.length, data: enriched });
});

router.post("/watchlist", (req, res) => {
  const { pairAddress, note } = req.body as {
    pairAddress: string;
    note?: string;
  };
  if (!pairAddress || typeof pairAddress !== "string") {
    res.status(400).json({ success: false, error: "pairAddress is required" });
    return;
  }
  const entry = watchlistService.add(pairAddress, note);
  res.json({ success: true, data: entry });
});

router.delete("/watchlist/:pairAddress", (req, res) => {
  const removed = watchlistService.remove(req.params.pairAddress);
  if (!removed) {
    res
      .status(404)
      .json({ success: false, error: "Pair not found in watchlist" });
    return;
  }
  res.json({ success: true, message: "Removed from watchlist" });
});

router.patch("/watchlist/:pairAddress", (req, res) => {
  const { note } = req.body as { note: string };
  const updated = watchlistService.updateNote(req.params.pairAddress, note);
  if (!updated) {
    res.status(404).json({ success: false, error: "Pair not found" });
    return;
  }
  res.json({ success: true, message: "Note updated" });
});

export default router;
