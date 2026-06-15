---
name: DexScreener Raydium gate timing
description: Raydium pool verification logic for the graduation sniper — 3-state outcome, 60s retry window
---

## The rule

The Raydium pool gate must distinguish THREE states from DexScreener, not two:

1. **Raydium pair found** → confirmed migration → proceed immediately ✅  
2. **Non-Raydium pairs only (pumpswap/pump.fun)** → definitive pre-graduation false trigger → block and exit early ❌  
3. **No pairs at all** → DexScreener hasn't indexed yet → keep retrying (do NOT block)  

**Why:** DexScreener takes 30–90 s to index a newly-created Raydium CPMM pool. Original code had only 3 × 4 s = 12 s of retrying. LIGHT token was blocked because DexScreener hadn't indexed it yet (no pairs at all), even though the on-chain migration was real. The fix extends to 10 × 6 s = 60 s, but only keeps retrying when NO pairs are found. If non-Raydium pairs are found, it exits immediately — that is the definitive false trigger signal.

**How to apply:**
- In `graduation-sniper.service.ts` `processGraduation` (the `!wsolVaultPubkey` branch): inline loop with 3-state check, 10 attempts × 6 s, early-exit on non-Raydium-only  
- In `paper-sniper.service.ts` `scheduleDelayedEntry`: same 3-state loop, same constants  
- Fail-open after 60 s of no pairs (DexScreener outage) — better to attempt entry than permanently lose a real graduation  
- `foundNonRaydiumOnly = true` → block with "pumpswap/pump.fun only" reason; exhausted retries with no pairs → skip with "unindexed after 60s" reason
