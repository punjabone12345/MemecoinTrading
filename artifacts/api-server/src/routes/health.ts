import { Router, type IRouter } from "express";
import { analyseTokenWithAi } from "../services/ai-analysis.service.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/debug/ai-test", async (_req, res) => {
  const start = Date.now();
  try {
    const result = await analyseTokenWithAi({
      symbol: "TESTTOKEN",
      name: "Test Token",
      pairAddress: "test",
      dexId: "raydium",
      pairAgeMinutes: 45,
      priceUsd: 0.00000042,
      marketCapUsd: 300_000,
      fdv: 300_000,
      liquidityUsd: 50_000,
      volume24hUsd: 900_000,
      volume1hUsd: 120_000,
      priceChange5m: 2.1,
      priceChange1h: 15.3,
      priceChange6h: 45.2,
      priceChange24h: 120.5,
      buys1h: 340,
      sells1h: 160,
      buys5m: 30,
      sells5m: 10,
      txns24h: 2100,
      aiScore: 86,
      confidence: 78,
    });
    res.json({ ok: true, wallMs: Date.now() - start, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, wallMs: Date.now() - start });
  }
});

export default router;
