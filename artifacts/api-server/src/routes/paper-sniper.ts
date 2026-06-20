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
    if (!updated) {
      res.status(404).json({ error: "Trade not found in history" });
      return;
    }
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

// ── Test Phase 3 trigger — fires a fake buy signal so you can verify paper trades work ──
router.post("/paper-sniper/test-phase3", async (_req, res) => {
  try {
    // Use a unique fake mint per request so repeated test presses never conflict.
    // Suffix with a timestamp so each is a distinct "token" in openPositions.
    const fakeId   = Date.now().toString(36).slice(-5).toUpperCase();
    const fakeMint   = `TEST${fakeId}111111111111111111111111111111111111111`; // 44 chars, valid-length
    const fakeSymbol = `TEST`;
    // Fetch the current SOL/USD price from Jupiter so the position has a real price
    let testPrice = 0.000050; // default ~$50k mcap price
    try {
      const { default: axios } = await import("axios");
      const r = await axios.get<{ data: Record<string, { price: number }> }>(
        "https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
        { timeout: 3_000 }
      );
      const p = r.data?.data?.["So11111111111111111111111111111111111111112"]?.price;
      if (p && p > 0) testPrice = p / 1_000_000; // scale down so it looks like a memecoin price
    } catch { /* use default */ }

    await paperSniperService.enterPhase3Trade(
      fakeMint,
      fakeSymbol,
      testPrice,
      48.0,   // phase1PumpPct  — simulated +48% pump
      32.0,   // phase2DumpPct  — simulated -32% dump
      73.0,   // phase3RetracePct — simulated +73% retrace (above 40% threshold)
    );

    res.json({
      success: true,
      message: "Test Phase 3 signal fired — check Paper tab for a new TEST position",
      mint: fakeMint,
      symbol: fakeSymbol,
      price: testPrice,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
