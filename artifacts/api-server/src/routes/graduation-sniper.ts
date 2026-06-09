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

// ── Edit a position (entry price, exit price, realized PNL, close reason) ──
router.patch("/sniper/positions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body as Record<string, unknown>;
    const patch: { entryPrice?: number; exitPrice?: number; currentPrice?: number; closeReason?: string; realizedPnlSol?: number } = {};
    if (typeof body["entryPrice"]     === "number") patch.entryPrice     = body["entryPrice"] as number;
    if (typeof body["exitPrice"]      === "number") patch.exitPrice      = body["exitPrice"] as number;
    if (typeof body["currentPrice"]   === "number") patch.currentPrice   = body["currentPrice"] as number;
    if (typeof body["closeReason"]    === "string") patch.closeReason    = body["closeReason"] as string;
    if (typeof body["realizedPnlSol"] === "number") patch.realizedPnlSol = body["realizedPnlSol"] as number;

    const updated = await graduationSniperService.editPosition(id!, patch);
    if (!updated) return res.status(404).json({ success: false, error: "Position not found" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Recalculate P&L from first principles (fixes bug-inflated totals) ───────
router.post("/sniper/positions/:id/recalculate", async (req, res) => {
  try {
    const updated = await graduationSniperService.recalculatePnl(req.params.id!);
    if (!updated) return res.status(404).json({ success: false, error: "Closed position not found or missing exit price" });
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Delete a position (open or closed) ─────────────────────────────────────
router.delete("/sniper/positions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const ok = await graduationSniperService.deletePosition(id!);
    if (!ok) return res.status(404).json({ success: false, error: "Position not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ── Delete an event from the detection feed ─────────────────────────────────
router.delete("/sniper/events/:id", (req, res) => {
  const { id } = req.params;
  const ok = graduationSniperService.deleteEvent(id!);
  if (!ok) return res.status(404).json({ success: false, error: "Event not found" });
  res.json({ success: true });
});

// ── Reset sniper account (clear all positions + restore virtual balance) ────
router.post("/sniper/reset", async (_req, res) => {
  try {
    await graduationSniperService.resetAccount();
    res.json({ success: true, data: graduationSniperService.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
