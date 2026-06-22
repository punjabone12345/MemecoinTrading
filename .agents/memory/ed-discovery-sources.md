---
name: ED token discovery sources
description: What APIs work for discovering new pump.fun token launches in Replit and calibration rules for rugcheck on brand-new tokens
---

## What is blocked in Replit's sandbox
- `wss://pumpportal.fun/api/data` — ECONNREFUSED (216.155.134.164:443). Outbound WebSocket is blocked.
- `https://client-api-2-74b1891ee9f9.herokuapp.com` — dead Heroku app ("No such app").
- `https://frontend-api.pump.fun` — Cloudflare error 1016 (blocked).
- `https://frontend-api-v3.pump.fun` — used for `fetchPumpFunData()` (metadata only, not for discovery).

## What WORKS in Replit
- `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1`
  - Returns ~20-30 pools created in the last few minutes, sorted newest first.
  - Includes `relationships.base_token.data.id` = `"solana_<MINT>"` for extracting mint address.
  - Includes `relationships.dex.data.id` — filter to `["pump-fun", "pumpswap", "pump_amm", "pump-amm"]`.
  - Extract symbol from `attributes.name` (format: `"SYMBOL / SOL"`).
  - **Rate limit**: free tier allows ~30 req/min; poll at 15s (4 req/min) with 60s backoff on 429.

## PumpPortal WS (works on Render, not Replit)
- On Render where the bot runs in production, `wss://pumpportal.fun/api/data` connects fine.
- Subscribe: `{ method: "subscribeNewToken" }`, events have `txType === "create"` with `mint`, `symbol`, `name`, `traderPublicKey`.
- Keep the WS connection attempt in code — it auto-connects on Render.

## Rugcheck calibration for new tokens
- When `pairAgeMinutes < 15`, skip these danger risks (normal at launch — dev holds all supply):
  - `"Single holder ownership"`
  - `"Top 10 holders high ownership"`
- Also skip `topHolderPct > 40` check for very new tokens.
- Still block on: `rugged` flag, mint authority, freeze authority, other DANGER risks (creator rug history, large LP unlocked), score > 800.

**Why:** A pump.fun token at launch always has 100% held by deployer. RugCheck marks this as DANGER. Without this filter, every single new token gets rejected immediately.

## Current constants (early-discovery.service.ts)
- `HTTP_POLL_INTERVAL_MS = 15_000` (15s)
- `MAX_TRACKED_TOKENS = 2000`
- `MAX_TRACK_AGE_MS = 60 * 60 * 1000` (60 min)
- `MAX_REJECTED_AGE_MS = 3 * 60 * 1000` (3 min — prune fast)
- `MAX_TOKENS_UI = 200` (cap sent to frontend)
