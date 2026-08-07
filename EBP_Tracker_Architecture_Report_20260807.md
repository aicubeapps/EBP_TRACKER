# EBP Tracker — Architecture & State Report

**Generated:** 2026-08-02, entirely from source code inspection and live D1 queries. **Updated:** 2026-08-07, following a same-day worker-topology refactor and production deployment (commit `d20aea3`, tag `deploy-2026-08-07-worker-split`) — two new workers were split out (`compute-worker`, `admin-worker`), `nse-worker` and `watchdog-worker` each absorbed routes previously owned by `worker/src/ebp-worker.js`, and all six workers were redeployed and smoke-tested against live traffic. Sections 1, 2, 5, 8, 9, and 10 were substantially rewritten to reflect the new topology; Sections 3, 4, 6, and 7 are carried forward from the 2026-08-02 audit largely unchanged (the database schema, detection algorithms, and frontend logic were not touched by this refactor) with only the route-ownership references corrected. Every specific fact newly stated below (line counts, route lists, configured secrets, cron-job.org job list) was re-verified directly against source and live infrastructure on 2026-08-07, not carried forward from the prior audit. Spec/roadmap docs were consulted only to flag divergences (marked ⚠️ DIVERGENCE), never as a source of truth for "what exists." Anything described in a code comment but not actually implemented is marked "documented but not implemented." **Further updated same day (2026-08-07, second session):** Weekly Market Breadth was implemented end-to-end (compute → API → frontend), and the `main`/`coding` branch divergence created by the worker-split refactor landing only on `main` was reconciled by merge. See new **Section 11** for full detail; Section 9's prior note calling Weekly Market Breadth "still-nonexistent" is superseded by that section and struck through in place below.

Legend: 🔶 UNTESTED = exists in code but not exercised on live data as of this audit. 🐛 BUG RISK = a concrete failure mode identified in the code. ⚠️ DIVERGENCE = contradicts a roadmap/reference doc. 🆕 = new or materially changed since 2026-08-02.

---

## Section 1 — Project Overview

### Live URLs
| Service | URL |
|---|---|
| Frontend (Cloudflare Pages) | `https://ebp-tracker.pages.dev` |
| EBP Worker (`ebp-tracker-worker`) | `https://ebp-tracker-worker.aicube-apps.workers.dev` |
| Sweep Worker (`sweep-detector`) | `https://sweep-detector.aicube-apps.workers.dev` |
| NSE Worker (`nse-tracker`) | `https://nse-tracker.aicube-apps.workers.dev` |
| Watchdog Worker (`ebp-watchdog`) | `https://ebp-watchdog.aicube-apps.workers.dev` — confirmed live this session (`/health` and `POST /health/watchdog-check` both smoke-tested against production) |
| 🆕 Compute Worker (`compute-worker`) | `https://compute-worker.aicube-apps.workers.dev` — new 2026-08-07, absorbs Market Breadth + Forex/Crypto SMA Cloud cron logic |
| 🆕 Admin Worker (`admin-worker`) | `https://admin-worker.aicube-apps.workers.dev` — new 2026-08-07, absorbs all `/admin/*` routes |
| Telegram bot (user alerts) | `@EbP_Tracker_bot` (shared bot, token in `SHARED_BOT_TOKEN` secret — see Section 5) |
| Telegram bot (Watchdog/dev alerts) | 🆕 **Implemented, and confirmed working this session** — `POST /health/watchdog-check` (moved from `ebp-worker.js` to `watchdog-worker` on 2026-08-07) sends real Telegram alerts via `WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID` to an admin chat. **Correction to the 2026-08-02 report**: this mechanism already existed in `ebp-worker.js` at the time of that audit (added by an earlier commit, `5f47d98`) — the prior report's claim "Watchdog Worker sends zero Telegram messages... there is no Watchdog alert bot" was checking only `watchdog-worker/src/index.js` and missed that the actual watchdog-check logic lived in a different worker file entirely. It is correct that `watchdog-worker` itself sent zero Telegram messages as of 2026-08-02 — that specific gap is what this session's move fixed, by relocating the check into the worker it actually monitors and giving it its own secrets. |

### Repo structure (source files only, line counts, re-verified 2026-08-07)
```
EBP_TRACKER/
├── worker/                         — EBP Worker + main REST API (Cloudflare Worker "ebp-tracker-worker")
│   ├── src/ebp-worker.js           2241 lines  — routes, EBP/FVG/Swing/MSS detection, T1-T3 chain step 1
│   │                                (was 2578 lines on 2026-08-02; -337 net despite this session removing far
│   │                                 more than that in raw code — several routes/detection additions from the
│   │                                 interim SMA Cloud revamp landed between the two audits)
│   └── wrangler.toml                 11 lines  — [triggers] native cron block removed 2026-08-07 (breadth moved out)
├── sweep-worker/                   — Sweep Worker (Cloudflare Worker "sweep-detector")
│   ├── src/index.js                 119 lines  — HTTP entrypoint, cron-only; POST /cron/sma route removed 2026-08-07
│   ├── src/sweep-cron.js           1139 lines  — Sweep/MSS/FVG detection, T1/T2/T3(step2-3)/T4 chains
│   │                                (Forex/Crypto SMA Cloud cron logic, ~630 lines, moved out to compute-worker)
│   └── wrangler.toml                 11 lines
├── nse-worker/                     — NSE Worker (Cloudflare Worker "nse-tracker")
│   ├── src/index.js                 406 lines  🆕 — was 62 lines; gained /nse/status, /nse/search, and all 4
│   │                                /user/nse-indicator-configs/* CRUD routes (+ Clerk auth, CORS) from ebp-worker.js
│   ├── src/nse-cron.js             1732 lines  — NSE EBP/Sweep/MSS/FVG, TDI, SMA Cloud (unchanged detection logic)
│   └── wrangler.toml                 16 lines  — secrets-documentation comment added 2026-08-07
├── watchdog-worker/                — Watchdog Worker (Cloudflare Worker "ebp-watchdog")
│   ├── src/index.js                1305 lines  🆕 — was 846(ish) lines pre-session; gained POST /health/watchdog-check
│   │                                (moved from ebp-worker.js), with rewritten probe logic — see Section 9/10
│   └── wrangler.toml                 11 lines
├── admin-worker/                   🆕 NEW — Admin Worker (Cloudflare Worker "admin-worker")
│   ├── src/index.js                 396 lines  — all 14 /admin/* routes + GET /health, own Clerk auth + CORS
│   └── wrangler.toml                  8 lines
├── compute-worker/                 🆕 NEW — Compute Worker (Cloudflare Worker "compute-worker")
│   ├── src/index.js                1111 lines  — Market Breadth (native hourly cron) + Forex/Crypto SMA Cloud
│   │                                (POST /cron/sma), absorbed from ebp-worker.js and sweep-cron.js
│   └── wrangler.toml                 11 lines  — [triggers] = ["5 * * * *"] (moved from worker/wrangler.toml)
├── frontend/                       — React 18 + Vite SPA, deployed to Cloudflare Pages
│   ├── src/App.jsx                   48 lines  — router
│   ├── src/main.jsx                  16 lines  — ClerkProvider bootstrap
│   ├── src/pages/                    8 files (Landing, Dashboard, Assets, Alerts, Settings, Admin, MarketBreathPage, NotFound)
│   ├── src/components/              11 files (AIAlertsPanel, AssetCard, PriceFeedPanel, EBPConfigPanel, SweepConfigPanel,
│   │                                 TdiConfigPanel, SmaConfigPanel, NseSearchModal, BiasOverridePanel, ExpiryBanner,
│   │                                 ApiErrorAlert, Layout)
│   ├── src/hooks/                    2 files (useAssets.js, useUser.js)
│   ├── src/lib/                      3 files (api.js 🆕 — now routes by path prefix across 3 worker base URLs, see
│   │                                 below; constants.js, utils.js)
│   └── vite.config.js                 9 lines
├── migrations/                     — 10 numbered SQL migration files (003–012), historical, already applied
├── migration_phase1_to_3.sql       — the FVG/Swing/Chain-state migration (prior session)
├── migration_forex_sma.sql         — Forex/Crypto SMA Cloud migration (prior session)
├── migration_sma_revamp.sql        — NSE SMA Cloud revamp migration (prior session)
└── schema.sql                      — hand-maintained schema reference, NOT auto-applied; drifts from live D1 (see Section 3)
```
`packages/core/` — 🆕 **confirmed removed.** The 2026-08-02 report flagged this as dead-but-present; as of 2026-08-07 the directory does not exist in the repo at all (already deleted in the interim, independent of this session).

Total source line count (`.js`/`.jsx` only, excluding `node_modules`/`dist`/`.wrangler`): **~12,300 lines** across 6 workers + frontend.

### Stack
- **Frontend**: React 18, Vite (`vite`/`@vitejs/plugin-react`), `react-router-dom` v6, `@clerk/clerk-react` (auth), `recharts` (Market Breadth charts only), `xlsx` (Alerts export only). ⚠️ **DIVERGENCE** (unchanged from 08-02): `README.md` claims "React + Vite + MUI" — there is no MUI dependency and zero `@mui` imports; all styling is hand-rolled CSS.
- **Backend**: 🆕 **6** independent Cloudflare Workers (was 4 on 2026-08-02), all zero-npm-dependency single-file (or single-file + one large cron-logic file) bundles, deliberately not importing from each other. Each of the two new workers (`compute-worker`, `admin-worker`) copies its shared helpers (CORS, `verifyClerkToken`, candle-cache readers, etc.) verbatim from `ebp-worker.js` rather than importing them — same "zero cross-package imports" convention as the original four.
- **Database**: Cloudflare D1 (SQLite), a single shared database `ebp-tracker-db` (id `b93b206a-5537-4d12-8c86-a4b2372aae7f`) bound as `DB` in all **six** workers' `wrangler.toml`. No schema changes this session.
- **Auth**: Clerk (`@clerk/clerk-react` frontend, hand-rolled JWKS-verification `verifyClerkToken()`). 🆕 Now duplicated verbatim in **three** worker files (`worker/src/ebp-worker.js`, `admin-worker/src/index.js`, `nse-worker/src/index.js`) rather than one — each with its own independent in-memory JWKS cache, so a JWKS refresh in one worker doesn't warm the cache in another (three separate 1-hour TTL caches, three separate cold-start Clerk API calls).
- **Scheduling**: Two mechanisms coexist, rebalanced this session:
  1. **cron-job.org HTTP triggers** — `/cron/ebp`, `/cron/sweep`, `/cron/nse` (unchanged), plus 🆕 `/cron/sma` (moved from `sweep-detector` to `compute-worker`, 4 jobs recreated 1:1 by schedule) and 🆕 `/health/watchdog-check` (repointed from `ebp-tracker-worker` to `ebp-watchdog`). Full verified job list in Section 10 — this update replaces the prior report's "inferred from route TF sets" methodology with actual data read from the cron-job.org REST API this session.
  2. **Native Cloudflare `[triggers]` cron** — `watchdog-worker` (`*/15 * * * *`, unchanged) and 🆕 `compute-worker` (`5 * * * *`, hourly Market Breadth — moved from `worker/wrangler.toml`, which no longer has a `[triggers]` block or a `scheduled()` export at all).
- **Deployment**: `npx wrangler deploy` per worker, run directly this session for all 6 workers (see Section 10 for the exact commands and verified output). Still no CI/CD pipeline in-repo. Frontend via Cloudflare Pages, GitHub-integration auto-build — confirmed this session: pushing commit `d20aea3` to `main` triggered a rebuild that picked up the two new frontend env vars.

### Environment variables / secrets per worker (names only, `wrangler secret list` output, re-verified 2026-08-07)

| Worker | Configured secrets | `[vars]` (plaintext) |
|---|---|---|
| `worker` (ebp-tracker-worker) | `APP_URL`, `CLERK_SECRET_KEY`, `CRON_SECRET`, `JOURNAL_API_SECRET`, `SHARED_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` ⚠️, `WATCHDOG_BOT_TOKEN` ⚠️ | none |
| `sweep-worker` (sweep-detector) | `CRON_SECRET`, `SHARED_BOT_TOKEN` | none |
| `nse-worker` (nse-tracker) | `CLERK_SECRET_KEY` 🆕 **now live** (was dead on 08-02 — nse-worker only just gained Clerk-gated routes), `CRON_SECRET`, `SHARED_BOT_TOKEN` | `ENVIRONMENT="production"` |
| `watchdog-worker` (ebp-watchdog) | 🆕 `CRON_SECRET`, `WATCHDOG_ADMIN_CHAT_ID`, `WATCHDOG_BOT_TOKEN` — all three added 2026-08-07 (was **zero secrets configured** on 08-02) | none |
| `admin-worker` 🆕 NEW | `CLERK_SECRET_KEY` | none |
| `compute-worker` 🆕 NEW | `CRON_SECRET` — **not part of the original migration plan**; added mid-session after discovering (via `wrangler secret list`, before any traffic hit it) that a brand-new worker has zero secrets by default, and its `/cron/sma` route would otherwise 403 every cron-job.org request | none |

⚠️ `WATCHDOG_ADMIN_CHAT_ID`/`WATCHDOG_BOT_TOKEN` are still present on `worker` as of this audit — they're dead there now (the code that read them moved to `watchdog-worker`), scheduled for removal as a post-deployment cleanup step that had not yet been executed as of this report. Several secrets the 2026-08-02 report flagged as dead (`DEVELOPER_TELEGRAM_CHAT_ID`, `TWELVE_DATA_API_KEY_1/2/3` on `worker`; `CLERK_SECRET_KEY`, `TWELVE_DATA_API_KEY_1/2/3` on `sweep-worker`) are **no longer present at all** in the current `wrangler secret list` output — removed at some point between the two audits, independent of this session's work.

Frontend build-time env vars (`.env.example`, current): `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_WORKER_URL`, 🆕 `VITE_ADMIN_WORKER_URL`, 🆕 `VITE_NSE_WORKER_URL`. The dead `VITE_SWEEP_WORKER_URL` entry the 2026-08-02 report flagged is no longer present in `.env.example` at all (cleaned up in the interim, independent of this session).

---

## Section 2 — Architecture & Data Pipeline

### End-to-end data flow (🆕 redrawn for the 6-worker topology)

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
                    │  daily/weekly synthesis, synthetic DXY         │
                    │                                               │
                    │  🆕 POST /health/watchdog-check (own route,   │
                    │     X-Cron-Secret, cron-job.org every 15 min) │
                    │     reads candle_cache/swing_states/breadth/  │
                    │     forex_sma_state/NSE tables, alerts via    │
                    │     Telegram (WATCHDOG_BOT_TOKEN) on failure  │
                    └─────────────────────────────────────────────┘
                                        │  (D1 read-only from here on)
                                        ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────────┐
   │  cron-job.org   │ │  cron-job.org   │ │  cron-job.org   │ │  cron-job.org        │
   │ POST /cron/ebp  │ │ POST /cron/sweep│ │ POST /cron/nse  │ │ 🆕 POST /cron/sma    │
   └────────┬────────┘ └────────┬────────┘ └────────┬────────┘ └──────────┬───────────┘
            ▼                   ▼                   ▼                     ▼
   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌──────────────────────┐
   │  EBP WORKER     │ │ SWEEP WORKER    │ │ NSE WORKER      │ │ 🆕 COMPUTE WORKER     │
   │ handleEBPCron() │ │handleSweepCron()│ │handleNseCron()  │ │handleForexSmaCron()   │
   │ EBP/FVG/Swing/  │ │ Sweep/FVG/Swing/│ │ own Upstox/Yahoo│ │(moved from sweep-cron)│
   │ MSS, T1-T3 Step1│ │ MSS, T1-T3(2-3)/│ │ EBP/Sweep/MSS/  │ │ + Market Breadth      │
   │                 │ │ T4              │ │ FVG, TDI, SMA   │ │ (native hourly cron,  │
   │                 │ │                 │ │ Cloud           │ │ moved from ebp-worker)│
   └────────┬────────┘ └────────┬────────┘ └────────┬────────┘ └──────────┬───────────┘
            │                   │                   │                     │
            └───────────────────┴─────────┬─────────┴─────────────────────┘
                                           ▼
             signals, chain_state, fvg_zones/nse_fvg_zones, swing_states/nse_swing_states,
             alert_history, bias_cache, forex_sma_state, market_breadth_* (D1 writes)
                                           │
             sendTelegramMessage() via SHARED_BOT_TOKEN → @EbP_Tracker_bot → user's chat_id
                                           │
                                           ▼ (Clerk-JWT-authenticated REST reads)
   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │                     FRONTEND (React SPA, Cloudflare Pages)                        │
   │  🆕 no longer a single-worker client — frontend/src/lib/api.js routes by path      │
   │  prefix across THREE worker base URLs:                                            │
   │    /admin/*                              → VITE_ADMIN_WORKER_URL (admin-worker)   │
   │    /nse/*, /user/nse-indicator-configs/* → VITE_NSE_WORKER_URL (nse-worker)        │
   │    everything else                       → VITE_WORKER_URL (ebp-tracker-worker)   │
   └─────────────────────────────────────────────────────────────────────────────────┘
```

**Key structural fact, corrected from 2026-08-02**: the prior report stated "the frontend never calls Sweep/NSE/Watchdog Workers directly... all frontend↔backend traffic goes through `worker/src/ebp-worker.js`." That is **no longer true**. As of 2026-08-07, `frontend/src/lib/api.js` picks one of three base URLs per request path (`baseFor(path)` — `/admin/*` → admin-worker, `/nse/*` and `/user/nse-indicator-configs/*` → nse-worker, everything else → the original EBP Worker). Sweep Worker and Watchdog Worker are still never called directly by the frontend.

### Workers — name, entry file, routes summary (🆕 all 6, re-verified 2026-08-07)

| Worker | CF Worker name | Entry file | Route count | Auth mechanisms used |
|---|---|---|---|---|
| EBP Worker | `ebp-tracker-worker` | `worker/src/ebp-worker.js` | **44** routes (was 51 on 08-02 — net change reflects both this session's removals and additions from an interim revamp the prior audit predates; see full table below) | Clerk JWT, X-Cron-Secret, X-Journal-Secret, none (public: `/health`, `/telegram/webhook`, `/invite/:token`) |
| Sweep Worker | `sweep-detector` | `sweep-worker/src/index.js` | 2 routes (`/health`, `/cron/sweep`) — `/cron/sma` removed 2026-08-07 | none, X-Cron-Secret |
| NSE Worker | `nse-tracker` | `nse-worker/src/index.js` | 🆕 **8** routes (was 2) — `/health`, `/cron/nse`, `/nse/status`, `/nse/search`, `/user/nse-indicator-configs/:assetId` (GET/POST), `/user/nse-indicator-configs/:id` (PATCH/DELETE) | none, X-Cron-Secret, Clerk JWT 🆕 |
| Watchdog Worker | `ebp-watchdog` | `watchdog-worker/src/index.js` | 🆕 **2** routes (was 1) — `/health`, `POST /health/watchdog-check` | none, X-Cron-Secret 🆕 |
| 🆕 Admin Worker | `admin-worker` | `admin-worker/src/index.js` | **15** routes — `/health` + all 14 `/admin/*` routes | Clerk JWT + admin (`requireAdmin()`), none (`/health`) |
| 🆕 Compute Worker | `compute-worker` | `compute-worker/src/index.js` | **2** routes — `/health`, `POST /cron/sma` | none, X-Cron-Secret |

**Current EBP Worker route table** (all 44 routes, re-verified via grep 2026-08-07 — supersedes the prior report's 51-row table, which both predated several additions from an interim revamp *and* omitted several routes that already existed then: `/user/chain-state/:assetId`, `/user/fvg-zones/:assetId`, and all 4 `/user/forex-indicator-configs/*` routes are not new, they were simply missing from the 08-02 table):

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
| GET/POST | `/user/ebp-configs/:assetId` | Clerk JWT | List / create EBP configs |
| GET/POST | `/user/sweep-configs/:assetId` | Clerk JWT | List / create Sweep configs |
| GET/POST | `/user/templates/:assetId` | Clerk JWT | List / create T1-T4 templates |
| PATCH/DELETE | `/user/template/:id` | Clerk JWT | Update / delete a template |
| GET | `/user/chain-state/:assetId` | Clerk JWT | Active T1-T4 chain progress, display only |
| GET | `/user/fvg-zones/:assetId` | Clerk JWT | Active/recently-mitigated FVG zones for the asset's configured TFs |
| GET | `/dashboard` | Clerk JWT | Assets + last alert timestamps |
| PATCH/DELETE | `/user/ebp-configs/:id` | Clerk JWT | Update / delete EBP config |
| PATCH/DELETE | `/user/sweep-configs/:id` | Clerk JWT | Update / delete Sweep config |
| GET/POST | `/user/forex-indicator-configs/:assetId` | Clerk JWT | List / create Forex/Crypto SMA Cloud config — **stayed on ebp-worker.js by explicit instruction**, even though the SMA *cron* logic itself moved to compute-worker; this worker owns CRUD only |
| PATCH/DELETE | `/user/forex-indicator-configs/:id` | Clerk JWT | Update / delete Forex/Crypto SMA Cloud config |
| GET | `/user/bias/:symbol` | Clerk JWT | bias_cache rows for a symbol |
| GET | `/health/datasources` | Clerk JWT | Per-source API call stats |
| GET | `/alerts/history` | Clerk JWT | Paginated alert history |
| GET | `/alerts/export` | Clerk JWT | Bulk alert export (up to 5000 rows) |
| GET | `/user/telegram` | Clerk JWT | Telegram connection status |
| POST | `/user/telegram/initlink` | Clerk JWT | Generate link code |
| POST | `/user/telegram/test` | Clerk JWT | Send test Telegram message |
| POST | `/cron/ebp` | X-Cron-Secret | EBP detection per TF (the `tf==='BREADTH'` branch was removed 2026-08-07 — breadth is now compute-worker's native cron only) |
| GET | `/market/breadth` | Clerk JWT + admin | Breadth heatmap/strength/correlation |
| POST | `/telegram/webhook` | none (public) | Telegram bot webhook (`/start`, link codes) |
| POST | `/user/telegram/verify` | Clerk JWT | Poll: has bot verified the link code |
| DELETE | `/user/telegram` | Clerk JWT | Disconnect Telegram |
| GET | `/signals/:id` | X-Journal-Secret | Trade Journal: fetch signal |
| PATCH | `/signals/:id/traded` | X-Journal-Secret | Trade Journal: mark traded |
| GET | `/invite/:token` | none (public) | Validate invite token |
| GET | `/sweep/dashboard` | Clerk JWT | Live sweep status (moved from Sweep Worker, prior session) |
| GET | `/sweep/history` | Clerk JWT | User's sweep alert history |

**Removed from this worker 2026-08-07** (now served elsewhere): `GET /nse/status`, `GET /nse/search`, `GET/POST /user/nse-indicator-configs/:assetId`, `PATCH/DELETE /user/nse-indicator-configs/:id` → nse-worker. All 14 `/admin/*` routes → admin-worker. `POST /health/watchdog-check` → watchdog-worker (as its own new route, not a passthrough).

**Sweep Worker routes**: `GET /health` (public), `POST /cron/sweep` (X-Cron-Secret, body `{tf}` ∈ `{M15,M30,1H,4H}`). `POST /cron/sma` — present as of 2026-08-02 (added by the interim SMA Cloud revamp, which the prior report's route description for this worker did not capture) — was removed 2026-08-07; forex/crypto SMA Cloud cron now lives on compute-worker.

**NSE Worker routes** 🆕 (major expansion — see Section 8 for full detail): `GET /health` (public), `POST /cron/nse` (X-Cron-Secret), `GET /nse/status` (public), `GET /nse/search` (Clerk JWT), `GET/POST /user/nse-indicator-configs/:assetId` (Clerk JWT), `PATCH/DELETE /user/nse-indicator-configs/:id` (Clerk JWT). The four CRUD routes share one regex-matched dispatcher (`/^\/user\/nse-indicator-configs\/([^/]+)$/`) rather than four separate literal-path handlers.

**Watchdog Worker routes** 🆕: `GET /health` (public), `POST /health/watchdog-check` (X-Cron-Secret) — moved here from `ebp-worker.js` 2026-08-07, with rewritten probe logic (Section 9/10). This is the first externally-triggerable business-logic route Watchdog Worker has ever had; previously all its logic fired exclusively from its native `scheduled()` handler.

**Admin Worker routes** 🆕: `GET /health` (public) plus all 14 `/admin/*` routes, moved verbatim from `ebp-worker.js` — `GET/POST /admin/api-keys`, `PATCH/DELETE /admin/api-keys/:id`, `GET /admin/users`, `GET /admin/tokens`, `POST /admin/invite`, `POST /admin/expire/:id`, `PATCH /admin/users/:id/asset-limit`, `GET /admin/users/:id/assets`, `GET/PATCH /admin/users/:id/tf-access`, `GET/PATCH /admin/users/:id/nse-tf-access`.

**Compute Worker routes** 🆕: `GET /health` (public), `POST /cron/sma` (X-Cron-Secret) — the Market Breadth cron itself has no HTTP route; it fires only from compute-worker's native `scheduled()` handler on the hourly `5 * * * *` trigger.

### Data sources — who calls what, for what, under what conditions
Unchanged from 2026-08-02 except one row:

| Caller | Source | Symbols | TFs | Condition | Fallback |
|---|---|---|---|---|---|
| Watchdog Worker | Twelve Data `time_series` | "signal symbols" = any symbol with ≥1 enabled `user_ebp_configs`/`user_sweep_configs` row | M15 (every tick), M30/1H/4H gated by minute/NY-hour | Chunked 7-symbols-per-key | Per-symbol Yahoo Finance if all TD keys exhausted |
| Watchdog Worker | Yahoo Finance | 28 `MAJOR_PAIRS` breadth cross-pairs | 1H only | `minute===0` | none |
| NSE Worker | Upstox `historical-candle` / Yahoo Finance | NSE equities/indices | M1/M5/M15/M30/1H/D | Upstox conditional on configured key | Yahoo always available |
| EBP/Sweep/Compute Workers | **none** — D1 `candle_cache` only | n/a | n/a | n/a | n/a |
| 🆕 NSE Worker `/nse/search` | Upstox `instruments/search` + Yahoo `finance/search` | user-typed query | n/a | **moved from `worker/src/ebp-worker.js` to `nse-worker/src/index.js` 2026-08-07** — logic itself unchanged, just relocated | Yahoo index search always runs |
| Frontend `PriceFeedPanel.jsx` | Twelve Data WebSocket, direct from browser | admin-typed symbol | live ticks | Admin manually pastes an API key | none — bypasses all workers |

### Cron schedule — 🆕 now confirmed via the cron-job.org REST API, not inferred

Unlike the 2026-08-02 report (which could only infer the job set from what each route's TF validation accepted, since cron-job.org's own dashboard was unqueryable from code), this session obtained a cron-job.org API key and read the **actual live job list** directly. All 21 active jobs, confirmed 2026-08-07:

| Route | Worker | Jobs | Schedule (UTC) |
|---|---|---|---|
| `POST /cron/ebp` | ebp-tracker-worker | 5 jobs (M15/1H/4H/1D/1W) | M15: `:01/:16/:31/:46`; 1H: `:01` hourly; 4H: hours `1,5,9,13,17,21` at `:01`; 1D: `21:01` Mon-Fri; 1W: `21:01` Fri |
| `POST /cron/sweep` | sweep-detector | 4 jobs (M15/M30/1H/4H) + 1 disabled (M5) | M15: `:02/:17/:32/:47`; M30: `:02/:32`; 1H: `:02` hourly; 4H: hours `1,5,9,13,17,21` at `:02` |
| `POST /cron/nse` | nse-tracker | 4 enabled jobs (M15/M30/1H/D) + 2 disabled (M1/M5) | all gated to NSE market-hours UTC windows (`3`–`10`), weekdays only |
| 🆕 `POST /cron/sma` | **compute-worker** (moved from sweep-detector) | 4 jobs (M15/M30/1H/4H) | M15: `:04/:19/:34/:49`; M30: `:04/:34`; 1H: `:04` hourly; 4H: hours `1,5,9,13,17,21` at `:04` — each new job created to exactly mirror its predecessor's schedule before the old one was deleted |
| `POST /health/watchdog-check` | 🆕 **ebp-watchdog** (moved from ebp-tracker-worker) | 1 job | every 15 min, `:03/:18/:33/:48` |

All jobs require the `X-Cron-Secret` header matching the target worker's `CRON_SECRET` secret.

**Cloudflare native crons** (`wrangler.toml` `[triggers]`, ground truth, re-verified 2026-08-07):
- `watchdog-worker`: `*/15 * * * *` — unchanged, sole schedule.
- 🆕 `compute-worker`: `5 * * * *` — hourly, fires `handleMarketBreadthCron()` via `scheduled()`. **Moved from `worker/wrangler.toml`**, which no longer has a `[triggers]` block or a `scheduled()` export at all — `ebp-worker.js` is now 100% cron-job.org-driven, no native cron.
- `sweep-worker`, `nse-worker`, `admin-worker`: no `[triggers]` block — 100% cron-job.org/Clerk-JWT-driven.

### Watchdog Worker vs EBP/Sweep/NSE/Compute Workers

| | Watchdog | EBP/Sweep/NSE/Compute |
|---|---|---|
| Purpose | External-data ETL (fetch → cache → synthesize) **plus 🆕 external health-check heartbeat** | Signal detection + user alerting (+ compute-worker: breadth/SMA compute) |
| Trigger | Native CF cron (`*/15 * * * *`) **+ 🆕 cron-job.org `POST /health/watchdog-check` every 15 min** | cron-job.org HTTP POST (`X-Cron-Secret`), + compute-worker's own native hourly cron for breadth |
| External APIs called | Twelve Data, Yahoo | none (EBP/Sweep/Compute read D1 only); NSE calls Upstox/Yahoo itself |
| Writes | `candle_cache`, `daily_candle_cache`, `weekly_candle_cache`, `api_key_state`, `api_call_log`, `watchdog_log` | `signals`, `chain_state`, `fvg_zones`/`nse_fvg_zones`, `swing_states`/`nse_swing_states`, `alert_history`, `bias_cache`, `forex_sma_state`, `market_breadth_*` |
| Alerts | 🆕 **Yes** — `POST /health/watchdog-check` sends Telegram alerts on any check failure, plus a 2-hourly all-clear and a 17:00 NY EOD summary. `watchdog_log` itself is still write-only, no delivery path (unchanged gap, see Section 10). | Telegram alerts via `SHARED_BOT_TOKEN` to `@EbP_Tracker_bot` |
| Secrets | 🆕 `CRON_SECRET`, `WATCHDOG_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` (was **none** on 08-02) | `CRON_SECRET`, `SHARED_BOT_TOKEN` (+Clerk on EBP/NSE/Admin) |

---

## Section 3 — Database Schema (ground truth)

**Not re-audited this update — no schema changes were made or requested this session ("do not modify D1 schema" was an explicit constraint on every task).** The full table-by-table detail from the 2026-08-02 report (34 live tables, `schema.sql` drift notes, FK relationships, cleanup cycles, live row counts as of 2026-08-02) is carried forward unchanged and should still be treated as accurate for schema *shape*. Live row counts specifically (e.g. "`fvg_zones` = 18 rows") are now 5 days stale and were not re-queried for this update — treat any specific count from the prior report as "as of 2026-08-02," not current.

One correction worth noting here since it surfaced during this session's live smoke-testing: `nse_fvg_zones` behaves identically to `fvg_zones` — a row is written only when `detectFVG()` actually finds a gap, not on every cron tick. This was already implied by the 2026-08-02 report's own description of `processFVGZones()`, but a new Watchdog check added this session initially assumed otherwise (see Section 9's "false alarm" writeup) and was corrected in place before this report was written.

---

## Section 4 — Signal Detection Engine

**Not re-audited this update — detection logic did not change.** `detectEBP`, `detectSweep`, `detectMSS`, the FVG engine, the Swing State Machine, `calcTTradesBias`, the T1-T4 template chain state machines, and the NSE-specific TDI/SMA Cloud detectors are all byte-for-byte unchanged from the 2026-08-02 report's description. The only thing that moved is *where* the Forex/Crypto SMA Cloud cron handler (`handleForexSmaCron` — not itself a signal-detection primitive like the above, more an orchestration function) physically lives: `sweep-worker/src/sweep-cron.js` → `compute-worker/src/index.js`, verbatim, including all its exclusive helper functions (`computeSMA`, `computeATR`, `advanceSmaPhase`, `checkForexSMABias`, `deliverForexSmaAlert`, etc.) and constants (`FOREX_SMA_SEPARATION_THRESHOLD`, `FOREX_SMA_VELOCITY_THRESHOLD`, `FOREX_SMA_WICK_PENETRATION`, `FOREX_SMA_VALID_TFS`, `FOREX_SMA_WATCH_EXPIRY_MS`, `FOREX_SMA_TYPE2_COOLDOWN_MS`). Refer to the 2026-08-02 report for the full algorithm write-up; every code sample quoted there still matches current source.

---

## Section 5 — Alert & Notification System

### Telegram bot setup
**Two bots now, not one** — a correction to how the 2026-08-02 report framed this (it described only the user-facing bot as real):
1. **`@EbP_Tracker_bot`** (`SHARED_BOT_TOKEN`) — all user-facing EBP/Sweep/MSS/T1-T4/TDI/SMA alerts. Configured identically on `worker`, `sweep-worker`, `nse-worker`.
2. 🆕 **Watchdog/admin bot** (`WATCHDOG_BOT_TOKEN` + `WATCHDOG_ADMIN_CHAT_ID`) — internal-only, sends to a single admin Telegram chat, triggered exclusively by `POST /health/watchdog-check`. As of 2026-08-07 this logic lives in `watchdog-worker/src/index.js` (moved from `ebp-worker.js`, where it had actually lived since an earlier commit predating even the 2026-08-02 audit — see Section 1's correction note). `watchdog-worker`'s own native `scheduled()` cron (the fetch/cache/synthesize loop) still sends **zero** Telegram messages of its own — only the separately-triggered `/health/watchdog-check` route does.

`DEVELOPER_TELEGRAM_CHAT_ID`, which the 2026-08-02 report flagged as a dead secret on `worker`, **no longer exists** in `worker`'s configured secrets as of this audit (removed independent of this session).

### Per-user bot token vs shared bot — what's actually implemented
Unchanged from 2026-08-02 — shared bot only, no per-user bot tokens, same linking flow (`POST /user/telegram/initlink` → `/start` DM → `POST /telegram/webhook` → poll `POST /user/telegram/verify`).

### Exact Telegram message format, per alert type
EBP/Sweep/MSS/T1-T4/NSE-EBP/Sweep/MSS/TDI/SMA formats are all unchanged from the 2026-08-02 report — refer there for the full quoted templates.

🆕 **Watchdog health-check formats** (new to this report — the prior audit stated no format existed because it hadn't found the route):
```
Failure (any check over threshold):
🚨 EBP Watchdog — Health Alert
🕐 {NY time} · {IST time}

Failed checks (N):
• {failure message}
• ...

System may be partially or fully offline.

All-clear (first :00-:15 tick after an even UTC hour, zero failures):
✅ EBP Watchdog — All Systems OK
🕐 {NY time} · {IST time}

📈 Forex: {open|weekend} · 📈 NSE: {open|closed}
All {N} checks passed.

EOD summary (first :00-:15 tick after 17:00 NY, always sent regardless of failures):
📊 EBP Watchdog — EOD Report (NY 5PM)
🕐 {NY time} · {IST time}

Status: {✅ All clear | ⚠️ N issue(s) detected}

System checks:
• {check name}: {value}
• ...
```

### Alert deduplication
Unchanged from 2026-08-02 — `isDuplicateAlert` (`alert_history`-keyed, INTEGER-epoch cutoff type gotcha as previously documented) and the chain-creation dedup patterns for T1-T4.

### Signal ID system
Unchanged from 2026-08-02.

---

## Section 6 — Frontend

Largely unchanged from 2026-08-02 — refer there for the full page/component/hook inventory, auth flow, and subscription/tier logic detail. Two corrections:

- **Per-page API calls — Dashboard**: `GET /nse/status` now resolves against `nse-worker` (`VITE_NSE_WORKER_URL`), not `ebp-tracker-worker` — the call site in `Dashboard.jsx` itself is unchanged, only the base URL `api.js` routes it to.
- **Admin page**: all `/admin/*` calls listed in the 2026-08-02 report (`/admin/users`, `/admin/tokens`, `/admin/api-keys`, etc.) now resolve against `admin-worker` (`VITE_ADMIN_WORKER_URL`) — same paths, same request shapes, different backend.

`frontend/src/lib/api.js` itself changed structurally (Section 1/2) but every call site elsewhere in the frontend (`Admin.jsx`, `NseSearchModal.jsx`, `TdiConfigPanel.jsx`/`SmaConfigPanel.jsx`, etc.) is untouched — they still call `api.get('/admin/users', token)` / `api.get('/nse/search?...', token)` exactly as before; the routing split happens transparently inside `api.js`'s `baseFor(path)`.

---

## Section 7 — Subscription & User Management

Unchanged from 2026-08-02 in every respect — tier model, `asset_limit`/`user_tf_access`/`nse_tf_access` gating, admin panel actions. The only change is that the admin panel's backend is now `admin-worker` instead of `ebp-worker.js` (Section 2/6) — the actions themselves, their D1 effects, and their UI are identical.

---

## Section 8 — NSE Module

### NSE Worker — entry file, routes, cron (🆕 majorly expanded 2026-08-07)
`nse-worker/src/index.js` grew from 62 to **406 lines**. Previously cron-only; now also owns:
- `GET /nse/status` (public) — whether an enabled Upstox `api_keys` row exists.
- `GET /nse/search` (Clerk JWT) — Upstox `instruments/search` (equities) + Yahoo `finance/search` (indices) in parallel, same logic as before, **moved here verbatim from `worker/src/ebp-worker.js`**.
- `GET/POST /user/nse-indicator-configs/:assetId`, `PATCH/DELETE /user/nse-indicator-configs/:id` (all Clerk JWT) — TDI/SMA Cloud config CRUD, also moved verbatim from `ebp-worker.js`.

To support this, `nse-worker/src/index.js` gained its own copy of `verifyClerkToken()` (with an independent JWKS cache), `ALLOWED_ORIGINS`/`corsHeaders()`, and an `authenticate()` helper wrapping the Bearer-token-verification boilerplate shared by all 5 newly-Clerk-gated routes. `nse-worker/wrangler.toml` gained a documentation comment listing `CRON_SECRET` and `CLERK_SECRET_KEY` as required secrets (the actual `CLERK_SECRET_KEY` value was set via `wrangler secret put` this session — see Section 1).

`POST /cron/nse` itself is unchanged: `tf` from JSON body or `?tf=` query fallback, X-Cron-Secret guarded. Still no native Cloudflare cron trigger — 100% cron-job.org.

### NSE data source — what's actually wired
Unchanged from 2026-08-02 — Upstox (conditional) → Yahoo Finance (fallback), same gating logic, same silent-degrade-to-Yahoo-forever risk if Upstox is never configured.

### NSE symbol list — storage and search
Storage unchanged (`user_assets`, `asset_type='nse'`). **Search location corrected**: `GET /nse/search` now lives in `nse-worker/src/index.js`, **not** `worker/src/ebp-worker.js` — the 2026-08-02 report's note "lives in worker/src/ebp-worker.js, not nse-worker" is exactly inverted as of this update.

### NSE TF constraints, signal detection differences, alert delivery
All unchanged from 2026-08-02 — refer there for `NSE_VALID_TFS`, the TDI/SMA Cloud algorithm detail, and the shared-bot delivery mechanism. The `ALL_NSE_TF_ACCESS` duplication bug-risk the prior report flagged (independently-maintained copy in `ebp-worker.js`) still exists in the same form — that constant did not move with the NSE routes (it's used by the `/admin/users/:id/nse-tf-access` routes, which are now on `admin-worker`, not `nse-worker` — so as of this update there are arguably **three** independent copies of this TF list in play: `nse-cron.js`'s `NSE_VALID_TFS`, and whatever `admin-worker` uses for its nse-tf-access validation. Not independently re-verified this update; flagged for a future pass.

### What works today vs infrastructure-only
Unchanged from 2026-08-02 — not re-queried this update (Section 3 note applies: live row counts are 5 days stale).

---

## Section 9 — Known Issues & Technical Debt

### Dead code — status update
**All 7 dead functions the 2026-08-02 report flagged were already gone by the start of this session** (`getHTFForTF`, `loadBiasCache` ×2, `isPriceInFVG`'s dead copy, `getHTFForSweepTF`, `oppositeDirection`, `fetchAndCacheNSECandles`) — removed in an interim cleanup commit (`c7e4b8b`) between the two audits. This session ran its own fresh dead-code sweep and found (and removed) a further round, all confirmed via repo-wide grep before deletion:

| Function/constant | File | Note |
|---|---|---|
| `VALID_HTF_OVERRIDES` | `sweep-worker/src/sweep-cron.js` | Dead duplicate of the copy in `ebp-worker.js` that's actually read |
| `FOREX_SMA_HTF_OPTIONS` | `sweep-worker/src/sweep-cron.js` | Dead duplicate of the copy in `ebp-worker.js` that's actually read |
| `sma1x9CandleSide`, `priceSameSide` | `nse-worker/src/nse-cron.js` | Self-documented in a code comment as orphaned from a prior phase-machine design |
| `FOREX_SMA_HTF_TFS` | `frontend/src/lib/constants.js` | Unused duplicate of `FOREX_SMA_HTF_OPTIONS` |
| `lastUpdated` state | `frontend/src/hooks/useAssets.js` | Set but never read by any of the 3 call sites |
| `error`/`refetch` return fields | `frontend/src/hooks/useUser.js` | Unused by all 4 call sites |

Also fixed as part of the same pass: a genuine **runtime bug** — `sweep-cron.js` called `endOfUTCMonthISO()` for T4 chain creation, but that function was only ever defined in `worker/src/ebp-worker.js` (a separate, standalone bundle) — a `ReferenceError` on every attempted T4 chain creation, silently swallowed by a surrounding `try/catch` and logged as `"T4 step1 error"`. A local copy was added to `sweep-cron.js` (later moved to `compute-worker` intact, since it's still needed there — no, correction: T4 chains stayed in `sweep-cron.js`; only the Forex SMA Cloud cron moved to compute-worker. The `endOfUTCMonthISO()` fix lives in `sweep-cron.js`, unaffected by the later compute-worker split).

As of this report, **zero known dead functions remain** from either audit pass.

`packages/core/` — confirmed fully removed (Section 1).

### 🆕 A live bug caught during this session's deployment
Immediately after deploying the rewritten `watchdog-worker` and smoke-testing `POST /health/watchdog-check` against production, it returned a real false-alarm failure: `"NSE FVG zones stale — HDFCBANK.NS M15 last entry 1409 min ago (expected ≤35 min)"`. The check's design comment had assumed NSE FVG detection writes a `nse_fvg_zones` row on every cron tick (unlike forex's `fvg_zones`, described as event-driven). Checking `processFVGZones()` in `nse-cron.js` showed this assumption was wrong — `nse_fvg_zones` is written to only when `detectFVG()` actually finds a gap, exactly as event-driven as the forex table. The check was changed from a hard-failure threshold to informational-only (matching the pre-existing forex `fvg_zones` check's pattern), redeployed, and the false alarm confirmed gone on retest. This is the exact category of bug the watchdog-check rewrite was meant to eliminate (the original task removed a different false-alarm source, the `watchdog_log`-silence check) — worth noting that a *new* one was introduced and caught within the same session, underscoring the value of smoke-testing against live traffic immediately after deploy rather than trusting the logic in isolation.

### Dead / orphaned secrets and env vars (re-verified 2026-08-07)
- **`worker`**: `WATCHDOG_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` are now dead here (the code that read them moved to `watchdog-worker`) — pending removal, not yet executed as of this report (see Section 10). `DEVELOPER_TELEGRAM_CHAT_ID` and `TWELVE_DATA_API_KEY_1/2/3`, flagged dead in the 2026-08-02 report, are gone entirely now.
- **`sweep-worker`**: `CLERK_SECRET_KEY` and `TWELVE_DATA_API_KEY_1/2/3`, flagged dead in the 2026-08-02 report, are gone entirely now — this worker's secret list is down to exactly what it uses (`CRON_SECRET`, `SHARED_BOT_TOKEN`).
- **`nse-worker`**: `CLERK_SECRET_KEY`, flagged dead on 08-02, is now **live** — this worker gained Clerk-gated routes this session.
- **New workers**: `admin-worker` and `compute-worker` each have exactly the secrets their code reads, no dead ones — `admin-worker`'s `CLERK_SECRET_KEY`, `compute-worker`'s `CRON_SECRET`.
- **Frontend**: the dead `VITE_SWEEP_WORKER_URL` the 2026-08-02 report flagged is gone from `.env.example` entirely (cleaned up independent of this session).

### schema.sql vs D1 mismatches
Unchanged from 2026-08-02 — not re-audited this update (Section 3).

### Hardcoded values that should probably be config — updated
- **`ALLOWED_ORIGINS`** (CORS allowlist) — the 2026-08-02 report flagged this as duplicated between `ebp-worker.js` and `sweep-worker/src/index.js` (2 copies). As of this update it is independently duplicated across **five** files: `worker/src/ebp-worker.js`, `sweep-worker/src/index.js`, `nse-worker/src/index.js` 🆕, `admin-worker/src/index.js` 🆕, `compute-worker/src/index.js` 🆕 — the drift risk the prior report noted (a staging/preview domain requiring edits to every copy) has grown proportionally with the worker count.
- 🆕 **`MAJOR_PAIRS`** (the 28-pair Market Breadth cross list) — the 2026-08-02 report described this as duplicated between `watchdog-worker/src/index.js` and `worker/src/ebp-worker.js`. Since the breadth-aggregation side moved to `compute-worker` this session, the second copy is now in `compute-worker/src/index.js` instead. **A new, smaller drift was introduced by this move**: `watchdog-worker/src/index.js`'s copy carries an in-code comment reading `"Same 28 cross-pairs as MAJOR_PAIRS in worker/src/ebp-worker.js"` — that comment is now factually wrong (the data moved to compute-worker) and was deliberately left as-is during the compute-worker extraction task, since the task's stated scope excluded touching `watchdog-worker`. Flagged here for a future cleanup pass; low priority since it's a comment, not a functional bug.
- `NSE_VALID_TFS`/`ALL_NSE_TF_ACCESS` duplication — unchanged bug risk from 2026-08-02, see Section 8's note on a possible third copy now in play via `admin-worker`.
- `CHUNK_SIZE`, `NY_4H_BOUNDARIES` — unchanged.
- Cron-job.org's schedule now **is** auditable from a code-adjacent source (this report, Section 2/10, backed by a live API read) but still isn't stored *in* the repo itself — a future schedule change made only via the cron-job.org dashboard would silently drift from this document again.

### Error handling gaps / silent failure risks
Unchanged from 2026-08-02, with one exception: the **T4 `endOfUTCMonthISO()` ReferenceError** documented in the prior section is now fixed (was an undiscovered gap as of 08-02, since the prior audit didn't catch it either). All other items (Watchdog→Yahoo fallback silent skip, `/nse/search` Upstox-silently-returns-`[]`, T4's weaker chain-dedup guard, `user_templates`'s ignored columns, `/health/datasources`'s no-known-caller, Clerk JWKS fetched with zero cross-worker caching — now **worse**, three independent per-worker JWKS caches instead of one) carry forward unchanged or slightly compounded by the worker split.

### Routes/features described in comments/docs but not implemented
Unchanged from 2026-08-02 — `user_indicator_settings.sma_forex_hours`, `nse_indicator_configs.day_filter`, and the dead `/upgrade` link all carry forward as-is. ~~the still-nonexistent Weekly Market Breadth aggregation~~ — **no longer true as of this same day's second session; see Section 11.** `README.md`'s staleness is now **worse** — it described 4 workers at the time of the prior audit; there are 6 now, none of the new two mentioned anywhere in it.

---

## Section 10 — Deployment & Operations

### Deploying each worker — 🆕 now 6, all redeployed live this session
```powershell
cd compute-worker;   npx wrangler deploy   # compute-worker — NEW
cd watchdog-worker;  npx wrangler deploy   # ebp-watchdog
cd admin-worker;     npx wrangler deploy   # admin-worker — NEW
cd nse-worker;       npx wrangler deploy   # nse-tracker
cd sweep-worker;     npx wrangler deploy   # sweep-detector
cd worker;           npx wrangler deploy   # ebp-tracker-worker — deployed LAST, deliberately
```
🆕 **Deployment ordering matters here in a way it didn't before**: `ebp-worker.js` was deployed *last*, only after the frontend's rebuild (picking up `VITE_ADMIN_WORKER_URL`/`VITE_NSE_WORKER_URL`) was confirmed live. The pre-refactor frontend build was still calling `ebp-worker.js` directly for `/admin/*`/`/nse/*` right up until its own redeploy — deploying the trimmed-down `ebp-worker.js` any earlier would have 404'd the Admin panel and NSE config UI for every user in the gap between the two deploys. This ordering constraint was identified and corrected before any deploy commands ran (an initially-proposed plan had `ebp-worker` deploying *before* the frontend).

Secrets were added mid-sequence, immediately after each worker's first deploy (Section 1's table): `WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID`/`CRON_SECRET` on `watchdog-worker`; `CLERK_SECRET_KEY` on both `admin-worker` and `nse-worker`; and — discovered only via `wrangler secret list` mid-session, not part of the original plan — `CRON_SECRET` on `compute-worker`, without which its 4 new `/cron/sma` cron-job.org jobs would have 403'd from the moment they were created.

Still no CI/CD pipeline exists in-repo for any worker (unchanged from 2026-08-02).

### Running a migration
Unchanged from 2026-08-02 — no migrations were run this session ("do not modify D1 schema" held for every task).

### cron-job.org configuration — 🆕 now confirmed via the REST API, not inferred
This session obtained a cron-job.org API key and used it directly (`GET/PUT/PATCH/DELETE https://api.cron-job.org/jobs`) to:
1. Repoint the existing "Watchdog Health Check" job's URL from `ebp-tracker-worker.../health/watchdog-check` to `ebp-watchdog.../health/watchdog-check` (`PATCH /jobs/{id}`, verified via a follow-up `GET`).
2. Create 4 new jobs on `compute-worker`, each built by reading its old `sweep-detector` counterpart's exact `schedule`/`extendedData` (headers, body) via `GET /jobs/{id}` first, then `PUT /jobs` with identical values except the URL — verified field-by-field against the original before deleting anything.
3. Delete the 4 old `/cron/sma` jobs on `sweep-detector` only after all 4 replacements were confirmed live.

One creation call failed silently mid-batch (an empty `{}` response with no `jobId`, likely a rate-limit or transient API hiccup) — caught by re-listing jobs immediately after and diffing against the expected 4, then retried successfully. This is worth noting as a general pattern for anyone scripting against this API: **always verify object counts after a batch of writes**, don't trust every individual response to be truthful about success.

The full current job list is in Section 2's cron schedule table — this replaces the 2026-08-02 report's "inferred from route TF acceptance" methodology with ground truth.

### Verifying a deployment worked — 🆕 6 health checks now
```
GET https://ebp-tracker-worker.aicube-apps.workers.dev/health
GET https://sweep-detector.aicube-apps.workers.dev/health
GET https://nse-tracker.aicube-apps.workers.dev/health
GET https://ebp-watchdog.aicube-apps.workers.dev/health
GET https://compute-worker.aicube-apps.workers.dev/health
GET https://admin-worker.aicube-apps.workers.dev/health
```
All 6 confirmed responding `200` with the expected `{status:'ok', worker:'<name>'}` shape (or close variant) immediately post-deploy this session. One transient false negative was observed: the very first `curl` to `compute-worker/health` right after its deploy returned a Cloudflare edge error (`error code: 1042`), which cleared on retry within seconds — attributed to normal global-propagation lag immediately after a fresh Worker deploy, not a real failure (a verbose retry showed a clean `200` with correct CORS headers). A similar transient was seen on `ebp-worker.js`'s post-deploy `/admin/users` probe (briefly `401` instead of the expected `404` from a stale edge node), which also cleared on retry.

Manual cron trigger and D1 query patterns for verification are unchanged from 2026-08-02.

### Cloudflare Pages (frontend) deployment
Mechanism unchanged (GitHub-integration-based, no `wrangler.toml`/`vercel.json` in `frontend/`). 🆕 Confirmed working end-to-end this session: committing all six workers' source changes plus the frontend `api.js`/`.env.example` updates (commit `d20aea3`, tag `deploy-2026-08-07-worker-split`), pushing to `main`, and adding `VITE_ADMIN_WORKER_URL`/`VITE_NSE_WORKER_URL` in the Pages dashboard triggered an automatic rebuild that the user confirmed was live before `ebp-worker.js` itself was deployed (see the ordering note above).

### Monitoring — 🆕 materially improved this session, one gap remains
The 2026-08-02 report's biggest flagged gap was: *"No delivery mechanism for `watchdog_log` contents to a human... this directly contradicts the roadmap's Phase H spec, which was never built."* That framing needs updating:

**Now covered**: `POST /health/watchdog-check`, now hosted on `watchdog-worker` itself, sends real Telegram alerts on failure (immediate), a 2-hourly all-clear, and a 17:00 NY EOD summary. Checks cover: most-recent `candle_cache` freshness (30 min threshold, unconditional — deliberately not market-hours-gated, since Watchdog's own fetch cron runs 24/7 including forex weekends when crypto still trades and `fetched_at` still updates even on Twelve-Data-returned stale bars); a dynamic active-symbol+TF candle-cache probe (2× TF-interval threshold); `swing_states`/`nse_swing_states` freshness (35 min, market-hours gated); `fvg_zones` (informational, event-driven, no hard failure) and `nse_fvg_zones` (same, corrected mid-session per the false-alarm writeup above); Market Breadth freshness (65 min); Forex SMA state freshness (35 min); NSE candle cache (20 min) and NSE SMA state (120 min). Verified live and producing real (not fabricated) failure/success data immediately post-deploy.

**Still not covered — the one gap that carries forward unchanged**: `watchdog_log` itself (Watchdog's own internal fetch/synthesis/key-rotation failure log) is still write-only with no delivery path to a human — an admin still has to query D1 directly to read it. The new `/health/watchdog-check` route is a *different*, independent mechanism (freshness probes against downstream tables, not a read of `watchdog_log`'s contents) — it would likely catch a Watchdog outage indirectly (stale `candle_cache` → Check A/B fail → alert), but does not surface *why* Watchdog failed, only *that* something downstream of it looks stale. Closing this specific gap (piping `watchdog_log` warning/error rows into a Telegram alert directly) remains unbuilt.

- `/health/datasources` — unchanged, still no confirmed frontend caller.
- No uptime/synthetic monitoring of the now-6 workers' `/health` endpoints found in-repo — unchanged, still presumed external if it exists at all.
- NSE Upstox-vs-Yahoo-fallback visibility — unchanged, still only the passive `/nse/status` badge.

---

## Section 11 — Weekly Market Breadth implementation + branch reconciliation (2026-08-07, second same-day session)

This session closed the Weekly Market Breadth gap noted throughout this report (Section 9's "still-nonexistent" note, above) and separately discovered and resolved a `main`/`coding` branch divergence left over from the worker-split refactor documented in the rest of this report — that refactor (commit `d20aea3`) landed only on `main`, while `coding` had two of its own independent bug-fix/docs commits on top of the pre-split code. Both pieces of work are recorded here together since the second (branch reconciliation) was discovered as a direct consequence of trying to ship the first.

### 11.1 — Weekly Market Breadth: compute → API → frontend

**Gap being closed** (diagnosed in an earlier pass this same day): `computeWeeklyBreadth()` in `compute-worker/src/index.js` already computed a completed-week average and wrote it to `market_breadth_cache` as `tf='1W'`, but (a) there was no in-progress "this week" figure, (b) `GET /market/breadth` in `worker/src/ebp-worker.js` hardcoded every query to `tf='1H'` and never read the `'1W'` row at all, and (c) the frontend's Weekly Strength section was a static placeholder that never fetched anything.

**`compute-worker/src/index.js`** (1111 → **1142** lines) — `computeWeeklyBreadth()` now also computes the current in-progress ISO week's running average from the same `market_breadth_intraday` rows already fetched for the completed-week calculation (no new D1 read), with no minimum-trading-day threshold (unlike the completed-week path's ≥3-day gate), and writes it as a second cache row: `INSERT INTO market_breadth_cache (tf, computed_at, heatmap, strength) VALUES ('1W_current', ?, '{}', ?) ON CONFLICT(tf) DO UPDATE ...`. Skipped entirely (no write, no clobber of a prior value) if the current week has zero trading days of data yet. The pre-existing `'1W'` write for the completed week is untouched.

**`worker/src/ebp-worker.js`** (repo-structure count above, 2241 lines, predates this change) — `GET /market/breadth` gained a new `nyTradingDayKey(tsMs)` helper (reuses the same `Intl` `shortOffset` NY-offset technique as the file's existing `nyDateAtHourToUTCms`, applied in the other direction: instant → NY wall-clock trading-day key, rolling over at 17:00 NY) and now returns two new top-level response fields, additive only — the existing `intraday` array and every other field are unchanged:
```
daily:  { today: {t, strength} | null, yesterday: {t, strength} | null }   — bucketed by NY trading day, not calendar date
weekly: { lastWeek: {strength, computed_at} | null, thisWeek: {strength, computed_at} | null }  — reads market_breadth_cache tf='1W'/'1W_current'
```
`daily.today`/`daily.yesterday` deliberately replace the *frontend's* prior client-side today/yesterday derivation (see below) — the old client-side logic used an approximate DST calculation and a single rolling session-start cutoff that could misbucket across weekends/holidays; the new server-side version buckets every row in the already-fetched 48h `intraday` window by trading-day key and takes the two most recent days that actually have data, which is correct across weekends by construction (though still bounded by the pre-existing 48h query window, unchanged per this task's explicit scope — a long weekend/holiday gap wider than 48h would still under-populate `yesterday`; flagged as a residual limitation, not fixed this session).

**`frontend/src/pages/MarketBreathPage.jsx`** (**+132 lines**) — Daily Strength's `todayStrength`/`yesterdayStrength` now read `data.daily.today.strength`/`data.daily.yesterday.strength` instead of being re-derived from the raw `intraday` array client-side; the chart JSX/colors/legend for both Intraday Strength and Daily Strength are otherwise byte-for-byte unchanged. The Weekly Strength placeholder is replaced with a live two-bar horizontal chart (This Week solid / Last Week faded), mirroring Daily Strength's recharts components, `CCY_COLORS`, and label styling exactly, with three null-safe render paths (both weeks null → "No weekly data yet"; only `thisWeek` null → Last Week bar only + a note; only `lastWeek` null → This Week bar only). A second `useEffect`/`setInterval` refetches and merges `data.weekly` on its own 4-hour cadence, independent of the existing 60-second full-refresh interval, with its own cleanup.

**Verification status — one gap, disclosed rather than fabricated**: `compute-worker` and `worker` were both redeployed and confirmed live (`/health` 200, `market_breadth_cache` queried directly via `wrangler d1 execute --remote`). However, live confirmation that the `'1W_current'` row actually populates, and a full authenticated `GET /market/breadth` response shape check, were **not completed this session** — the forex-weekend gate inside `handleMarketBreadthCron()` (Friday 17:00–Sunday 17:00 NY) was active for the entire session, suppressing every cron cycle before it reaches `computeWeeklyBreadth()`, and no Clerk bearer token was available in-session to call the authenticated route directly. Both are recommended follow-up checks once markets reopen.

### 11.2 — `main`/`coding` branch reconciliation

**What was found**: `coding` (local + `origin/coding`) had diverged from `main` at commit `3df2a47` — `main` progressed through the worker-split refactor (`d20aea3`, everything described in the rest of this report), while `coding` independently carried two of its own commits on the pre-split code (`a381484` "cleanup: bug fixes + tech debt removal," `ff0cac9` "docs: reconcile architecture report Section 9..."). This surfaced only because the Weekly Market Breadth edits above were made against `main`'s post-split file layout (`compute-worker/src/index.js` doesn't exist on `coding` at all), and the intended target branch for this work was `coding`.

**Resolution** — `main` was merged into `coding` (not the reverse, to preserve `coding`'s bug-fix commits as first-class history) and both real conflicts were resolved by tracing each side's content to its actual new home rather than blindly picking one side:
- `sweep-worker/src/sweep-cron.js` — `coding`'s still-present Forex/Crypto SMA Cloud cron block (~640 lines) was dropped; confirmed byte-equivalent logic already lives in `compute-worker/src/index.js` on `main` (Section 4 of this report already documents this move). `coding`'s own unrelated fixes elsewhere in the same file (the `fired_at` TEXT-ISO migration, the T4 dedup time-window fix — both from `a381484`) fell outside the conflicting hunk and were preserved automatically by git's 3-way merge.
- `worker/src/ebp-worker.js` — `coding`'s still-present `handleWatchdogHealthCheck()`/`POST /health/watchdog-check` and the entire `/admin/*` route block were dropped; both moves are already documented in this report (Section 1/2/9) as having relocated to `watchdog-worker` and `admin-worker`/`nse-worker` respectively. Two `coding`-only fixes inside those now-dropped blocks predated `main`'s split and were **not** present in the moved copies, so they were ported by hand into their new homes rather than silently lost:
  - `watchdog-worker/src/index.js` (1305 → **1333** lines) — gained a ported "Check A2" (internal `watchdog_log` error/warning check, originally `coding`'s "Check 1b"), inserted into the rewritten `handleWatchdogHealthCheck()` in the same relative position it held in the pre-split function.
  - `admin-worker/src/index.js` (396 → **399** lines) — gained the `ALL_NSE_TF_ACCESS` "SYNC NOTICE" comment `coding` had added, cross-referencing `nse-worker/src/nse-cron.js`'s `NSE_VALID_TFS` duplicate (Section 8/9's known duplication risk already documents the underlying issue this comment flags).

Both conflict resolutions and the two ported fixes were verified with `node --check` against all five touched files before committing. `main` was then fast-forwarded to the merge commit (no rewrite — `main` was a strict ancestor of the merged `coding`) and both branches pushed. The stray `origin/claude/ebp-tracker-codebase-audit-o4noyr` branch, left over from an earlier session, was deleted — `main` and `coding` are now the only two branches, local or remote, and are at the same commit.

**Report-file cleanup**: an uncommitted working-tree deletion of `EBP_Tracker_Architecture_Report_20260802.md` (superseded independently by `coding`'s own `20260802`→`20260806` rename, `ff0cac9`) had been stashed rather than force-resolved mid-merge, pending a decision on which report file to treat as canonical. That decision landed after this section was first drafted: this file (`...20260807.md`) is the canonical, actively-maintained report going forward; `EBP_Tracker_Architecture_Report_20260806.md` was deleted from the repo in the same pass that added this section, and the stash was dropped as moot.

---
