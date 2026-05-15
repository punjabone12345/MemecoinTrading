import { type Request, type Response, Router, type IRouter } from "express";
import { analyseTokenWithAi } from "../services/ai-analysis.service.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Live AI debug endpoint ────────────────────────────────────────────────────
// Runs a real analyseTokenWithAi() call and returns the result.
// Used by the in-app "Test Gemini" button to confirm AI is working.
// Gemini takes ~10 s so we disable socket timeouts for this route only.
router.get("/debug/ai-test", async (req: Request, res: Response) => {
  // Prevent the socket from being closed before Gemini responds (~10 s)
  req.socket?.setTimeout(0);
  req.socket?.setKeepAlive(true);
  res.setTimeout(35_000);

  const start = Date.now();
  try {
    const result = await analyseTokenWithAi({
      symbol: "TESTTOKEN",
      name: "Test Token",
      pairAddress: "test-pair",
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
