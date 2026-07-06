---
name: Whale sniper immediate activation
description: Why DexScreener must NOT gate whale tracking activation, and how the immediate-activation + async-enrichment pattern works.
---

## Rule
Activate `trackedTokens` **immediately** when a graduation event arrives. Never wait for DexScreener to index the pool before starting to poll.

## Why the old DexScreener gate was fatal
DexScreener takes 30–120s to index a freshly graduated PumpSwap pool. The old `waitForPoolAndActivate` polled every 3s, found no pairs, waited, and then added a 10s stability gate on top. By the time tracking started (~2 minutes after graduation), the entire early-whale window had closed. Whales buy in the first 5–30 seconds.

## How the immediate-activation pattern works
1. `addGraduatedToken` → `activateTrackingNow`: synchronously adds mint to `trackedTokens` with placeholder name (`mint.slice(0,6)+'…'`) and the poolAddress from the graduation TX.
2. `wsSubscribeMint` and the polling loop start within the next 2s cycle.
3. `enrichTokenMetadataAsync` runs in background — polls DexScreener every 3s, updates name/symbol/liquidity/price once indexed. Does NOT gate trading.
4. Periodic `refreshTrackedTokensMarketData` also backfills name/symbol if the token is still on a placeholder (in case enrichment timed out).

## No stability gate needed
`detectBuy` already filters out the migration TX (it checks SOL spent + tokens gained; liquidity provision moves both sides together and fails the filter). The 10s `MIN_POOL_AGE_MS` gate was therefore just adding pure latency.

## Baseline scan improvements (applied at same time)
- First-poll sig limit: 100 (was 30) — catches all buys from the first minute
- Scan depth: 50 with Helius / 20 without (was 20/10)
- Processing: parallel batches of 5 with 50ms inter-batch delay (was sequential 150–300ms per tx)
- `outer:` label breaks scan as soon as `entryTriggered` is set

**Why:** the baseline scan is the only mechanism that catches whales who bought while the bot was still activating. Making it faster and deeper is the second most important fix after immediate activation.

## How to apply
- If ever restoring the pool gate for a different reason (e.g., MEV protection), gate ONLY position entry — never gate tracking/polling activation.
- `enrichTokenMetadataAsync` failure (timeout) should be logged at WARN, not DEBUG, because it means the UI will show placeholder names.
