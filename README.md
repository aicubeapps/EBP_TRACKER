# EBP Tracker

Multi-signal trading-alert platform for forex, crypto, commodities, and NSE
(Indian market) assets. Detects Engulfing Bar Print (EBP) and liquidity
Sweep patterns, Market Structure Shift (MSS), Fair Value Gap (FVG) zones,
multi-step T1-T4 alert chains, and SMA Cloud trend/re-entry signals (NSE
and forex/crypto), and delivers them to users via a shared Telegram bot.

## Live URLs

| Service | URL |
|---|---|
| Frontend (Cloudflare Pages) | `https://ebp-tracker.pages.dev` |
| EBP Worker (`ebp-tracker-worker`) | `https://ebp-tracker-worker.aicube-apps.workers.dev` |
| Sweep Worker (`sweep-detector`) | `https://sweep-detector.aicube-apps.workers.dev` |
| NSE Worker (`nse-tracker`) | `https://nse-tracker.aicube-apps.workers.dev` |
| Watchdog Worker (`ebp-watchdog`) | `https://ebp-watchdog.aicube-apps.workers.dev` |

## Stack

- **Frontend**: React 18 + Vite, `react-router-dom`, `@clerk/clerk-react`, `recharts` (Market Breadth), `xlsx` (Alerts export). No MUI, no CSS framework — hand-rolled CSS (`src/styles/`).
- **Backend**: 4 independent Cloudflare Workers, each a zero-npm-dependency bundle. They never import from each other — anything shared (detection logic, TF constants, etc.) is deliberately duplicated per-worker.
- **Database**: Cloudflare D1 (SQLite), one shared database (`ebp-tracker-db`) bound in all four workers' `wrangler.toml`.
- **Auth**: Clerk, verified via a hand-rolled JWKS check in `ebp-worker.js` (no Clerk backend SDK).
- **Alerts**: Telegram Bot API — one shared bot (`SHARED_BOT_TOKEN`) for all user-facing alerts, plus a separate bot/chat for Watchdog's own health-check alerts (`WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID`).
- **Market data**: Twelve Data (primary, forex/crypto signal symbols) + Yahoo Finance (fallback, and sole source for Market Breadth); Upstox (primary, NSE) + Yahoo Finance (fallback).
- **Scheduling**: cron-job.org (external HTTP-triggered cron) for detection, plus two native Cloudflare Cron Triggers — see Scheduling below.

## Architecture

Watchdog Worker is the **sole external data fetcher**. On its own 15-minute
native Cloudflare cron, it pulls candles from Twelve Data/Yahoo (forex,
crypto, commodities) and writes them to D1's `candle_cache`. EBP Worker,
Sweep Worker, and NSE Worker never call Twelve Data or Yahoo themselves for
forex/crypto — they only read `candle_cache`. NSE Worker is the one
exception: it fetches its own candles directly from Upstox/Yahoo into a
separate `nse_candle_cache`, independent of Watchdog.

```
Watchdog Worker (native cron, */15 * * * *)
  → Twelve Data / Yahoo → candle_cache, daily_candle_cache, weekly_candle_cache
                                        │
                    (D1 read-only from here on)
                                        │
        ┌───────────────┬──────────────┴──────────────┬───────────────┐
        ▼               ▼                              ▼               │
  EBP Worker      Sweep Worker                    NSE Worker            │
  (cron-job.org)  (cron-job.org)                  (cron-job.org,        │
                                                    own Upstox/Yahoo    │
                                                    fetch — not         │
                                                    Watchdog-fed)       │
        │               │                              │               │
        └───────────────┴──────────────┬───────────────┘               │
                                        ▼                                
                          Telegram (SHARED_BOT_TOKEN)                   
                                        │                                
                                        ▼                                
                    Frontend (React SPA, Cloudflare Pages) ──────────────
                    reads exclusively through EBP Worker's REST API
```

EBP Worker also runs `POST /health/watchdog-check`, an external heartbeat
on its own cron-job.org schedule, independent of Watchdog — it checks
`watchdog_log` freshness plus several forex/NSE data-freshness signals and
alerts via Telegram if Watchdog (or anything downstream of it) goes
silent. This exists because a Cloudflare CPU-limit kill terminates a
Worker's execution before any of its own in-process error handling can
run — Watchdog structurally cannot alert on its own catastrophic failure,
so this check lives outside it.

## Deployment

Each worker deploys independently via Wrangler CLI from its own directory:

```powershell
cd worker;          npx wrangler deploy   # ebp-tracker-worker
cd sweep-worker;     npx wrangler deploy   # sweep-detector
cd nse-worker;       npx wrangler deploy   # nse-tracker
cd watchdog-worker;  npx wrangler deploy   # ebp-watchdog
```

No CI/CD pipeline is configured — every deploy is a manual `wrangler
deploy` invocation. All four workers share one D1 database, so deploying
one never requires redeploying the others *unless* a migration changes a
table another worker's already-deployed code depends on — in that case,
check whether it's safer to deploy the code or run the migration first,
based on how the two are affected by SQLite's type-affinity comparison
rules (an INTEGER-vs-TEXT column change is not automatically safe in
either order — reason it through for the specific columns involved).

### Running a D1 migration

```powershell
cd worker
npx wrangler d1 execute ebp-tracker-db --file=..\migrations\<name>.sql --remote
```

Any of the four worker directories works — they share the same D1
binding. Omit `--remote` to target the local Miniflare-backed emulation
first for a dry run.

## Environment variables / secrets

| Worker | Secrets (`wrangler secret list`) | `[vars]` |
|---|---|---|
| `worker` (ebp-tracker-worker) | `APP_URL`, `CLERK_SECRET_KEY`, `CRON_SECRET`, `JOURNAL_API_SECRET`, `SHARED_BOT_TOKEN`, `WATCHDOG_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` | none |
| `sweep-worker` (sweep-detector) | `CRON_SECRET`, `SHARED_BOT_TOKEN` | none |
| `nse-worker` (nse-tracker) | `CRON_SECRET`, `SHARED_BOT_TOKEN` | `ENVIRONMENT="production"` |
| `watchdog-worker` (ebp-watchdog) | none configured | none |

Live Twelve Data keys and the Upstox token are **not** Worker secrets —
they're rows in the D1 `api_keys` table, managed via `/admin/api-keys` in
the frontend.

Frontend build-time env vars (`.env.example`): `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WORKER_URL`.

## Frontend deployment

Cloudflare Pages, connected to this GitHub repo — a push to the tracked
branch triggers a build automatically, no CLI step needed.

- Build command: `npm run build`
- Build output: `dist`
- Root directory: `frontend`
- Environment variables: `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WORKER_URL`

## Scheduling

Two mechanisms:

1. **cron-job.org** (external HTTP-triggered cron, schedule lives in
   cron-job.org's own dashboard, not in this repo) — the primary
   mechanism for EBP, Sweep, NSE, and Forex SMA Cloud detection, plus the
   Watchdog external health-check. One job per timeframe per route:
   - `POST /cron/ebp` (EBP Worker) — M15, 1H, 4H, D, W
   - `POST /cron/sweep` (Sweep Worker) — M15, M30, 1H, 4H
   - `POST /cron/sma` (Sweep Worker, Forex/Crypto SMA Cloud) — M15, M30, 1H, 4H
   - `POST /cron/nse` (NSE Worker) — 1H, Daily, M15, M30 enabled (M1, M5 exist as jobs but are currently disabled)
   - `POST /health/watchdog-check` (EBP Worker) — every 15 min, offset from the other jobs so it checks state after they've run, not mid-tick
   
   All of the above require an `X-Cron-Secret` header matching the target worker's `CRON_SECRET`.

2. **Native Cloudflare Cron Triggers** (`wrangler.toml` `[triggers]`, the only scheduling actually declared in this repo):
   - `watchdog-worker`: `*/15 * * * *` — Watchdog's sole schedule.
   - `worker` (EBP Worker): `5 * * * *` — hourly, runs Market Breadth computation directly (not through `/cron/ebp`).
   - `sweep-worker`, `nse-worker`: no native trigger — 100% cron-job.org-driven.

## First admin user

```sql
SELECT id FROM users;
UPDATE users SET is_admin = 1 WHERE id = 'your_clerk_user_id';
```

## Telegram bot webhook

```
https://api.telegram.org/bot<SHARED_BOT_TOKEN>/setWebhook?url=<EBP_WORKER_URL>/telegram/webhook
```
