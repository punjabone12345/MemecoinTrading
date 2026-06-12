---
name: Jupiter swap Custom:1 / ExceededSlippage fix
description: Root causes and fixes for InstructionError Custom:1 errors on all buy/sell attempts
---

## Root causes of Custom:1 (ExceededSlippage) errors

1. **`slippageBps` + `dynamicSlippage` conflict** — passing both `slippageBps` and `dynamicSlippage` to Jupiter's `/swap` endpoint causes Jupiter to use the static `slippageBps` override instead of the dynamic calculation. The static value (500–1000 bps) was always too tight for fresh CPMM pools. **Fix:** remove `slippageBps` from `getSwapTx` entirely; let `dynamicSlippage` handle minimum-output enforcement.

2. **`dynamicSlippage.maxBps` too low** — was 5000 (50%). Fresh graduation pools have wild price impact. **Fix:** raised to 9000 (90%).

3. **Priority fee too low** — was 50,000 lamports (0.00005 SOL). Graduation sniping on congested slots requires competitive fees. **Fix:** default raised to 500,000 lamports; Helius p75 estimation used at runtime.

4. **`maxAccounts: 50` constraint** — forced Jupiter to pick suboptimal routes. **Fix:** removed entirely.

5. **`skipUserAccountsRpcCalls: true`** — added to reduce RPC overhead during swap construction.

## What getSwapTx does now

```
getSwapTx(quoteResponse, priorityFeeLamports)
```
- Always uses `dynamicSlippage: { minBps: 50, maxBps: 9000 }` — NO `slippageBps` field
- `wrapAndUnwrapSol: true`, `skipUserAccountsRpcCalls: true`
- `prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: priorityFeeLamports, priorityLevel: "veryHigh" } }`

## Default config (graduation-sniper.service.ts)

- `slippageBps: 3000` — used only for quote route-finding, widened +1500/retry up to 9000
- `priorityFeeLamports: 500_000` — floor; Helius p75 may raise it at runtime
- `waitBeforeEntryMs: 5000` — gives Jupiter time to index new CPMM pool after graduation

## Helius priority fee estimation (solana-wallet.service.ts)

`getOptimalPriorityFee(defaultLamports, accountKeys?)` — fetches p75 of recent prioritization fees via `getRecentPrioritizationFees`. Caps at 5_000_000 lamports (0.005 SOL). Falls back to `defaultLamports` when HELIUS_API_KEY is absent or call fails.

Called automatically by `buy()` and `sell()` before the retry loop.

**Why:** p75 is aggressive enough to land quickly in congested slots without wasting SOL. The cap prevents runaway fees on extreme congestion events.
