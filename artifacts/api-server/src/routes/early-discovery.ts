import { Router } from "express";
import { earlyDiscoveryService } from "../services/early-discovery.service.js";
import type { EDConfig } from "../services/early-discovery.service.js";

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

router.post("/ed/inject-test", (req, res) => {
  const { mint } = req.body as { mint?: string };
  if (!mint || mint.length < 32) {
    res.status(400).json({ error: "Valid mint address required" });
    return;
  }
  earlyDiscoveryService.injectTestToken(mint);
  res.json({ ok: true, mint });
});

export default router;
