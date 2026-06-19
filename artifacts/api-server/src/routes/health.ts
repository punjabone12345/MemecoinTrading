import axios from "axios";
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

// ─── WSOL vault balance test — proves on-chain liquidity reading works ────────
// GET /api/debug/vault-test?pubkey=<vault_pubkey>
// Calls getTokenAccountBalance on the given vault pubkey using the same
// multi-RPC fallback logic as the token quality service.
// Usage: test with a real Raydium CPMM vault pubkey from a pump.fun graduation.
router.get("/debug/vault-test", async (req: Request, res: Response) => {
  const pubkey = req.query["pubkey"] as string | undefined;
  if (!pubkey) {
    res.status(400).json({ error: "?pubkey= query param required" });
    return;
  }

  const HELIUS_KEY = process.env["HELIUS_API_KEY"] ?? null;
  const endpoints: string[] = [
    ...(HELIUS_KEY ? [`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`] : []),
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/demo",
  ];

  const results: Record<string, unknown> = {};

  for (const endpoint of endpoints) {
    try {
      type TokenBalResp = { result?: { value?: { uiAmount?: number | null; uiAmountString?: string; amount?: string; decimals?: number } }; error?: unknown };
      const r = await axios.post<TokenBalResp>(
        endpoint,
        { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [pubkey] },
        { timeout: 6_000 },
      );
      if (r.data?.error) {
        results[endpoint.replace("https://","").split("/")[0]] = { error: r.data.error };
      } else {
        const val = r.data?.result?.value;
        results[endpoint.replace("https://","").split("/")[0]] = val ?? null;
        if (val?.uiAmount != null && val.uiAmount > 0) {
          res.json({
            ok: true,
            pubkey,
            uiAmount: val.uiAmount,
            solBalance: val.uiAmount,
            endpoint: endpoint.replace("https://","").split("/")[0],
            allResults: results,
            message: `✅ On-chain vault balance: ${val.uiAmount.toFixed(2)} SOL — fix is working!`,
          });
          return;
        }
      }
    } catch (e) {
      results[endpoint.replace("https://","").split("/")[0]] = { error: (e as Error).message };
    }
  }

  res.json({ ok: false, pubkey, allResults: results, message: "All RPC endpoints returned 0 or error for this pubkey" });
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
