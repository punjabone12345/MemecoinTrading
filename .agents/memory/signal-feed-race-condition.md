---
name: Signal feed race condition & gmgnConfigured gate
description: Why the Smart Wallet Signal Feed showed empty even with active baseline scans; two-part fix.
---

## Race condition: age-cap prune fires during baseline scan

**The rule:** Add `mintHasActiveBaseline.add(mint)` (with `finally` delete) around the baseline processing loop in `pollTokenBuys`. In `validateOrPrune`, defer the age-cap prune when `mintHasActiveBaseline.has(mint) && tokenAgeMs <= BASELINE_PRUNE_HARD_CAP_MS` (25 min) — fall through the loop iteration instead of pruning.

**Why:** GMGN 1h-rank tokens are 12–14 min old at activation. `validateOrPrune` prunes them ~2–3 min later (when they cross the 15-min cap). But the baseline scan takes 90+ seconds due to Helius 429 backoff storms (all 30+ tokens start baselines within seconds of each other). By the time baseline calls `handleVolumeUpdate`, `trackedTokens.get(mint)` returns null → silent early return → nothing in buyLog.

**How to apply:** Any time baseline scan + 429 delays can exceed `MAX_TOKEN_AGE_FOR_VALIDATION_MS - tokenAgeAtActivation`. Currently the guard is in place; don't remove it.

## Early exit in baseline batch loop

Add `if (!trackedTokens.has(mint)) break outer;` at the top of each batch iteration. Stops wasting Helius calls on tokens pruned by non-age-cap reasons (e.g. micro-liquidity check) mid-scan.

## Frontend gmgnConfigured gate blocked entry display

**The rule:** The `gmgnConfigured=false` check must show an inline warning banner, NOT replace the buyLog list. Score-0 entries are valid signal-feed entries (they prove the pipeline is working).

**Why:** Old code: `!gmgnConfigured ? <banner> : buyLogs.length===0 ? <empty> : entries`. When no GMGN key, the banner replaced all entries even though buyLog had 20 entries. Fixed to: show banner inline, then always render `buyLogs.length===0 ? <empty> : entries`.

**How to apply:** Same pattern applies to any future status banner (GMGN ban, rate limit) — show as inline chip, never as a gate that hides the list.
