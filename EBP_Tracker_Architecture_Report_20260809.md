# EBP Tracker — Architecture & State Report

**Generated:** 2026-08-02, entirely from source code inspection and live D1 queries. **Updated:** 2026-08-07, following a same-day worker-topology refactor and production deployment (commit `d20aea3`, tag `deploy-2026-08-07-worker-split`) — two new workers were split out (`compute-worker`, `admin-worker`), `nse-worker` and `watchdog-worker` each absorbed routes previously owned by `worker/src/ebp-worker.js`, and all six workers were redeployed and smoke-tested against live traffic. Sections 1, 2, 5, 8, 9, and 10 were substantially rewritten to reflect the new topology; Sections 3, 4, 6, and 7 are carried forward from the 2026-08-02 audit largely unchanged (the database schema, detection algorithms, and frontend logic were not touched by this refactor) with only the route-ownership references corrected. Every specific fact newly stated below (line counts, route lists, configured secrets, cron-job.org job list) was re-verified directly against source and live infrastructure on 2026-08-07, not carried forward from the prior audit. Spec/roadmap docs were consulted only to flag divergences (marked ⚠️ DIVERGENCE), never as a source of truth for "what exists." Anything described in a code comment but not actually implemented is marked "documented but not implemented." **Further updated same day (2026-08-07, second session):** Weekly Market Breadth was implemented end-to-end (compute → API → frontend), and the `main`/`coding` branch divergence created by the worker-split refactor landing only on `main` was reconciled by merge. See **Section 11** for full detail; Section 9's prior note calling Weekly Market Breadth "still-nonexistent" is superseded by that section and struck through in place below. **Further updated 2026-08-09:** the site logo/favicon were replaced; a stale native Cloudflare cron trigger left over from the 2026-08-07 split (registered live on `ebp-tracker-worker` despite `wrangler.toml` no longer declaring it) was discovered and deleted; and `watchdog-worker`'s ETL (Twelve Data/Yahoo candle fetch, breadth/DXY/synthesis) was extracted from its native `scheduled()` cron into two new cron-job.org-triggered HTTP routes, retiring `watchdog-worker`'s native CF cron trigger entirely. See new **Section 12** for full detail, including what was and wasn't independently verified. **Further updated 2026-08-12:** a full verification pass compared this report, the `main` branch source, and live production (Cloudflare deployments, D1, and all 6 `/health` endpoints) directly against each other — no claim below was carried forward from memory. Stale line counts in Section 1's repo-structure table (left un-synced by Sections 11/12) were corrected in place. A critical divergence was found: `watchdog-worker`'s live deployed code was materially different from anything ever committed to this repository — see **Section 13** for the discovery and **Section 14** for the rebuild that resolved it (deployed and committed, `1c0242a`). **Same day, continued:** the rebuild's post-deploy verification surfaced a second, deeper issue — an undocumented native Cloudflare cron trigger (silently re-created 2026-08-10, the same day the above divergence was introduced) had been running an old, uncommitted version of the ETL entirely outside cron-job.org's visibility, leaving cron-job.org's own three Watchdog jobs disabled and 404ing for two days. Diagnosed and fixed — native trigger deleted, cron-job.org jobs re-enabled, end-to-end production traffic confirmed working — in **Section 15**. `compute-worker` was found to have the same class of undocumented-live-code problem (Section 9/13.3) — **also resolved same day**, once the user supplied the actual live deployed source directly: the divergence was exactly one function (`getYahooCandlesFromCache`) plus one call site, committed as-is (`787f736`), no redeploy needed since the live code was already correct. `worker` (ebp-tracker-worker), originally flagged the same way (Section 9/13.2) as two commits behind, turned out to be a **false positive** once the user supplied its actual live source too — full comparison found it byte-identical to committed `main`, including both supposedly-undeployed commits' changes; no fix was needed. As of this update, **every worker in the fleet is confirmed consistent between live deployment and this repository** — the first time this report can make that claim with direct evidence for all six, not inference from timestamps alone.

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
│   ├── src/ebp-worker.js           2358 lines  🆕 (2026-08-12 correction) — was reported 2241; grew via the
│   │                                08-07 second-session Weekly Breadth work (Section 11.1) and commit `fd62ff7`
│   │                                (08-08, market breadth historical selectors) — neither growth had been
│   │                                folded back into this table until now. **`fd62ff7` is committed on `main`
│   │                                but not yet deployed — see Section 13.1; production is still running the
│   │                                pre-`fd62ff7` build.**
│   └── wrangler.toml                 11 lines  — [triggers] native cron block removed 2026-08-07 (breadth moved out)
├── sweep-worker/                   — Sweep Worker (Cloudflare Worker "sweep-detector")
│   ├── src/index.js                 119 lines  — HTTP entrypoint, cron-only; POST /cron/sma route removed 2026-08-07
│   ├── src/sweep-cron.js           1156 lines  🆕 (2026-08-12 correction, was reported 1139)
│   │                                (Forex/Crypto SMA Cloud cron logic, ~630 lines, moved out to compute-worker)
│   └── wrangler.toml                 11 lines
├── nse-worker/                     — NSE Worker (Cloudflare Worker "nse-tracker")
│   ├── src/index.js                 406 lines  🆕 — was 62 lines; gained /nse/status, /nse/search, and all 4
│   │                                /user/nse-indicator-configs/* CRUD routes (+ Clerk auth, CORS) from ebp-worker.js
│   ├── src/nse-cron.js             1735 lines  🆕 (2026-08-12 correction, was reported 1732) — NSE EBP/Sweep/MSS/FVG, TDI, SMA Cloud
│   └── wrangler.toml                 16 lines  — secrets-documentation comment added 2026-08-07
├── watchdog-worker/                — Watchdog Worker (Cloudflare Worker "ebp-watchdog")
│   ├── src/index.js                1669 lines  🆕 (2026-08-12) — 846(ish)→1305 (2026-08-07, gained POST
│   │                                /health/watchdog-check) →1333 (2026-08-07 branch merge, Section 11.2)
│   │                                →1432 (2026-08-09: gained isForexClosedWindow(), POST /cron/candle-fetch,
│   │                                POST /cron/breadth-fetch; runWatchdog() stripped to a heartbeat — Section 12)
│   │                                →1669 (2026-08-12: rebuilt the DXY/Yahoo pipeline that had been running
│   │                                live but uncommitted since ~08-10; see Section 14)
│   └── wrangler.toml                  8 lines  🆕 (2026-08-09) — was 11; [triggers] block removed, native
│                                       */15 * * * * cron retired — see Section 12
├── admin-worker/                   🆕 NEW — Admin Worker (Cloudflare Worker "admin-worker")
│   ├── src/index.js                 399 lines  🆕 (2026-08-12 correction, was reported 396 here despite
│   │                                Section 11.2 already noting 399 — table simply wasn't synced) — all 14
│   │                                /admin/* routes + GET /health, own Clerk auth + CORS
│   └── wrangler.toml                  8 lines
├── compute-worker/                 🆕 NEW — Compute Worker (Cloudflare Worker "compute-worker")
│   ├── src/index.js                1142 lines  🆕 (2026-08-12 correction, was reported 1111 here despite
│   │                                Section 11.1 already noting 1142 — table simply wasn't synced) — Market
│   │                                Breadth (native hourly cron) + Forex/Crypto SMA Cloud (POST /cron/sma),
│   │                                absorbed from ebp-worker.js and sweep-cron.js
│   └── wrangler.toml                 11 lines  — [triggers] = ["5 * * * *"] (moved from worker/wrangler.toml)
├── frontend/                       — React 18 + Vite SPA, deployed to Cloudflare Pages
│   ├── src/App.jsx                   48 lines  — router
│   ├── src/main.jsx                  16 lines  — ClerkProvider bootstrap
│   ├── src/pages/                    8 files (Landing, Dashboard, Assets, Alerts, Settings, Admin, MarketBreathPage, NotFound)
│   ├── src/components/              16 files 🆕 (2026-08-12 correction, was reported 11 — this list was never
│   │                                re-verified since 08-02): AIAlertsPanel, ApiErrorAlert, AssetCard,
│   │                                BiasOverridePanel, ChainProgressBar, EBPConfigPanel, ExpiryBanner,
│   │                                FVGZoneIndicator, ForexSmaConfigPanel, Layout, NseSearchModal, PriceFeedPanel,
│   │                                SmaConfigPanel, SweepConfigPanel, TdiConfigPanel, TemplateCard — at least
│   │                                ChainProgressBar/FVGZoneIndicator/ForexSmaConfigPanel/TemplateCard were never
│   │                                previously listed in this report at all
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

Total source line count (`.js`/`.jsx` only, excluding `node_modules`/`dist`/`.wrangler`): **13,026 lines** 🆕 (2026-08-12, recounted a second time this same day after the `watchdog-worker` rebuild — was 12,789 earlier this session, "~12,300" before that) across 6 workers + frontend.

### Stack
- **Frontend**: React 18, Vite (`vite`/`@vitejs/plugin-react`), `react-router-dom` v6, `@clerk/clerk-react` (auth), `recharts` (Market Breadth charts only), `xlsx` (Alerts export only). ⚠️ **DIVERGENCE** (unchanged from 08-02): `README.md` claims "React + Vite + MUI" — there is no MUI dependency and zero `@mui` imports; all styling is hand-rolled CSS.
- **Backend**: 🆕 **6** independent Cloudflare Workers (was 4 on 2026-08-02), all zero-npm-dependency single-file (or single-file + one large cron-logic file) bundles, deliberately not importing from each other. Each of the two new workers (`compute-worker`, `admin-worker`) copies its shared helpers (CORS, `verifyClerkToken`, candle-cache readers, etc.) verbatim from `ebp-worker.js` rather than importing them — same "zero cross-package imports" convention as the original four.
- **Database**: Cloudflare D1 (SQLite), a single shared database `ebp-tracker-db` (id `b93b206a-5537-4d12-8c86-a4b2372aae7f`) bound as `DB` in all **six** workers' `wrangler.toml`. No schema changes this session.
- **Auth**: Clerk (`@clerk/clerk-react` frontend, hand-rolled JWKS-verification `verifyClerkToken()`). 🆕 Now duplicated verbatim in **three** worker files (`worker/src/ebp-worker.js`, `admin-worker/src/index.js`, `nse-worker/src/index.js`) rather than one — each with its own independent in-memory JWKS cache, so a JWKS refresh in one worker doesn't warm the cache in another (three separate 1-hour TTL caches, three separate cold-start Clerk API calls).
- **Scheduling**: 🆕 (2026-08-09) **down to one mechanism** — as of this update, cron-job.org HTTP triggers are the sole scheduling mechanism for every worker except `compute-worker`:
  1. **cron-job.org HTTP triggers** — `/cron/ebp`, `/cron/sweep`, `/cron/nse` (unchanged), `/cron/sma` (moved from `sweep-detector` to `compute-worker` 2026-08-07, 4 jobs recreated 1:1 by schedule), `/health/watchdog-check` (repointed from `ebp-tracker-worker` to `ebp-watchdog` 2026-08-07), and 🆕 (2026-08-09) `POST /cron/candle-fetch` (every 15 min) + `POST /cron/breadth-fetch` (hourly) on `ebp-watchdog` — see Section 12. Full verified job list in Section 10.
  2. **Native Cloudflare `[triggers]` cron** — **one worker only, verified 2026-08-12 via a direct `GET .../workers/scripts/{name}/schedules` sweep of all 6 workers** (Section 15 — the first time this report's "down to one" claim was checked against Cloudflare's live API rather than `wrangler.toml`/deploy-log inference): `compute-worker` (`5 * * * *`, hourly Market Breadth — moved from `worker/wrangler.toml` 2026-08-07). `watchdog-worker`'s `*/15 * * * *` native trigger was retired 2026-08-09 as originally documented in Section 12 — **but was silently re-created 2026-08-10T12:15:14Z** by the same undocumented deploy that introduced the `yahoo_candle_cache`/`dxy_candle_cache` divergence (Section 13.1/14), and stayed live and firing until this session found and deleted it again 2026-08-12 (Section 15). `watchdog-worker`'s `scheduled()` handler still exists (unchanged signature) and only runs a near-zero-CPU heartbeat, no ETL — true again now, but was *not* true 08-10 through 08-12 while the resurrected trigger was firing into the old, uncommitted inline-ETL code. `worker/wrangler.toml` has had no `[triggers]` block since 2026-08-07; its stale live Cloudflare-side registration (found and deleted 2026-08-09, Section 9/12) has stayed empty since, reconfirmed by this session's 2026-08-12 sweep.
- **Deployment**: `npx wrangler deploy` per worker, run directly this session for all 6 workers on 2026-08-07 (see Section 10 for the exact commands and verified output); `watchdog-worker` was redeployed twice more on 2026-08-09 (Section 12). Still no CI/CD pipeline in-repo. Frontend via Cloudflare Pages, GitHub-integration auto-build — confirmed 2026-08-07: pushing commit `d20aea3` to `main` triggered a rebuild that picked up the two new frontend env vars; confirmed again 2026-08-09 when the logo/favicon commit (`fd5f951`) was pushed (build success itself not independently re-verified post-push this session — see Section 12). 🆕 **2026-08-12 — deployment-vs-repo consistency, fully reconciled for all 6 workers.** `npx wrangler deployments list` timestamps alone are **not sufficient** to determine whether a worker's live code matches `main` — this session initially misread `ebp-tracker-worker`'s deploy (`2026-08-07T23:25:19Z`, predating commits `060350e`/`fd62ff7`) as stale, but direct comparison of the actual live source (supplied by the user) against committed `main` showed them byte-identical; the deploy simply predated the matching commit in wall-clock time (code deployed from an uncommitted working copy, committed minutes later) — see Section 13.2's correction. `compute-worker` and `watchdog-worker` were genuinely diverged (confirmed via real source, not timestamps alone) and both are now reconciled: `compute-worker` via a direct commit (`787f736`, no redeploy needed — the live code was already correct), `watchdog-worker` via a full rebuild, commit, and redeploy (`1c0242a`, `2026-08-12T06:45:17Z` — Section 14). **As of this update, all 6 workers are confirmed consistent between their live deployment and this repository.**

### Environment variables / secrets per worker (names only, `wrangler secret list` output, re-verified 2026-08-07, spot-checked again 2026-08-12 — exact match, see Section 13.4)

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
                    │  🆕 (2026-08-09) no native CF cron — all 3    │
                    │     routes below are cron-job.org HTTP       │
                    │     triggers, X-Cron-Secret gated             │
                    │                                               │
                    │  🆕 POST /cron/candle-fetch (every 15 min)    │
                    │     Twelve Data (M15/M30/1H/4H, signal        │
                    │     symbols) — forex/commodity skipped via    │
                    │     isForexClosedWindow() while forex is      │
                    │     shut; crypto still fetched 24/7           │
                    │       │                                       │
                    │       ▼                                       │
                    │  writeCandleCache() ──► D1: candle_cache      │
                    │                                               │
                    │  🆕 POST /cron/breadth-fetch (hourly)         │
                    │     Yahoo Finance (all Market Breadth pairs)  │
                    │     ──► D1: yahoo_candle_cache (🆕 08-12,      │
                    │     rebuilt — Section 14) ──► synthetic DXY    │
                    │     ──► D1: dxy_candle_cache (1H/4H/Daily/     │
                    │     Weekly, own table) ──► mirrored into       │
                    │     candle_cache (symbol='DXY') for any        │
                    │     consumer still reading candle_cache        │
                    │     directly; daily/weekly synthesis also      │
                    │     still runs the pre-existing generic path   │
                    │     — no weekend gate, runs regardless        │
                    │                                               │
                    │  POST /health/watchdog-check (own route,      │
                    │     X-Cron-Secret, cron-job.org every 15 min) │
                    │     reads candle_cache/swing_states/breadth/  │
                    │     forex_sma_state/NSE tables, alerts via    │
                    │     Telegram (WATCHDOG_BOT_TOKEN) on failure  │
                    │                                               │
                    │  scheduled() still exists (native cron        │
                    │  trigger retired) but only runs a heartbeat:  │
                    │  daily-digest gate + one logWatchdog() write  │
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
| Watchdog Worker | `ebp-watchdog` | `watchdog-worker/src/index.js` | 🆕 **4** routes (2026-08-09; was 2 as of 08-07, was 1 pre-08-07) — `/health`, `POST /health/watchdog-check`, 🆕 `POST /cron/candle-fetch`, 🆕 `POST /cron/breadth-fetch` | none, X-Cron-Secret 🆕 |
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

**Watchdog Worker routes** 🆕: `GET /health` (public), `POST /health/watchdog-check` (X-Cron-Secret) — moved here from `ebp-worker.js` 2026-08-07, with rewritten probe logic (Section 9/10). 🆕 (2026-08-09) `POST /cron/candle-fetch` (X-Cron-Secret) and `POST /cron/breadth-fetch` (X-Cron-Secret) — the ETL previously run inline inside the native `scheduled()` handler, extracted verbatim into these two routes; see Section 12. As of 2026-08-09, **all** of Watchdog Worker's business logic is externally HTTP-triggered via cron-job.org — its native `scheduled()` handler (still present, unchanged signature) now only does a lightweight daily-digest check plus a heartbeat log write.

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

Unlike the 2026-08-02 report (which could only infer the job set from what each route's TF validation accepted, since cron-job.org's own dashboard was unqueryable from code), the 2026-08-07 session obtained a cron-job.org API key and read the **actual live job list** directly (21 active jobs as of that date). 🆕 Two more jobs were added 2026-08-09 (Section 12) — **23 active jobs** as of this update:

| Route | Worker | Jobs | Schedule (UTC) |
|---|---|---|---|
| `POST /cron/ebp` | ebp-tracker-worker | 5 jobs (M15/1H/4H/1D/1W) | M15: `:01/:16/:31/:46`; 1H: `:01` hourly; 4H: hours `1,5,9,13,17,21` at `:01`; 1D: `21:01` Mon-Fri; 1W: `21:01` Fri |
| `POST /cron/sweep` | sweep-detector | 4 jobs (M15/M30/1H/4H) + 1 disabled (M5) | M15: `:02/:17/:32/:47`; M30: `:02/:32`; 1H: `:02` hourly; 4H: hours `1,5,9,13,17,21` at `:02` |
| `POST /cron/nse` | nse-tracker | 4 enabled jobs (M15/M30/1H/D) + 2 disabled (M1/M5) | all gated to NSE market-hours UTC windows (`3`–`10`), weekdays only |
| `POST /cron/sma` | compute-worker (moved from sweep-detector 2026-08-07) | 4 jobs (M15/M30/1H/4H) | M15: `:04/:19/:34/:49`; M30: `:04/:34`; 1H: `:04` hourly; 4H: hours `1,5,9,13,17,21` at `:04` — each new job created to exactly mirror its predecessor's schedule before the old one was deleted |
| `POST /health/watchdog-check` | ebp-watchdog (moved from ebp-tracker-worker 2026-08-07) | 1 job | every 15 min, `:03/:18/:33/:48` |
| 🆕 `POST /cron/candle-fetch` | **ebp-watchdog** (new 2026-08-09) | 1 job, id `8239654` | every 15 min, `:00/:15/:30/:45` |
| 🆕 `POST /cron/breadth-fetch` | **ebp-watchdog** (new 2026-08-09) | 1 job, id `8239655` | hourly, `:00` |

All jobs require the `X-Cron-Secret` header matching the target worker's `CRON_SECRET` secret.

🆕 **2026-08-12 correction**: the three `ebp-watchdog` jobs above (`/health/watchdog-check` id `8221243`, `/cron/candle-fetch` id `8239654`, `/cron/breadth-fetch` id `8239655`) were found **disabled** this session, live-verified via the cron-job.org API — not just "23 active jobs" as this table's 08-09 count assumed. Root cause and fix in **Section 15**; all three are re-enabled and confirmed as of this update. Every other job in this table (EBP/Sweep/NSE/SMA) was reconfirmed enabled in the same 2026-08-12 API sweep — this watchdog-specific disablement was isolated, not a fleet-wide issue.

**Cloudflare native crons** (ground truth via `GET .../workers/scripts/{name}/schedules` against the live Cloudflare API for all 6 workers, 2026-08-12 — see Section 15; superseded the prior `wrangler.toml`-only verification method, which this same finding shows is not sufficient on its own):
- 🆕 `watchdog-worker`: **none, as of 2026-08-12T07:5{9,58}Z** (deleted this session). Retired 2026-08-09 as Section 12 documented — **but silently re-created 2026-08-10T12:15:14Z** by the undocumented deploy behind Section 13.1/14's `yahoo_candle_cache` divergence, and stayed live, firing every 15 minutes, until this session found it (only possible once given a Cloudflare API token) and deleted it again. Its ETL runs exclusively via the three cron-job.org jobs below, all now confirmed enabled.
- `compute-worker`: `5 * * * *` — hourly, fires `handleMarketBreadthCron()` via `scheduled()`. Moved from `worker/wrangler.toml` 2026-08-07. Its live schedule's `modified_on` is `2026-08-10T12:15:26Z` — 11 seconds after `watchdog-worker`'s resurrected trigger's `created_on` — confirming the same 08-10 deploy session touched both workers together (Section 9's `compute-worker`/`getYahooCandlesFromCache` finding). **This is, once again, the only worker in the fleet with a live native Cloudflare cron trigger** — true today, but was not true 08-10 through 08-12.
- `sweep-worker`, `nse-worker`, `admin-worker`: confirmed empty schedules via the same 2026-08-12 API sweep — no `[triggers]` block, 100% cron-job.org/Clerk-JWT-driven, as expected.
- `worker` (ebp-tracker-worker): confirmed empty via the same sweep — the stale live schedule found and deleted 2026-08-09 (Section 9/12) has stayed empty since.

**The lesson this section now demonstrates twice** (`worker`'s stale schedule in Section 9/12, `watchdog-worker`'s resurrected one here): a `[triggers]` block's absence from `wrangler.toml`, and even a *prior* confirmed-empty `GET` on the live schedule, are each only a snapshot — neither is a durable guarantee. Any future session making scheduling claims from this report should re-verify against the live Cloudflare API rather than trusting this table indefinitely.

### Watchdog Worker vs EBP/Sweep/NSE/Compute Workers

| | Watchdog | EBP/Sweep/NSE/Compute |
|---|---|---|
| Purpose | External-data ETL (fetch → cache → synthesize) plus external health-check heartbeat | Signal detection + user alerting (+ compute-worker: breadth/SMA compute) |
| Trigger | 🆕 (2026-08-09) **100% cron-job.org, no native cron**: `POST /cron/candle-fetch` (every 15 min), `POST /cron/breadth-fetch` (hourly), `POST /health/watchdog-check` (every 15 min) — native `*/15 * * * *` CF trigger retired this date; `scheduled()` still exists but is now a heartbeat-only no-op | cron-job.org HTTP POST (`X-Cron-Secret`), + compute-worker's own native hourly cron for breadth |
| External APIs called | Twelve Data, Yahoo | none (EBP/Sweep/Compute read D1 only); NSE calls Upstox/Yahoo itself |
| Writes | `candle_cache`, `daily_candle_cache`, `weekly_candle_cache`, `api_key_state`, `api_call_log`, `watchdog_log` | `signals`, `chain_state`, `fvg_zones`/`nse_fvg_zones`, `swing_states`/`nse_swing_states`, `alert_history`, `bias_cache`, `forex_sma_state`, `market_breadth_*` |
| Alerts | 🆕 **Yes** — `POST /health/watchdog-check` sends Telegram alerts on any check failure, plus a 2-hourly all-clear and a 17:00 NY EOD summary. `watchdog_log` itself is still write-only, no delivery path (unchanged gap, see Section 10). | Telegram alerts via `SHARED_BOT_TOKEN` to `@EbP_Tracker_bot` |
| Secrets | 🆕 `CRON_SECRET`, `WATCHDOG_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` (was **none** on 08-02) | `CRON_SECRET`, `SHARED_BOT_TOKEN` (+Clerk on EBP/NSE/Admin) |

---

## Section 3 — Database Schema (ground truth)

**Table-by-table detail (FK relationships, cleanup cycles, per-table row counts) not re-audited this update** — the 2026-08-02 report's write-up of those is carried forward and should still be treated as accurate for schema *shape* per table. 🆕 **2026-08-12 correction — the table *count* was stale and has been corrected**: live D1 (`SELECT name FROM sqlite_master WHERE type='table'`, queried directly via `wrangler d1 execute --remote` this session) has **37** tables, not the 34 carried forward from 2026-08-02. The 2026-08-02 table list itself was not preserved verbatim in this report, so a full diff of which 3 tables are new isn't possible from this document alone.

🆕 **Two of those tables — `yahoo_candle_cache` and `dxy_candle_cache` — are now fully documented, both in D1 and in `watchdog-worker/src/index.js`** (as of commit `1c0242a`, 2026-08-12; see Section 14 for the full rebuild writeup):
- **`yahoo_candle_cache`**: `(symbol TEXT, tf TEXT, candles_json TEXT, fetched_at TEXT)`, PK `(symbol, tf)` — identical shape to `candle_cache`, but dedicated to Yahoo-sourced breadth-pair candles. Written by `fetchBreadthFromYahoo()`/`writeYahooCandleCache()`; read by `computeSyntheticDXY()`'s constituent lookups and by `compute-worker`'s Market Breadth cron (`getYahooCandlesFromCache()` — confirmed present in compute-worker's *live* deployment via a recovered fragment, Section 14, though still absent from compute-worker's *committed* source — see Section 9's compute-worker entry).
- **`dxy_candle_cache`**: `(tf TEXT, candle_time INTEGER, open/high/low/close REAL, created_at TEXT)`, PK `(tf, candle_time)` — a dedicated, self-contained, all-timeframe table for synthetic DXY (`tf` values `'1H'`/`'4H'`/`'Daily'`/`'Weekly'`, all in this one table — not the shared `daily_candle_cache`/`weekly_candle_cache`). Written by `computeSyntheticDXY()`, `seedDXYHistory()`, `synthesiseDXY4H()`, `synthesiseDXYDaily()`, `synthesiseDXYWeekly()`; mirrored into `candle_cache` (`symbol='DXY'`) by `writeDXYBlobsToCache()` for any consumer still reading `candle_cache` directly.

Live row counts elsewhere (e.g. "`fvg_zones` = 18 rows") are now over a week stale and were not re-queried for this update — treat any specific count from the prior report as "as of 2026-08-02," not current.

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

🆕 (2026-08-12) **A fourth Watchdog message format exists in the git-committed source and was missing from this report**: `sendWatchdogDailyDigest()` (`watchdog-worker/src/index.js`), gated inside `runWatchdog()` by `hour === 8` **plain UTC** (not NY-adjusted, unlike every other gate in the file — the code's own comment flags this explicitly). Format: `📊 Watchdog Daily Summary` / 24h counts of info·warning·error / last-run timestamp. Because `runWatchdog()` only runs from the native `scheduled()` handler, and `watchdog-worker/wrangler.toml` has had no `[triggers]` block since 2026-08-09 (Section 12), **this digest cannot currently fire at all in the code as committed** — it's dormant, not broken. (Whether the actual *live* deployed code still contains this function, an altered version, or something else entirely is unknown — see Section 13.1.) Worth noting since UTC 08:00 is IST 13:30 (afternoon) — if this gate is ever reconnected to a live trigger without first switching it to an NY-hour check (the same `Intl`-based pattern the EOD gate below already uses), it will fire at an arbitrary UTC time unrelated to market close, not "EOD."

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
- 🆕 (2026-08-09) **Site logo/favicon replaced**: `frontend/src/assets/logo.jpeg` and `frontend/public/favicon.jpeg` (both JPEG, replacing the prior placeholder SVGs) — `Layout.jsx`'s sidebar `<img>` import and `index.html`'s `<link rel="icon">` updated accordingly; old `logo.svg`/`favicon.svg` deleted (confirmed no other references before deletion). Purely cosmetic, no logic changed. `vite build` verified clean; the Cloudflare Pages rebuild itself was not independently re-checked post-push this session.

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

### ✅ (2026-08-12) RESOLVED — root cause found and fixed: an undocumented native cron trigger, not a code bug. See Section 15.
Originally flagged as "cron-job.org appears to have stopped calling `watchdog-worker`... likely not a code bug" (full original discovery preserved in Section 14.5). **Root cause, once the user supplied cron-job.org and Cloudflare API credentials**: the 2026-08-10T12:15 mystery deploy (Section 13.1/14.1) had re-registered a live native Cloudflare cron trigger (`*/15 * * * *`) on `ebp-watchdog` — the same trigger Section 12.3 had documented deleting back on 08-09 — and shipped code whose `fetch()` handler only implemented `/health`, no HTTP cron routes at all. Real ETL data had been flowing this whole time via that undocumented native trigger + inline logic, completely bypassing cron-job.org, whose three "Watchdog ..." jobs had accordingly gone quiet/disabled (getting `404`s against routes that didn't exist in that code). This session's rebuild deployed the *correct*, documented HTTP-route architecture — but didn't clear the leftover native trigger (same Cloudflare quirk Section 12.2 already documented: a `wrangler.toml` without `[triggers]` doesn't retroactively clear an existing live schedule), so the trigger kept firing into the new heartbeat-only `scheduled()`, and with cron-job.org's jobs disabled, nothing was left calling the ETL. **Fixed**: native schedule deleted via the Cloudflare API (`PUT .../workers/scripts/ebp-watchdog/schedules` with `[]`, confirmed empty via follow-up `GET`), and all 3 cron-job.org jobs re-enabled via `PATCH /jobs/{id}`. See **Section 15** for full verification.

### ✅ (2026-08-12) RESOLVED — `watchdog-worker`'s live-vs-repo divergence
Originally flagged the same day (see Section 13.1 for the full discovery writeup, preserved unchanged below for the record): production `watchdog-worker` was found actively writing to two D1 tables (`yahoo_candle_cache`, `dxy_candle_cache`) through functions that existed nowhere in this repo's git history, deployed from an uncommitted local working copy. **Status: rebuilt and redeployed this same session** — `seedDXYHistory`, `writeDXYBlobsToCache`, `synthesiseDXY4H`/`Daily`/`Weekly`, and a rewritten `computeSyntheticDXY`/`fetchBreadthFromYahoo` were reconstructed (grounded in recovered fragments of the real logic, not pure guesswork — see Section 14), committed (`1c0242a`), and deployed (`wrangler deploy`, `2026-08-12T06:45:17Z`). Repo and live deployment are now the same code for this worker. See Section 14 for full verification detail and residual caveats (a few small gaps were filled by reasonable inference, not recovered byte-for-byte).

### ✅ (2026-08-12) RESOLVED — `compute-worker`'s divergence, closed with the real deployed source (not a rebuild)
Originally found via a recovered fragment showing `compute-worker`'s Market Breadth cron reading breadth candles via `getYahooCandlesFromCache()`/`yahoo_candle_cache`, absent from committed source (`grep` returned zero matches) — the same class of problem `watchdog-worker` had, and, unlike that one, not fixed at the time (out of this session's original scope). **Resolved later the same session**: the user retrieved and supplied the complete, actual live deployed `compute-worker/src/index.js` directly from Cloudflare. Diffed line-by-line against committed `main` — the **only** functional difference was exactly the one predicted: `getYahooCandlesFromCache()` (one new function, reads `yahoo_candle_cache` with the same staleness-gating pattern as the existing `getCandlesFromCache()`) and one call-site change in `handleMarketBreadthCron()` (`getCandlesFromCache` → `getYahooCandlesFromCache` for the `MAJOR_PAIRS` read). Everything else — SMA Cloud logic, weekly breadth, routing, exports — matched the committed source byte-for-byte. Committed to `main` (`787f736`) with the exact real code, not an inference; **no redeploy was needed since this code was already live** — the commit brings the repo back in sync with production. This confirms the earlier guess ("very likely feeding `compute-worker`'s live breadth logic correctly") was exactly right: `watchdog-worker`'s rebuilt `fetchBreadthFromYahoo()` writes `yahoo_candle_cache`, which is precisely what `compute-worker`'s real live code reads.

### ✅ (2026-08-12) CORRECTED — `worker` (ebp-tracker-worker) is NOT behind; the deploy-timestamp heuristic gave a false positive here
Section 13.2 originally flagged `worker` as running stale code, reasoning from `wrangler deployments list`'s last-deploy timestamp (`2026-08-07T23:25:19Z`) predating commits `060350e` and `fd62ff7` (both touching `worker/src/ebp-worker.js`'s `/market/breadth` handler). **The user then supplied the complete, actual live deployed `worker/src/ebp-worker.js` source, retrieved directly from Cloudflare.** Read in full and compared function-by-function against every one of the committed file's 2,358 lines — including the exact `/market/breadth` handler (`nyTradingDayKey`, the daily/weekly bucketing, the full `{daily, today, yesterday, weekly:{weeks, lastWeek, thisWeek}}` response shape `fd62ff7`/`060350e` added) — **the two are identical.** No code changes were needed or made.

**Why the timestamp heuristic was wrong here**: re-querying `wrangler deployments list` confirmed the last deploy is still timestamped `2026-08-07T23:25:19Z`, genuinely before `fd62ff7`'s commit time (`23:37:29Z`, 12 minutes later) and `060350e`'s (`22:42:32Z`, deploy came 6 minutes after that one). The only explanation consistent with byte-identical live/committed source: the code was written locally, deployed to test (picking up whatever was in the working directory at that moment, uncommitted), and committed to git shortly after — deploy-before-commit in wall-clock time, but the same final content either way. **This is a real limitation of the deploy-timestamp-vs-commit-timestamp heuristic used throughout Section 13**: it correctly caught two genuine divergences (`watchdog-worker`, `compute-worker` — both confirmed via actual source comparison, not just timing) but produced one false positive here that only direct source comparison could rule out. Treat any future finding from this heuristic alone as a lead to verify, not a confirmed fact — exactly as Section 13's original framing for `watchdog-worker`/`compute-worker` already insisted on, and as this correction now demonstrates why.

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

### 🆕 Correction (2026-08-09): "no `[triggers]` block in source" ≠ "no live schedule on Cloudflare"
The 2026-08-07 report stated (Section 1/2) that `worker/wrangler.toml` "no longer has a `[triggers]` block... `ebp-worker.js` is now 100% cron-job.org-driven, no native cron." That was accurate about the *source file* but turned out to be incomplete: a live Cloudflare-side schedule (`"5 * * * *"`, `created_on: 2026-07-30`, `modified_on: 2026-08-05` — both dates predating the split) was still registered against `ebp-tracker-worker` as of 2026-08-09, discovered via `GET https://api.cloudflare.com/client/v4/accounts/{id}/workers/scripts/ebp-tracker-worker/schedules`. Deleting a `[triggers]` block from `wrangler.toml` and redeploying does not retroactively clear a schedule that predates the block's removal from a *live* deployed script — it has to be explicitly deleted via `PUT .../schedules` with an empty array (or the dashboard). This was verified safe to delete before deletion: `worker/src/ebp-worker.js`'s `export default` has no `scheduled()` handler at all (confirmed via grep — zero occurrences of the word `scheduled` in the file), so the orphaned trigger was firing into a dead handler every hour with no functional effect, just wasted invocations. Deleted 2026-08-09; confirmed via a follow-up `GET` showing `"schedules": []`. The exact same class of drift was then proactively checked for and confirmed absent on `ebp-watchdog` post-retirement (Section 12) — deleting *that* worker's schedule was done explicitly via the API rather than assuming the `wrangler.toml` edit alone would suffice, precisely because of this finding.

### 🆕 Disclosure (2026-08-09): the CPU-limit premise behind the Watchdog ETL extraction was not independently measured
Both the `compute-worker` `scheduled()` investigation (Section 12 context) and the `watchdog-worker` ETL-extraction work (Section 12) were undertaken on a stated premise — that native `scheduled()` cron invocations doing inline parallel HTTP fetches + D1 writes were exceeding Cloudflare's CPU-time limit. Neither premise was independently confirmed against real Cloudflare metrics/logs (no `wrangler tail` session or CPU-time dashboard reading was performed for either worker) — investigation of `compute-worker`'s specific claimed failure mode (a crash at ~0.1ms CPU, i.e. before any async work starts) found no code-level defect that would explain it, and that investigation was left unresolved, not fixed. The `watchdog-worker` refactor itself (moving ETL to HTTP-triggered routes) is sound as an architecture change regardless — cron-job.org-triggered `fetch()` invocations are functionally decoupled from the native `scheduled()` cron path either way — but readers should not take this report as confirming the original CPU-limit claim was verified true; it's recorded here as the stated rationale, not a measured fact.

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

**Verification status — one gap, disclosed rather than fabricated**: `compute-worker` and `worker` were both redeployed and confirmed live (`/health` 200, `market_breadth_cache` queried directly via `wrangler d1 execute --remote`). However, live confirmation that the `'1W_current'` row actually populates, and a full authenticated `GET /market/breadth` response shape check, were **not completed this session** — the forex-weekend gate inside `handleMarketBreadthCron()` (Friday 17:00–Sunday 17:00 NY) was active for the entire session, suppressing every cron cycle before it reaches `computeWeeklyBreadth()`, and no Clerk bearer token was available in-session to call the authenticated route directly. Both are recommended follow-up checks once markets reopen. 🆕 **2026-08-12 — the first of these two gaps is now closed**: `SELECT tf, computed_at FROM market_breadth_cache` (live, `wrangler d1 execute --remote`) returns three rows — `1H`, `1W`, and `1W_current` — confirming the in-progress weekly row is populating in production. The authenticated `GET /market/breadth` response-shape check still was not performed this session (same reason — no Clerk bearer token available) and remains open. Separately, note `worker`'s live deployment now trails `main` by one commit (`fd62ff7`) — see Section 1/13.1 — so this confirmation reflects `compute-worker`'s write path, not proof that the currently-deployed `ebp-worker.js` serves `1W_current` in its response.

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

## Section 12 — Site branding, orphaned-cron cleanup, and Watchdog ETL extraction (2026-08-09)

Three unrelated pieces of work landed this date, all on `main`, in this order.

### 12.1 — Site logo/favicon replacement
`frontend/src/assets/logo.jpeg` and `frontend/public/favicon.jpeg` replaced `logo.svg`/`favicon.svg` — `Layout.jsx:8`'s `logoSrc` import and `index.html`'s `<link rel="icon">` updated to match; both old SVGs deleted after confirming (via grep) no other references. Verified with `vite build` (clean, image bundled correctly) before committing. Commit `fd5f951`, pushed to `main`. Purely cosmetic — no route, schema, or cron behaviour touched.

### 12.2 — Orphaned `ebp-tracker-worker` native cron trigger: found and deleted
Investigating a reported near-zero-CPU crash on `compute-worker`'s `scheduled()` handler (unresolved — see Section 9's disclosure above) led to a comparison of `compatibility_date`/bindings across all four workers sharing the `"5 * * * *"` schedule string in their history. That comparison surfaced the drift documented in Section 9: `ebp-tracker-worker` still had a **live** Cloudflare-side cron schedule (`"5 * * * *"`) despite `worker/wrangler.toml` having had no `[triggers]` block since the 2026-08-07 split. Confirmed via `GET .../workers/scripts/ebp-tracker-worker/schedules` (returned exactly one schedule, `created_on: 2026-07-30`, `modified_on: 2026-08-05`); confirmed safe to remove by grepping `worker/src/ebp-worker.js` for `scheduled` (zero matches — `export default` has only a `fetch` handler, so the orphaned trigger had nothing to invoke). Deleted via `PUT .../schedules` with body `[]`; re-verified via a follow-up `GET` showing `"schedules": []`. No code or config change was needed for this piece — it was a Cloudflare-API-only cleanup of drift the 2026-08-07 refactor's `wrangler.toml` edit didn't reach.

### 12.3 — Watchdog Worker: ETL extracted from native `scheduled()` cron to cron-job.org HTTP routes
Stated rationale (not independently measured — see Section 9's disclosure): `watchdog-worker`'s native `scheduled()` handler was doing parallel Twelve Data/Yahoo HTTP fetches plus multiple D1 writes inline, and was reported to be exceeding Cloudflare's CPU-time limit on every tick.

**Code changes** (`watchdog-worker/src/index.js`, 1333 → **1432** lines):
- New helper `isForexClosedWindow(nowMs)` — NY-timezone Fri-17:00-through-Sun-17:00 gate, defined once, used only by the new candle-fetch route (not breadth-fetch, which deliberately has no weekend gate — matching prior `runWatchdog()` behaviour where breadth/DXY/synthesis always ran on `minute===0` regardless of forex hours).
- New `NY_4H_BOUNDARIES` constant hoisted to module scope (was a local `const` inside `runWatchdog()`) — needed by the new candle-fetch handler once the section that declared it was removed from `runWatchdog()`. Same value, relocated only.
- New `POST /cron/candle-fetch` (`handleCandleFetchCron()`) — the old `runWatchdog()` signal-symbol fetch block (`getSignalSymbols`, `getActiveKeys`, per-TF key assignment, the M15/M30/1H/4H `fetches[]` gating, `Promise.all`), extracted with `event.scheduledTime` replaced by `Date.now()` (no `event` object in an HTTP handler) and the new forex-closed-window gate layered on top: while forex is closed, a second D1 query (`SELECT symbol FROM user_assets WHERE symbol IN (...) AND asset_type='crypto'`) splits the signal-symbol pool so only crypto symbols are still fetched; if none remain, returns early and logs `'Forex closed + no crypto symbols — nothing to fetch'` without calling `Promise.all` on an empty set. Returns `{ok, symbols, tfs}` / `{ok:false, error}`.
- New `POST /cron/breadth-fetch` (`handleBreadthFetchCron()`) — the old `runWatchdog()` `minute===0` block (`fetchBreadthFromYahoo`, `computeSyntheticDXY`, `attemptDailySynthesis`, `cleanupApiCallLog`, the Friday-17:00-NY `attemptWeeklySynthesis` gate), extracted verbatim with the same `Date.now()` substitution. Returns `{ok:true}` / `{ok:false, error}`.
- `runWatchdog()` stripped to exactly three things: `_watchdogAlertEnv = env`, the pre-existing 08:00 UTC daily-digest gate (`sendWatchdogDailyDigest`), and one `logWatchdog(db, 'info', 'Watchdog scheduled tick — heartbeat')` call. `scheduled()`'s own signature and body are byte-identical to before.
- Both new routes wired into `fetch()`'s router, same `X-Cron-Secret === env.CRON_SECRET` pattern as every other cron route in the file.

**Config/infra changes**:
- `watchdog-worker/wrangler.toml`'s `[triggers]` block (`crons = ["*/15 * * * *"]`) removed entirely — deployed via `npx wrangler deploy`.
- The live Cloudflare-side schedule for `ebp-watchdog` was then explicitly deleted via `PUT .../workers/scripts/ebp-watchdog/schedules` with `[]` (not left to chance, given the Section 12.2/Section 9 finding that a `wrangler.toml` edit alone doesn't guarantee this) — confirmed via a follow-up `GET` showing `"schedules": []`. 🆕 **2026-08-12 correction**: this deletion did not stick. The undocumented 2026-08-10T12:15 deploy (Section 13.1/14) re-created this exact same `*/15 * * * *` schedule, and it stayed live and firing for roughly two days before this session found and deleted it again — see **Section 15**. The action taken here on 08-09 was correct and correctly verified *at the time*; it was undone by a later, unrelated, uncommitted deploy, not by any flaw in this step itself.
- Two new cron-job.org jobs created via `PUT https://api.cron-job.org/jobs`: **Job A** "Watchdog Candle Fetch" (id `8239654`, `POST /cron/candle-fetch`, every 15 min at `:00/:15/:30/:45` UTC) and **Job B** "Watchdog Breadth Fetch" (id `8239655`, `POST /cron/breadth-fetch`, hourly at `:00` UTC) — both created with `X-Cron-Secret`/`Content-Type` headers and body `{}`, matching the existing job pattern from the 2026-08-07 session (Section 10). Both individually re-fetched via `GET /jobs/{id}` post-creation and confirmed `enabled:true` with the correct URL/schedule/headers.

**Verification performed this session**:
- `node --check watchdog-worker/src/index.js` passed.
- Post-deploy: `GET /health` → `200`.
- `POST /cron/candle-fetch` with a real `X-Cron-Secret` → `{"ok":true,"symbols":2,"tfs":["M15"]}` (live, not simulated — 2 signal symbols configured at test time, M15 fired since the test minute wasn't a 30/60-min boundary).
- `POST /cron/breadth-fetch` → `{"ok":true}` (live).
- `SELECT symbol, tf, fetched_at FROM candle_cache ORDER BY fetched_at DESC LIMIT 10` via `wrangler d1 execute --remote` immediately after the two manual test calls above showed the top 10 rows (28 breadth pairs + DXY) timestamped within the same second as the test — confirms the new routes actually write real data, not just return `ok:true`.
- Both cron-job.org jobs confirmed present and correctly configured via individual `GET /jobs/{id}` calls (not just the creation response).

**What was *not* independently verified this session** (disclosed per this report's own standard, not fabricated as confirmed):
- The original CPU-time-exceeded claim that motivated this refactor — see Section 9's disclosure.
- The Cloudflare dashboard's cron-events UI for `ebp-watchdog` was not visually checked (no browser access) — the empty-schedule confirmation above is API-level, which is authoritative for "is a schedule registered," but a human visual check of the events log was not performed.
- The two new cron-job.org jobs' **first actual scheduled fire** (as opposed to the manual test calls made pre-job-creation) was not observed/confirmed within this session — job creation and the manual route tests happened in immediate sequence, but no follow-up check was made after enough real time had passed for cron-job.org itself to trigger a fire.
- The Cloudflare Pages rebuild triggered by the `fd5f951` (logo) push was not re-confirmed live post-push this session (unlike the 2026-08-07 session, which did confirm this explicitly).

**Net effect on the fleet-wide scheduling picture**: as of this report, `compute-worker` is the only remaining worker with a live native Cloudflare `[triggers]` cron. Every other worker — including `watchdog-worker`, previously the architecture's one consistent native-cron holdout since 2026-08-02 — is now 100% cron-job.org HTTP-triggered. Section 1's Stack/Scheduling bullet and Section 2's native-crons list above reflect this.

---

## Section 13 — 2026-08-12: full repo-vs-live-infrastructure verification audit

This report had drifted from both `main` and live production in small, ordinary ways (Section 1's line-count table not synced after Sections 11/12 landed — now corrected in place above) and in one serious way (below). Every fact in this section was obtained directly this session — `git log`/`git show` against `main`, `wc -l` and `grep` against the actual working tree, `wrangler deployments list` / `wrangler secret list` / `wrangler d1 execute --remote` against live Cloudflare/D1, and plain `curl` against all 6 public `/health` endpoints plus the Pages frontend. Nothing below is carried forward from a prior report or from model memory.

### 13.1 — 🐛 CRITICAL (✅ resolved same day — see Section 9 and Section 14): `watchdog-worker`'s live code has fully diverged from this repository

*The discovery writeup below is preserved as originally written, for the record — status as of the end of this session: rebuilt, committed (`1c0242a`), and redeployed (`2026-08-12T06:45:17Z`). Repo and live are now the same code for this worker. Treat everything below as a historical account of the discovery, not current state.*

**How this was found**: `wrangler deployments list` (run from `watchdog-worker/`) showed the worker's most recent deployment at `2026-08-11T12:30:48Z`, `Source: Upload` — a plain code upload, not a secret change. `git log -- watchdog-worker/` shows the last commit touching that directory is `9c63c95`, dated `2026-08-09T19:36:21+05:30` (`2026-08-09T14:06:21Z`). The deploy is **~22 hours after** the last commit, with a second undocumented deploy in between (`2026-08-10T12:15:12Z`). Neither deploy corresponds to any commit — nothing was pushed to `main` (or any branch) between `9c63c95` and now.

**What that deploy actually contains, established from live D1 state**: `SELECT * FROM sqlite_master WHERE type='table'` against the live `ebp-tracker-db` returns two tables that do not appear anywhere in `watchdog-worker/src/index.js` as committed — `yahoo_candle_cache` (schema: `symbol, tf, candles_json, fetched_at`, PK `(symbol, tf)`) and `dxy_candle_cache` (schema: `tf, candle_time, open, high, low, close, created_at`, PK `(tf, candle_time)`). Both are being written **right now**: `yahoo_candle_cache` has 29 rows, most recent `fetched_at = 2026-08-12T05:01:17Z`; `dxy_candle_cache` has 526 rows (516 `1H` + 10 `4H`), most recent `created_at = 2026-08-12T05:00:56Z` — both timestamps within minutes of this session's queries, i.e. an active cron is writing to them continuously.

`git log --all -p -S "dxy_candle_cache" ` (and the same for `yahoo_candle_cache`, `seedDXYHistory`, `writeDXYBlobsToCache`, `synthesiseDXY4H`, `synthesiseDXYDaily`, `synthesiseDXYWeekly`) returns **zero hits across every commit on every branch this repo has ever had.** These identifiers — table names, column layouts, and function names — have never existed in version control. The `watchdog-worker/src/index.js` actually deployed to production on 2026-08-11 is not derived from anything in this git history; it was authored and deployed from a local working copy outside the repo (or from a version of the repo that was never `git add`ed/committed/pushed).

**The git-committed version is not simply outdated — it takes a different architectural approach that appears to still be running in parallel.** The committed `computeSyntheticDXY()`/`fetchBreadthFromYahoo()` (read in full this session, `watchdog-worker/src/index.js:525-600`) write synthetic DXY and breadth candles as JSON-blob arrays into the single `candle_cache` table (`symbol='DXY'`), and this *also* checks out as live and fresh: `SELECT * FROM candle_cache WHERE symbol='DXY'` shows `1H`/`4H` rows fetched at `2026-08-12T05:01:20Z`, and `candle_cache` broadly has fresh `M15`/`1H` rows across dozens of symbols as recently as `2026-08-12T05:16:04Z`. So the live worker appears to be running **both** the committed `candle_cache`-blob approach **and** an uncommitted `yahoo_candle_cache`/`dxy_candle_cache` row-per-candle approach side by side — consistent with a mid-refactor local build that was deployed before being finished or committed.

**Why this matters immediately**: this repo's `watchdog-worker/src/index.js` (as read and analyzed earlier in this same session, and as it stands in `main` right now) is not a reliable description of what's actually running. A `wrangler deploy` run from this repo — including as the final step of the CPU-fix task this session was originally asked to do — **would overwrite the live `yahoo_candle_cache`/`dxy_candle_cache` write path with nothing**, silently breaking whatever downstream logic (DXY history seeding, blob synthesis for 4H/Daily/Weekly — function names `seedDXYHistory`/`writeDXYBlobsToCache`/`synthesiseDXY4H`/`synthesiseDXYDaily`/`synthesiseDXYWeekly` are known only because a separate task prompt this session described them, and their existence is now corroborated by the live table writes) currently depends on it. **No deploy of `watchdog-worker` should happen from this repo until the live source is recovered and reconciled into git.** Recovery options, not yet attempted: check for the missing code in shell history / editor autosave / a Cloudflare "Quick Edit" dashboard session on the machine that ran the 08-10/08-11 deploys; or, failing that, treat the live table-writing logic as a spec to be deliberately reimplemented and recommitted, informed by the live schemas captured above.

### 13.2 — `worker` (`ebp-tracker-worker`): ✅ (2026-08-12, corrected) NOT behind — deploy-timestamp inference was a false positive here

*Original reasoning, preserved for the record*: `wrangler deployments list` showed the last deploy at `2026-08-07T23:25:19Z`; `git log -- worker/` showed commit `fd62ff7` ("market breadth historical selectors, refresh animation, header UI fixes") at `2026-08-07T23:37:29Z` — 12 minutes after — and a second, earlier commit `060350e` (`2026-08-07T22:42:32Z`) also touching `worker/src/ebp-worker.js`'s `/market/breadth` handler, both seemingly undeployed. `git show --stat` confirmed both were real backend changes, not docs-only, so this was written up as a live frontend/backend mismatch with a recommended `wrangler deploy` fix.

**This conclusion was wrong, caught the same session**: the user retrieved and supplied the complete actual live source of `worker/src/ebp-worker.js` from Cloudflare. Read in full and compared line-by-line/function-by-function against every one of the committed file's 2,358 lines — they are identical, including the exact `/market/breadth` response shape (`nyTradingDayKey`, daily/weekly bucketing, `today`/`yesterday`/`weekly.weeks`/`thisWeek`/`lastWeek`) that `fd62ff7`/`060350e` added. Re-querying `wrangler deployments list` confirmed the deploy timestamp genuinely hasn't moved — so the only consistent explanation is that the code was written locally, deployed to test (picking up the then-uncommitted working directory), and committed to git minutes later: deploy-before-commit in wall-clock order, identical content either way. **No `wrangler deploy` was needed or performed** — the original recommendation was withdrawn.

This is a useful calibration for the rest of Section 13: the deploy-timestamp-vs-commit-timestamp heuristic correctly caught two *genuine* divergences below (`watchdog-worker` in 13.1, `compute-worker` in 13.3 — both independently confirmed via actual source, not timing alone) but produced this one false positive. Treat the heuristic as a lead worth checking, never as confirmation by itself.

### 13.3 — `compute-worker`: same deployed-after-last-commit pattern as 13.1 — ✅ (2026-08-12) confirmed, then resolved with real source, same session

`compute-worker`'s last deploy (`2026-08-10T12:15:23Z`) is also after its last commit (`060350e`, `2026-08-08T04:12:32+05:30`). *Originally written*: "no corroborating evidence... found to confirm the deployed code actually differs" — **superseded later the same day, twice over**: first, a recovered fragment (Section 14) showed `compute-worker`'s live Market Breadth cron reading via `getYahooCandlesFromCache()` from `yahoo_candle_cache` (confirmed absent from committed source via `grep`); then the user supplied the actual complete live source directly from Cloudflare, which was diffed line-by-line against `main` and found to differ in exactly that one function plus one call site — nothing else. Committed (`787f736`) — see Section 9's dedicated entry for full detail. Unlike `watchdog-worker`, no redeploy was needed here since the live code was already correct; only the repo was out of sync.

### 13.4 — What matched exactly (verified, not just carried forward)
- **Secrets**: `wrangler secret list` for all 6 workers returns exactly the secret names Section 1's table lists, worker-for-worker, including the two dead `WATCHDOG_*` secrets still sitting unremoved on `worker` (Section 9's "pending removal, not yet executed" is confirmed still true, 5+ days later).
- **Native cron triggers**: `grep -A2 triggers */wrangler.toml` across all 6 workers confirms `compute-worker` is the only one with a live `[triggers]` block (`crons = ["5 * * * *"]`); the other 5 have none — exactly as Section 2/9 state.
- **`/health` endpoints**: all 6 worker URLs plus `https://ebp-tracker.pages.dev` return `200` live. Response shapes mostly match `{status:'ok', worker:'<name>'}` as Section 10 describes, with one minor, already-hedged exception: `ebp-tracker-worker`'s `/health` omits the `worker` field entirely (`{"status":"ok","timestamp":...}`) — Section 10 already says "(or close variant)," so this isn't a new gap, just now specifically identified.
- **Frontend logo/favicon**: `curl https://ebp-tracker.pages.dev` serves `<link rel="icon" ... href="/favicon.jpeg">`, confirming Section 12.1's logo/favicon replacement is live.
- **`admin-worker`/`nse-worker`/`sweep-worker`**: their most-recent-touching commit is a later branch-reconciliation merge (`63490cc`, Section 11.2), which read as a possible deploy/commit gap at first glance — `git show 63490cc --stat` for these paths confirms it's `coding` catching up to content that was already part of `main`'s `d20aea3` and already deployed 2026-08-07; not a real gap.

### 13.5 — Not checked this session (disclosed, not assumed clean)
- Full route-by-route re-verification for `sweep-worker`/`nse-worker`/`admin-worker`/`compute-worker` (only structural facts — triggers, secrets, deploy timestamps — were checked; Section 2's per-worker route tables were not re-derived from source line-by-line this pass).
- D1 schema shape/FK/per-table row counts beyond the table-name list (Section 3's 08-02-vintage detail remains unverified beyond the table count correction above).
- cron-job.org's live job list — no API key was available this session (unlike 2026-08-07/09, which had one); Section 2/10's job tables are unverified as of this update.
- Live Cloudflare-side cron *schedule* registrations (as distinct from `wrangler.toml`'s `[triggers]` block) for any worker — checking this the way Section 12.2 did requires a raw Cloudflare API token, which this session deliberately did not extract from `wrangler`'s local credential store.
- Whether `worker/src/ebp-worker.js`'s live (pre-`fd62ff7`) `/market/breadth` response actually breaks or degrades gracefully against the already-live `fd62ff7` frontend — inferred as a real risk from the deploy-gap timing, not observed directly (no Clerk bearer token available to call the authenticated route).

---

## Section 14 — 2026-08-12 (same day, continued): `watchdog-worker` rebuild, redeploy, and a second full report pass

Section 13.1 documented discovering that `watchdog-worker`'s live production code had diverged from this repository. This section records what was done about it, plus a follow-up end-to-end re-verification of the whole report requested immediately after.

### 14.1 — Recovering real evidence, not just schema inference

Mid-task, the user located a separate, previously-unmerged session (branch `claude/ebp-tracker-codebase-audit-o4noyr`, dated 2026-08-10 — a read-only audit whose branch no longer exists, per Section 11.2's cleanup) and pasted its contents. That paste contained real recovered fragments of the missing logic, not just the D1 schemas Section 13.1 had already captured:
- Confirmed `computeSyntheticDXY` reads all 6 constituents from `yahoo_candle_cache` (not `candle_cache`), and that the original CPU-fix prompt's own text — legible in full once pasted — literally said *"the `INSERT OR IGNORE INTO dxy_candle_cache`... is unchanged,"* directly confirming that statement's existence in the real function.
- Confirmed `compute-worker`'s live Market Breadth cron reads breadth-pair candles via `getYahooCandlesFromCache()` from `yahoo_candle_cache` — exclusively, not `candle_cache`. This is what let this session conclude `fetchBreadthFromYahoo` should stop writing breadth pairs into the shared `candle_cache` at all (nothing downstream reads them there anymore) — see 14.2.
- Recovered near-complete bodies of `seedDXYHistory`, `synthesiseDXY4H`, `synthesiseDXYDaily`, `synthesiseDXYWeekly`, and `writeDXYBlobsToCache` (the last taking an *array* of timeframes, not one at a time — a detail that would not have been guessed).
- Established that `dxy_candle_cache` is a fully self-contained, all-timeframe table (`1H`/`4H`/`Daily`/`Weekly` — note the mixed-case strings, not `D`/`W`) — DXY's daily/weekly rows do **not** live in the shared `daily_candle_cache`/`weekly_candle_cache` tables. Also established that `'DXY'` staying in the *generic* `attemptDailySynthesis`/`attemptWeeklySynthesis([...signalSymbols, 'DXY'])` calls is intentional, parallel output, not redundancy to be removed — an earlier draft of the rebuild plan had incorrectly proposed removing it.

Small gaps that remained genuinely inferred (not recovered): `computeDXYCandle`'s exact body (written as the existing, unchanged ICE-formula math factored into a shared helper), `seedDXYHistory`'s exact guard condition (`COUNT(*) > 0` skip — a direct restatement of the original prompt's own "already has 500 rows" claim), and `fetchBreadthFromYahoo`'s exact new body (parallelized per the already-evidenced `Promise.all` pattern, writing via a new `writeYahooCandleCache` helper).

### 14.2 — What was built and deployed

All changes confined to `watchdog-worker/src/index.js`, committed as `1c0242a` on `main` (merged from a `Coding` working branch, fast-forward, then pushed):
- `fetchBreadthFromYahoo`: fetch phase parallelized (`Promise.all`, per-symbol `.catch` isolation); writes to `yahoo_candle_cache` via new `writeYahooCandleCache()`, no longer also writes breadth pairs into `candle_cache`.
- `computeSyntheticDXY`: rewritten to read only the latest closed candle per constituent via `json_extract(candles_json, '$[0]')` (the original CPU-fix prompt's Fix 1, now provably correct once the function only needs the latest tick, not full history), verifies all 6 constituents share one timestamp, computes via new shared helper `computeDXYCandle()`, `INSERT OR IGNORE`s one row into `dxy_candle_cache`.
- New `seedDXYHistory`, `synthesiseDXY4H`, `synthesiseDXYDaily`, `synthesiseDXYWeekly`, `writeDXYBlobsToCache` — reconstructed per 14.1, wired into `handleBreadthFetchCron` in the call order: breadth fetch → seed (no-op once seeded) → per-tick DXY → 4H/Daily/Weekly synthesis (each boundary-gated) + candle_cache mirror → generic daily/weekly synthesis (unchanged, DXY still included).
- `LIMIT 20` added to `attemptDailySynthesis`'s remaining un-limited `candle_cache` read (the original prompt's Fix 4).
- `sendWatchdogDailyDigest`'s EOD gate in `runWatchdog()` switched from hardcoded UTC hour 8 (IST ~13:30 afternoon, unrelated to NY close — matches a "fires at the wrong time" bug report) to a new `getNYHour()` Intl-based DST-aware check for NY 17:00, matching the pattern `handleWatchdogHealthCheck`'s own EOD gate already used correctly (the original prompt's Fix 5).

`node --check` passed before commit. Deployed via `cd watchdog-worker && npx wrangler deploy` — live version `6cc20415-01a5-4742-9f4c-3f8f4cf5e9cb`, deployed `2026-08-12T06:45:17Z`. `GET /health` confirmed `200` post-deploy. A baseline was captured immediately before/after deploy (`dxy_candle_cache` last write `2026-08-12T06:00:56Z`, from the pre-deploy code) to confirm against the next natural hourly `POST /cron/breadth-fetch` fire from cron-job.org — manual triggering wasn't possible this session (no `CRON_SECRET` value available, only the secret *name* via `wrangler secret list`). **This freshness confirmation was still in progress as this section was being written; see the addendum at the end of this section for the outcome.**

Coding branch was fast-forward merged into `main` and pushed (`9c63c95..1c0242a`) at the user's request ("deploy to main").

### 14.3 — Second full end-to-end pass, requested immediately after

The user then asked for a complete review of this whole report against the repo, explicitly: *"report should match what is in repo... report should reflect what is live in repo and report should reflect the repo as source of truth."* This pass re-verified (not re-derived from memory) the following, all directly against current `main` HEAD (`1c0242a`) and live infrastructure a second time:

- **Line counts, all 6 workers + `wrangler.toml`s**: re-run via `wc -l`. Only `watchdog-worker/src/index.js` changed (1432→1669, this session's rebuild); everything else matched Section 1's already-corrected figures from earlier the same day. Repo-wide total: **13,026 lines** (was 12,789 before the rebuild).
- **Deploy-vs-commit timestamps, all 6 workers**: re-run via `wrangler deployments list`. `watchdog-worker` now shows `2026-08-12T06:45:17Z` — matches its own last commit, divergence closed. All other workers' deploy/commit relationships unchanged from Section 13's findings.
- **`compute-worker`'s `yahoo_candle_cache` gap**: `grep -n "yahoo_candle_cache\|getYahooCandlesFromCache" compute-worker/src/index.js` against current `main` — zero matches, confirming (not just suspecting, as Section 13.3 originally hedged) the same live/repo divergence `watchdog-worker` had. Recorded in Section 9 and 13.3 as not-fixed/out-of-scope at the time this bullet was written — **resolved later the same session** once the user supplied the real live source directly (Section 9's `compute-worker` entry, commit `787f736`).
- **A second, earlier undeployed `worker` commit**: `git log --since=2026-08-07 -- worker/src/ebp-worker.js` surfaced `060350e` (2026-08-08, before `fd62ff7`), also touching `worker/src/ebp-worker.js` (+54 lines) and `compute-worker/src/index.js` (+31 lines) — `worker` production is two commits behind, not one. Recorded in Section 9 and 13.2.
- **Section 4's "detection logic unchanged" claim**: re-checked via `git log --since=2026-08-07` against `ebp-worker.js`/`sweep-cron.js`/`nse-cron.js` — the only touches were the two `worker`-only commits above (market breadth, not detection) and the already-accounted-for `63490cc` branch-reconciliation merge. Claim holds; no change needed to Section 4.
- **Frontend file inventory**: re-counted via `ls`. `App.jsx`/`main.jsx`/`pages/`(8)/`hooks/`(2)/`lib/`(3) all matched. `components/` did not: **16 files live, 11 claimed** (and the claimed list itself only named 12) — `ChainProgressBar.jsx`, `FVGZoneIndicator.jsx`, `ForexSmaConfigPanel.jsx`, and `TemplateCard.jsx` were never listed in this report at all, at any prior update. Corrected in Section 1.
- **D1 table count**: re-queried, still 37 (unchanged since the earlier-this-session correction) — `yahoo_candle_cache`/`dxy_candle_cache` are now also documented with full schema in Section 3, since they're real, committed, code-backed tables as of this rebuild rather than an unexplained live-only anomaly.
- **Secrets, `[triggers]` blocks, `/health` endpoints**: spot-re-checked, unchanged from Section 13.4's findings (all still match).

### 14.4 — Not checked in this second pass either (still disclosed, not assumed clean)
Everything Section 13.5 already listed as unchecked remains unchecked (cron-job.org's live job list, D1 FK/row-count detail beyond table names, live Cloudflare cron *schedule* registrations distinct from `wrangler.toml`). Additionally not checked this pass: a full route-by-route diff of `worker/src/ebp-worker.js`'s two undeployed commits' actual behavioral impact (beyond confirming they touched real backend code, not just frontend); whether `compute-worker`'s live `getYahooCandlesFromCache` path is now actually receiving fresh data from the rebuilt `watchdog-worker` (plausible — both target `yahoo_candle_cache` — but not directly observed via compute-worker's own logs/output, which this session has no access to).

### 14.5 — Addendum: post-deploy freshness confirmation — 🐛 BUG RISK, points at cron-job.org rather than the rebuild itself

A background poll ran every 90 seconds from `06:47Z` to `07:10Z` (15 checks, full window) waiting for a `dxy_candle_cache` write newer than the `06:00:56Z` pre-deploy baseline. **None appeared in the entire window** — spanning the `07:00` hourly boundary this job fired within a minute of, every hour, all day before the deploy (`00:00:34`, `01:01:16`, `02:01:19`, `03:01:16`, `04:01:17`, `05:01:17`, `06:01:21`).

**Broadened the check past just the code this session touched**, and found the same silence on a route this session never modified: `POST /cron/candle-fetch` (the M15/M30/1H/4H signal-symbol fetch, `handleCandleFetchCron`/`fetchSignalAndStore` — byte-identical to before this session's changes) last wrote to `candle_cache` at `06:31:05-06Z`, six symbols in one batch — consistent with its `:00/:15/:30/:45` cron-job.org schedule (Section 2). **Nothing since**, despite `:45` and `:00` boundaries having since passed. `GET /health` continued returning `200` throughout this whole window, confirming the Worker itself was up and reachable the entire time.

**Because a route this session never touched also went silent at essentially the same time as the rebuilt one, this points away from a bug in the `watchdog-worker` rebuild and toward cron-job.org itself no longer calling this worker** — for both jobs, starting right around this session's deploy (`06:45:17Z`, within a minute of the missed `06:45` `/cron/candle-fetch` tick). Plausible causes, none confirmed: cron-job.org auto-disabling a job after a failure coinciding with the ~15-second deploy window; an unrelated cron-job.org account/API issue; or something else entirely on cron-job.org's side. **This session has no cron-job.org API key (unlike the 2026-08-07/09 sessions) and no `CRON_SECRET` value (only the secret name, via `wrangler secret list`)**, so neither "check the job's live status/history on cron-job.org" nor "manually re-invoke the route to rule out an app-level bug" was possible. **Recommended next step: check the cron-job.org dashboard directly for both jobs' status/history/last-execution result around `06:45Z` onward.** Until that's done, treat the `watchdog-worker` rebuild as deployed and structurally sound (`node --check` passed, `/health` is live, the code review in 14.1-14.2 was thorough) but **not yet confirmed working end-to-end against real cron traffic**.

A second, unrelated anomaly surfaced while checking this: `watchdog_log`'s `"Watchdog scheduled tick — heartbeat"` entries (from the native `scheduled()` cron, not the HTTP routes) show a large gap — firing every 15 minutes through `2026-08-10T12:00:59Z`, then **nothing until `2026-08-12T06:46:00Z`** (shortly after this session's deploy), then again at `07:00:43Z`. Section 12.3 documented explicitly deleting `watchdog-worker`'s live Cloudflare-side cron schedule on 2026-08-09 via the Workers API, confirmed empty via a follow-up `GET`; this session's `watchdog-worker/wrangler.toml` still has no `[triggers]` block. **Update: this was fully confirmed and resolved later the same session — see Section 15.** The speculative explanation below turned out to be exactly right: Section 9/12.2 already documented that a `wrangler.toml` `[triggers]` removal doesn't retroactively clear an already-registered live Cloudflare schedule, and the 2026-08-10 undocumented deploy (Section 13.1/14.1) had indeed re-registered one. Checking Cloudflare's actual live schedule registration for `ebp-watchdog` (the way Section 12.2 did for `ebp-tracker-worker`) resolved this but required a Cloudflare API token, which this session did not have at the time this paragraph was first written — the user supplied one shortly after, prompting Section 15.

---

## Section 15 — 2026-08-12 (same day, continued): root cause found and fixed — an undocumented native cron trigger, not the rebuild

Section 14.5 left two open items: `watchdog-worker`'s ETL not firing since the redeploy, and an unexplained gap-then-resume pattern in native `scheduled()` heartbeat logs. The user supplied a cron-job.org API key and a Cloudflare API token to resolve both. This section documents the diagnosis, both fixes applied, and verification — the API keys/tokens themselves are not recorded anywhere in this report or in the repo.

### 15.1 — Diagnosis

**cron-job.org job status** (`GET https://api.cron-job.org/jobs`, all 24 jobs read): all three `ebp-watchdog` jobs — `Watchdog Candle Fetch` (`8239654`), `Watchdog Breadth Fetch` (`8239655`), `Watchdog Health Check` (`8221243`) — were **disabled**. Every other job in the fleet (EBP ×5, Sweep ×4 + 1 intentionally-disabled M5, NSE ×4 + 2 intentionally-disabled M1/M5, SMA ×4) was enabled, exactly as Section 10 already documents — the disablement was isolated to the three Watchdog jobs.

**Execution history didn't match `watchdog_log`'s evidence, and that mismatch was the key clue**: `GET .../jobs/8239655/history` showed only 5 entries, all `404 Not Found`, most recent `2026-08-11T14:00:49Z`; `Watchdog Candle Fetch` and `Watchdog Health Check` had **zero** history entries at all. Yet `watchdog_log` had recorded successful hourly `"Breadth fetch complete"` writes continuing all the way through `2026-08-12T06:01:21Z` — 16 hours past cron-job.org's own last recorded attempt. Since nothing else in the code calls that exact log line, something other than these cron-job.org jobs had to be producing that data.

**`GET https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/ebp-watchdog/schedules` supplied the answer**: a live native cron trigger, `*/15 * * * *`, `created_on: 2026-08-10T12:15:14Z`. Section 12.3 (2026-08-09) had documented deleting this exact schedule and confirming it empty — this timestamp shows it was **silently re-created the very next day** by the same undocumented deploy responsible for the `yahoo_candle_cache`/`dxy_candle_cache` divergence (Section 13.1/14). A sweep of all 6 workers' live schedules confirmed the rest of Section 12/Section 9's claims still held (`ebp-tracker-worker`/`sweep-detector`/`nse-tracker`/`admin-worker`: empty; `compute-worker`: `5 * * * *` as documented) — **with one added detail**: `compute-worker`'s schedule `modified_on` is `2026-08-10T12:15:26Z`, 11 seconds after `watchdog-worker`'s `created_on` — confirming the same 08-10 deploy session touched both workers, corroborating Section 9's separately-confirmed finding that `compute-worker`'s live Market Breadth logic (`getYahooCandlesFromCache`/`yahoo_candle_cache`) is also absent from its committed source.

**Full causal chain, now fully evidenced rather than speculative**:
1. 2026-08-10T12:15 — an uncommitted deploy shipped `watchdog-worker` code matching the pre-08-09 architecture (recovered fragment, Section 14.1: `fetch()` only implements `/health`, no HTTP cron routes at all; `scheduled()`→`runWatchdog()` does the full inline ETL — signal fetch, breadth fetch, DXY, synthesis — directly), and its `wrangler.toml` still had `[triggers] crons = ["*/15 * * * *"]`, re-registering the schedule Section 12.3 had deleted the day before.
2. From that point, real data flowed continuously via this undocumented native trigger, invisible to cron-job.org entirely. cron-job.org's three Watchdog jobs — calling routes that didn't exist in that code — got `404`s and were disabled (by cron-job.org or a person) as a result.
3. 2026-08-12T06:45:17 — this session's rebuild deployed the *correct*, documented HTTP-route architecture (this repo's `watchdog-worker/src/index.js` as committed, `1c0242a`). But a `wrangler.toml` with no `[triggers]` block doesn't clear an already-live schedule (the same Cloudflare quirk Section 12.2 already documented) — so the resurrected `*/15` trigger kept firing, now into the new heartbeat-only `scheduled()` (hence the `06:46:00`/`07:00:43`/etc. heartbeat entries), while cron-job.org's disabled jobs sat idle. Net effect: nothing was left calling the ETL logic at all — not a defect in the rebuild itself, which was architecturally correct per the documented design the whole time.

### 15.2 — Fixes applied

1. **Deleted `ebp-watchdog`'s live native schedule**: `PUT https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/ebp-watchdog/schedules` with body `[]`. Verified via immediate follow-up `GET` showing `"schedules": []`.
2. **Re-enabled all 3 cron-job.org Watchdog jobs**: `PATCH https://api.cron-job.org/jobs/{id}` with body `{"job":{"enabled":true}}`, run individually per job (`8239654`, `8239655`, `8221243`), each returning `200`. Verified via a follow-up `GET /jobs` showing all three `"enabled":true`.

### 15.3 — Verification

`node --check` / code-level verification for the rebuild itself is unchanged from Section 14.2 — this section is about the scheduling layer, not the code. Native-schedule deletion confirmed: no `scheduled()` heartbeat entry appeared for the `08:00` tick that would otherwise have fired one (last heartbeat `07:45:43Z`).

### 15.4 — ✅ Post-fix confirmation: both cron-job.org jobs fired successfully on their first tick after re-enabling

A background poll (started immediately after re-enabling all 3 jobs, checking every 90s) caught the first `:00` boundary cleanly:

| Signal | Pre-fix baseline | First post-fix write |
|---|---|---|
| `watchdog_log` "Breadth fetch complete" | `2026-08-12T06:01:21Z` | `2026-08-12T08:00:5{7,8}Z` (implied by table writes below; `POST /cron/breadth-fetch` succeeded) |
| `candle_cache` M15 (signal fetch) | `2026-08-12T06:31:06Z` | `2026-08-12T08:00:53Z` |
| `yahoo_candle_cache` (all 29 breadth pairs) | `2026-08-12T06:01:17Z` | `2026-08-12T08:00:58Z` |
| `dxy_candle_cache` `tf='1H'` | 517 rows, latest `06:00:56Z` | **518 rows** (one new row appended via `INSERT OR IGNORE`), latest `08:01:00Z` — confirms `computeSyntheticDXY`'s rewritten `json_extract`-based read + single-row insert works correctly end-to-end in production |
| `candle_cache` `symbol='DXY', tf='1H'` (mirror) | `2026-08-12T06:01:20Z` | `2026-08-12T08:01:00Z` — confirms `writeDXYBlobsToCache` works |
| `dxy_candle_cache` `tf='4H'` | 10 rows, latest `05:01:19Z` | unchanged — **correct**, `synthesiseDXY4H` only runs at `NY_4H_BOUNDARIES` hours, not due at this tick |

**This closes out both of this session's open verification items** (Section 9's two 2026-08-12 entries): the `watchdog-worker` rebuild is now confirmed working end-to-end against real production cron traffic, not just deployed and code-reviewed. The native-schedule/cron-job.org-disablement issue is fully resolved, with root cause identified rather than papered over.

---
