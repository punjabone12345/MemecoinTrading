import { type Request, type Response, Router, type IRouter } from "express";
import { analyseTokenWithAi } from "../services/ai-analysis.service.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Env diagnostic — visit /api/debug/env to see what keys the server has ───
router.get("/debug/env", (_req, res) => {
  const vars: Record<string, string> = {};

  const watchKeys = [
    "GROQ_API_KEY",
    "NODE_ENV",
    "PORT",
    "DATABASE_URL",
  ];

  for (const key of watchKeys) {
    const val = process.env[key];
    if (val === undefined) {
      vars[key] = "❌ NOT SET";
    } else if (val === "") {
      vars[key] = "⚠️ SET BUT EMPTY";
    } else {
      vars[key] = `✅ SET — starts with "${val.slice(0, 6)}…" (${val.length} chars)`;
    }
  }

  const allKeys = Object.keys(process.env).sort();
  res.json({ message: "Env diagnostic — values are masked for safety", aiVars: vars, allKeyNames: allKeys });
});

// ─── Live AI test endpoint ─────────────────────────────────────────────────────
// Runs a real dual-Groq analysis and returns the result.
// Used by the in-app "Test AI" button to confirm both models are working.
router.get("/debug/ai-test", async (req: Request, res: Response) => {
  req.socket?.setTimeout(0);
  req.socket?.setKeepAlive(true);
  res.setTimeout(35_000);

  const start = Date.now();
  try {
    const result = await analyseTokenWithAi({
      symbol:          "TESTTOKEN",
      name:            "Test Token",
      contractAddress: "test-contract",
      pairAddress:     "test-pair",
      dexId:           "raydium",
      pairAgeMinutes:  45,
      priceUsd:        0.00000042,
      marketCapUsd:    300_000,
      fdv:             300_000,
      liquidityUsd:    50_000,
      volume24hUsd:    900_000,
      volume1hUsd:     120_000,
      priceChange5m:   2.1,
      priceChange1h:   28.3,
      priceChange6h:   45.2,
      priceChange24h:  120.5,
      buys1h:          340,
      sells1h:         160,
      buys5m:          30,
      sells5m:         10,
      txns24h:         2100,
      aiScore:         86,
      confidence:      78,
    });
    res.json({ ok: true, wallMs: Date.now() - start, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message, wallMs: Date.now() - start });
  }
});

export default router;
