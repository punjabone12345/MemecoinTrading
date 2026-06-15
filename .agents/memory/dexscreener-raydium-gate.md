---
name: DexScreener AMM pool gate
description: AMM pool verification for the graduation sniper — no early-exit, 75s window, pumpfun pair lingers after migration
---

## The rule

**Never early-exit on "pumpfun-only" DexScreener results.** The pumpfun bonding-curve pair stays on DexScreener for 30–90 s AFTER migration while the new pumpswap pool is still being indexed. Seeing only `dexId:"pumpfun"` does NOT mean the token is still on the curve.

Decision is only made AFTER the full window:
1. **AMM pair found** (`dexId` in `{"raydium","pumpswap","orca","meteora"}`) at any point → proceed immediately ✅  
2. **After 75s, saw non-AMM pairs but never AMM** → block (likely genuinely not migrated) ❌  
3. **After 75s, no pairs at all** → fail-open (DexScreener down or extreme lag) ⚠️

**Why:** Three successive bugs from wrong early-exit logic:
- First version: required `dexId === "raydium"` only → missed PumpSwap graduations (Pump.fun migrated to PumpSwap)
- Second version: accepted pumpswap but early-exited on "pumpfun-only" → blocked real graduations because the OLD pumpfun pair lingers on DexScreener while pumpswap is still being indexed
- Correct version: never early-exit on pumpfun; retry 15×5s = 75s window; decide only at end

**How to apply:**
- `GRAD_DEXES = new Set(["raydium", "pumpswap", "orca", "meteora"])` — any = proceed
- Loop runs the **full** 15 attempts × 5 s regardless of what non-AMM pairs are seen
- `lastSeenDexes` tracks what was visible on last attempt for the post-loop decision
- Applied in both `graduation-sniper.service.ts` (inline loop + `hasRaydiumPool()` helper) and `paper-sniper.service.ts` (`scheduleDelayedEntry`)
- The `hasRaydiumPool()` helper (used in a separate code path) also checks for all `GRAD_DEXES`, not just raydium
