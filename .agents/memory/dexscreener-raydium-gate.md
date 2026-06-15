---
name: DexScreener AMM pool gate
description: AMM pool verification for the graduation sniper — 3-state logic, 60s window, PumpSwap is a valid graduation target
---

## The rule

Pump.fun graduates tokens to **either Raydium CPMM (old) or PumpSwap (new)**. Both are valid. Never require Raydium specifically.

3-state check on DexScreener response:

1. **AMM pair found** (`dexId` in `{"raydium","pumpswap","orca","meteora"}`) → real graduation → proceed ✅  
2. **ONLY bonding-curve pair** (`dexId: "pumpfun"`, no AMM pair at all) → definitive false trigger → block immediately ❌  
3. **No pairs at all** → DexScreener hasn't indexed yet → keep retrying ⏳

**Why:** Original guard required `dexId === "raydium"` only. Pump.fun now migrates tokens to PumpSwap (dexId `"pumpswap"` on DexScreener). LIGHT and MUST were real graduations that got blocked because the guard treated pumpswap as a false trigger. The ONLY valid false-trigger signal is when ONLY a `"pumpfun"` bonding-curve pair exists with zero AMM pairs.

**How to apply:**
- `GRAD_DEXES = new Set(["raydium", "pumpswap", "orca", "meteora"])` — any of these = real migration
- `CURVE_DEXES = new Set(["pumpfun"])` — bonding curve only = pre-graduation  
- 10 attempts × 6 s = 60 s window; early exit when only bonding-curve pairs found  
- Fail-open after 60 s of no pairs (DexScreener outage) — better to attempt than lose graduation  
- Applied in both `graduation-sniper.service.ts` (inline loop + `hasRaydiumPool()` helper) and `paper-sniper.service.ts` (`scheduleDelayedEntry`)
