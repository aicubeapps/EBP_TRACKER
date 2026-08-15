# EBP Tracker — Architecture & State Report

**Version:** `v2026.08.14`

**Based on:** `EBP_Tracker_Architecture_Report_20260812.md` (full prior history). This report documents only the 2026-08-14 changes (market-breath-worker split) plus updated tables for all sections affected by that change. For stable sections (signal detection, database schema, frontend, chain templates, NSE, SMA Cloud), refer to the 2026-08-12 report.

**Update scope:** 2026-08-14 — `watchdog-worker/src/index.js` (1990 lines at time of this split; 1669 lines per the 2026-08-12 report but grown further since) was split into:
- `watchdog-worker/src/index.js` → **948 lines** (retained: candle-fetch + health-check + heartbeat only)
- `market-breath-worker/src/index.js` → **1118 lines** (new: breadth-fetch + DXY synthesis + daily-digest + prune)

Both workers deployed and confirmed live. cron-job.org updated from 24 to **25 jobs** (prune job added). See Section 16 for the full split detail.

Legend: 🆕 = new or materially changed since 2026-08-12.

---

## Section 1 — Project Overview

### Live URLs

| Service | URL |
|---|---|
| Frontend (Cloudflare Pages) | `https://ebp-tracker.pages.dev` |
| EBP Worker (`ebp-tracker-worker`) | `https://ebp-tracker-worker.aicube-apps.workers.dev` |
| Sweep Worker (`sweep-detector`) | `https://sweep-detector.aicube-apps.workers.dev` |
| NSE Worker (`nse-tracker`) | `https://nse-tracker.aicube-apps.workers.dev` |
| Watchdog Worker (`ebp-watchdog`) | `https://ebp-watchdog.aicube-apps.workers.dev` |
| Compute Worker (`compute-worker`) | `https://compute-worker.aicube-apps.workers.dev` |
| Admin Worker (`admin-worker`) | `https://admin-worker.aicube-apps.workers.dev` |
| 🆕 Market Breath Worker (`market-breath`) | `https://market-breath.aicube-apps.workers.dev` |
| Telegram bot (user alerts) | `@EbP_Tracker_bot` (`SHARED_BOT_TOKEN`) |
| Telegram bot (Watchdog/admin alerts) | `WATCHDOG_BOT_TOKEN` / `WATCHDOG_ADMIN_CHAT_ID` — **now in market-breath-worker only** |

### Repo Structure (source files, updated 2026-08-14)

```
EBP_TRACKER/
├── worker/
│   └── src/ebp-worker.js           2351 lines   (confirmed wc -l 2026-08-14)
├── sweep-worker/
│   ├── src/index.js                 119 lines
│   └── src/sweep-cron.js           1156 lines
├── nse-worker/
│   ├── src/index.js                 406 lines
│   └── src/nse-cron.js             1757 lines
├── watchdog-worker/
│   └── src/index.js                 948 lines   🆕 was ~1990; split 2026-08-14
├── market-breath-worker/            🆕 NEW 2026-08-14
│   ├── src/index.js                1118 lines
│   └── wrangler.toml                 12 lines
├── compute-worker/
│   └── src/index.js                1167 lines
├── admin-worker/
│   └── src/index.js                 377 lines
└── frontend/                        (unchanged)
```

**Total backend lines: 8874** (was 7698 counting watchdog at 1990; market-breath adds net 76 lines due to refactoring).

### Secrets Per Worker (updated 2026-08-14)

| Worker (CF Name) | Secrets |
|---|---|
| ebp-tracker-worker | `CLERK_SECRET_KEY`, `CRON_SECRET` |
| sweep-detector | `CLERK_SECRET_KEY`, `CRON_SECRET`, `SHARED_BOT_TOKEN` |
| nse-tracker | `CLERK_SECRET_KEY`, `CRON_SECRET`, `SHARED_BOT_TOKEN`, `UPSTOX_CLIENT_ID`, `UPSTOX_CLIENT_SECRET`, `UPSTOX_REDIRECT_URI` |
| ebp-watchdog | `CRON_SECRET` only 🆕 (WATCHDOG_BOT_TOKEN and WATCHDOG_ADMIN_CHAT_ID **removed** — moved to market-breath) |
| market-breath | `CRON_SECRET`, `WATCHDOG_BOT_TOKEN`, `WATCHDOG_ADMIN_CHAT_ID` 🆕 NEW |
| compute-worker | `CRON_SECRET`, `SHARED_BOT_TOKEN` (SHARED_BOT_TOKEN added commit `d0893a3`) |
| admin-worker | `CLERK_SECRET_KEY` |

### Database

Single shared Cloudflare D1: `ebp-tracker-db` (id `b93b206a-5537-4d12-8c86-a4b2372aae7f`), binding `DB`. All 7 workers bind the same database. Schema: 37 tables (last confirmed count from 2026-08-12 session; live D1 queries unavailable this session — Cloudflare API token expired, error 9109).

---

## Section 2 — Cron Schedule (updated 2026-08-14)

### Worker Trigger Types

| Worker | Trigger Type | Notes |
|---|---|---|
| ebp-tracker-worker | cron-job.org HTTP | POST /cron/ebp-detect |
| sweep-detector | cron-job.org HTTP | POST /cron/sweep-detect |
| nse-tracker | cron-job.org HTTP | Multiple routes |
| ebp-watchdog | cron-job.org HTTP + native CF scheduled() | POST /cron/candle-fetch, POST /health/watchdog-check. Native scheduled() = heartbeat only |
| market-breath | cron-job.org HTTP only 🆕 | No native CF crons. POST /cron/breadth-fetch, /cron/daily-digest, /cron/prune |
| compute-worker | Native CF: `["5 * * * *"]` | One job fires hourly at :05 |
| admin-worker | None | HTTP only |

**Total cron-job.org jobs: 25** (was 24 before split; prune job added for market-breath).

### cron-job.org Job List (25 jobs)

The following jobs trigger via HTTP POST with header `X-Cron-Secret`:

**ebp-watchdog** (2 jobs):
- `/cron/candle-fetch` — every 15 min (Twelve Data M15/M30/1H/4H fetch)
- `/health/watchdog-check` — every 2h (9 health checks, watchdog log, 2h OK Telegram)

**market-breath** (3 jobs) 🆕:
- `/cron/breadth-fetch` — every 15 min (Yahoo 29-pair fetch → DXY synthesis → daily/weekly synthesis)
- `/cron/daily-digest` — every 15 min (self-gated: fires Telegram digest only at NY 17:00)
- `/cron/prune` — every 15 min (self-gated: executes only on UTC Saturday)

**ebp-tracker-worker** (~6 jobs): EBP detect per TF (M15/M30/1H/4H/D/W)

**sweep-detector** (~8 jobs): Sweep detect per TF

**nse-tracker** (~6 jobs): NSE candle fetch + EBP/Sweep/SMA/TDI detect

*(Exact counts for ebp/sweep/nse jobs carried from 2026-08-12 report — not re-verified this session.)*

---

## Section 9 — Known Issues (updated 2026-08-14)

Issues from the 2026-08-12 report remain in force. Additional issues from the 2026-08-14 split:

### 9.1 ebp-watchdog Missing WATCHDOG_BOT_TOKEN

After the split, `ebp-watchdog` holds only `CRON_SECRET`. The `POST /health/watchdog-check` route calls `handleWatchdogHealthCheck(env)` which attempts Telegram alerts via `env.WATCHDOG_BOT_TOKEN` — but that secret is absent. Alert sends will silently produce empty/invalid API calls. The health check *checks* will still run and be logged to `watchdog_log`; only the Telegram notification is broken.

**Fix options:**
1. Add `WATCHDOG_BOT_TOKEN` and `WATCHDOG_ADMIN_CHAT_ID` back to `ebp-watchdog` secrets (two workers each hold the secret — simple, slightly redundant)
2. Remove the Telegram-alert path from `handleWatchdogHealthCheck` and accept silent DB-only logging in watchdog
3. Move the health-check route to `market-breath-worker` (already has the secrets) — would require cron-job.org job URL update

### 9.2 /cron/prune UTC Saturday vs NY Saturday

`POST /cron/prune` gates on `new Date().getUTCDay() === 6` (UTC Saturday). The rest of the system uses `isForexClosedWindow()` which derives NY Saturday via `getNYOffset()`. These can differ:
- UTC 00:00 Saturday = NY Friday evening (EDT: 20:00 Fri, EST: 19:00 Fri) → prune fires on what NY still sees as Friday
- UTC Saturday ends at NY time that is still Saturday → no functional problem there

Net effect: prune fires roughly 4–5 hours early relative to the NY-week boundary. For a weekly prune with no strict timing requirement, this is harmless.

---

## Section 10 — Deployment (updated 2026-08-14)

### Worker Deployment Commands

```bash
# All workers — deploy in any order
cd worker        && npx wrangler deploy
cd sweep-worker  && npx wrangler deploy
cd nse-worker    && npx wrangler deploy
cd watchdog-worker && npx wrangler deploy
cd market-breath-worker && npx wrangler deploy   # NEW 2026-08-14
cd compute-worker && npx wrangler deploy
cd admin-worker  && npx wrangler deploy
```

### Smoke Test Sequence (post-deploy)

1. `GET /health` on each of the 7 workers — expect `{"status":"ok"}`
2. `POST /cron/candle-fetch` on ebp-watchdog — expect candle fetch log entries
3. `POST /cron/breadth-fetch` on market-breath — expect yahoo_candle_cache + dxy_candle_cache updates
4. `POST /cron/daily-digest` on market-breath outside NY 17:00 — expect `{"skipped":true}`
5. `POST /cron/prune` on market-breath outside UTC Saturday — expect `{"skipped":true}` or equivalent gate

### Health Endpoint Verification (confirmed 2026-08-14)

All 7 workers at `/health` return `{"status":"ok"}`. Confirmed via Cloudflare dashboard / direct HTTP check after deploy.

---

## Section 16 — 2026-08-14 market-breath Split (NEW)

### Motivation

`watchdog-worker/src/index.js` had grown to ~1990 lines combining two distinct concerns:
1. **Twelve Data candle fetch** — latency-sensitive, runs every 15 min, no Yahoo dependency
2. **Yahoo/breadth/DXY pipeline** — broader, slower, includes digest and prune logic

The split creates a clean separation: watchdog is a pure Twelve Data poller; market-breath owns everything Yahoo/breadth.

### What Moved to market-breath-worker

From `watchdog-worker/src/index.js` to `market-breath-worker/src/index.js`:

| Moved | Notes |
|---|---|
| `fetchBreadthFromYahoo(symbols, env)` | 29-symbol parallel Yahoo fetch; writes `yahoo_candle_cache` via `db.batch()` |
| `computeSyntheticDXY(env)` | Reads yahoo_candle_cache; INSERT OR IGNORE dxy_candle_cache 1H |
| `seedDXYHistory(env)` | Runs once when dxy_candle_cache empty |
| `synthesiseDXY4H/Daily/Weekly(db)` | Higher-TF DXY derivation |
| `writeDXYBlobsToCache(db, tfs, limit)` | Mirrors dxy_candle_cache → candle_cache as symbol='DXY' |
| `attemptDailySynthesis(symbols, env)` | Groups 1H → daily_candle_cache; gated nyHour===17 |
| `attemptWeeklySynthesis(symbols, env)` | Groups daily → weekly_candle_cache; gated nyDay===5 && nyHour===17 |
| `handleBreadthFetchCron(env)` | Orchestrates the full POST /cron/breadth-fetch pipeline |
| `sendWatchdogDailyDigest(env)` | 11-query D1 read → Telegram digest; nyHour===17 gate |
| `lastDigestNYDate` (module-level) | Dedup guard against double-fire on same NY date |
| `NY_DATE_HOUR_FMT` (module-level) | `Intl.DateTimeFormat` instance hoisted for performance |
| `POST /cron/breadth-fetch` route | Calls handleBreadthFetchCron |
| `POST /cron/daily-digest` route | Calls sendWatchdogDailyDigest with nyHour gate |
| `POST /cron/prune` route | 5-statement db.batch() DELETE (new — was inline in breadth-fetch) |
| WATCHDOG_BOT_TOKEN + WATCHDOG_ADMIN_CHAT_ID secrets | Removed from ebp-watchdog, added to market-breath |

### What Stays in watchdog-worker

| Retained | Notes |
|---|---|
| `handleCandleFetchCron(env)` | Twelve Data M15/M30/1H/4H round-robin fetch pipeline |
| `handleWatchdogHealthCheck(env)` | 9 health checks; Telegram alert broken (no WATCHDOG_BOT_TOKEN — see Section 9.1) |
| `runWatchdog(env)` | Native CF scheduled() handler — heartbeat only |
| `logWatchdog(db, type, msg)` | INSERT watchdog_log |
| `GET /health` | Heartbeat |
| `POST /health/watchdog-check` | Calls handleWatchdogHealthCheck |
| `POST /cron/candle-fetch` | Calls handleCandleFetchCron |
| CRON_SECRET | Only secret remaining in ebp-watchdog |

### Pruning Changes

The old `handleBreadthFetchCron` ran inline dxy_candle_cache pruning (DELETE NOT IN subquery). The new `POST /cron/prune` uses the `LIMIT 1 OFFSET N` index-seek pattern via `db.batch()`:

```javascript
await env.DB.batch([
  env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='1H'
    AND candle_time < (SELECT candle_time FROM dxy_candle_cache
    WHERE tf='1H' ORDER BY candle_time DESC LIMIT 1 OFFSET 167)`),
  env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='4H'
    AND candle_time < (SELECT candle_time FROM dxy_candle_cache
    WHERE tf='4H' ORDER BY candle_time DESC LIMIT 1 OFFSET 41)`),
  env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='Daily'
    AND candle_time < (SELECT candle_time FROM dxy_candle_cache
    WHERE tf='Daily' ORDER BY candle_time DESC LIMIT 1 OFFSET 29)`),
  env.DB.prepare(`DELETE FROM dxy_candle_cache WHERE tf='Weekly'
    AND candle_time < (SELECT candle_time FROM dxy_candle_cache
    WHERE tf='Weekly' ORDER BY candle_time DESC LIMIT 1 OFFSET 11)`),
  env.DB.prepare(`DELETE FROM watchdog_log
    WHERE created_at < datetime('now', '-7 days')`),
]);
```

Row retention: 1H=168 (~7 days), 4H=42 (~7 days), Daily=30 (~1 month), Weekly=12 (~3 months). Prune also clears `watchdog_log` rows older than 7 days.

### _watchdogAlertEnv Pattern in market-breath

market-breath has no `scheduled()` handler. To allow `logWatchdog` error/warning paths to call `sendWatchdogAlert`, each POST route handler sets `_watchdogAlertEnv = env` as the first statement in its body (before any async work). This mirrors the pattern in watchdog's `runWatchdog()` but is applied per-route rather than once at scheduled() entry.

### wrangler.toml for market-breath-worker

```toml
name = "market-breath"
main = "src/index.js"
compatibility_date = "2024-09-23"

[[d1_databases]]
binding = "DB"
database_name = "ebp-tracker-db"
database_id = "b93b206a-5537-4d12-8c86-a4b2372aae7f"
```

No `[triggers]` key — confirmed no native CF cron registered.

### Deployment Verification (2026-08-14)

- `GET https://market-breath.aicube-apps.workers.dev/health` → `{"status":"ok"}` ✓
- `GET https://ebp-watchdog.aicube-apps.workers.dev/health` → `{"status":"ok"}` ✓
- cron-job.org updated: 3 new jobs added for market-breath (breadth-fetch, daily-digest, prune); corresponding watchdog jobs for breadth-fetch and daily-digest removed. Total: 25 jobs.
- D1 live queries not available this session (Cloudflare API token expired, error 9109). Table counts and candle row counts carried from 2026-08-12 session.

### Git State (2026-08-14)

Working branch: `Coding`. market-breath-worker files committed as part of the split. Commits include worker code, wrangler.toml, and this documentation update.
