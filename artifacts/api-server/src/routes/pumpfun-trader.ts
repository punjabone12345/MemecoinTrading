import { Router } from "express";
import { pumpfunTraderService } from "../services/pumpfun-trader.service.js";
import type { PumpfunConfig } from "../services/pumpfun-trader.service.js";

const router = Router();

router.get("/pumpfun/status", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getStatus() });
});

router.get("/pumpfun/tokens", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getTrackedTokens() });
});

router.get("/pumpfun/positions", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getOpenPositions() });
});

router.get("/pumpfun/history", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getClosedPositions() });
});

router.get("/pumpfun/events", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getEvents() });
});

router.get("/pumpfun/config", (_req, res) => {
  res.json({ success: true, data: pumpfunTraderService.getConfig() });
});

router.patch("/pumpfun/config", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const allowed: (keyof PumpfunConfig)[] = [
      "enabled", "minAiScore", "positionSizeSol", "maxOpenPositions",
      "graduationMinPct", "graduationMaxPct", "virtualBalanceSol", "scoreWeights",
    ];
    const patch: Partial<PumpfunConfig> = {};
    for (const k of allowed) {
      if (k in body) (patch as Record<string, unknown>)[k] = body[k];
    }
    const updated = await pumpfunTraderService.updateConfig(patch);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// Inject a token manually for testing / external discovery
router.post("/pumpfun/inject", (req, res): void => {
  try {
    const { mint, symbol, name, mcap, priceUsd, pairAddress } = req.body as {
      mint: string; symbol: string; name: string;
      mcap: number; priceUsd: number; pairAddress: string;
    };
    if (!mint || !symbol) {
      res.status(400).json({ success: false, error: "mint and symbol required" });
      return;
    }
    pumpfunTraderService.injectToken(mint, symbol, name ?? symbol, mcap ?? 0, priceUsd ?? 0, pairAddress ?? "");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

export default router;
