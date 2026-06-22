import { Router } from "express";
import { earlyDiscoveryService } from "../services/early-discovery.service.js";
import type { EDConfig, EDPositionPatch } from "../services/early-discovery.service.js";

const router = Router();

router.get("/ed/status", (_req, res) => {
  res.json(earlyDiscoveryService.getStatus());
});

router.get("/ed/tokens", (_req, res) => {
  res.json(earlyDiscoveryService.getTokens());
});

router.get("/ed/positions", (_req, res) => {
  res.json(earlyDiscoveryService.getPositions());
});

router.get("/ed/config", (_req, res) => {
  res.json(earlyDiscoveryService.getConfig());
});

router.patch("/ed/config", async (req, res) => {
  try {
    const config = await earlyDiscoveryService.updateConfig(req.body as Partial<EDConfig>);
    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

router.post("/ed/reset-paper", async (_req, res) => {
  await earlyDiscoveryService.resetPaperBalance();
  res.json({ ok: true, balance: 1.0 });
});

router.post("/ed/positions/:id/close", (req, res) => {
  const ok = earlyDiscoveryService.forceClosePosition(req.params.id);
  if (!ok) { res.status(404).json({ error: "Position not found or already closed" }); return; }
  res.json({ ok: true });
});

router.delete("/ed/positions/:id", (req, res) => {
  const ok = earlyDiscoveryService.deletePosition(req.params.id);
  if (!ok) { res.status(404).json({ error: "Position not found" }); return; }
  res.json({ ok: true });
});

router.patch("/ed/positions/:id", (req, res) => {
  const patch = req.body as EDPositionPatch;
  const pos = earlyDiscoveryService.editPosition(req.params.id, patch);
  if (!pos) { res.status(404).json({ error: "Position not found" }); return; }
  res.json(pos);
});

router.post("/ed/inject-test", (req, res) => {
  const { mint } = req.body as { mint?: string };
  if (!mint || mint.length < 32) {
    res.status(400).json({ error: "Valid mint address required" });
    return;
  }
  earlyDiscoveryService.injectTestToken(mint);
  res.json({ ok: true, mint });
});

router.get("/ed/analytics", (_req, res) => {
  const positions = earlyDiscoveryService.getPositions();
  const closed = positions.closed;
  const open = positions.open;

  const total = closed.length;
  const wins = closed.filter((p) => p.realizedPnlSol > 0);
  const losses = closed.filter((p) => p.realizedPnlSol <= 0);
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;

  const grossProfit = wins.reduce((s, p) => s + p.realizedPnlSol, 0);
  const grossLoss   = Math.abs(losses.reduce((s, p) => s + p.realizedPnlSol, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const pnls = closed.map((p) => p.realizedPnlSol).sort((a, b) => a - b);
  const avgPnl = total > 0 ? pnls.reduce((s, v) => s + v, 0) / total : 0;
  const medianPnl = total > 0 ? pnls[Math.floor(total / 2)] ?? 0 : 0;

  let peak = 0, trough = 0, maxDrawdown = 0, running = 0;
  for (const p of closed.slice().reverse()) {
    running += p.realizedPnlSol;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const byScore = [
    { range: "95-99",   min: 95,  max: 99  },
    { range: "100-109", min: 100, max: 109 },
    { range: "110-120", min: 110, max: 120 },
  ].map(({ range, min, max }) => {
    const group = closed.filter((p) => p.entryScore >= min && p.entryScore <= max);
    const gWins = group.filter((p) => p.realizedPnlSol > 0);
    return {
      range,
      trades: group.length,
      winRate: group.length > 0 ? (gWins.length / group.length) * 100 : 0,
      avgPnl: group.length > 0 ? group.reduce((s, p) => s + p.realizedPnlSol, 0) / group.length : 0,
      totalPnl: group.reduce((s, p) => s + p.realizedPnlSol, 0),
    };
  });

  const avgHoldTimeWins = wins.length > 0
    ? wins.reduce((s, p) => s + (p.closedAt ?? p.entryAt) - p.entryAt, 0) / wins.length / 60_000
    : 0;
  const avgHoldTimeLosses = losses.length > 0
    ? losses.reduce((s, p) => s + (p.closedAt ?? p.entryAt) - p.entryAt, 0) / losses.length / 60_000
    : 0;

  res.json({
    total,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    grossProfit,
    grossLoss,
    avgPnl,
    medianPnl,
    maxDrawdown,
    totalRealizedPnl: closed.reduce((s, p) => s + p.realizedPnlSol, 0),
    openCount: open.length,
    unrealizedPnl: open.reduce((s, p) => s + p.unrealizedPnlSol, 0),
    byScore,
    avgHoldTimeWins,
    avgHoldTimeLosses,
    recentTrades: closed.slice(0, 20),
  });
});

export default router;
