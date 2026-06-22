---
name: Early Discovery bonding curve + trade quality fixes
description: Bonding curve accuracy fixes, duplicate trade guard, entryBondingCurvePct DB field, entryBlockers UI, REST discovery fallback for Replit
---

## Bonding curve was wrong (non-linear with mcap)

**Rule:** Never derive bonding curve % from market cap. `fetchDexData` was using `(mcapUsd / 69000) * 100` which is wildly wrong — a $6.6K mcap token can be at 59.8% curve completion because price acceleration is non-linear.

**Fix:** `fetchDexData` returns `bondingCurvePct: 0` always. The accurate value comes exclusively from `fetchPumpFunData` which uses either `bonding_curve_progress` (direct API field) or calculates from `virtual_sol_reserves` using `(solReserves - 30) / 85 * 100`.

**Why:** pump.fun's bonding curve prices tokens with a non-linear curve. A token at 59.8% curve completion can have a small mcap because the price hasn't accelerated much yet. The mcap-derived formula was showing 6% when reality was 59.8%, causing eligible tokens to be wrongly blocked.

## In-flight duplicate trade guard

**Rule:** Before entering a paper trade, check `enteringMints.has(mint)` AND `openPositions.has(mint)`. Add to `enteringMints` at the start; delete from it at every early return AND at successful entry.

**Why:** `pollCycle` runs every 30s. `enterPaperTrade` is called synchronously. If an entry is in-flight (e.g. async operations), a second call from the next poll cycle could fire concurrently.

## entryBondingCurvePct field

Added to `EDPosition` interface, DB (`entry_bonding_curve_pct DOUBLE PRECISION DEFAULT 0` + `ALTER TABLE IF NOT EXISTS` migration), `persistPosition` SQL (now 30 params), `loadPositions` mapping. Populated from `token.bondingCurvePct` at entry time.

## entryBlockers surfaced in UI

`checkEntryConditions` returns `blockers: string[]`. These are stored on `token.entryBlockers` after every poll and sent to the frontend. The `EntryChecklist` component shows green ✓ / red ✗ for all 8 entry conditions live.

## REST discovery fallback — critical for Replit

**Rule:** PumpPortal WS (`wss://pumpportal.fun/api/data`) is ECONNREFUSED from Replit's network. pump.fun APIs are also blocked. Do NOT rely on WebSockets alone.

**Fix:** Two parallel REST discovery sources, always-on (run at startup + every 30s):

1. **Solana public RPC** (`getSignaturesForAddress` for pump.fun program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`):
   - First poll: seed `lastRpcSignature` cursor, don't process old txs
   - Subsequent polls: fetch up to 5 new successful txs, call `getTransaction` to extract mint from "Instruction: Create" logs
   - Fallback: scan `accountKeys` for address ending in "pump"
   
2. **DexScreener `/token-profiles/latest/v1`**:
   - Filter `chainId === "solana"` and `tokenAddress.endsWith("pump")` (pump.fun vanity suffix)
   - All pump.fun mints end in lowercase "pump" — reliable identifier
   - Returns ~20-30 recently-profiled tokens per call

**Dead endpoints (do NOT use from Replit):**
- `client-api-2-74b1891ee9f9.herokuapp.com` — Heroku "no such app" (dead)
- `frontend-api.pump.fun` — Cloudflare 1016 error (blocks Replit IPs)
- Birdeye public API — requires API key

**connectionSource** now reports `"polling"` when both WebSockets are down but REST is active. Frontend shows "POLLING" badge.
