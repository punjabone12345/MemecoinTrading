# Apex Meme Trader

A Solana memecoin graduation sniper bot — automatically detects tokens graduating from Pump.fun to Raydium and executes timed buy/sell trades with configurable TP/SL/trailing-stop logic.

## Run & Operate

- API server runs on port **8080** (`artifacts/api-server`) — `pnpm --filter @workspace/api-server run dev`
- Frontend runs on port **5000** (`artifacts/terminal`) — `pnpm --filter @workspace/terminal run dev`
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- Required env: `DATABASE_URL` — Postgres connection string (set in Replit Secrets)

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5
- API: Express 5, port 8080
- DB: PostgreSQL + Drizzle ORM
- Build: esbuild (ESM bundle via `build.mjs`)
- Frontend: React + Vite (proxies `/api` and `/ws` to :8080)
- Solana: @solana/web3.js + Jupiter Lite API (`https://lite-api.jup.ag/swap/v1/`)

## Where things live

- `artifacts/api-server/src/services/graduation-sniper.service.ts` — core sniper logic, TP/SL/trailing-stop, DEFAULT_CONFIG
- `artifacts/api-server/src/services/jupiter-swap.service.ts` — buy/sell/emergencySell via Jupiter; dynamicSlippage; Helius fee estimation
- `artifacts/api-server/src/services/solana-wallet.service.ts` — keypair, signAndSendAndConfirm, getOptimalPriorityFee
- `artifacts/api-server/src/services/pumpfun-scanner.service.ts` — Module A: Pump.fun bonding curve scanner
- `artifacts/terminal/src/` — React frontend

## Architecture decisions

- **Two completely separate modules**: Pumpfun Module A (bonding curve scanner) and Sniper Module B (graduation sniper). Never merge TP logic between them.
- **dynamicSlippage only**: Jupiter `/swap` is called with `dynamicSlippage: { minBps: 50, maxBps: 9000 }` and NO `slippageBps` field — passing both causes the static value to override dynamic calculation, which was the root cause of all Custom:1 errors.
- **Helius p75 priority fees**: `getOptimalPriorityFee()` fetches the 75th-percentile of recent prioritization fees from Helius; floored at `priorityFeeLamports` config value (500k lamports), capped at 5M lamports.
- **`@solana/web3.js` externalized in esbuild**: marked as external in `build.mjs` to avoid bundling issues; loaded from node_modules at runtime.
- **Paper trading mode**: when `SOLANA_PRIVATE_KEY` is absent, the bot runs in simulation mode — all buy/sell paths degrade gracefully without throwing.

## Product

- Monitors Pump.fun token graduations via Helius WebSocket
- Automatically enters positions on newly-graduated Raydium CPMM pools
- Manages each position with configurable TP1/TP2/trailing-stop/SL
- Real-time dashboard showing open positions, P&L, wallet balance
- Telegram alerts for entries, exits, and errors

## Gotchas

- **Render has all trading secrets** (`SOLANA_PRIVATE_KEY`, `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — Replit does NOT. Live trading only works on Render.
- **`waitBeforeEntryMs: 5000`** — graduation sniper waits 5 s before buying to give Jupiter time to index the new CPMM pool. Shortening this causes "route not found" errors.
- **Always restart the API Server workflow after code changes** — esbuild rebuilds on `dev` start.
- **`pnpm --filter @workspace/api-server run dev`** rebuilds then starts; just `pnpm run start` skips the build.
