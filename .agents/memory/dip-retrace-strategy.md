---
name: Dip-retrace entry strategy
description: Replaces immediate buy entry; watches each graduated token for 30 min and enters only on 40–60% dump + 60% retrace pattern.
---

## The Rule
After a token passes the quality gate, do NOT enter immediately. Instead add it to the `dipWatchMap` and check every 5 seconds for a dip-and-retrace pattern. Enter when:
- `dumpPct` (= `(peakHigh - dipLow) / peakHigh * 100`) is between 40–60%
- `retracePct` (= `(currentPrice - dipLow) / (peakHigh - dipLow) * 100`) ≥ 60%

Watch window is 30 minutes (`DIP_WATCH_DURATION_MS`). If no pattern, emit a "skipped/expired" event.

**Why:** The immediate-entry approach chased momentum right at graduation. The dip-retrace pattern buys the "second wave" — after early holders dump and smart money reaccumulates.

**How to apply:** Any time the entry strategy is revisited, the dip-watch parameters (40–60% / 60%) live in the constants `DIP_MIN_PCT`, `DIP_MAX_PCT`, `RETRACE_MIN_PCT` at the top of `graduation-sniper.service.ts`.

## Key design decisions
- `seenMints.add(mint)` happens inside `addToDipWatch`, not `enterPosition` — prevents duplicate watchers.
- `dipWatchIntervalId` runs every 5 s independently of `checkAllPrices` (the position-price loop). This way watchers tick even when there are 0 open positions.
- `DipWatchInternal` extends the public `DipWatchEntry` with private fields (`_quality`, `_signature`, etc.) that are stripped before returning to the API.
- `peakHigh` resets `dipLow` to current price on every new high — this handles pump→dump→pump→dump sequences correctly.

## Files modified
- `artifacts/api-server/src/services/graduation-sniper.service.ts` — `DipWatchEntry`, `DipWatchInternal` interfaces; `addToDipWatch`, `checkDipWatchers`, `enterDipPosition`, `getDipWatchers` methods; `processGraduation` calls `addToDipWatch` instead of `enterPosition`
- `artifacts/api-server/src/routes/graduation-sniper.ts` — GET `/api/sniper/dip-watchers`
- `artifacts/terminal/src/lib/types.ts` — `DipWatchEntry` interface
- `artifacts/terminal/src/lib/api.ts` — `useDipWatchers()` hook
- `artifacts/terminal/src/pages/GraduationSniper.tsx` — `DipWatchPanel` component shown above active positions

## Pre-existing unrelated TypeScript error
`artifacts/terminal/src/pages/PaperMode.tsx:231` — `Type 'false' is not assignable to type 'string | …'` — pre-existed before this feature; does not affect build or runtime.
