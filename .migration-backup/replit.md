# Apex Meme Trader AI

A personal-use Solana meme coin paper trading platform powered by real-time DexScreener data and AI confidence scoring.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `PORT` — HTTP port (auto-set by workflow)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + WebSocket (ws)
- HTTP client: axios (DexScreener API)
- Logging: pino + pino-http
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/services/scanner.service.ts` — DexScreener polling, token mapping
- `artifacts/api-server/src/services/ai-scoring.service.ts` — AI confidence scoring (0-100)
- `artifacts/api-server/src/services/paper-trading.service.ts` — paper buy/sell, PNL, stop/TP
- `artifacts/api-server/src/services/analytics.service.ts` — trade analytics & calendar PNL
- `artifacts/api-server/src/services/alerts.service.ts` — in-app alert queue + WS broadcast
- `artifacts/api-server/src/services/watchlist.service.ts` — token watchlist (in-memory)
- `artifacts/api-server/src/websocket/server.ts` — WebSocket server (path: /ws)
- `artifacts/api-server/src/types/index.ts` — all shared TypeScript types
- `artifacts/api-server/.env.example` — env variable template

## API Routes

All routes are prefixed with `/api`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthz` | Health check |
| GET | `/api/scanner` | All scanned Solana tokens (sorted by AI score) |
| GET | `/api/scanner/:pairAddress` | Single token details |
| POST | `/api/paper-buy` | Open a paper trade |
| POST | `/api/paper-sell` | Close a paper trade |
| POST | `/api/reset` | Reset account to 100 SOL |
| GET | `/api/positions` | Open positions with live PNL |
| GET | `/api/positions/all` | All trades (open + closed) |
| GET | `/api/positions/closed` | Closed trade history |
| GET | `/api/positions/portfolio` | Portfolio summary |
| GET | `/api/analytics` | Full analytics snapshot |
| GET | `/api/watchlist` | Watchlist with enriched token data |
| POST | `/api/watchlist` | Add to watchlist |
| DELETE | `/api/watchlist/:pairAddress` | Remove from watchlist |
| PATCH | `/api/watchlist/:pairAddress` | Update watchlist note |
| GET | `/api/alerts` | All alerts |
| GET | `/api/alerts/unread` | Unread alerts |
| PATCH | `/api/alerts/:id/read` | Mark alert as read |
| POST | `/api/alerts/read-all` | Mark all alerts as read |
| DELETE | `/api/alerts` | Clear all alerts |

## WebSocket

Connect to `ws://<host>/ws` for real-time push events:

| Event type | Payload |
|-----------|---------|
| `scanner_update` | Array of all scanned tokens |
| `position_update` | `{ positions, portfolio }` |
| `portfolio_update` | Portfolio summary object |
| `alert` | Single alert object |
| `ping` | Keepalive null payload |

## Architecture decisions

- **In-memory state only** — no database; paper trading state resets on server restart. This is intentional for a personal tool; add persistence later if needed.
- **DexScreener only** — no wallet, no RPC, no blockchain calls. Purely simulated.
- **AI score is a weighted composite** of 6 signals: liquidity quality, volume growth, buy pressure, volatility, momentum, and liquidity/market cap ratio.
- **Stop/TP checker runs every 1.5s** on cached scanner data (no extra API calls) to minimize latency without hitting rate limits.
- **High-score alerts are debounced** — a token can only trigger a high-score alert once per 5 minutes.

## Product

Personal Solana meme coin paper trading terminal:
- Real-time token scanner via DexScreener (refreshes every 2.5s)
- AI confidence scoring from 1–100 per token
- Paper buy/sell with simulated fees (0.3%) and slippage (0.5%)
- Stop loss, take profit, and trailing stop on every position
- Full analytics: win rate, PNL by period, avg R:R, calendar view
- Real-time WebSocket push for scanner data, position updates, and alerts
- Watchlist and in-app notification queue

## User preferences

- Personal-use only — no wallet connection, no blockchain execution, no private keys
- Simulated paper trading only

## Gotchas

- Scanner starts polling on server boot — first data arrives ~2–4s after start
- DexScreener rate limits: if you see 429 errors in logs, the 2.5s interval may need tuning
- All state is in-memory; restart loses all trades and alerts
- `POST /api/reset` wipes all trades and restores 100 SOL balance

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
