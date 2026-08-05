# EBP Tracker — Architecture & State Report

**Generated:** 2026-08-02, entirely from source code inspection and live D1 queries. Spec/roadmap docs (`EBP_Tracker_Roadmap.md`, `EBP_Tracker_Technical_Reference_v2.2.md`, etc.) were consulted only to flag divergences (marked ⚠️ DIVERGENCE below), never as a source of truth for "what exists." Anything described in a code comment but not actually implemented is marked "documented but not implemented."

**Updated:** 2026-08-06, in three passes, all from fresh source-code inspection and live D1 queries (not carried forward from the 2026-08-02 text). First pass: `MarketBreathPage.jsx`'s chart/label/timestamp changes (Section 6), the Watchdog Telegram-alerting gap being resolved (Sections 5/9/10), weekly Market Breadth aggregation now existing but not yet API/frontend-wired (Sections 3/9), and `/market/breadth` losing its admin gate (Sections 2/3/6). Second pass: the full NSE SMA Cloud revamp and the new Forex/Crypto SMA Cloud feature (Section 8, plus the `nse_indicator_configs`/`forex_indicator_configs`/`forex_sma_state`/`nse_sma_state` schema entries in Section 3 and the `user_templates` dead-columns bug risk being resolved), the current 16-file frontend component inventory including 4 new components and the rewritten `AIAlertsPanel.jsx`/`TemplateCard.jsx` pairing (Section 6), and the EBP/Sweep Worker route inventories growing to 65/3 routes respectively with 7 new EBP routes and `/cron/sma` (Section 2). Third pass — a debug/cleanup/documentation session, not new features (Section 9's "Cleanup applied 2026-08-06" entry has the full list): migration 013 (`alert_history.fired_at` INTEGER→TEXT), T4 dedup strengthened, `NSE_VALID_TFS` sync comments, `watchdog_log`→Telegram delivery, `schema.sql` reconciled (4 items), `README.md` rewritten, 3 stale audit files deleted — plus discovering that the 2026-08-02 report's "dead functions"/`packages/core`/"dead secrets" findings were already resolved by an earlier, unrelated commit, not by anything in this repo's more recent sessions. Not re-verified in any pass: NSE's TDI detector (unchanged, but not independently re-checked), the exact live cron-job.org job list beyond what's directly stated, and any table/route not explicitly named — table row counts quoted below are point-in-time and will drift.

Legend: 🔶 UNTESTED = exists in code but not exercised on live data as of this audit. 🐛 BUG RISK = a concrete failure mode identified in the code. ⚠️ DIVERGENCE = contradicts a roadmap/reference doc.

---

## Section 1 — Project Overview

### Live URLs
| Service | URL |
|---|---|
| Frontend (Cloudflare Pages) | `https://ebp-tracker.pages.dev` (from `ALLOWED_ORIGINS` in `worker/src/ebp-worker.js` and `sweep-worker/src/index.js`) |
| EBP Worker (`ebp-tracker-worker`) | `https://ebp-tracker-worker.aicube-apps.workers.dev` |
| Sweep Worker (`sweep-detector`) | `https://sweep-detector.aicube-apps.workers.dev` |
| NSE Worker (`nse-tracker`) | `https://nse-tracker.aicube-apps.workers.dev` |
| Watchdog Worker (`ebp-watchdog`) | not directly confirmed this session (no outbound calls made to it), but per `wrangler.toml` name it would deploy to `https://ebp-watchdog.<account>.workers.dev` |
| Telegram bot (user alerts) | `@EbP_Tracker_bot` (shared bot, token in `SHARED_BOT_TOKEN` secret — see Section 5) |
| Telegram bot (Watchdog/dev alerts) | Watchdog Worker itself still sends zero Telegram messages, and no literal `@EBP_Watchdog_bot` exists — but as of 2026-08-06 the underlying need is met externally: `WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID` (EBP Worker secrets) back a `POST /health/watchdog-check` heartbeat that alerts on Watchdog going silent or logging errors. See Section 5. |

### Repo structure (source files only, line counts)
```
EBP_TRACKER/
├── worker/                         — EBP Worker + main REST API (Cloudflare Worker "ebp-tracker-worker")
│   ├── src/ebp-worker.js           2578 lines  — everything: routes, EBP/FVG/Swing/MSS detection, T1-T3 chain step 1, market breadth, admin
│   └── wrangler.toml                 12 lines
├── sweep-worker/                   — Sweep Worker (Cloudflare Worker "sweep-detector")
│   ├── src/index.js                 118 lines  — HTTP entrypoint, cron-only
│   ├── src/sweep-cron.js           1058 lines  — Sweep/MSS/FVG detection, T1/T2/T3(step2-3)/T4 chains
│   └── wrangler.toml                 11 lines
├── nse-worker/                     — NSE Worker (Cloudflare Worker "nse-tracker")
│   ├── src/index.js                  62 lines  — HTTP entrypoint, cron-only
│   ├── src/nse-cron.js             1643 lines  — NSE EBP/Sweep/MSS/FVG, TDI, SMA Cloud
│   └── wrangler.toml                 11 lines
├── watchdog-worker/                — Watchdog Worker (Cloudflare Worker "ebp-watchdog")
│   ├── src/index.js                 846 lines  — sole Twelve Data/Yahoo caller, candle_cache writer, key rotation
│   └── wrangler.toml                 11 lines
├── frontend/                       — React 18 + Vite SPA, deployed to Cloudflare Pages
│   ├── src/App.jsx                   48 lines  — router
│   ├── src/main.jsx                  16 lines  — ClerkProvider bootstrap
│   ├── src/pages/                    8 files (Landing, Dashboard, Assets, Alerts, Settings, Admin [549 lines], MarketBreathPage [551 lines], NotFound)
│   ├── src/components/              16 files as of 2026-08-06, was 11/12 (see Section 6 for the current list — includes 4 new since 2026-08-02: ChainProgressBar, TemplateCard, FVGZoneIndicator, ForexSmaConfigPanel)
│   ├── src/hooks/                    2 files (useAssets.js, useUser.js)
│   ├── src/lib/                      3 files (api.js, constants.js, utils.js)
│   └── vite.config.js                 9 lines
├── (packages/core/ — REMOVED. Legacy shared package, confirmed dead as of 2026-08-02, already gone by the time a fresh check ran 2026-08-06 — see Section 9.)
├── migrations/                     — numbered SQL migration files (003–013 as of 2026-08-06), historical, already applied
├── migration_phase1_to_3.sql       — the FVG/Swing/Chain-state migration applied 2026-08-02
└── schema.sql                      — hand-maintained schema reference, reconciled with live D1 2026-08-06 (Section 3/9) — still not auto-applied, can still drift again
```
Total source line count (excluding `node_modules`, `dist`, `.wrangler`, lockfiles): **~10,300 lines** across 4 workers + frontend + packages/core.

### Stack
- **Frontend**: React 18, Vite (`vite`/`@vitejs/plugin-react`), `react-router-dom` v6, `@clerk/clerk-react` (auth), `recharts` (Market Breadth charts only), `xlsx` (Alerts export only). ⚠️ **DIVERGENCE**: `README.md` line 7 claims "React + Vite + **MUI**" — there is no MUI dependency in `frontend/package.json` and zero `@mui` imports anywhere in `src/`. All styling is hand-rolled CSS (`src/styles/tokens.css`, `global.css`).
- **Backend**: 4 independent Cloudflare Workers, all zero-npm-dependency single-file (or single-file + one large cron-logic file) bundles, deliberately not importing from each other or from `packages/core` (which is dead — see Section 9).
- **Database**: Cloudflare D1 (SQLite), a single shared database `ebp-tracker-db` (id `b93b206a-5537-4d12-8c86-a4b2372aae7f`) bound as `DB` in all four workers' `wrangler.toml`.
- **Auth**: Clerk (`@clerk/clerk-react` frontend, hand-rolled JWKS-verification `verifyClerkToken()` in `ebp-worker.js` — no Clerk backend SDK).
- **Scheduling**: Two distinct mechanisms coexist:
  1. **cron-job.org HTTP triggers** — external service POSTs `X-Cron-Secret`-guarded routes (`/cron/ebp`, `/cron/sweep`, `/cron/nse`) on a schedule maintained *outside this repo* (cron-job.org's own dashboard — not queryable from code). This is the primary mechanism for EBP/Sweep/NSE detection, adopted specifically as a workaround for Cloudflare's free-tier native-cron-trigger limits.
  2. **Native Cloudflare `[triggers]` cron** — used by Watchdog Worker (`*/15 * * * *`, its sole/primary schedule) and by EBP Worker for one secondary job (`5 * * * *`, hourly Market Breadth computation only — not EBP detection itself, which stays cron-job.org-driven).
- **Deployment**: `npx wrangler deploy` per worker (imperative CLI, no CI/CD pipeline configured in-repo — see Section 10). Frontend via Cloudflare Pages, triggered by GitHub push (per `README.md`; build command `npm run build`, output `dist`, root `frontend`).

### Environment variables / secrets per worker (names only)

| Worker | Configured secrets (`wrangler secret list`) | `[vars]` (plaintext) |
|---|---|---|
| `worker` (ebp-tracker-worker) | `APP_URL`, `CLERK_SECRET_KEY`, `CRON_SECRET`, `JOURNAL_API_SECRET`, `SHARED_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID`, `WATCHDOG_BOT_TOKEN` | none |
| `sweep-worker` (sweep-detector) | `CRON_SECRET`, `SHARED_BOT_TOKEN` | none |
| `nse-worker` (nse-tracker) | `CRON_SECRET`, `SHARED_BOT_TOKEN` | `ENVIRONMENT="production"` |
| `watchdog-worker` (ebp-watchdog) | **none configured** (`wrangler secret list` → `[]`) | none |

⚠️ **Status changed since 2026-08-02**: the dead secrets this report originally found (`DEVELOPER_TELEGRAM_CHAT_ID`/`TWELVE_DATA_API_KEY_1/2/3` on `worker`; `CLERK_SECRET_KEY`/`TWELVE_DATA_API_KEY_1/2/3` on `sweep-worker`; `CLERK_SECRET_KEY` on `nse-worker`) are **already gone** — confirmed via a fresh `wrangler secret list` per worker on 2026-08-06. This wasn't done by that session's own cleanup work (which focused elsewhere); they'd already been removed by the time this check ran, likely as part of an earlier "dead code/secrets cleanup" commit already in this repo's history before that session began. `worker` also gained `WATCHDOG_ADMIN_CHAT_ID`/`WATCHDOG_BOT_TOKEN` since 2026-08-02 (Section 5). Live Twelve Data/Upstox credentials remain **not** Worker secrets at all — they're rows in the D1 `api_keys` table, admin-managed via `/admin/api-keys`.

Frontend build-time env vars (`.env.example`): `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WORKER_URL`, `VITE_SWEEP_WORKER_URL` (the last one is dead — never read anywhere in `src/`, see Section 9).

---

## Section 2 — Architecture & Data Pipeline

### End-to-end data flow

```
                    ┌─────────────────────────────────────────────┐
                    │         WATCHDOG WORKER (ebp-watchdog)       │
                    │  native CF cron */15 * * * *                 │
                    │                                               │
                    │  Twelve Data (M15/M30/1H/4H, signal symbols)  │
                    │  Yahoo Finance (fallback + all Market Breadth)│
                    │       │                                       │
                    │       ▼                                       │
                    │  writeCandleCache() ──► D1: candle_cache      │
                    │  attemptDailySynthesis() ──► daily_candle_cache│
                    │  attemptWeeklySynthesis() ──► weekly_candle_cache│
                    │  computeSyntheticDXY() ──► candle_cache('DXY')│
                    └─────────────────────────────────────────────┘
                                        │
                                        │  (D1 read-only from here on)
                                        ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │   cron-job.org    │   │   cron-job.org    │   │   cron-job.org    │
   │ POST /cron/ebp    │   │ POST /cron/sweep  │   │ POST /cron/nse    │
   │ (X-Cron-Secret)   │   │ (X-Cron-Secret)   │   │ (X-Cron-Secret)   │
   └────────┬──────────┘   └────────┬──────────┘   └────────┬──────────┘
            ▼                       ▼                       ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │   EBP WORKER      │   │  SWEEP WORKER     │   │   NSE WORKER      │
   │ handleEBPCron()   │   │ handleSweepCron() │   │ handleNseCron()   │
   │                   │   │                   │   │  (own Upstox/     │
   │ reads candle_cache│   │ reads candle_cache│   │   Yahoo fetch —   │
   │ detectEBP         │   │ detectSweep       │   │   NOT Watchdog-fed)│
   │ FVG Phase1        │   │ FVG Phase1        │   │ detectEBP/Sweep/  │
   │ Swing/MSS Ph1.5/2 │   │ Swing/MSS Ph1.5/2 │   │ MSS/FVG, TDI,     │
   │ T1/T2/T3 Step1    │   │ T1/T2/T3(2-3)/T4  │   │ SMA Cloud          │
   │       │           │   │       │           │   │       │           │
   │       ▼           │   │       ▼           │   │       ▼           │
   │ signals, chain_    │   │ signals, chain_    │   │ signals,           │
   │ state, fvg_zones,  │   │ state, fvg_zones,  │   │ nse_fvg_zones,     │
   │ swing_states,      │   │ swing_states,      │   │ nse_swing_states,  │
   │ alert_history,     │   │ alert_history,     │   │ nse_indicator_*,   │
   │ bias_cache         │   │ bias_cache         │   │ alert_history      │
   │       │           │   │       │           │   │       │           │
   │       ▼           │   │       ▼           │   │       ▼           │
   │ sendTelegramMessage() via SHARED_BOT_TOKEN → @EbP_Tracker_bot → user's chat_id (user_telegram) │
   └──────────────────┘   └──────────────────┘   └──────────────────┘
            │                       │                       │
            └───────────────────────┴───────────────────────┘
                                        │
                                        ▼ (Clerk-JWT-authenticated REST reads)
                    ┌─────────────────────────────────────────────┐
                    │         FRONTEND (React SPA, Cloudflare Pages)│
                    │  Dashboard/Assets/Alerts/Settings/Admin/Market│
                    │  all reads go through worker/src/ebp-worker.js│
                    │  (the only worker frontend calls directly)    │
                    └─────────────────────────────────────────────┘
```

Key structural fact: **the frontend never calls Sweep/NSE/Watchdog Workers directly.** All frontend↔backend traffic goes through `worker/src/ebp-worker.js` (`VITE_WORKER_URL`) — including `/sweep/dashboard` and `/sweep/history`, which were explicitly relocated there from Sweep Worker (IM-3 migration, see Section 9's dead-route note). `VITE_SWEEP_WORKER_URL` exists as a frontend env var but is never read.

### Workers — name, entry file, routes summary

| Worker | CF Worker name | Entry file | Route count | Auth mechanisms used |
|---|---|---|---|---|
| EBP Worker | `ebp-tracker-worker` | `worker/src/ebp-worker.js` | 65 routes as of 2026-08-06 (was 51 on 2026-08-02 — full REST API — user/admin/signals/telegram/sweep-dashboard/breadth, plus `/cron/ebp`) | Clerk JWT, X-Cron-Secret, X-Journal-Secret, none (public: `/health`, `/nse/status`, `/telegram/webhook`, `/invite/:token`) |
| Sweep Worker | `sweep-detector` | `sweep-worker/src/index.js` | 3 routes as of 2026-08-06 — was 2 (`/health`, `/cron/sweep`, **`/cron/sma`** new) | none, X-Cron-Secret |
| NSE Worker | `nse-tracker` | `nse-worker/src/index.js` | 2 routes (`/health`, `/cron/nse`) | none, X-Cron-Secret |
| Watchdog Worker | `ebp-watchdog` | `watchdog-worker/src/index.js` | 1 route (`/health`) | none |

Full per-route tables are in Section 2's route inventory below and cross-referenced in Sections 5, 6, 7, 8.

**Complete EBP Worker route table** (65 routes as of 2026-08-06 — 7 new since 2026-08-02, marked below; method + path + auth + purpose):

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check |
| GET | `/user/me` | Clerk JWT | Get/create current user row |
| GET | `/user/assets` | Clerk JWT | List user's assets + live EBP status |
| POST | `/user/assets` | Clerk JWT | Add asset (enforces asset_limit for forex/crypto; NSE unlimited) |
| GET | `/user/assets/count` | Clerk JWT | Forex/crypto vs NSE counts + limits |
| DELETE | `/user/assets/:id` | Clerk JWT | Delete asset + cascade delete configs/templates/chains |
| PATCH | `/user/assets/:id/bias-overrides` | Clerk JWT | Update per-asset bias overrides |
| GET | `/user/assets/validate` | Clerk JWT | Symbol validation (Yahoo-based) |
| GET | `/user/ebp-configs/:assetId` | Clerk JWT | List EBP configs |
| POST | `/user/ebp-configs/:assetId` | Clerk JWT | Create EBP config |
| GET | `/user/sweep-configs/:assetId` | Clerk JWT | List Sweep configs |
| POST | `/user/sweep-configs/:assetId` | Clerk JWT | Create Sweep config |
| GET | `/user/templates/:assetId` | Clerk JWT | List T1-T4 templates |
| POST | `/user/templates/:assetId` | Clerk JWT | Create a template |
| PATCH | `/user/template/:id` | Clerk JWT | Update a template |
| DELETE | `/user/template/:id` | Clerk JWT | Delete a template |
| GET | `/user/chain-state/:assetId` | Clerk JWT | **New (2026-08-06).** Active (non-`complete`, non-expired) `chain_state` rows for an asset — feeds `ChainProgressBar` |
| GET | `/user/fvg-zones/:assetId` | Clerk JWT | **New (2026-08-06).** Active/recently-mitigated `fvg_zones` rows for TFs the asset has an EBP or Sweep config on — feeds `FVGZoneIndicator` |
| GET | `/dashboard` | Clerk JWT | Assets + last alert timestamps |
| PATCH | `/user/ebp-configs/:id` | Clerk JWT | Update EBP config |
| DELETE | `/user/ebp-configs/:id` | Clerk JWT | Delete EBP config |
| PATCH | `/user/sweep-configs/:id` | Clerk JWT | Update Sweep config |
| DELETE | `/user/sweep-configs/:id` | Clerk JWT | Delete Sweep config |
| GET | `/user/nse-indicator-configs/:assetId` | Clerk JWT | List TDI/SMA configs |
| POST | `/user/nse-indicator-configs/:assetId` | Clerk JWT | Create TDI/SMA config |
| PATCH | `/user/nse-indicator-configs/:id` | Clerk JWT | Update TDI/SMA config |
| DELETE | `/user/nse-indicator-configs/:id` | Clerk JWT | Delete + cleanup orphaned chain/sma_state rows |
| GET | `/user/forex-indicator-configs/:assetId` | Clerk JWT | **New (2026-08-06).** List forex/crypto SMA Cloud configs |
| POST | `/user/forex-indicator-configs/:assetId` | Clerk JWT | **New (2026-08-06).** Create a forex/crypto SMA Cloud config |
| PATCH | `/user/forex-indicator-configs/:id` | Clerk JWT | **New (2026-08-06).** Update a forex/crypto SMA Cloud config |
| DELETE | `/user/forex-indicator-configs/:id` | Clerk JWT | **New (2026-08-06).** Delete a forex/crypto SMA Cloud config |
| GET | `/user/bias/:symbol` | Clerk JWT | bias_cache rows for a symbol |
| GET | `/health/datasources` | Clerk JWT | Per-source API call stats |
| GET | `/alerts/history` | Clerk JWT | Paginated alert history |
| GET | `/alerts/export` | Clerk JWT | Bulk alert export (up to 5000 rows) |
| GET | `/user/telegram` | Clerk JWT | Telegram connection status |
| POST | `/user/telegram/initlink` | Clerk JWT | Generate link code |
| POST | `/user/telegram/test` | Clerk JWT | Send test Telegram message |
| POST | `/cron/ebp` | X-Cron-Secret | EBP detection per TF, or Market Breadth if `tf==='BREADTH'` |
| POST | `/health/watchdog-check` | X-Cron-Secret | **New (2026-08-06).** External Watchdog heartbeat — see Section 5/10 |
| GET | `/market/breadth` | Clerk JWT ⚠️ (admin gate removed since 2026-08-02 — see Section 3/6) | Breadth heatmap/strength/correlation |
| POST | `/telegram/webhook` | none (public) | Telegram bot webhook (`/start`, link codes) |
| POST | `/user/telegram/verify` | Clerk JWT | Poll: has bot verified the link code |
| DELETE | `/user/telegram` | Clerk JWT | Disconnect Telegram |
| GET | `/admin/users` | Clerk JWT + admin | List all users |
| GET | `/admin/tokens` | Clerk JWT + admin | List invite tokens |
| POST | `/admin/invite` | Clerk JWT + admin | Generate invite token |
| POST | `/admin/expire/:id` | Clerk JWT + admin | Deactivate a user |
| GET | `/admin/api-keys` | Clerk JWT + admin | List API keys w/ usage |
| POST | `/admin/api-keys` | Clerk JWT + admin | Add API key |
| PATCH | `/admin/api-keys/:id` | Clerk JWT + admin | Enable/disable API key |
| DELETE | `/admin/api-keys/:id` | Clerk JWT + admin | Delete API key |
| PATCH | `/admin/users/:id/asset-limit` | Clerk JWT + admin | Set asset limit |
| GET | `/admin/users/:id/assets` | Clerk JWT + admin | List a user's assets |
| GET | `/admin/users/:id/tf-access` | Clerk JWT + admin | Get forex/crypto TF access |
| PATCH | `/admin/users/:id/tf-access` | Clerk JWT + admin | Set forex/crypto TF access |
| GET | `/admin/users/:id/nse-tf-access` | Clerk JWT + admin | Get NSE TF access |
| PATCH | `/admin/users/:id/nse-tf-access` | Clerk JWT + admin | Set NSE TF access |
| GET | `/nse/status` | none (public) | Whether Upstox is configured |
| GET | `/nse/search` | Clerk JWT | NSE symbol search (Upstox + Yahoo parallel) |
| GET | `/signals/:id` | X-Journal-Secret | Trade Journal: fetch signal |
| PATCH | `/signals/:id/traded` | X-Journal-Secret | Trade Journal: mark traded |
| GET | `/invite/:token` | none (public) | Validate invite token |
| GET | `/sweep/dashboard` | Clerk JWT | Live sweep status (moved from Sweep Worker) |
| GET | `/sweep/history` | Clerk JWT | User's sweep alert history |

Auth glue: Clerk JWT verified per-request via hand-rolled `verifyClerkToken()` (JWKS fetch against Clerk, no SDK) and attached to `request._ctx`; admin routes additionally call `requireAdmin()` which checks `users.is_admin`.

**Sweep Worker routes**: `GET /health` (public), `POST /cron/sweep` (X-Cron-Secret, body `{tf}` ∈ `{M15,M30,1H,4H}`), and **`POST /cron/sma`** (X-Cron-Secret, same TF set — new since 2026-08-02, drives `handleForexSmaCron`, Section 8). Everything else 404s — file header comment explicitly documents `/sweep/dashboard`/`/sweep/history` as moved out (IM-3).

**NSE Worker routes**: `GET /health` (public), `POST /cron/nse` (X-Cron-Secret, `tf` from JSON body or `?tf=` query fallback).

**Watchdog Worker routes**: `GET /health` (public) only. No cron-secret-guarded HTTP route exists at all — it is the one worker with zero externally-triggerable business logic; everything fires from its native `scheduled()` handler.

### Data sources — who calls what, for what, under what conditions

| Caller | Source | Symbols | TFs | Condition | Fallback |
|---|---|---|---|---|---|
| Watchdog Worker | Twelve Data `time_series` | "signal symbols" = any symbol with ≥1 enabled `user_ebp_configs`/`user_sweep_configs` row | M15 (every tick), M30 (`minute%30===0`), 1H (`minute===0`), 4H (`minute===0` AND NY hour ∈ {17,21,1,5,9,13}) | Chunked 7-symbols-per-key across `api_keys` (source='twelvedata') | Per-symbol Yahoo Finance if all TD keys exhausted |
| Watchdog Worker | Yahoo Finance | 28 `MAJOR_PAIRS` breadth cross-pairs | 1H only | `minute===0` | none (breadth is Yahoo-only, never Twelve Data) |
| Watchdog Worker | (computed, no fetch) | synthetic `DXY` | 1H | `minute===0`, derived from 6 breadth pairs via ICE formula | n/a |
| NSE Worker | Upstox `historical-candle` API | NSE equities/indices | M1/M5/M15/M30/1H/D | Only if an enabled `api_keys` row with `source='upstox'` exists | Yahoo Finance if Upstox errors or returns &lt;3 closed candles |
| NSE Worker | Yahoo Finance | NSE equities/indices | same | Always available as the default/fallback | none further — if Yahoo also fails, cron logs and skips that symbol |
| EBP/Sweep Workers | **none** — D1 `candle_cache` only | n/a | n/a | n/a | n/a (by design, post-Watchdog-migration) |
| EBP Worker `/nse/search` | Upstox `instruments/search` (equities) + Yahoo `finance/search` (indices) | user-typed query | n/a | Upstox branch returns `[]` silently if no token configured | Yahoo index search always runs regardless |
| Frontend `PriceFeedPanel.jsx` (admin debug tool) | Twelve Data WebSocket, direct from browser | admin-typed symbol | live ticks | Admin manually pastes an API key into the UI | none — diagnostic tool only, bypasses the worker entirely |

### Cron schedule

**cron-job.org jobs** (external service, schedule not stored in this repo — inferred from the TF sets each `/cron/*` route accepts):
- `POST /cron/ebp` — one job per EBP timeframe: `M15`, `1H`, `4H`, `D`, `W`, plus a `BREADTH`-tagged variant is *not* needed here since Market Breadth uses the native CF cron instead (see below) — **but** the same route does accept `tf:'BREADTH'`, so it's plausible cron-job.org has a redundant BREADTH job too; this can't be confirmed from code alone.
- `POST /cron/sweep` — one job per Sweep timeframe: `M15`, `M30`, `1H`, `4H`.
- `POST /cron/nse` — one job per NSE timeframe: `M1`, `M5`, `M15`, `M30`, `1H`, `D`.

All three require the `X-Cron-Secret` header matching each worker's `CRON_SECRET` secret.

**Cloudflare native crons** (from `wrangler.toml` `[triggers]`, ground truth):
- `watchdog-worker`: `*/15 * * * *` — sole schedule, internally self-gates M30/1H/4H/daily/weekly work by checking `minute`/NY-hour inside one handler.
- `worker` (EBP Worker): `5 * * * *` — hourly, fires `handleMarketBreadthCron()` directly via the native `scheduled()` handler (not via `/cron/ebp`).
- `sweep-worker`, `nse-worker`: no `[triggers]` block at all — 100% cron-job.org-driven.

### Watchdog Worker vs EBP/Sweep/NSE Workers

| | Watchdog | EBP/Sweep/NSE |
|---|---|---|
| Purpose | Sole external-data ETL: fetch → cache → synthesize | Signal detection + user alerting |
| Trigger | Native CF cron (`*/15 * * * *`) | cron-job.org HTTP POST (`X-Cron-Secret`) |
| External APIs called | Twelve Data, Yahoo (forex/crypto/commodity + breadth) | none (EBP/Sweep read D1 only); NSE calls Upstox/Yahoo itself |
| Writes | `candle_cache`, `daily_candle_cache`, `weekly_candle_cache`, `api_key_state`, `api_call_log`, `watchdog_log` | `signals`, `chain_state`, `fvg_zones`/`nse_fvg_zones`, `swing_states`/`nse_swing_states`, `alert_history`, `bias_cache`, NSE indicator tables |
| User data touched | none | `user_assets`, `user_telegram`, `user_ebp_configs`, etc. |
| Alerts | **None** — only internal failure logging to `watchdog_log` | Telegram alerts via `SHARED_BOT_TOKEN` to `@EbP_Tracker_bot` |
| Secrets | none configured | `CRON_SECRET`, `SHARED_BOT_TOKEN`, (+Clerk/Journal on EBP Worker) |

---

## Section 3 — Database Schema (ground truth)

All tables live in the single shared D1 database `ebp-tracker-db`. **37 tables total live in production as of 2026-08-06** (was 34 on 2026-08-02 — the 2 new ones, `forex_sma_state` and `forex_indicator_configs`, are covered below; `sqlite_sequence`/`_cf_KV` remain SQLite/Cloudflare-internal, not application schema). Column definitions below are the live `PRAGMA table_info()` ground truth as of this update, cross-checked against `schema.sql`; every divergence found is called out inline with ⚠️ DIVERGENCE.

### Core user/asset tables

**`users`** — `id` TEXT PK, `email` TEXT NOT NULL, `name` TEXT, `plan` TEXT DEFAULT 'free', `asset_limit` INTEGER DEFAULT **3** ⚠️ **DIVERGENCE**: `schema.sql` line 9 says `DEFAULT 5` — live production default has drifted to 3, likely via an untracked ALTER/D1-console edit never ported back to schema.sql), `created_at`/`expires_at` INTEGER NOT NULL, `active` INTEGER DEFAULT 1, `is_admin` INTEGER DEFAULT 0, `user_tf_access` TEXT DEFAULT `["M5","M15","M30","1H","4H","D","W"]`, `nse_tf_access` TEXT DEFAULT `["M1","M5","M15","M30","1H","D"]`.
- Written by: `worker/src/ebp-worker.js` (`getOrCreateUser` — which itself still hardcodes `asset_limit=5` in its INSERT, line 1184 — so **new users get 5 via the app-level INSERT regardless of the column's DEFAULT 3**; the column default only matters for any INSERT that omits the column, which doesn't currently happen in app code); admin routes: expire, asset-limit, tf-access, nse-tf-access.
- Read by: every worker (all four check `active`/`user_tf_access`/`nse_tf_access` before alerting); frontend via `/user/me` (`hooks/useUser.js`, polled every 2 min).
- `plan` is effectively vestigial for feature-gating — see Section 7.

**`user_assets`** — `id` TEXT PK, `user_id` TEXT NOT NULL FK→users, `symbol`/`display_name`/`asset_type` TEXT NOT NULL, `added_at` INTEGER NOT NULL, `bias_overrides` TEXT DEFAULT `{}`.
- Written by: EBP Worker (`POST/DELETE /user/assets`, `PATCH .../bias-overrides`).
- Read by: all three detection workers (joined into every config query); frontend `Dashboard.jsx`/`Assets.jsx` via `useAssets()` hook (`GET /user/assets`).
- No `CHECK` constraint on `asset_type` — `'forex'`/`'crypto'`/`'nse'`/`'system'` (DXY) are a convention enforced only in application code.

**`user_telegram`** — `user_id` TEXT PK FK→users, `chat_id` TEXT NOT NULL, `link_code` TEXT, `verified` INTEGER DEFAULT 0, `updated_at` INTEGER NOT NULL.
- Written/read by: EBP Worker (`/user/telegram*`, `/telegram/webhook`). Read by all three detection workers to resolve `chat_id` before every Telegram send (`WHERE user_id=? AND verified=1`).

**`alert_history`** — live has **10 columns**: `id` TEXT PK, `user_id` FK→users, `symbol`/`timeframe`/`direction`/`trend_bias` TEXT NOT NULL, `candle_time` INTEGER NOT NULL, **`fired_at` TEXT NOT NULL** (⚠️ was INTEGER ms epoch as of 2026-08-02 — converted to ISO 8601 by migration `013_alert_history_fired_at_text.sql`, 2026-08-06, matching `signals.fired_at`'s format), `alert_type` TEXT DEFAULT 'ebp', `details` TEXT DEFAULT `{}`. `schema.sql`'s CREATE TABLE block now matches production exactly (`details` was missing from it as of 2026-08-02; both that gap and the `fired_at` type are fixed in the same 2026-08-06 pass).
- Written by: all three detection workers, on every delivered alert (`ebp`, `sweep`, `mss`, `t3`, plus NSE's alert types, and TDI/SMA `alert_type='tdi'`/`'sma'`). `details` itself is never written to by any code path found (defaults to `{}` on every insert) — 🔶 **UNTESTED**/unused column in practice, unaffected by the `fired_at` migration.
- Read by: same workers for the dedup guard (`isDuplicateAlert`, forex/crypto only — Section 5), and by EBP Worker's `/alerts/history`, `/alerts/export`, `/sweep/history` routes → frontend `Alerts.jsx`.
- ⚠️ **Bug risk resolved 2026-08-06**: `fired_at` and `signals.fired_at` are now both TEXT ISO 8601 — the previous type mismatch (INTEGER here vs. TEXT there) that any future cross-table query would have had to know to work around no longer exists. Migration required updating all 9 `alert_history` INSERT sites and both `isDuplicateAlert` cutoff computations across the three workers in lockstep (Section 5) — and, caught only by testing the migration's actual output rather than trusting the SQL's intent, its first version produced SQLite's own `datetime()` format (`YYYY-MM-DD HH:MM:SS`, space-separated, no `Z`) for migrated rows instead of matching `toISOString()`'s format, which would have made same-day lexicographic comparisons wrong for those specific rows — fixed to use `strftime('%Y-%m-%dT%H:%M:%fZ', ...)` before any row was affected in practice.

**`invite_tokens`** — `token` TEXT PK, `created_at` INTEGER NOT NULL, `used_by`/`used_at` nullable, `active` INTEGER DEFAULT 1.
- Written/read by EBP Worker (`/admin/invite`, `/admin/tokens`, `/invite/:token`); read by frontend `Landing.jsx` (via the `:token` URL param, display-only) and `Admin.jsx`.

### Candle cache tables (Watchdog-owned)

**`candle_cache`** — `id` INTEGER PK AUTOINCREMENT, `symbol`/`tf` TEXT NOT NULL, `candles_json` TEXT NOT NULL, `fetched_at` TEXT NOT NULL, UNIQUE(symbol, tf).
- Written exclusively by Watchdog Worker. Read by EBP Worker, Sweep Worker (both via `getCandlesFromCache`, staleness-gated — 2× TF interval, 1.25× for 4H). NSE Worker does **not** read this table (it has its own `nse_candle_cache`, fetched independently via Upstox/Yahoo).

**`daily_candle_cache`** — `id` INTEGER PK AUTOINCREMENT, `symbol` TEXT NOT NULL, `date_ny` TEXT NOT NULL, `open`/`high`/`low`/`close` REAL NOT NULL, `synthesised_at` TEXT NOT NULL, UNIQUE(symbol, date_ny). **`weekly_candle_cache`** — same shape with `week_start_ny`/`week_end_ny` in place of `date_ny`, UNIQUE(symbol, week_start_ny). ⚠️ **DIVERGENCE**: both live in production but have **no CREATE TABLE statement anywhere in `schema.sql`** — only documented as a bottom-of-file comment ("Live tables not yet in schema... Added via ALTER TABLE or ad-hoc migration"). A developer relying solely on schema.sql would not know these tables' actual column shapes.
- Written by Watchdog (`attemptDailySynthesis`/`attemptWeeklySynthesis`, from 1H and daily rows respectively; capped at 130/26 rows per symbol). Read by EBP Worker and Sweep Worker for D/W-timeframe HTF bias and EBP/MSS detection.

**`watchdog_log`** — `id` INTEGER PK AUTOINCREMENT, `event_type` TEXT NOT NULL, `message` TEXT NOT NULL, `created_at` TEXT NOT NULL. Same ⚠️ DIVERGENCE as above — live, undocumented as a CREATE TABLE in schema.sql, only a comment. Written by Watchdog's `logWatchdog()` (failures/warnings only, by design). Not read by any worker or frontend page — write-only operational log, presumably intended for direct D1-console inspection.

### FVG / Swing / Chain tables (Phase 1–3, this session's migration)

**`fvg_zones`** (forex/crypto) / **`nse_fvg_zones`** (NSE) — identical 12-column shape: `id` INTEGER PK AUTOINCREMENT, `symbol`/`tf`/`direction` TEXT NOT NULL, `top`/`bottom`/`midpoint` REAL NOT NULL, `formed_at`/`expires_at` TEXT NOT NULL (ISO), `mitigated_at`/`mitigated_by_tf` TEXT nullable, `created_at` TEXT NOT NULL. Matches schema.sql exactly.
- Written by: `ebp-worker.js` and `sweep-cron.js` (`processFVGZones`, both write `fvg_zones`) for forex/crypto TFs M15/M30/1H/4H; `nse-cron.js` (own copy) writes `nse_fvg_zones` for M5/M15/1H only.
- Read by: `sweep-cron.js`'s `checkFvgEntryChain` (T1/T2/T4 completion check).
- Not read by any frontend page/hook — no UI surfaces FVG zone data directly (consistent with `EBP_Tracker_Roadmap.md`'s own "Deferred" list item "FVG zone visualisation in UI" — not a contradiction, correctly deferred).
- Cleanup: `DELETE FROM fvg_zones/nse_fvg_zones WHERE expires_at < now`, on the `tf==='M15'` branch of `handleSweepCron` (forex/crypto) and the `tf==='M1'` branch of `handleNseCron` (NSE).
- **Live row counts**: `fvg_zones` = **287 rows** as of 2026-08-06 (was 18 on 2026-08-02 — actively exercised, growing steadily). `nse_fvg_zones` = **5 rows** as of 2026-08-06 (was 0, previously 🔶 UNTESTED — see Section 8's updated finding).

**`swing_states`** (forex/crypto) / **`nse_swing_states`** (NSE) — `id` INTEGER PK AUTOINCREMENT, `symbol`/`tf` TEXT NOT NULL, `run_dir` TEXT nullable, `run_start_time` TEXT nullable, `run_candle_count` INTEGER DEFAULT 0, `last_confirmed_swing_high`/`_low` REAL nullable + `_time` TEXT nullable, `pending_swing_high`/`_low` REAL nullable + `_time` TEXT nullable, `updated_at` TEXT, UNIQUE(symbol, tf). Matches schema.sql exactly.
- Written/read by: `ebp-worker.js`, `sweep-cron.js` (both write `swing_states`, keyed by symbol+tf — since EBP and Sweep Workers can both run on the same symbol+tf if a user has both an EBP config and a Sweep config on it, they share and both mutate the *same row* per symbol+tf); `nse-cron.js` writes/reads its own `nse_swing_states` exclusively (also read by TDI's `checkTdiDivergence`/`checkTdiCondition4`).
- Not read by any frontend page.
- **Live row counts**: `swing_states` = **29 rows** as of 2026-08-06 (was 22). `nse_swing_states` = **3 rows** as of 2026-08-06 (was 0, previously 🔶 UNTESTED — see Section 8's updated finding).

**`chain_state`** — 19 columns: `id` INTEGER PK AUTOINCREMENT, `template_type` TEXT NOT NULL ('T1'/'T2'/'T3'/'T4'), `user_id`/`asset_id`/`symbol` TEXT NOT NULL, `htf`/`ltf` TEXT NOT NULL (`htf=''` for T4), `direction` TEXT NOT NULL, `state` TEXT NOT NULL, `step1_signal_id`/`step2_signal_id`/`step3_signal_id` TEXT nullable, `fvg_id` INTEGER nullable (FK→fvg_zones.id, not DB-enforced), `htf_candle_open`/`_close` REAL nullable + `_open_time`/`_close_time` TEXT nullable (T2 only), `expires_at`/`created_at` TEXT NOT NULL. Matches schema.sql exactly.
- Written by: `ebp-worker.js` (Step 1 for T1/T2/T3, via `insertChain`/`initiateT3Chain`); `sweep-cron.js` (Step 2/3 completion for T1/T2/T3/T4, via `advanceT3Chain`/`completeT3Chain`/`completeFvgEntryChain`, and Step 1+2 entirely for T4).
- Read by: `sweep-cron.js` exclusively (`getChains`, per-cycle chain lookups) — EBP Worker never reads it back after writing Step 1.
- Forex/crypto only — no NSE equivalent exists; NSE has no T1-T4 template chain machinery (by design, this session's scoping decision).
- Cleanup: `DELETE FROM chain_state WHERE expires_at < now`, same `tf==='M15'` cleanup branch in `sweep-cron.js`.
- ⚠️ **Status changed since 2026-08-02**: at the time of the original audit, `chain_state` held exactly 1 row ever, and `user_templates` had zero T1/T2/T4 rows (T3-only). As of 2026-08-06, `user_templates` holds **13 rows spanning all 4 template types** (`SELECT COUNT(DISTINCT template)` = 4) — T1/T2/T4 are now genuinely configured by at least one user, not just T3. `chain_state` itself currently reads **0 rows**, but that reflects the table's own cleanup cycle (chains flip to `complete` then get pruned once `expires_at` passes, same `tf==='M15'` cron branch as `fvg_zones`) rather than the chain machine being unused — a live row count of 0 on a churn-and-prune table is expected between active chains, not evidence of "never fired." Whether T1/T2/T4 have completed an end-to-end chain on live data specifically (vs. just being configured) isn't determinable from a point-in-time row count alone.

### Bias / template config tables

**`bias_cache`** — `symbol`/`timeframe` TEXT (composite PK), `bias`/`closure_type` TEXT NOT NULL, `close_pos` REAL, `bar1_time` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL.
- Written by all three detection workers (`writeBiasCache`, one row per symbol+HTF actually in use that cron cycle). Read by EBP Worker's `/user/bias/:symbol` → frontend `EBPConfigPanel.jsx`/`SweepConfigPanel.jsx` (live bias label per row).

**`user_templates`** — `id` TEXT PK, `user_id`/`asset_id` TEXT NOT NULL FK, `template` TEXT NOT NULL ('t1'/'t2'/'t3'/'t4', lowercase), `enabled` INTEGER DEFAULT 0, `htf`/`ltf` TEXT NOT NULL, `window_mins` INTEGER DEFAULT 60, `step3_enabled` INTEGER DEFAULT 1, `bias_gate` INTEGER DEFAULT 1, `fvg_rule` TEXT DEFAULT '50_percent', `created_at` INTEGER NOT NULL.
- Written by: EBP Worker (`/user/templates/:assetId`, `/user/template/:id`) ← frontend `AIAlertsPanel.jsx`.
- Read by: EBP Worker (Step 1 trigger query, `WHERE template=? AND enabled=1 AND htf=?`); Sweep Worker (T4's step-1 trigger query, `WHERE template='t4' AND enabled=1 AND ltf=?`).
- ⚠️ **Status changed since 2026-08-02, bug risk resolved**: `step3_enabled`, `bias_gate`, and `fvg_rule` were originally found completely dead — no cron code read them, no route let a user set them. Both halves are now fixed: `PATCH /user/template/:id` accepts all three (with validation — `fvg_rule` restricted to `50_percent`/`any_touch`/`full_fill`), `TemplateCard.jsx` exposes them in the UI (Section 6), and the cron code genuinely reads and applies them — `bias_gate` gates T4's Step-1 trigger (`sweep-cron.js`) and T3's Step-3 MSS check (`ebp-worker.js`), `fvg_rule` drives a per-template mitigation rule inside `checkFvgEntryChain` (looked up by `user_id`+`asset_id`+`template`, not `chain_state` directly — T4's `chain_state.htf` is always `''` so it can't be used as a join key back to the template row), and `step3_enabled` lets T3 run as a 2-step EBP+Sweep chain instead of the full 3-step chain. `day_filter` on `nse_indicator_configs` (different table, Section 3 above) remains genuinely dead, unaffected by this fix.

### Signal ID / append-only signal log

**`signals`** — 13 columns: `signal_id` TEXT PK, `template_type` TEXT NOT NULL ('EBP'/'T1'/'T2'/'T3'/'T4'/'NSE_EBP'/'NSE_SWEEP'/'NSE_MSS'), `symbol` TEXT NOT NULL, `htf_tf`/`ltf_tf`/`direction` TEXT, `fired_at` TEXT NOT NULL (ISO), `traded` INTEGER DEFAULT 0, `expires_at` TEXT, `price_at_signal`/`htf_close` REAL, `htf_bias`/`session` TEXT.
- Written by: EBP Worker (EBP signals only — not T1/T2/T3 at Step 1, since those aren't "fired" signals yet); Sweep Worker (T1/T2/T3-step3/T4 signals, on chain completion); NSE Worker (NSE_EBP/NSE_SWEEP/NSE_MSS).
- Read by: EBP Worker's `/signals/:id` and `/signals/:id/traded` routes (X-Journal-Secret — external Trade Journal app, not this repo's frontend).
- Append-only by design (comment in schema.sql); only `traded` is ever mutated post-insert.

**`signal_counters`** — `template` TEXT PK, `series` TEXT DEFAULT 'A', `count` INTEGER DEFAULT 0.
- One row per template key: `'EBP-M15'`, `'EBP-1H'`, `'EBP-4H'`, `'EBP-1D'`, `'EBP-1W'`, `'T3'`, `'T1'`, `'T2'`, `'T4'`, `'NSE'`. Format produced: `{template}-{SYMBOL}-{series}{count:03d}` (e.g. `T3-XAUUSD-A001`), except EBP's own generator which additionally embeds the TF: `EBP-{SYMBOL}-{tf}{series}{count:03d}`.
- Written/read by: `generateSignalId()`/`generateEbpSignalId()`/`generateNseSignalId()` — one near-identical copy in each of `ebp-worker.js`, `sweep-cron.js`, `nse-cron.js`.

### Market Breadth tables

**`market_breadth_cache`** — `tf` TEXT PK, `computed_at` INTEGER, `heatmap`/`strength` TEXT (JSON). **`market_breadth_intraday`** — `tf`+`snapshot_at` composite PK, `strength` TEXT (JSON), pruned to 40 days (was 48h — see below). **`market_breadth_correlation`** — `tf` TEXT PK, `computed_at` INTEGER, `matrix` TEXT (JSON, Pearson).
- All three written exclusively by EBP Worker's `handleMarketBreadthCron` (hourly native cron); `market_breadth_intraday`/`market_breadth_correlation` rows are always `tf='1H'`. ⚠️ **Status changed since 2026-08-02**: a later session added `computeWeeklyBreadth()`, called at the end of every `handleMarketBreadthCron` run, which aggregates the trailing 35 days of `market_breadth_intraday` into a single `market_breadth_cache` row with `tf='1W'` (most-recently-completed ISO week only, requires ≥3 trading days that week) — reversing this report's original "there is no weekly breadth aggregation anywhere in code" finding. `market_breadth_intraday`'s prune window was widened 48h→40 days specifically so this aggregation has enough history. However, `GET /market/breadth` (below) still only ever queries `tf='1H'` from `market_breadth_cache` — the `'1W'` row is computed and stored but never returned by the API or read by the frontend (Section 6), so the "Weekly Strength" UI section is still effectively unimplemented from the user's perspective, just for a different reason than originally found.
- Also added since 2026-08-02: a forex-weekend gate at the top of `handleMarketBreadthCron` (Friday 17:00 NY through Sunday 17:00 NY) that skips the entire computation — on a weekend tick, whatever was last computed simply stays in place (not zeroed).
- Read by: EBP Worker's `/market/breadth` → frontend `MarketBreathPage.jsx` (polled every 60s). ⚠️ **No longer admin-gated** — the route now only requires a valid Clerk JWT (confirmed live in `ebp-worker.js`); see Section 6 for the resulting change to the access-control finding below.

### NSE-specific tables

**`nse_candle_cache`** — `symbol`/`timeframe` composite PK, fixed 3-bar columns (`bar_0_open..bar_2_close`, `bar_0_time`, `bar_1_time`), `updated_at` INTEGER — 17 columns total.
- Written/read exclusively within `nse-cron.js` — completely separate caching mechanism from the forex/crypto `candle_cache`.

**`nse_indicator_candle_cache`** — `symbol`/`timeframe` composite PK, `candles` TEXT (JSON array, up to 60 OHLCV, newest-first), `updated_at` INTEGER NOT NULL.
- Written/read exclusively within `nse-cron.js`, feeding TDI (RSI(13)/BB(34)) and SMA Cloud, which both need more history than the 3-bar `nse_candle_cache` provides.

**`nse_indicator_configs`** — `id`/`user_id`/`asset_id` TEXT, `indicator` TEXT ('tdi'|'sma'), `timeframe` TEXT ('sma' now also validates `M30`, not just `M15`/`M5` — was UI-only-missing as of 2026-08-02, now fixed), `confirmation_mode` TEXT (⚠️ **renamed from `stack_mode` since 2026-08-02** — now `'mss'`/`'cisd'`/`'either'`, the SMA Cloud Type 2 confirmation gate, Section 8; old `'strict'`/`'loose'` rows fall back to `'either'` at read time)/`bias_mode`/`htf_timeframe` TEXT (sma only), `day_filter` INTEGER (still dead — schema.sql's own comment still says "unused since the SMA Cloud corrective patch"), `enabled` INTEGER DEFAULT 1, `created_at` INTEGER NOT NULL.
- Written by EBP Worker (`/user/nse-indicator-configs/*`) ← frontend `TdiConfigPanel.jsx`/`SmaConfigPanel.jsx`. Read by `nse-cron.js`.

**`forex_indicator_configs`** — **new table since 2026-08-02**, same shape as `nse_indicator_configs` minus `day_filter` (never had a forex equivalent): `id`/`user_id`/`asset_id` TEXT, `indicator` TEXT DEFAULT `'sma'` (only value in practice — this table only exists for forex/crypto SMA Cloud, unlike `nse_indicator_configs` which also holds TDI rows), `timeframe` TEXT (`M15`/`M30`/`1H`/`4H`), `bias_mode`/`htf_timeframe`/`confirmation_mode` TEXT.
- Written by EBP Worker (`/user/forex-indicator-configs/*`) ← frontend `ForexSmaConfigPanel.jsx`. Read by `sweep-cron.js` (`handleForexSmaCron`).

**`forex_sma_state`** — **new table since 2026-08-02**, same shape as `nse_sma_state` below (Section 8 has the full phase-machine detail) plus one extra column `distribution_started_at` (ISO time, set on Type 1, cleared on exhaustion). One row per `(symbol, timeframe)`, shared across every user configured on that symbol+TF.
- Written/read exclusively by `sweep-cron.js`'s `handleForexSmaCron`.

**`user_indicator_settings`** — `user_id` TEXT PK, `sma_forex_hours` TEXT DEFAULT 'session', `updated_at` INTEGER NOT NULL.
- Documented but not implemented: schema comment states this is "scaffolding... not yet read by any Worker." Confirmed — no read site exists anywhere, and no write route exists either.

**`nse_indicator_chain`** — `id`/`user_id`/`asset_id`/`symbol`/`timeframe` TEXT, `direction` TEXT, `state` INTEGER DEFAULT 1, `created_at`/`expires_at` INTEGER NOT NULL.
- TDI's 2-state pending mechanism (condition 1-3 met → row created; condition 4 met → row deleted + alert fires). Written/read exclusively in `nse-cron.js`.

**`nse_sma_state`** — `symbol`/`timeframe` composite PK, `direction`/`phase` TEXT nullable, `stack_active`/`consecutive_widening` INTEGER (both retired — `consecutive_widening` always written as 0, `stack_active` a holdover from the old phase machine), `separation`/`atr14`/`cloud_top`/`cloud_bottom` REAL, `velocity_label` TEXT, `stack_formed_date`/`last_signal_date` TEXT, `last_signal_time` INTEGER, `updated_at` INTEGER NOT NULL. ⚠️ **6 columns added since 2026-08-02** as part of the SMA Cloud revamp (Section 8): `sma1_last`/`sma9_last` REAL (prior run's values, for fresh-cross detection), `cisd_watch_active` INTEGER, `cisd_watch_direction` TEXT, `cisd_pullback_start` TEXT (ISO), `cisd_watch_armed_at` TEXT (ISO) — the Type 2 arm/confirm chain's state.
- SMA Cloud's per-symbol+TF phase state, written/read every cron cycle regardless of whether a signal fires. Exclusively `nse-cron.js`.

**`sma_cloud_states`** — `id` INTEGER PK AUTOINCREMENT, `symbol`/`tf` TEXT NOT NULL, `phase` TEXT NOT NULL, `phase_started_at` TEXT NOT NULL, `sma1_last`/`sma9_last`/`atr_last` REAL, `crossovers_in_transition`/`widening_candles` INTEGER DEFAULT 0, `last_signal_date` TEXT, `updated_at` TEXT NOT NULL, UNIQUE(symbol, tf). **Confirmed genuinely orphaned**: live in D1, defined in schema.sql's own trailing comment as "created in the original IM-1 migration but currently unused/orphaned — no worker code reads or writes it," and this session's dead-code/table-usage scan found zero read or write references anywhere in `nse-cron.js` (SMA Cloud's real, actively-used state table is `nse_sma_state`, a differently-named and differently-shaped table — easy to confuse the two by name).

### API key / call-log tables

**`api_keys`** — `id`/`source`/`key_value`/`label` TEXT, `enabled` INTEGER DEFAULT 1, `added_at` INTEGER, `added_by` TEXT.
- The single admin-managed table for **both** Twelve Data keys (`source='twelvedata'`) and the Upstox token (`source='upstox'`) — despite the schema comment implying it's Twelve-Data-specific. Written by EBP Worker's `/admin/api-keys*`. Read by Watchdog (Twelve Data rotation) and NSE Worker (Upstox token + `/nse/search`, `/nse/status`).

**`api_key_state`** — `key_name` TEXT PK (references `api_keys.id`), `exhausted` INTEGER DEFAULT 0, `exhausted_at` INTEGER, `calls_today` INTEGER DEFAULT 0, `reset_at` INTEGER.
- Written/read exclusively by Watchdog Worker (key rotation/exhaustion bookkeeping). Not read by any Upstox flow (Upstox has no equivalent state tracking — no rotation, single token only).

**`api_call_log`** — corrected this session to match production exactly: `id` TEXT PK, `source`/`symbol`/`timeframe` TEXT NOT NULL, `called_at` INTEGER NOT NULL, `success` INTEGER DEFAULT 1. Now matches live D1 exactly (verified — no further drift).
- Written by Watchdog Worker (`logApiCall`, every Twelve Data/Yahoo call), pruned to 2 days old on Watchdog's hourly tick. Read by EBP Worker's `/health/datasources` — 🔶 **UNTESTED/orphaned route**: no page in `frontend/src` calls `/health/datasources` (confirmed via the frontend research pass's full API-call inventory), so this data is only reachable via direct API call, not through any UI.

### Cleanup cycles summary

| Table(s) | Deleted by | Trigger | Rule |
|---|---|---|---|
| `fvg_zones`, `nse_fvg_zones` | `sweep-cron.js` / `nse-cron.js` | `tf==='M15'` (forex) / `tf==='M1'` (NSE) cron tick | `expires_at < now` (formed_at + 14 days) |
| `chain_state` | `sweep-cron.js` | `tf==='M15'` cron tick | `expires_at < now` (T3: now+window_mins at creation; T1/T2/T4: end of UTC month) |
| `market_breadth_intraday` | `ebp-worker.js` | every `handleMarketBreadthCron` run (hourly) | `snapshot_at < now - 48h` |
| `signals` (`template_type='EBP'`) | `ebp-worker.js` | `tf==='D'` cron tick (daily) | `expires_at <= now` |
| `api_call_log` | `watchdog-worker` | `minute===0` (hourly) | `called_at < now - 2 days` |
| `nse_indicator_chain` | `nse-cron.js` | inline, every TDI evaluation | `expires_at <= now`, deleted individually when checked |
| `nse_swing_states`, `swing_states`, `bias_cache`, `nse_sma_state`, `candle_cache`, `daily_candle_cache`, `weekly_candle_cache` | never | n/a | Overwritten in place (`INSERT ... ON CONFLICT DO UPDATE` / `INSERT OR REPLACE`), not time-expired — `daily_candle_cache`/`weekly_candle_cache` are instead row-capped by Watchdog itself (130/26 rows per symbol). |
| `alert_history`, `user_ebp_configs`, `user_sweep_configs`, `user_templates`, `chain_state` (cascade) | `ebp-worker.js` | `DELETE /user/assets/:id` | Cascade-deletes the asset's own config/template/chain rows — see Section 9 for what's *not* cascaded. |

### Foreign key relationships (application-enforced — D1/SQLite does not enforce FKs by default in this schema; no `PRAGMA foreign_keys=ON` found anywhere in worker code)

`user_assets.user_id → users.id` · `user_telegram.user_id → users.id` · `alert_history.user_id → users.id` · `user_ebp_configs.user_id → users.id`, `user_ebp_configs.asset_id → user_assets.id` · `user_sweep_configs` same shape · `user_templates.user_id → users.id`, `user_templates.asset_id → user_assets.id` · `chain_state.user_id → users.id`, `chain_state.asset_id → user_assets.id` (added beyond the original migration spec specifically so the asset-delete cascade and template-lookup joins keep working) · `chain_state.fvg_id → fvg_zones.id` (implicit, JS-only — set from `fvg_zones.id` at chain completion, never validated) · `nse_indicator_configs.user_id/asset_id`, `nse_indicator_chain.user_id/asset_id` same pattern · `api_key_state.key_name → api_keys.id` (implicit, by convention, not a real FK column type match — `api_keys.id` is the UUID, `api_key_state.key_name` is documented as referencing it but the column name doesn't match `id`, an easy point of confusion for a future maintainer).

---

## Section 4 — Signal Detection Engine

Every detection function below is duplicated near-verbatim across the worker files that need it (deliberate "zero cross-package imports" architecture — see Section 9 for the resulting drift risk). Logic shown is quoted directly from `worker/src/ebp-worker.js`; `sweep-worker/src/sweep-cron.js` and `nse-worker/src/nse-cron.js` copies are byte-for-byte identical except where noted.

### EBP (Engulfing Bar Print)
`worker/src/ebp-worker.js` (`detectEBP`), identical in `nse-worker/src/nse-cron.js`:
```js
function detectEBP(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];               // newest, closed candle
  const bar1 = candles[1];               // previous candle
  const prevBodyHigh = Math.max(bar1.open, bar1.close);
  const prevBodyLow  = Math.min(bar1.open, bar1.close);
  const bullEBP = bar0.low  < bar1.low  && bar0.close > prevBodyHigh;
  const bearEBP = bar0.high > bar1.high && bar0.close < prevBodyLow;
  if (!bullEBP && !bearEBP) return null;
  return { direction: bullEBP ? 'bullish' : 'bearish', candleTime: bar0.time,
           sweptLevel: bullEBP ? bar1.low : bar1.high, closedLevel: bar0.close };
}
```
Plain English: a **bullish EBP** requires the newest candle to wick below the prior candle's low (a liquidity sweep) *and* close back above the prior candle's real body high (engulfing the body, not just the wick). Bearish is the mirror. Only 2 candles needed — fires from day one on any TF with ≥2 cached candles. Sweep Worker does not run `detectEBP` at all (EBP is exclusively an EBP-Worker/NSE-Worker concept).

### Sweep
`worker/src/ebp-worker.js` / `sweep-worker/src/sweep-cron.js` (exported) / `nse-worker/src/nse-cron.js`, all identical:
```js
function detectSweep(candles) {
  if (!candles || candles.length < 2) return null;
  const bar0 = candles[0];
  const bar1 = candles[1];
  const bullSweep = bar0.low  < bar1.low  && bar0.close > bar1.low;
  const bearSweep = bar0.high > bar1.high && bar0.close < bar1.high;
  if (!bullSweep && !bearSweep) return null;
  return { direction: bullSweep ? 'bullish' : 'bearish', candleTime: bar0.time,
           sweptLevel: bullSweep ? bar1.low : bar1.high, closedInsideLevel: bar0.close,
           prevHigh: bar1.high, prevLow: bar1.low };
}
```
A **bullish sweep** = wick below the prior low, close back *above* the prior low (does not require closing above the prior body, unlike EBP — a materially looser trigger). This is the key structural difference from EBP: Sweep only cares about closing back inside the prior range, EBP requires closing beyond the prior candle's *body*.

### FVG (Fair Value Gap) — Phase 1
Identical across all three workers (`fvg_zones`/`nse_fvg_zones`, both written via the same `processFVGZones`):
```js
function detectFVG(candles) {              // candles: oldest-first, 3-item window
  if (!candles || candles.length < 3) return null;
  const barIMinus2 = candles[candles.length - 3];
  const barI       = candles[candles.length - 1];
  if (barIMinus2.high < barI.low) {                    // bullish gap
    const top = barI.low, bottom = barIMinus2.high;
    return { direction: 'bullish', top, bottom, midpoint: (top+bottom)/2, formed_at: barI.time };
  }
  if (barIMinus2.low > barI.high) {                    // bearish gap
    const top = barIMinus2.low, bottom = barI.high;
    return { direction: 'bearish', top, bottom, midpoint: (top+bottom)/2, formed_at: barI.time };
  }
  return null;
}
function checkFVGMitigation(bar, fvgRow) {   // body-close-through-midpoint rule
  if (fvgRow.direction === 'bullish') return bar.close < fvgRow.midpoint;
  return bar.close > fvgRow.midpoint;
}
function isPriceInFVG(price, fvgRow) {
  return price >= fvgRow.bottom && price <= fvgRow.top;
}
```
Gap is between the candle 2-back and the current candle — the middle candle (the "impulse" candle) isn't itself compared. Dedup guard on insert: skip if an active (non-mitigated, non-expired) zone of the same direction already overlaps the new zone's price range (`existing.top >= new.bottom AND existing.bottom <= new.top`). Zones expire 14 days after `formed_at`. TFs: forex/crypto M15/M30/1H/4H; NSE M5/M15/1H only (D and W never run FVG detection anywhere — daily/weekly candle history from Watchdog synthesis is too short for a 3-bar gap check to be meaningful this early in the system's life).

### Swing State Machine + MSS — Phase 1.5 / 2
This is the most structurally involved detector. Full state fields (`swing_states`/`nse_swing_states`): `run_dir` ('bullish'|'bearish'|null), `run_start_time`, `run_candle_count`, `last_confirmed_swing_high`/`_low` (+ `_time`), `pending_swing_high`/`_low` (+ `_time`).

**Doji rule** — a bar is skipped entirely (no state mutation at all, including `run_candle_count`) if its body is smaller than a doji threshold:
```js
function isDoji(bar, dojiThreshold) { return Math.abs(bar.close - bar.open) <= dojiThreshold; }
```
`dojiThreshold = ATR(14)*0.1` when 14+ bars are available, else `(bar.high - bar.low)*0.1`. 🔶 **UNTESTED in the ATR(14) branch**: the D1 candle cache these functions read from only ever supplies the 3-bar window already used elsewhere in each file, so `calcATR14()` returns `null` in every real invocation today and the fallback branch is what actually runs in production. The ATR(14) branch is real code, not stubbed, but has never executed against live data.

**State transition diagram** (per non-doji bar):
```
                    ┌─────────────┐
                    │ run_dir=null │  (bootstrap — first bar ever seen for symbol+tf)
                    └──────┬──────┘
         close > prevBar.high │ close < prevBar.low │ (neither, or no prevBar)
                    ▼               ▼                      ▼
              run_dir='bullish'  run_dir='bearish'   run_dir='bullish' (default)
              run_candle_count=1, run_start_time=bar.time

  ┌─── run_dir === 'bullish' ──────────────────────────────────────────┐
  │  if bar.high > pending_swing_high (or none set):                  │
  │      pending_swing_high = bar.high   (tracks the running extreme) │
  │  if pending_swing_high set AND bar.close < pending_swing_high:    │
  │      last_confirmed_swing_high = pending_swing_high  (CONFIRMED)  │
  │      pending_swing_high = null                                    │
  │  run_candle_count += 1                                             │
  │  ── MSS check: bearish (see below) ──                              │
  └──────────────────────────────────────────────────────────────────┘

  ┌─── run_dir === 'bearish' ─── mirror of the above on lows ─────────┐
  └──────────────────────────────────────────────────────────────────┘
```
**MSS (Market Structure Shift)**:
```js
function detectMSS(bar, swingState) {
  if (!swingState || swingState.run_dir == null || (swingState.run_candle_count ?? 0) < 3) return null;
  if (swingState.run_dir === 'bearish' && swingState.last_confirmed_swing_high != null
      && bar.close > swingState.last_confirmed_swing_high) {
    return { direction: 'bullish', level: swingState.last_confirmed_swing_high, candle_time: bar.time };
  }
  if (swingState.run_dir === 'bullish' && swingState.last_confirmed_swing_low != null
      && bar.close < swingState.last_confirmed_swing_low) {
    return { direction: 'bearish', level: swingState.last_confirmed_swing_low, candle_time: bar.time };
  }
  return null;
}
```
Requires a *minimum 3-candle run* before an MSS can fire (prevents rapid-fire whipsaw MSS on a 1-2 candle run). On fire: `run_dir` flips to the MSS direction, both pending fields clear, `run_candle_count` resets to 1, `run_start_time` resets to the firing bar's time — i.e. an MSS is itself the start of a brand-new run in the opposite direction. Only the single newest bar is fed through this state machine per cron cycle (not the whole 3-bar window) — the second-to-last element of the fetched window is used solely as the comparison bar for the bootstrap case.

MSS fires an alert independently of any template chain (any user with a matching EBP-config or Sweep-config TF gets notified) — separately, MSS is also the trigger `sweep-cron.js` checks to advance a T3 chain from `awaiting_mss` → `complete` (Section below).

### TTrades Closure Bias Engine
```js
function calcTTradesBias({ bar1, bar2 }) {
  const c0 = bar1.close, h0 = bar1.high, l0 = bar1.low, prevH = bar2.high, prevL = bar2.low;
  const sweptH = h0 > prevH && c0 <= prevH;      const sweptL = l0 < prevL && c0 >= prevL;
  const insideD = h0 <= prevH && l0 >= prevL;    const outsideD = h0 > prevH && l0 < prevL;
  const aboveH = c0 > prevH;                     const belowL = c0 < prevL;
  let closure = outsideD ? 'outside_bar' : insideD ? 'inside_bar' : sweptH ? 'swept_high_closed_inside'
    : sweptL ? 'swept_low_closed_inside' : aboveH ? 'above_prev_high' : belowL ? 'below_prev_low' : 'none';
  const rng = h0 - l0;
  const closePos = rng !== 0 ? ((c0 - l0) / rng) * 100 : 50;
  let bias = (closure === 'above_prev_high' || closure === 'swept_low_closed_inside') ? 'bullish'
    : (closure === 'below_prev_low' || closure === 'swept_high_closed_inside') ? 'bearish'
    : closure === 'outside_bar' ? (closePos >= 50 ? 'bullish' : 'bearish') : 'neutral';
  return { bias, closure, closePos };
}
```
This runs once on the HTF's two most recent candles, cached in `bias_cache`, and read back per-user through the pairing table below plus per-user overrides (`bias_overrides` JSON on `user_assets`, editable via `BiasOverridePanel.jsx`).

**HTF pairing table** (`BIAS_SOURCE`):
```js
const BIAS_SOURCE = {
  ebp:      { M15:'4H', '1H':'D', '4H':'W', D:'W', W:null },
  sweep:    { M5:'1H', M15:'1H', M30:'4H', '1H':'D', '4H':'W' },
  template: { W:null, D:'W', '4H':'D', '1H':'4H' },
};
```
NSE has its own separate, simpler pairing map (`NSE_BIAS_SOURCE`, `{ M1:'M15', M5:'M30', M15:'1H', M30:'D', '1H':'D', D:null }`, identical for `ebp`/`sweep`) — cannot reuse the forex map since NSE's TF ladder differs (e.g. NSE M15→1H vs forex M15→4H).

**Override mechanism**: `resolveHTF(signalType, tf, htfOverride)` — if a user's config row has a non-null `htf_override`, it wins outright; otherwise falls back to `BIAS_SOURCE[signalType][tf]`. Only `1H` and `4H` configs are overridable, and only to one of two allowed alternates: `VALID_HTF_OVERRIDES = { '1H': ['4H','D'], '4H': ['D','W'] }`. `getEffectiveBias()` then layers a *further* per-symbol override on top (`bias_overrides` JSON: `'auto'` defers to the computed bias, anything else — `'bullish'`/`'bearish'`/`'neutral'` — is used verbatim, ignoring the cache entirely).

### T1/T2/T3/T4 Template Chains — Phase 3

All four templates share the `chain_state` table (schema in Section 3). `direction` is always `'bullish'`/`'bearish'` throughout (never `'bull'`/`'bear'`) so it can be compared directly against `detectEBP`/`detectSweep`/`detectMSS` output with no translation layer.

**T3 — HTF EBP → LTF Sweep → LTF MSS** (`awaiting_sweep` → `awaiting_mss` → `complete`)
1. **Step 1** (`ebp-worker.js`, inside the per-user EBP-alert loop, only after that user's plain EBP alert has already passed the dedup check): query `user_templates WHERE template='t3' AND enabled=1 AND htf=?` (the EBP's own TF). If found: `generateSignalId(db, 'T3', symbol)` (ID assigned **here**, at Step 1 — carried through unchanged to Steps 2/3 via `chain_state.step1_signal_id`, never regenerated), then `initiateT3Chain()` inserts a `chain_state` row with `state='awaiting_sweep'`, `expires_at = now + window_mins*60000` (T3's own per-chain timing window, deliberately *not* the generic "end of UTC month" default the other three templates use — window_mins defaults to 60 and is user-configurable, but the config UI to change it doesn't exist — see Section 9). Fires a Telegram alert immediately (Step 1 of 3).
2. **Step 2** (`sweep-cron.js`, inside the per-user Sweep-alert loop): on every LTF cron cycle where a sweep fires, query active `T3`/`awaiting_sweep` chains for that symbol+user+**same** direction as the sweep (`sweep.direction === chain.direction` — see the code-comment-documented naming-convention resolution below), filtered further to `chain.ltf === tf`. Match → `advanceT3Chain()` sets `state='awaiting_mss'`. Fires Step 2 Telegram alert reusing `chain.step1_signal_id`.
3. **Step 3** (`sweep-cron.js`, inside the per-user MSS-alert loop): on MSS fire, query active `T3`/`awaiting_mss` chains for that symbol+user+**same** direction as the MSS result, filtered to `chain.ltf === tf`. Match → insert a `signals` row (`template_type='T3'`, reusing `step1_signal_id`), fire the completion Telegram alert, `completeT3Chain()` sets `state='complete'` (chains are never row-deleted on completion, only state-flipped — swept up later by the generic `expires_at` cleanup).

⚠️ **Resolved ambiguity, documented in-code**: the *literal* T3 spec text this session's earlier work was built from said Step 2's sweep direction must be "**opposite**" to the chain's direction ("bull chain expects a sweep of lows"). In this codebase's naming convention, a sweep is named after its *resulting bias* (a "bullish sweep" = a sweep of lows that closes back above — i.e. IS a sweep of lows), so "bull chain expects a sweep of lows" is actually the **same**-direction case, matching what was already live in production before this session's rewrite. The code was written to match same-direction (`sweep.direction === chain.direction`), with an inline comment explaining the resolution — flagging here since it directly contradicts the plain-English phrasing of the original design doc.

**T1 — HTF EBP → LTF FVG Entry** (`awaiting_fvg_entry` → `complete`)
1. **Step 1** (`ebp-worker.js`, same loop as T3 Step 1, same trigger — one EBP event can spawn a T1, T2, *and* T3 chain simultaneously for the same user if they've enabled all three templates on that htf): query `user_templates WHERE template='t1' AND enabled=1 AND htf=?`. Match → `insertChain()` with `state='awaiting_fvg_entry'`, `step1_signal_id=null` (no signal has fired yet — T1 only gets an ID at completion), `expires_at = end of current UTC month`.
2. **Step 2** (`sweep-cron.js`, `processTemplateChains()` — a function that runs **independently of `user_sweep_configs`**, once per LTF cron cycle regardless of whether that user has any Sweep alert config at all, since a user might enable a T1 template on an LTF without separately subscribing to plain Sweep alerts on it): for every active T1/T2/T4 chain whose `ltf === tf`, fetch the latest cached close for `chain.symbol`, look up active `fvg_zones` rows matching `chain.symbol`/`chain.ltf`/`chain.direction`, and check `isPriceInFVG(latestClose, fvg)`. Match → `generateSignalId(db, 'T1', symbol)` (ID generated **only now**, at completion — not at Step 1), `completeFvgEntryChain()` sets `state='complete'` + `fvg_id`, inserts a `signals` row, sends the T1 Telegram alert.

**T2 — HTF EBP → LTF FVG Retracement** (`awaiting_retracement` → `complete`) — most complex, built last
1. **Step 1** (`ebp-worker.js`, same EBP-triggered loop): additionally captures the firing EBP candle's own `open`/`close`/`open_time` into `chain_state.htf_candle_open/_close/_open_time`, plus a *derived* `htf_candle_close_time = open_time + one HTF interval* (the cache only ever stores a candle's open timestamp — this session's implementation approximates the close bound so the Step 2 window check has something real to compare against; this is a disclosed adaptation, not part of any original spec text). `state='awaiting_retracement'`.
2. **Step 2** (`sweep-cron.js`, same `processTemplateChains()` pass as T1): for each active T2 chain, additionally filters candidate FVGs to those whose `formed_at` falls within `[htf_candle_open_time, htf_candle_close_time]` **and** whose price range sits inside the HTF EBP candle's real body (`fvg.top <= max(open,close) && fvg.bottom >= min(open,close)`) — i.e. the FVG must have literally formed as a retracement *inside* the very candle that triggered the EBP. Only then does `isPriceInFVG` get checked. Completion mechanics identical to T1.

**T4 — LTF Sweep → LTF FVG Entry** (`awaiting_fvg_entry` → `complete`) — no HTF EBP step at all
1. **Step 1** (`sweep-cron.js` only, `processTemplateChains()`, driven entirely by `user_templates WHERE template='t4' AND enabled=1 AND ltf=?` joined against `user_assets`/`users` — **not** gated by `user_sweep_configs` at all, since T4's own sweep detection is self-contained): for each matching template row, fetch cached candles for that symbol+ltf, run `detectSweep()` directly. On a hit, if no existing `awaiting_fvg_entry` T4 chain already exists for that symbol+direction+user (a lightweight re-fire guard, not a full dedup — see Section 9), `insertChain()` with `htf=''` (T4 has no HTF concept — this is the one template where the column is deliberately empty rather than a real TF), `expires_at = end of current UTC month`.
2. **Step 2** — runs in the **same cron pass** as Step 1 (T4 chains are eligible for FVG-entry completion the instant they're created, not just on subsequent cycles) via the same shared T1/T2/T4 FVG-entry check described above.

**Signal ID generation** (all templates): `generateSignalId(db, template, symbol)` reads `signal_counters WHERE template=?`, increments `count`, rolls `series` to the next letter past 999, writes back, returns `` `${template}-${symbolNoSlash}-${series}${count.padStart(3,'0')}` `` (e.g. `T1-XAUUSD-A007`). T3 generates at Step 1; T1/T2/T4 generate only at completion.

**Telegram alert format per template** (all built via `formatT3Alert`/`formatFvgEntryAlert`):
```
T3 (per step):
🎯 T3 Chain — {SYMBOL}
Step: S{n} of 3
HTF: {htf} EBP → LTF: {ltf} Sweep → LTF: {ltf} MSS
Direction: {🟢/🔴} {BULL/BEAR}
Session: {session}
Price: {price}
Signal ID: {signalId}/S{n}

T1/T2/T4 (completion only):
🎯 {T1|T2|T4} Signal — {SYMBOL}
{flow line: "HTF: {htf} EBP → LTF: {ltf} FVG Entry" (T1) |
 "HTF: {htf} EBP → LTF: {ltf} Retracement FVG" (T2) |
 "LTF: {ltf} Sweep → FVG Entry" (T4)}
Direction: {🟢/🔴} {BULL/BEAR}
FVG Zone: {bottom} – {top}
Price: {price}
Signal ID: {signalId}
```

### NSE-specific detection differences vs forex/crypto
`detectEBP`, `detectSweep`, `detectMSS`, and the FVG engine are **byte-for-byte identical** between `nse-cron.js` and the forex/crypto workers — no NSE-specific tuning of any threshold or condition. The only structural differences are: (1) NSE writes to its own `nse_fvg_zones`/`nse_swing_states` tables rather than the shared forex/crypto ones; (2) NSE has **no T1/T2/T3/T4 template-chain machinery at all** — EBP/Sweep/MSS fire as standalone alerts with no multi-step confirmation chain on NSE; (3) NSE has two entirely NSE-only detectors with no forex/crypto equivalent — **TDI** and **SMA Cloud** (both fully detailed in Section 8).

### TF access rules per market
| | Forex/crypto | NSE |
|---|---|---|
| Valid TF set (hard-coded) | `['M5','M15','M30','1H','4H','D','W']` (EBP); `['M5','M15','M30','1H','4H']` (Sweep, enforced in `sweep-worker/src/index.js`) | `['M1','M5','M15','M30','1H','D']`, duplicated as a *second*, separately-maintained literal in `ebp-worker.js` (`ALL_NSE_TF_ACCESS`) and in `nse-cron.js` (`NSE_VALID_TFS`) — ⚠️ **risk mitigated, not eliminated, 2026-08-06**: the duplication itself can't be removed (Cloudflare Workers can't share imports across independently-deployed bundles), but both declarations now carry an explicit sync-notice comment ("if you change one, change the other in the same commit"), reducing the chance of an edit to one being made without the other. |
| Per-user override column | `users.user_tf_access` (JSON array) | `users.nse_tf_access` (JSON array), added by `migrations/007_nse_worker.sql`, explicitly documented as separate from `user_tf_access` |
| Admin route | `GET/PATCH /admin/users/:id/tf-access` | `GET/PATCH /admin/users/:id/nse-tf-access` |
| FVG-specific TF subset | M15/M30/1H/4H | M5/M15/1H only (D/W and M1/M30 never run FVG) |
| Checked at | config creation (`POST /user/ebp-configs`/`sweep-configs`) and alert delivery time | same pattern, plus TDI/SMA delivery (`deliverNseIndicatorAlert`) |

---

## Section 5 — Alert & Notification System

### Telegram bot setup
**One shared bot for all user-facing alerts**: `@EbP_Tracker_bot`, token in the `SHARED_BOT_TOKEN` secret, configured identically on `worker`, `sweep-worker`, and `nse-worker` (three separate `wrangler secret put` invocations of the same value — not shared infrastructure, just the same token pasted three times). ⚠️ **DIVERGENCE from README.md's implied architecture** ("Telegram bot (via @BotFather)" singular setup step) — this is accurate, just worth noting there is genuinely one bot for the whole system, not per-alert-type bots.

**Watchdog Worker itself still sends zero Telegram messages** — confirmed via full-file grep, no `SHARED_BOT_TOKEN` reference exists in `watchdog-worker/src/index.js` and it has no secrets configured at all. `DEVELOPER_TELEGRAM_CHAT_ID` is a configured secret on the EBP Worker but **has no live call site anywhere in `ebp-worker.js`** — documented but not implemented (per-code-comment history, it was used for payment-submission notifications that were later removed; the secret was never cleaned up).

⚠️ **Status changed since 2026-08-02**: the underlying gap this section originally flagged — "nothing delivers a Watchdog failure to a human" — has since been addressed, though not by adding alerting *inside* Watchdog itself. Watchdog suffered a live incident (Cloudflare CPU-limit kills on its scheduled runs, ~3.5 hours undetected) that exposed a structural blind spot: a CPU-limit kill terminates the isolate before any in-process code — including Watchdog's own outer `scheduled().catch()` — can run, so no alerting logic living inside Watchdog can ever fire on Watchdog's own catastrophic failure. The fix is a new **external** heartbeat: `POST /health/watchdog-check` on the EBP Worker (new secrets `WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID`, both configured on `worker`, not `watchdog-worker`), triggered independently every 15 minutes via its own cron-job.org job. It checks freshness of `watchdog_log`, forex `candle_cache`/`swing_states`/`fvg_zones`/`market_breadth_intraday`/`forex_sma_state`, and (market-hours-gated) the NSE equivalents, and sends a Telegram failure alert, a 2-hourly all-clear, or an NY-5PM EOD summary. So a "Watchdog alert bot" now effectively exists — just implemented as an external checker rather than as code inside Watchdog, which is precisely why it can detect the one failure mode Watchdog can never report on itself.

### Per-user bot token vs shared bot — what's actually implemented
**Shared bot only.** There is no per-user bot token anywhere in the schema or code — `user_telegram` stores only `chat_id` (which chat the shared bot should DM), never a bot token. Linking flow: `POST /user/telegram/initlink` generates a 4-digit code → user DMs `@EbP_Tracker_bot` with `/start` or the code → `POST /telegram/webhook` (public, Telegram-called) resolves the code to a `user_id` and writes `chat_id`+`verified=1` → frontend polls `POST /user/telegram/verify` every 3s until it sees `verified=1`.

### Exact Telegram message format, per alert type

**EBP** (`worker/src/ebp-worker.js`, `formatEBPAlert`):
```
{🟢|🔴} <b>{BULLISH|BEARISH} EBP — {SYMBOL}</b>
⏱ Timeframe: {tf}
🕐 Candle: {NY time}
📊 Trend: {trendBias} ({htf bias label}) {✅|⚠️ No Trend Filter}
━━━━━━━━━━━━━━
{Low swept|High swept}: {sweptLevel}
{Closed above body|Closed below body}: {closedLevel}
━━━━━━━━━━━━━━{if signalId: newline "🔗 Signal ID: {signalId}"}
<i>EBP Tracker</i>
```

**Sweep** (`sweep-cron.js`, `formatSweepAlert`) — near-identical to EBP but no Signal ID line at all (Sweep alerts never get a Signal ID — see below) and a 3-way align-mark (`✅` aligned / `📊 Price Action` mode / `⚠️ No Trend Filter`):
```
{🟢|🔴} <b>{BULLISH|BEARISH} SWEEP — {SYMBOL}</b>
⏱ Timeframe: {tf}
🕐 Candle: {NY time}
📊 Trend: {trendBias} ({htf bias label}) {✅|📊 Price Action|⚠️ No Trend Filter}
━━━━━━━━━━━━━━
{Low swept|High swept}: {sweptLevel}
Closed inside: {closedInsideLevel}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>
```

**MSS** (`formatMSSAlert`, forex/crypto) — also no Signal ID:
```
{🟢|🔴} <b>{BULLISH|BEARISH} MSS — {SYMBOL}</b>
⏱ Timeframe: {tf}
🕐 Candle: {NY time}
📊 Trend: {htfBias} ({htf label}) {✅|⚠️}
━━━━━━━━━━━━━━
{Swing high reclaimed|Swing low reclaimed}: {level}
━━━━━━━━━━━━━━
<i>EBP Tracker</i>
```

**T3** (`formatT3Alert`, all 3 steps use the same template, `step` and price vary):
```
🎯 T3 Chain — {SYMBOL}
Step: S{n} of 3
HTF: {htf} EBP → LTF: {ltf} Sweep → LTF: {ltf} MSS
Direction: {🟢|🔴} {BULL|BEAR}
Session: {session}
Price: {price}
Signal ID: {signalId}/S{n}
```

**T1 / T2 / T4** (`formatFvgEntryAlert`, completion only — no Step-1 alert is sent for these three, unlike T3):
```
🎯 {T1|T2|T4} Signal — {SYMBOL}
{HTF: {htf} EBP → LTF: {ltf} FVG Entry             [T1]
 HTF: {htf} EBP → LTF: {ltf} Retracement FVG        [T2]
 LTF: {ltf} Sweep → FVG Entry                       [T4]}
Direction: {🟢|🔴} {BULL|BEAR}
FVG Zone: {bottom} – {top}
Price: {price}
Signal ID: {signalId}
```

**NSE EBP / Sweep / MSS** (`nse-cron.js`, `formatNseEBPAlert`/`formatNseSweepAlert`/`formatNseMSSAlert`) — same visual structure as their forex/crypto counterparts but IST instead of NY time, and — unlike forex/crypto Sweep/MSS — **always** include a Signal ID line (NSE generates a signal ID for every EBP/Sweep/MSS fire, forex/crypto only does so for EBP):
```
{🟢|🔴} <b>{BULLISH|BEARISH} {EBP|SWEEP|MSS} — {SYMBOL}</b>
⏱ Timeframe: {tf}
🕐 Candle: {IST time}
📊 Trend: {trendBias}{ (biasTF bias)} {✅|⚠️ No Trend Filter|blank if neutral}
━━━━━━━━━━━━━━
{type-specific level line(s)}
━━━━━━━━━━━━━━
🔗 Signal ID: {signalId}
EBP Tracker
```

**TDI** (`formatTdiAlert`) — no Signal ID at all (TDI/SMA never write to the `signals` table, only `alert_history`):
```
{🟢|🔴} <b>{BUY|SELL} — {SYMBOL}</b>
⏱ Timeframe: {tf}
🕐 Candle: {IST time}
━━━━━━━━━━━━━━
TDI: RSI exhaustion at {lower|upper} band
Divergence: Price {LL, RSI HL|HH, RSI LH} confirmed
Momentum: Red crossed Yellow {↑|↓}
MSS: {Swing high reclaimed|Swing low broken}: {level}
{if equity: 📦 Volume: {ratio}× average}
{if SMA context available: 📊 SMA Context: ...}
━━━━━━━━━━━━━━
EBP Tracker
```

**SMA Cloud** — three distinct alert shapes, also no Signal ID:
- **Type 1 (trend initiation)**: `SMA Cloud: {Bullish markup|Bearish distribution} — {Sharp⚡|Gradual📉}`, SMA1/SMA9/HTF-SMA9 values, bias line, optional volume line.
- **Type 2 (cloud rejection re-entry)**: `SMA Cloud: {Bullish|Bearish} re-entry`, `Rejected from {cloud top|cloud bottom}: {value}`, `Close strength: {pct}% — strong ✅`, bias line.
- **Exhaustion**: `⚠️ {SYMBOL} — SMA Trend Exhausting` (shortest format, timeframe + candle time only, no direction/bias/level detail).

**Watchdog**: documented but not implemented — no Telegram format exists because Watchdog never sends a Telegram message (see above).

### Alert deduplication
Two independent mechanisms, applied at different layers:
1. **Telegram-alert dedup** (`isDuplicateAlert`, in both `ebp-worker.js` and `sweep-cron.js` — ⚠️ **correction**: `nse-cron.js` has no equivalent function at all, confirmed via grep during the 2026-08-06 cleanup session; NSE alert delivery (`tryDeliverNseAlert`/`deliverNseIndicatorAlert`) writes to `alert_history` but performs no dedup check before sending, unlike forex/crypto) — before sending, checks `alert_history WHERE user_id=? AND symbol=? AND timeframe=? AND direction=? AND alert_type=? AND fired_at > cutoff`, where `cutoff = now - ALERT_INTERVAL_MS[tf]` (one full TF interval per alert type — e.g. a 1H EBP alert can't re-fire for the same symbol+direction within 1 hour). ⚠️ **Bug risk resolved 2026-08-06** (migration 013): `fired_at` is now TEXT ISO 8601, matching `signals.fired_at`'s format — the previous INTEGER/TEXT type-mismatch landmine (where a future format change could make the `>` comparison silently always-false) no longer applies, since both tables now agree on format. All 9 `alert_history` INSERT sites across the three workers and both `isDuplicateAlert` cutoff computations were updated in lockstep with the migration.
2. **Chain-creation dedup** (Phase 3 templates) — T3's chain creation is implicitly protected by inheriting the *EBP alert's own* dedup check (chain creation code runs strictly after the `if (isDuplicateAlert) continue;` guard in the same loop iteration). T1/T2 inherit the same protection (same loop). ⚠️ **T4's weaker guard fixed 2026-08-06**: previously just checked whether an `awaiting_fvg_entry` chain already existed (no time-window, so a repeat sweep shortly *after* a chain completed could spawn a duplicate). Now queries `chain_state` for any T4 chain — any state, including `complete` — for that `user_id`+`symbol`+`direction` created within the template's own `window_mins` (defaults to 60), matching `isDuplicateAlert`'s "did one fire recently" intent rather than just "is one still pending."

### Signal ID system
`signal_counters(template TEXT PK, series TEXT DEFAULT 'A', count INTEGER DEFAULT 0)` — one row per template key. Format: `` `{TEMPLATE}-{SYMBOL_NO_SLASH_UPPERCASE}-{series}{count:03d}` ``, e.g. `T3-XAUUSD-A001`, except EBP's generator which embeds the TF too: `EBP-{SYMBOL}-{tf}{series}{count:03d}` (e.g. `EBP-XAUUSD-4HA007`). Counter is global per template (shared across all symbols), not per-symbol — confirmed by every generator function's `WHERE template=?` lookup having no symbol filter. Rollover: `count > 999` → `series` advances one letter, `count` resets to 1 (26,000 signals per template before `series` exhausts Z999).

| Alert type | Gets a Signal ID? | Where generated |
|---|---|---|
| EBP (forex/crypto) | ✅ | `ebp-worker.js`, once per symbol+TF event (shared across all notified users) |
| Sweep (forex/crypto) | ❌ | n/a — plain Sweep alerts never carry an ID |
| MSS (forex/crypto) | ❌ | n/a |
| T3 | ✅ | Step 1 (`ebp-worker.js`), carried through Steps 2/3 unchanged |
| T1 / T2 / T4 | ✅ | Only at chain completion (`sweep-cron.js`) — no ID exists during the pending state |
| NSE EBP / Sweep / MSS | ✅ | Every fire, via `generateNseSignalId` — one shared `'NSE'` counter row across all three alert types and all NSE symbols |
| TDI / SMA Cloud | ❌ | n/a — never written to `signals`, only `alert_history` |

---

## Section 6 — Frontend

**Stack**: React 18 + Vite, `react-router-dom` v6, `@clerk/clerk-react`, `recharts` (Market Breadth only), `xlsx` (Alerts export only). ⚠️ **DIVERGENCE**: `README.md` claims "React + Vite + MUI" — there is no MUI dependency anywhere in `package.json` and zero `@mui` imports in `src/`; all styling is hand-rolled CSS (`src/styles/tokens.css`, `global.css`).

### Page inventory (`src/App.jsx`)
| Path | Component | Guard | Purpose |
|---|---|---|---|
| `/` | `LandingRoute` → `Landing` | Redirects to `/dashboard` if already signed in (Clerk `useUser`) | Marketing/sign-in page |
| `/invite/:token` | `LandingRoute` → `Landing` | Same | Same landing page, displays the invite token param (no dedicated API call) |
| `/dashboard` | `Layout` → `Dashboard` | `ProtectedRoute` (Clerk `SignedIn`/`SignedOut`) | Asset overview (DXY + Forex/Crypto + NSE) |
| `/assets` | `Layout` → `Assets` | `ProtectedRoute` | Asset picker with slot-limit enforcement |
| `/alerts` | `Layout` → `Alerts` | `ProtectedRoute` | Alert history + Excel export |
| `/settings` | `Layout` → `Settings` | `ProtectedRoute` | Account info + Telegram linking |
| `/admin` | `Layout` → `Admin` | `ProtectedRoute` at router level + **in-component** `is_admin===1` check (renders "Access Denied" otherwise) | Users, invite tokens, API keys, limits, price feed test |
| `/market` | `Layout` → `MarketBreathPage` | `ProtectedRoute` only — no admin check, just hidden from the nav sidebar for non-admins | Currency strength dashboard (correlation table and 48h history chart removed — see below) |
| `*` | `NotFound` | none | 404 |

⚠️ **Status changed since 2026-08-02, finding superseded**: this report originally flagged `/market`'s missing frontend admin check as lower-risk because the backend `/market/breadth` route was itself admin-gated, so a non-admin would see only an empty shell. **That backend gate has since been removed** (commit message: "open Market Breadth access") — `/market/breadth` now only requires a valid Clerk JWT (Section 2/3). The access-control gap is now more significant than originally described: any signed-in user navigating to `/market` sees the page render **with real data**, not just an empty shell — Market Breadth access is now effectively open to all authenticated users by design, not a partial gap.

### Per-page API calls (method, path, auth)
- **Dashboard**: `GET /user/assets/count` (token); `GET /nse/status` (no token, public).
- **Assets**: `GET /user/assets/count`; asset add/remove via `useAssets()`'s `POST /user/assets` / `DELETE /user/assets/:id`.
- **Alerts**: `GET /alerts/history?...`; `GET /alerts/export...` (client builds an `.xlsx` via the `xlsx` package).
- **Settings**: `GET /user/telegram`; `POST /user/telegram/verify` (polled every 3s while linking); `POST /user/telegram/initlink`; `POST /user/telegram/test`; `DELETE /user/telegram`.
- **Admin** (heaviest page, 549 lines): `GET /user/me`, `/admin/users`, `/admin/tokens`, `/admin/api-keys`; `POST /admin/invite`, `/admin/expire/:userId`, `/admin/api-keys` (both generic keys and the Upstox token, same route, `source` field differs); `PATCH /admin/api-keys/:id`, `/admin/users/:userId/asset-limit`, `/admin/users/:userId/tf-access`, `/admin/users/:userId/nse-tf-access`; `DELETE /admin/api-keys/:id`; `GET /admin/users/:userId/assets`, `/tf-access`, `/nse-tf-access`.
- **MarketBreathPage**: `GET /market/breadth`, polled every 60s.

### Hook inventory (`src/hooks/`, only 2 files exist)
- **`useAssets.js`**: `{ assets, loading, error, addAsset, removeAsset, refetch, lastUpdated }`. Fetches `GET /user/assets` once on mount/auth-state change (no polling). `addAsset`/`removeAsset` call the respective REST routes then refetch.
- **`useUser.js`**: `{ user, loading, error, refetch }`. Fetches `GET /user/me`, **polls every 120s** (`setInterval`) "to pick up plan changes" per inline comment — the only polling hook in the app.

### Component inventory (`src/components/`, 16 files — was 11/12 as of 2026-08-02; ⚠️ this whole subsection rewritten 2026-08-06)
| Component | Purpose |
|---|---|
| `AIAlertsPanel.jsx` | T1-T4 template config UI — rewritten since 2026-08-02 to render a `TemplateCard` per template instead of a flat checkbox list (full detail below) |
| `ApiErrorAlert.jsx` | Trivial error banner + optional Retry button |
| `AssetCard.jsx` | Per-asset dashboard card. **Own 60s polling removed** since 2026-08-02 (now fetches once on mount only — `AssetCard`'s config summary no longer self-polls; only `MarketBreathPage.jsx`, `Layout.jsx`'s health timestamp, and `useUser.js` still poll). Also now fetches chain-state and FVG-zone data and renders `ChainProgressBar`/`FVGZoneIndicator`; the standalone Bias Overrides section is gated `!isNse` (so DXY, `asset_type='system'`, keeps it, matching pre-existing behavior) rather than `isForex`, specifically to avoid regressing DXY when the panel was generalized for NSE. |
| `BiasOverridePanel.jsx` | Bias-override select rows — now asset-type-aware: forex/crypto/commodity gets `['W','D','4H','1H']` (unchanged), NSE gets its own set `['D','1H','M30','M15']` (new) |
| `ChainProgressBar.jsx` — **new** | Pure display, no API calls. Renders per-template step-dot progress (2 steps for T1/T2/T4, 3 for T3) driven by `chain_state.state`, given a `chain` row (or null → "No active chain") |
| `EBPConfigPanel.jsx` | EBP alert-TF CRUD per asset, filters TF options by `allowedTfs`. Now also renders the effective bias (override vs. live market bias, visually distinguished) rather than just the raw `bias_cache` value |
| `ExpiryBanner.jsx` | Expiry warning (≤7 days) / error (≤2 days) banner; "Renew" button links to a nonexistent `/upgrade` route (dead link) |
| `ForexSmaConfigPanel.jsx` — **new** | Forex/crypto SMA Cloud config CRUD (`/user/forex-indicator-configs/*`) — the forex/crypto counterpart to `SmaConfigPanel.jsx`, added alongside the new Forex/Crypto SMA Cloud backend feature (Section 8) |
| `FVGZoneIndicator.jsx` — **new** | Pure display, no API calls. Read-only table of active/mitigated FVG zones for an asset (from the new `/user/fvg-zones/:assetId` route) |
| `Layout.jsx` | App shell — topbar (health datasource timestamp, polled 60s), sidebar nav (Market/Admin links only for `is_admin===1`), `ExpiryBanner`, page children |
| `NseSearchModal.jsx` | Debounced (400ms) NSE symbol search modal |
| `PriceFeedPanel.jsx` | Admin-only diagnostic tool — connects **directly from the browser** to Twelve Data's WebSocket using a manually pasted API key, bypassing the worker entirely |
| `SmaConfigPanel.jsx` | NSE SMA Cloud config CRUD — `stack_mode` param renamed `confirmation_mode` (Section 3), TF options now correctly include `M30` (previously missing from the UI despite the backend supporting it) |
| `SweepConfigPanel.jsx` | Structurally identical to `EBPConfigPanel.jsx`, for Sweep configs — same effective-bias display upgrade |
| `TdiConfigPanel.jsx` | NSE TDI config CRUD — now actually filters by `allowedTfs`/`nse_tf_access` (previously didn't, a gap the 2026-08-02 audit flagged) |
| `TemplateCard.jsx` — **new** | Full per-template card for `AIAlertsPanel.jsx`: enable toggle, HTF/LTF selects, `bias_gate`/`fvg_rule` (T1/T2/T4)/`step3_enabled`+`window_mins` (T3) controls — the three `user_templates` columns the 2026-08-02 audit found dead in the UI (Section 3) are now fully wired here — plus an embedded `ChainProgressBar` |

### Auth flow
`main.jsx` wraps the app in `ClerkProvider publishableKey={VITE_CLERK_PUBLISHABLE_KEY || 'pk_test_placeholder'}` (silent fallback to a placeholder key on misconfiguration, rather than a loud error). `isLoaded`/`isSignedIn` gate every data-fetching hook and the router's `LandingRoute`/`ProtectedRoute`. **Admin detection is entirely app-level, not Clerk-level**: `Admin.jsx` fetches `GET /user/me` and checks `me.is_admin === 1`; `Layout.jsx` does the same to decide whether to render the Market/Admin nav links.

### Subscription / tier system — what's actually enforced
There is **no generic tier-gating framework**. The only real enforcement mechanism is a hardcoded **forex/crypto asset-slot limit** (`user.asset_limit`, default 5 at the app-INSERT level — see Section 3's note on the live column default drifting to 3), computed server-side and enforced client-side by disabling/locking unowned asset checkboxes once `forex_crypto_count >= forex_crypto_limit`:
```jsx
const limitReached = assetCount.forex_crypto_count >= assetCount.forex_crypto_limit;
const isLocked = limitReached && !isOwned;
```
NSE assets are explicitly **unlimited** (`nse_limit: 'unlimited'`), DXY is exempt from the slot count entirely (`asset_type==='system'`). `user.plan` (a free-text string) is read only for **display** — `Layout.jsx`'s account dropdown ("Free · N days left") and one dead prop-pass (`Dashboard.jsx` passes `tier={user?.plan}` into `AssetCard`, which never destructures or reads it). The real per-user gating axis that actually restricts *feature access* (not just asset count) is **timeframe access** (`user_tf_access`/`nse_tf_access`, admin-set JSON arrays), which filter the selectable-TF option lists inside `EBPConfigPanel`/`SweepConfigPanel`. Payment is manual/out-of-band — a static "Pay $30.00 to unlock more assets" banner with no checkout flow, plus a UPI QR code image asset (`public/upi-qr.png`) referenced nowhere in the render tree found — the payment story is entirely outside this codebase (manual verification, per README).

Account-level (not tier-level) expiry: `user.active`/`user.expires_at` drive a full-screen "Plan Expired" overlay on `Dashboard.jsx` when `active===0`, and `ExpiryBanner.jsx`'s warning/error banner in the final 7/2 days.

### `AIAlertsPanel.jsx` in detail (⚠️ rewritten since 2026-08-02 — the below describes the current implementation, not the flat-list version the original audit found)
`TEMPLATES` is still a static 4-entry array (`t1`-`t4`, labels, descriptions), but each now renders as a `TemplateCard` rather than a checkbox + inline sub-row. `AIAlertsPanel` itself just fetches `GET /user/templates/${assetId}` on mount/assetId-change and hands each template's row (or `null`) plus a matching `chain_state` row (passed down from `AssetCard`'s own chain-state fetch, matched via `c.template_type === tmpl.key.toUpperCase()`) to its `TemplateCard`. All mutation logic now lives in `TemplateCard.jsx`:
- **Create** (toggle on, no existing row): `POST /user/templates/${assetId}` — still a hardcoded default payload (`htf:'4H'`, `ltf:'M15'`, `window_mins:60`), same "create then edit" pattern as before.
- **Toggle enable/disable**: `PATCH /user/template/${id}` with `{enabled}`.
- **HTF/LTF edits**: same pairing logic as before — an HTF change re-sends a recomputed valid LTF alongside it via `templateLtfOptions()`, since the backend's `PATCH` only validates `LTF < HTF` when both are present in the same request body; a lone HTF-only patch wouldn't be checked against the row's existing LTF.
- **`bias_gate`/`fvg_rule`/`step3_enabled`/`window_mins`** — ⚠️ **now live**, closing the exact gap the 2026-08-02 audit flagged (Section 3: "dead columns... no cron code anywhere reads them"). `TemplateCard` renders a Bias Gate select (all templates), an FVG Rule select (T1/T2/T4 only — `50_percent`/`any_touch`/`full_fill`), and Step 3 Enabled + Window (minutes) controls (T3 only), each `PATCH`ing its own field independently. The backend now genuinely reads and applies all three (Section 3/4/8): `bias_gate` gates T4's Step-1 trigger and T3's Step-3 MSS check; `fvg_rule` drives a per-template FVG-mitigation rule in `checkFvgEntryChain` (T1/T2/T4 completion); `step3_enabled` lets a user run T3 as a 2-step EBP+Sweep chain instead of the full 3-step EBP+Sweep+MSS chain.
- Each `TemplateCard` also renders a `ChainProgressBar` for its matched `chain_state` row.
A "Saved ✓" flash (1.5s `setTimeout`) confirms writes, same UX as before.

### `MarketBreathPage.jsx` in detail (added 2026-08-06, not present in the 2026-08-02 audit)
Three chart sections plus a header timestamp, all driven by a single `GET /market/breadth` response polled every 60s (`setInterval`, unchanged):
- **Intraday Strength** — horizontal `recharts` `BarChart` of the latest hourly snapshot's cumulative per-currency strength (session-scoped from NY 5:00 PM, via a hand-rolled NY-offset/DST helper duplicated in this file rather than imported from anywhere shared). Bar value labels hug the zero axis, on the side opposite the bar's own direction — positive bars (extend right) get their label just left of zero, negative bars (extend left) get theirs just right of zero. Implemented via a shared `makeStrengthLabel(opacity, fontWeight)` factory returning a Recharts `<LabelList content={...}>` renderer, applied as `makeStrengthLabel(1, 600)`. This required reading Recharts 3.8.1's own source (`Bar.js`/`getBaseValueOfBar`) to confirm the geometry: `x` is always the zero-axis pixel regardless of bar sign, and `width` is signed — two earlier attempts at this same fix, based on plausible-but-wrong assumptions about which of `x`/`x+width` represents the zero line for a negative bar, shipped and had to be corrected.
- **Daily Strength** — Today vs Yesterday bars per currency, same zero-hugging label treatment (`makeStrengthLabel(1, 600)` for Today, `makeStrengthLabel(0.5, 400)` for Yesterday — reduced opacity/weight so it reads as secondary). The Today bar also still carries its pre-existing `<DeltaLabel />` (Δ vs. yesterday, a separate custom label unrelated to `makeStrengthLabel`) — so it currently shows two overlapping labels; not yet reconciled.
- **Weekly Strength** — still a static placeholder, never fetches or renders real data (see Section 3's `market_breadth_cache` entry for why: the backend now computes a `tf='1W'` row, but the API and this component were never updated to surface it).
- **Removed since 2026-08-02**: the Pearson correlation table and the 48h strength-history line chart (`LineChart`/`CartesianGrid`/`Legend` imports removed entirely; `correlation` is still present in the API response but no longer read anywhere in the component).
- Header "Updated …" timestamp now renders in `America/New_York` time (labelled "NY"), not UTC.
- No admin gate at the frontend level (unchanged from 2026-08-02) — see the access-control note above for how the backend side of this changed.

---

## Section 7 — Subscription & User Management

### Tier definitions (from actual code/DB — no separate tier docs are authoritative)
There is effectively **one implicit tier** (all signed-up users), differentiated only by two independently-set numeric/list fields on `users`, both admin-editable per-user rather than derived from any named plan:
- `asset_limit` (INTEGER, default 5 at app-insert time, live column default 3 — see Section 3) — caps forex/crypto asset count only; NSE is always unlimited.
- `user_tf_access` / `nse_tf_access` (JSON arrays) — cap which timeframes a user can configure alerts on, independently for forex/crypto vs NSE.
`plan` (TEXT, default `'free'`) exists on `users` but — confirmed in Section 6 — is never read anywhere to branch behavior; it is purely a display label. ⚠️ **DIVERGENCE**: `EBP_Tracker_Roadmap.md`'s "Closed Decisions" table states "Tier model | Dropped. Flat model: 5 forex/crypto slots, unlimited NSE. Closed." — this matches the code exactly (confirms the roadmap is accurate on this specific point, not a contradiction, but worth citing since it explains *why* `plan` is vestigial rather than a bug).

### Admin panel — every action available, role detection
Role detection: **not** a Clerk role/metadata field — a plain `users.is_admin` INTEGER column, checked via `GET /user/me` both client-side (`Admin.jsx`, `Layout.jsx`) and server-side (`requireAdmin()` gate on every `/admin/*` route, so the client-side check is UX-only, not the real security boundary).

Admin actions (all from `Admin.jsx`'s 5 tabs, all backed by real routes in `worker/src/ebp-worker.js`):
1. **Users tab**: view all users (assets, alert configs, Telegram status); expand a user to see their assets and per-TF access checkboxes (forex/crypto and NSE, independently); grant `+3 Slots` (asset-limit bump); toggle per-TF access; "Expire Account" (soft-deactivate, `active=0`).
2. **Invite Tokens tab**: generate a new invite token; list all tokens with used/unused status.
3. **API Keys tab**: a dedicated "Upstox Analytics Token" card (single-slot, `source='upstox'`, shows an expiry countdown) plus a generic multi-key list (Twelve Data keys) with per-key enable/disable, delete, add-new-key form, and live usage/credit progress bars (sourced from `api_key_state`).
4. **User Limits tab**: per-user numeric asset-limit editor (duplicate UI surface for the same action as the Users tab's "+3 Slots" button, via a different route pattern).
5. **Price Feed tab**: renders `PriceFeedPanel` — the direct-to-browser Twelve Data WebSocket diagnostic tool (Section 6).

No self-service downgrade/upgrade exists anywhere — every limit change is admin-initiated via the panel above; there is no automated tier-transition logic anywhere in the codebase.

---

## Section 8 — NSE Module

### NSE Worker — entry file, routes, cron
`nse-worker/src/index.js` (62 lines): `GET /health` (public), `POST /cron/nse` (X-Cron-Secret; `tf` from JSON body or `?tf=` query fallback). No native Cloudflare cron trigger — `nse-worker/wrangler.toml` has no `[triggers]` block; scheduling is 100% cron-job.org, one job per TF in `NSE_VALID_TFS`.

### NSE data source — what's actually wired
**Upstox (conditional) → Yahoo Finance (fallback)**, gated purely on whether an enabled `api_keys` row with `source='upstox'` exists:
```js
async function fetchNseCandles(symbol, tf, env) {
  const upstoxKey = await env.DB.prepare(
    "SELECT key_value FROM api_keys WHERE source='upstox' AND enabled=1 LIMIT 1"
  ).first();
  if (upstoxKey) {
    try {
      const raw = await fetchUpstoxNse(symbol, tf, upstoxKey.key_value);
      const candles = raw ? getClosedCandles(raw, INTERVAL_MS[tf]) : null;
      if (candles && candles.length >= 3) return candles;
    } catch (e) { /* fall through to Yahoo */ }
  }
  try { return getClosedCandles(await fetchYahooFinanceNse(symbol, tf), INTERVAL_MS[tf]); }
  catch (e) { return null; }
}
```
No seed row exists for `source='upstox'` in any migration — an admin must paste it via the "Upstox Analytics Token" card in `Admin.jsx` (`POST /admin/api-keys`, `source:'upstox'`). Until that happens, **the entire NSE pipeline (EBP/Sweep/MSS/TDI/SMA) silently runs on Yahoo Finance only, forever**, with the only visible signal being the public `GET /nse/status` badge ("~15 min delayed") — no error is ever surfaced to an admin that Upstox isn't configured. Yahoo itself is an undocumented free endpoint scraped with a spoofed `User-Agent: Mozilla/5.0` header and no auth — the more fragile of the two paths, and the default one.

### NSE symbol list — storage and search
Stored in the shared `user_assets` table with `asset_type='nse'` (no dedicated NSE-symbols table, no `CHECK` constraint on `asset_type`). Search: `GET /nse/search` lives in **`worker/src/ebp-worker.js`, not `nse-worker`** — fans out to Upstox `instruments/search` (equities, returns `[]` silently if no token configured) and Yahoo `finance/search` (indices, always works) in parallel via `Promise.allSettled`.

### NSE TF constraints
`NSE_VALID_TFS = ['M1','M5','M15','M30','1H','D']` (`nse-cron.js`), enforced at cron entry. `worker/src/ebp-worker.js` independently maintains its own identical literal, `ALL_NSE_TF_ACCESS = ['M1','M5','M15','M30','1H','D']` — two hand-copied arrays with no shared constant, so drift is still structurally possible, but as of 2026-08-06 each declaration carries a sync-notice comment pointing at the other (Section 9). Per-user override: `users.nse_tf_access` (JSON, default all 6), separate column from forex/crypto's `user_tf_access`, admin-editable via `GET/PATCH /admin/users/:id/nse-tf-access`. FVG detection further narrows to `['M5','M15','1H']` only, enforced inline in `handleNseCron` (not in the shared TF-list constants).

### NSE signal detection differences vs forex/crypto
`detectEBP`/`detectSweep`/`detectMSS` and the FVG engine are **byte-for-byte identical** to the forex/crypto copies — no NSE-specific threshold tuning anywhere. The only NSE-specific *detection* logic is two indicators with zero forex/crypto equivalent:

**TDI (Traders Dynamic Index)** — 4-condition gate, State-1-pending-chain pattern (`nse_indicator_chain`, expires after 4 candles):
1. RSI(13) exhaustion at a Bollinger Band(34, 1.6185) computed *on the RSI series itself*: `cond1Bull = redNow <= bbLowerNow` (red = SMA(2) of RSI).
2. Divergence (`checkTdiDivergence`) — current RSI/price vs a reference extreme sourced from the live `nse_swing_states.pending_swing_high/low` for the opposite-direction run, falling back to a 20-candle lookback extreme if unavailable.
3. Momentum crossover: Red SMA(2) crossing Yellow SMA(7) of RSI.
4. (checked on later cron cycles against the pending chain) MSS confirmation (`close` beyond `last_confirmed_swing_high/low`) **plus** a volume gate (1.5× 20-candle average volume) — skipped entirely for index symbols.

**SMA Cloud** — ⚠️ **Fully rewritten since 2026-08-02; the old `accumulation`→`transition`→`distribution`→`exhaustion` four-phase machine described in the original audit no longer exists.** The cloud itself is unchanged (gap between SMA1 = raw close and SMA9 = 9-period SMA, both on the native/signal timeframe; a user-configurable HTF SMA9 is now purely a bias reference, not part of the cloud), but the phase machine is now a **two-phase** design (`accumulation`/`distribution` only), persisted per `(symbol, timeframe)` in `nse_sma_state`:
```js
const isDistributing = trendDirection !== null
  && separationNow > (atr14 * 0.15)     // SMA_SEPARATION_THRESHOLD
  && crossover3 === 0;                  // no SMA1×SMA9 crossover in the last 3 candles
const isExhausting = prevPhase === 'distribution'
  && (separationNow < (atr14 * 0.15) || crossover3 >= 1);
```
Three signal types fire off phase-edge transitions, all independently gated:
- **Type 1 (trend initiation)** — fires once on the accumulation→distribution edge (`justEnteredDistribution`). Gates: separation threshold, the same dual-mode bias gate below, an active same-direction FVG zone, and (non-index symbols only) a 1.5×-of-20-candle-average volume check.
- **Type 2 (cloud rejection re-entry)** — a genuinely new two-step **arm/confirm chain**, not a single-shot condition check like Type 1: a rejection wick into the cloud of at least `atr14 * 0.10` (`SMA_WICK_PENETRATION`) that closes back outside arms a `cisd_watch_*` state on the row (`cisd_watch_active`, `_direction`, `_pullback_start`, `_armed_at`); a *later* cron tick then checks for **MSS** (close beyond the last confirmed swing high/low) **or CISD** (close beyond the open of the pullback run's first candle) confirmation, per a user-configurable `confirmation_mode` (`'mss'`/`'cisd'`/`'either'`, on `nse_indicator_configs`/`forex_indicator_configs` — renamed from the old `stack_mode` column). The watch auto-expires (1h for `M5`/forex `M15`/`M30`, 24h for `M15`/`M30`/forex `1H`/`4H`) or is invalidated by a bias flip. Independent of Type 1 within the same distribution run — both can fire in one run if their conditions land together.
- **Exhaustion** — fires on the distribution→accumulation edge, no additional gates, disarms any active CISD watch, and precludes a Type 1/Type 2 firing on that same tick.

Bias gate is now dual-mode (`bias_mode` column: `'ttrades'` = HTF TTrades closure bias with an HTF-SMA fallback if the `bias_cache` row is missing; `'htf_sma'` = close vs. HTF SMA9 directly; `'none'` = same-timeframe TTrades bias) — all three fail open (pass) if their required data isn't available yet, rather than blocking signals on a cold cache.

⚠️ **No longer NSE-exclusive.** A near-identical **Forex/Crypto SMA Cloud** shipped in a later session, in Sweep Worker (`sweep-cron.js`, `handleForexSmaCron`, new `POST /cron/sma` route, own cron-job.org schedule per TF) rather than NSE Worker. Same two-phase machine, same three signal types, same threshold constants (`FOREX_SMA_SEPARATION_THRESHOLD`/`_VELOCITY_THRESHOLD`/`_WICK_PENETRATION` — all identical values to NSE's), same dual-mode bias gate and MSS/CISD confirmation chain — confirmed via direct code comparison, not just a self-reported design intent. Concrete differences from the NSE version: reads the shared `fvg_zones`/`swing_states` tables (not `nse_`-prefixed), state lives in its own `forex_sma_state` table (same shape as `nse_sma_state` plus `distribution_started_at`), timestamps in Telegram messages are NY time (`America/New_York`) rather than IST, **no volume gate at all** (forex/crypto has no reliable OTC volume data, so Type 1 skips that check entirely rather than approximating it), and `htf_timeframe` is always explicit per-config (validated against `FOREX_SMA_HTF_OPTIONS` at creation, e.g. `M15`→`4H` only, `1H`→`4H` or `D`) rather than falling back to a hardcoded default pairing map the way NSE's `SMA_HTF_PAIRING` does. Config CRUD lives on the EBP Worker (`/user/forex-indicator-configs/*`, Section 2), cron logic on Sweep Worker — the same worker-split pattern as NSE's indicator configs (EBP Worker owns the routes, NSE Worker owns the cron).

TDI remains 100% NSE-exclusive (no forex/crypto counterpart). SMA Cloud is the one indicator now shared, in near-identical form, across both markets. NSE still has **no T1-T4 template chain machinery** — that asymmetry (forex/crypto gets multi-step EBP chains, NSE gets these indicator-style detectors) is unchanged, just no longer also true of SMA Cloud's *availability*, only of NSE lacking chains.

### NSE alert delivery
Same shared bot/infrastructure as forex/crypto — `SHARED_BOT_TOKEN`, resolved via the same `user_telegram` table, no NSE-specific bot or linkage mechanism. Two delivery paths inside `nse-cron.js`: `tryDeliverNseAlert` (EBP/Sweep/MSS) and `deliverNseIndicatorAlert` (TDI/SMA), both gated on `nse_tf_access` and a verified Telegram chat.

### What works today vs infrastructure-only
**Fully wired end-to-end** (fetch → detect → deliver, actively exercised): EBP/Sweep/MSS on NSE (`swing_states`/`fvg_zones` row counts confirm forex/crypto side is live, but see below), TDI, SMA Cloud, the Upstox admin token flow, `/nse/search`.

⚠️ **Status changed since 2026-08-02**: the original audit found `nse_fvg_zones` and `nse_swing_states` both empty (0 rows) — untested on live NSE data. As of 2026-08-06, both have real rows: `nse_fvg_zones` = **5 rows**, `nse_swing_states` = **3 rows** (still far behind forex/crypto's `fvg_zones`/`swing_states` at **287**/**29** rows, reflecting NSE's narrower FVG-eligible TF set (M5/M15/1H only) and limited market-hours window, not a code gap — but no longer "never populated").

**Documented but incomplete/dead**, per in-code comments (not this audit's own inference): `nse_indicator_configs.day_filter` ("unused since the SMA Cloud corrective patch"), `user_indicator_settings.sma_forex_hours` ("not yet read by any Worker"), `fetchAndCacheNSECandles()` (dead wrapper, "kept for any standalone/manual-test call path" — confirmed as one of the 3 genuinely-dead top-level functions in `nse-cron.js`, Section 9).

---

## Section 9 — Known Issues & Technical Debt

### Cleanup applied 2026-08-06
Migration 013 applied (`alert_history.fired_at` INTEGER→TEXT ISO 8601; caught
and fixed a format bug in the migration itself — `datetime()` produces
space-separated non-ISO output, not `strftime('%Y-%m-%dT%H:%M:%fZ',...)`'s
proper ISO output — before it could affect dedup comparisons; `%f` support
in D1's SQLite build independently confirmed live). T4 chain dedup
strengthened to a time-window guard. `NSE_VALID_TFS`/`ALL_NSE_TF_ACCESS`
given sync-notice comments (see below — duplication itself is structural,
not removable). `watchdog_log` errors/warnings now delivered via Telegram
through `POST /health/watchdog-check`. `schema.sql` reconciled with live D1
(4 divergences fixed, Section 3). `README.md` rewritten for the current
4-worker architecture. 3 superseded audit `.md` files deleted from the repo
root. Confirmed already resolved before this session (commit `c7e4b8b`,
not this one — verified via fresh checks rather than assumed): the 7 "dead
functions," `packages/core/`, and 9 "dead secrets" originally flagged in
the 2026-08-02 audit (Section 1).

### TODO/FIXME/HACK/XXX comments
Zero matches — unchanged finding. Known-incomplete items are documented as ordinary prose comments, not tagged markers.

### NSE_VALID_TFS duplication
`NSE_VALID_TFS` in `nse-cron.js` and `ALL_NSE_TF_ACCESS` in `ebp-worker.js` remain two independently-maintained copies (no shared import possible across Cloudflare Workers). Both are identical and, as of 2026-08-06, both carry a sync-notice comment ("if you change one, change the other in the same commit"). Risk is mitigated, not eliminated — any future edit to the NSE TF set must still touch both files by hand.

### Hardcoded values
- `ALLOWED_ORIGINS` duplicated in `ebp-worker.js` and `sweep-worker/src/index.js` — a staging domain requires editing both.
- `MAJOR_PAIRS` duplicated between Watchdog and EBP Worker — deliberate, documented in-code.
- `CHUNK_SIZE = 7` and `NY_4H_BOUNDARIES` are magic numbers — require a code deploy to change.
- cron-job.org's schedule lives outside the repo — not reconstructable from source alone.

### Remaining silent failure risks
- Watchdog Yahoo fallback failure: if all Twelve Data keys exhaust AND Yahoo fails, a candle simply isn't written — logged to `watchdog_log` (now Telegram-delivered via the 2026-08-06 health check) but there's still no aggregate "N consecutive misses" signal.
- `/nse/search`'s Upstox branch silently returns `[]` when no token is configured — UI-indistinguishable from "no results."
- `GET /health/datasources` has no frontend caller — admin-curl-only.
- `nse-worker`'s `ENVIRONMENT="production"` `[vars]` entry has no code consumer.
- `worker` code: `env.TWELVE_DATA_API_KEY` (singular, no `_1/2/3` suffix) is referenced once, passed into `validateSymbol()`, but that function's `apiKey` parameter is never used inside the function body and no secret by that exact name exists — dead parameter, no functional impact. **Not touched by the 2026-08-06 cleanup** (Section 1's secret cleanup was Cloudflare secrets only, not this in-code reference).
- Frontend: `VITE_SWEEP_WORKER_URL` is still defined in `frontend/.env.local` (confirmed live 2026-08-06 — `.env.example` no longer has it, but `.env.local` does) and still never read anywhere in `src/` — `api.js` only reads `VITE_WORKER_URL`. **Also not touched by the 2026-08-06 cleanup**, despite being adjacent to the secrets that were.
- Clerk JWT verification (`verifyClerkToken`) fetches Clerk's JWKS on every single authenticated request with no caching — not a silent-failure risk, but a real latency/reliability dependency: a slow or briefly-unavailable Clerk JWKS endpoint fails every authenticated route in the app simultaneously, with no cached-key grace period. Unaffected by this cleanup.

### Documented but not implemented
- `user_indicator_settings.sma_forex_hours` — schema only, no read site, no write route, no UI.
- `nse_indicator_configs.day_filter` — schema column, explicitly dead per its own comment.
- `/upgrade` route — `ExpiryBanner.jsx`'s "Renew" button dead-links here (falls through to `NotFound`).
- Weekly Strength UI — backend computes a `tf='1W'` row (`computeWeeklyBreadth`), but `GET /market/breadth` only ever queries `tf='1H'`; `MarketBreathPage.jsx`'s "Weekly Strength" section is still a static placeholder that never fetches it.
- `sma_cloud_states` — orphaned in D1, now properly marked in schema.sql (Section 3). Never read or written by any worker.

### Routes/features described in comments/docs but not implemented
- **Watchdog Telegram alerting** (`@EBP_Watchdog_bot`, per the roadmap's Phase H spec) — a literal bot of that name still doesn't exist, and Watchdog itself still sends zero Telegram messages (`DEVELOPER_TELEGRAM_CHAT_ID` remains configured but dead). ⚠️ **Resolved differently since 2026-08-02**: the underlying need (a human gets told when Watchdog is failing) is now met by an external `POST /health/watchdog-check` heartbeat on the EBP Worker instead — see Section 5's corrected entry and Section 10 below.
- **`user_indicator_settings.sma_forex_hours`** (forex SMA Cloud working-hours gate) — schema-only, no read site, no write route, no UI.
- **`nse_indicator_configs.day_filter`** — schema-only remnant, explicitly dead per its own column comment.
- **`/upgrade` route** — `ExpiryBanner.jsx`'s "Renew" button navigates to `/upgrade`, which doesn't exist in `App.jsx`'s router (falls through to `NotFound`) — a dead link in a user-facing banner.
- **Weekly Market Breadth aggregation** — ⚠️ **Status changed since 2026-08-02, finding partially reversed**: at the time of the original audit, no backend code anywhere computed weekly breadth (all three `market_breadth_*` tables were written exclusively with `tf='1H'`). A later session added `computeWeeklyBreadth()`, which now writes a `tf='1W'` row to `market_breadth_cache`. However `GET /market/breadth` still only ever queries `tf='1H'`, and `MarketBreathPage.jsx`'s "Weekly Strength" section is still a static placeholder that never fetches it (Section 6) — so from a user's perspective the feature is still not implemented, just for a different reason: the gap moved from "backend never computes it" to "computed and stored, but never surfaced through the API or the UI."
- **`README.md`** is broadly stale end-to-end (⚠️ DIVERGENCE, several distinct claims): describes deploying via "worker-bundle-v4.js... Cloudflare dashboard editor" (actual deployment is `npx wrangler deploy` from each worker's own source directory, Section 10); lists 5 native Cloudflare cron triggers on fixed schedules (actual scheduling is the cron-job.org HTTP-trigger architecture described in Section 2, adopted specifically to work around free-tier native-cron limits); claims "MUI" (Section 6); doesn't mention Sweep Worker, NSE Worker, or Watchdog Worker at all — reads as documentation for an earlier, single-worker version of the system that predates most of what's now deployed.

---

## Section 10 — Deployment & Operations

### Deploying each worker (exact commands — confirmed working, used live this session)
```powershell
cd worker;          npx wrangler deploy   # ebp-tracker-worker
cd sweep-worker;     npx wrangler deploy   # sweep-detector
cd nse-worker;       npx wrangler deploy   # nse-tracker
cd watchdog-worker;  npx wrangler deploy   # ebp-watchdog
```
No CI/CD pipeline exists in-repo for the workers (no `.github/workflows/`, no Cloudflare "Workers Builds" GitHub-integration config found) — every deploy is a manual `wrangler deploy` invocation from a developer's machine (or an AI coding assistant's, as in this session). All four share one D1 database, so deploying one worker never requires redeploying the others *unless* the D1 schema itself changed underneath them (see the migration ordering note below).

### Running a migration
```powershell
npx wrangler d1 execute ebp-tracker-db --file=<migration>.sql --remote
```
Must be run from a directory containing a `wrangler.toml` with the `ebp-tracker-db` D1 binding (any of the four worker directories works — they share the same binding). ⚠️ **Deployment-ordering note, established explicitly this session**: when a migration changes tables that live worker code already depends on, deploy the **new code first, then run the migration** — old code hitting dropped/renamed tables mid-deploy is worse than new code briefly erroring against not-yet-migrated tables, since the deploy window is short and scripted back-to-back. This is a judgment call made explicitly during this session's Phase 1-3 migration, not an automated safeguard — nothing in the repo enforces this ordering.

Numbered migrations (`migrations/003` through `migrations/012`) are historical and already applied; `migration_phase1_to_3.sql` (repo root) was applied this session. There is no migration-tracking table (no `schema_migrations` or similar) — whether a given numbered migration has been applied to production is not queryable, only inferable from the live schema matching its expected end-state.

### cron-job.org configuration
Not queryable from this repo — cron-job.org's own dashboard is the source of truth for actual schedules, credentials, and job status; nothing in the codebase mirrors or exports that configuration. Inferred job set, based on what each `/cron/*` route accepts (Section 2):
- `POST https://ebp-tracker-worker.aicube-apps.workers.dev/cron/ebp` — one job per `{tf: "M15"|"1H"|"4H"|"D"|"W"}` (5 jobs), each with header `X-Cron-Secret: <worker's CRON_SECRET>`.
- `POST https://sweep-detector.aicube-apps.workers.dev/cron/sweep` — one job per `{tf: "M15"|"M30"|"1H"|"4H"}` (4 jobs).
- `POST https://nse-tracker.aicube-apps.workers.dev/cron/nse` — one job per `{tf: "M1"|"M5"|"M15"|"M30"|"1H"|"D"}` (6 jobs).
This inference cannot confirm actual cadence (e.g. whether the M15 job really fires every 15 minutes) or whether all inferred jobs are actually configured — only that these are the TF values each route is prepared to accept without erroring.

### Verifying a deployment worked
**Health checks** (all public, no auth):
```
GET https://ebp-tracker-worker.aicube-apps.workers.dev/health
GET https://sweep-detector.aicube-apps.workers.dev/health
GET https://nse-tracker.aicube-apps.workers.dev/health
GET https://<watchdog-worker-url>/health
```
**Manual cron trigger** (requires the real `CRON_SECRET` value — a write-only Cloudflare secret, must be retrieved from wherever it was originally generated/stored, not from `wrangler secret list` which only lists names):
```powershell
curl -X POST https://ebp-tracker-worker.aicube-apps.workers.dev/cron/ebp -H "X-Cron-Secret: <secret>" -H "Content-Type: application/json" -d '{\"tf\":\"1H\"}'
```
The JSON response's `debug` array shows a per-symbol trace of what the cron cycle actually did (candles fetched, FVG/swing/MSS results, sweep detection, skip reasons) — this was used extensively this session to confirm the Phase 1-3 migration's new code paths ran cleanly against real production data immediately after deploy.

**D1 query patterns for verification**:
```powershell
npx wrangler d1 execute ebp-tracker-db --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" --remote
npx wrangler d1 execute ebp-tracker-db --command="PRAGMA table_info(<table>)" --remote
npx wrangler d1 execute ebp-tracker-db --command="SELECT COUNT(*) FROM <table>" --remote
```
`--remote` is required for production; omitting it targets a local Miniflare-backed SQLite emulation under `.wrangler/state/v3/d1` (used this session to dry-run the Phase 1-3 migration safely before touching production — a reusable pattern for validating future migrations: seed a local DB with the pre-migration table shapes, run the migration file against it, confirm success and inspect the resulting schema, *then* run `--remote`).

### Cloudflare Pages (frontend) deployment
No `wrangler.toml`/`vercel.json`/`netlify.toml` exists inside `frontend/` — deployment is GitHub-integration-based, not CLI-triggered. Per `README.md` (the one part of it confirmed still accurate): connect the GitHub repo to Cloudflare Pages, build command `npm run build`, output directory `dist`, root directory `frontend`, env vars `VITE_CLERK_PUBLISHABLE_KEY` + `VITE_WORKER_URL` (`VITE_SWEEP_WORKER_URL` is also typically set per `.env.example` but is dead — Section 9). Trigger: a push to whichever branch Cloudflare Pages is configured to track (not confirmable from this repo alone — Cloudflare Pages' own dashboard owns that setting). The root `package.json`'s single script (`npm ci --prefix frontend && npm run build --prefix frontend`) is what Cloudflare Pages most likely invokes as its build command if configured to use the repo root rather than `frontend/` directly — the exact configured root is a Cloudflare Pages dashboard setting, not stored in this repo.

### Monitoring — what Watchdog covers, what it doesn't, observability gaps
**Covered**: Watchdog's `watchdog_log` table records failures/warnings (not successes, by design) for its own fetch/synthesis/key-rotation operations. `api_call_log` (also Watchdog-written) gives a raw per-call success/failure record for every Twelve Data/Yahoo call, queryable via `/health/datasources`.

**Not covered — real gaps**:
- ⚠️ **Status changed since 2026-08-02**: this report originally found **no delivery mechanism for `watchdog_log` contents to a human** — the table was written but never read by any route/cron/alert path, so an admin would have to manually query D1 to discover a Watchdog failure. That gap directly caused a live incident: Watchdog silently hit Cloudflare's CPU-time limit on every scheduled run for roughly 3.5 hours (root cause, discovered only by chance via manual D1 inspection: a per-script CPU-limit override with no visible dashboard setting and no account-wide cause — resolved by a fresh `wrangler deploy`, which appears to have cleared whatever Cloudflare-side state was pinning it, though the underlying platform-level cause was never fully explained). Since a CPU-limit kill terminates the isolate before any in-process code can run — including Watchdog's own failure-catching `.catch()` — no fix living *inside* Watchdog could ever close this gap. The actual fix is a new external heartbeat, `POST /health/watchdog-check` on the EBP Worker (own cron-job.org job, every 15 min, independent of Watchdog entirely), which alerts via Telegram (`WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID`, both on `worker`) if `watchdog_log` or any of several forex/NSE freshness signals go stale. Watchdog's own Phase-H-spec `@EBP_Watchdog_bot` still doesn't exist as such, and Watchdog itself still sends zero Telegram messages — the delivery mechanism now exists one layer up, external to Watchdog, which is structurally necessary rather than incidental.
- **`/health/datasources`** (the one UI-adjacent visibility into data-source health) has no confirmed frontend caller — effectively invisible unless queried directly.
- **No alerting on stale `candle_cache`** beyond each individual EBP/Sweep/NSE cron's own per-request staleness check (`getCandlesFromCache`'s 2×/1.25× TF-interval age gate) — a systemic Watchdog outage (e.g. all Twelve Data keys exhausted *and* Yahoo down) degrades silently: EBP/Sweep Workers just log `"SKIP: insufficient candles in cache"` per symbol and move on, with no aggregate "N consecutive cron cycles have had 0 fresh candles" signal anywhere.
- **No uptime/synthetic monitoring** of the four workers' `/health` endpoints found in-repo — if such monitoring exists, it's entirely external (e.g. a third-party uptime checker hitting `/health`), not configured or referenced anywhere in this codebase.
- **NSE-specific**: no visibility into whether the Yahoo-fallback-only mode (Upstox never configured) is currently active, beyond the passive `/nse/status` badge a regular user might see on the Dashboard — nothing alerts an admin that NSE has been running on the more fragile unauthenticated Yahoo scrape this whole time.

---
