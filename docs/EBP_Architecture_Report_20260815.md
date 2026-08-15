# EBP Tracker — Architecture & State Report

**Version:** `v2026.08.15`

**Based on:** `EBP_Architecture_Report_20260814.md`. This report documents the 2026-08-15 changes (T1–T4 template refactor, SMA Cloud admin config, watchdog Telegram fix, admin panel update). For all prior architecture, refer to the 2026-08-14 report.

**Update scope:** 2026-08-15 — Full template rewrite (T1–T4), global CISD/MSS redefinition, migrations 016–019, SMA Cloud admin config, watchdog Telegram fix, admin panel tab reorder and SMA Cloud UI.

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

### Repo Structure (source files, updated 2026-08-15)

```
EBP_TRACKER/
├── worker/
│   └── src/ebp-worker.js           2648 lines
├── sweep-worker/
│   ├── src/index.js                 119 lines
│   └── src/sweep-cron.js           1924 lines
├── nse-worker/
│   ├── src/index.js                 406 lines
│   └── src/nse-cron.js             1757 lines
├── watchdog-worker/
│   └── src/index.js                 528 lines   🆕 was 948; health-check/Telegram code stripped 2026-08-15
├── market-breath-worker/            🆕 NEW 2026-08-14
│   ├── src/index.js                1508 lines   🆕 was 1118; gained handleWatchdogHealthCheck 2026-08-15
│   └── wrangler.toml                  8 lines
├── compute-worker/
│   └── src/index.js                1206 lines   🆕 was 1167; SMA Cloud DB-config loader added 2026-08-15
├── admin-worker/
│   └── src/index.js                 428 lines   🆕 was 377; GET/PATCH /admin/sma-config routes added 2026-08-15
└── frontend/                       (updated 2026-08-15 — new SmaCloudAdminPanel.jsx)
```

**Total backend lines: 10532** (wc -l across all 7 workers + market-breath-worker/wrangler.toml, confirmed 2026-08-15).

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

Single shared Cloudflare D1: `ebp-tracker-db` (id `b93b206a-5537-4d12-8c86-a4b2372aae7f`), binding `DB`. All 7 workers bind the same database. Schema: 37 tables as of 2026-08-12 (live D1 queries unavailable that session — Cloudflare API token expired, error 9109) **+ 1 new table 2026-08-15** (`sma_cloud_config`, created by migration 016 — see Section 17) **→ 38 tables current**, not independently re-verified via live D1 query this session either.

---

## Section 2 — Cron Schedule (updated 2026-08-15)

### Worker Trigger Types

| Worker | Trigger Type | Notes |
|---|---|---|
| ebp-tracker-worker | cron-job.org HTTP | POST /cron/ebp-detect |
| sweep-detector | cron-job.org HTTP | POST /cron/sweep-detect |
| nse-tracker | cron-job.org HTTP | Multiple routes |
| ebp-watchdog | cron-job.org HTTP + native CF scheduled() | POST /cron/candle-fetch. Native scheduled() = heartbeat only |
| market-breath | cron-job.org HTTP only 🆕 | No native CF crons. POST /cron/breadth-fetch, /cron/daily-digest, /cron/prune, /health/watchdog-check |
| compute-worker | Native CF: `["5 * * * *"]` | One job fires hourly at :05 |
| admin-worker | None | HTTP only |

**Total cron-job.org jobs: 25** (was 24 before split; prune job added for market-breath).

### cron-job.org Job List (25 jobs)

The following jobs trigger via HTTP POST with header `X-Cron-Secret`:

**ebp-watchdog** (1 job) 🆕 was 2 — `/health/watchdog-check` moved to market-breath 2026-08-15:
- `/cron/candle-fetch` — every 15 min (Twelve Data M15/M30/1H/4H fetch)

**market-breath** (4 jobs) 🆕 was 3 — gained `/health/watchdog-check` 2026-08-15:
- `/cron/breadth-fetch` — every 15 min (Yahoo 29-pair fetch → DXY synthesis → daily/weekly synthesis)
- `/cron/daily-digest` — every 15 min (self-gated: fires Telegram digest only at NY 17:00)
- `/cron/prune` — every 15 min (self-gated: executes only on UTC Saturday)
- `/health/watchdog-check` — every 15 min (health checks, watchdog log, 2h-window OK Telegram) 🆕 moved from ebp-watchdog 2026-08-15; job URL repointed via cron-job.org API

**ebp-tracker-worker** (~6 jobs): EBP detect per TF (M15/M30/1H/4H/D/W)

**sweep-detector** (~8 jobs): Sweep detect per TF

**nse-tracker** (~6 jobs): NSE candle fetch + EBP/Sweep/SMA/TDI detect

*(Exact counts for ebp/sweep/nse jobs carried from 2026-08-12 report — not re-verified this session.)*

---

## Section 9 — Known Issues (updated 2026-08-15)

Issues from the 2026-08-12 report remain in force. Additional issues from the 2026-08-14 split:

### 9.1 ~~ebp-watchdog Missing WATCHDOG_BOT_TOKEN~~ — RESOLVED 2026-08-15

`/health/watchdog-check` route moved from `watchdog-worker` to `market-breath-worker` where `WATCHDOG_BOT_TOKEN` and `WATCHDOG_ADMIN_CHAT_ID` secrets live. `sendWatchdogAlert()`, `_watchdogAlertEnv`, and all Telegram send calls stripped from `watchdog-worker` — `logWatchdog()` is now DB-only. `market-breath-worker` is the sole Watchdog Telegram sender.

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

## Section 16 — 2026-08-14 market-breath Split

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
| `handleWatchdogHealthCheck(env)` | 🆕 Moved 2026-08-15 — **not** part of the original 2026-08-14 split above; moved in a later session once WATCHDOG_BOT_TOKEN had already relocated here. See Section 9.1/17. |
| `POST /health/watchdog-check` route | 🆕 Moved 2026-08-15, same change as above — calls handleWatchdogHealthCheck |

### What Stays in watchdog-worker

| Retained | Notes |
|---|---|
| `handleCandleFetchCron(env)` | Twelve Data M15/M30/1H/4H round-robin fetch pipeline |
| `runWatchdog(env)` | Native CF scheduled() handler — heartbeat only |
| `logWatchdog(db, type, msg)` | INSERT watchdog_log only — Telegram send removed 2026-08-15. DB-only. |
| `GET /health` | Heartbeat |
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

---

## Section 17 — 2026-08-15 Template Refactor & Related Changes

### Migrations Applied

| Migration | Contents |
|---|---|
| 016_template_refactor.sql | Adds 25 columns to `chain_state` (cid 19–43): `signal_id`, `step`, `htf_high`, `htf_low`, `ote_top`, `ote_bottom`, `zone_type`, `ote_enabled`, `sweep_required`, `trigger_type`, `cisd_level`, `pullback_run_high`, `pullback_run_low`, `sweep_signal_id`, `zone_entry_price`, `zone_entry_time`, `key_level_fvg_id`, `mss_tf`, `mss_run_high`, `mss_run_low`, `daily_bias`, `bias_mode`, `target_1`, `target_2`, `hard_kill_level`. Creates `sma_cloud_config` table with seed row (defaults). |
| 017_t2_s1_sent.sql | Adds `s1_sent INT DEFAULT 0` to `chain_state` — 26th new column. |
| 018_retire_old_t3.sql | `DELETE FROM chain_state WHERE template_type='T3'`. `DELETE FROM user_templates WHERE template='t3'`. `DELETE FROM signal_counters WHERE template='T3'`. |
| 019_user_templates_toggles.sql | Adds 6 columns to `user_templates`: `ote_enabled INT DEFAULT 1`, `sweep_required INT DEFAULT 0`, `trigger_type TEXT DEFAULT 'cisd'`, `mss_tf TEXT DEFAULT '1H'`, `bias_mode TEXT DEFAULT 'auto'`, `manual_bias TEXT DEFAULT 'bullish'`. |

**Total `chain_state` columns after migrations 016–017: 45 (19 original + 26 new)** — corrected from the originally drafted 44/25: migration 016's own `ALTER TABLE` statements (verified directly against `migrations/016_template_refactor.sql`) number 25, not 24, matching the stated cid range 19–43 (25 slots) and the 25 column names listed.

---

### Global CISD/MSS Redefinition

Replaces all prior CISD/MSS logic across SMA Cloud, T1, T2, T3, T4.

**CISD (bullish setup — bearish pullback):**
1. Identify the most recent consecutive series of bearish candles (close < open) in the pullback
2. Within that series, find the candle with the highest high
3. CISD level = open of that candle
4. Confirmed when: bullish candle body closes above that level
5. Pullback run continues until CISD fires — single candles, SL hunts, and bounces that do not close above a bearish body do not end the run

**MSS (bullish setup):**
1. MSS level = high of the entire pullback run (where bearish delivery originally began)
2. Confirmed when: bullish candle body closes above that level

**Bearish setup:** exact mirror for both.

**Replaces:** `run_start_time` candle open logic (old CISD) and `last_confirmed_swing_high` comparison (old MSS) across all templates.

---

### New Template Lineup

| Template | Trigger | Flow | Alert count | Expiry |
|---|---|---|---|---|
| T1 | 4H EBP fires | EBP → FVG in OTE zone (formed during EBP candle, 0.5–0.768) → body close beyond FVG | 1 (at CISD) | End of UTC week |
| T2 | 4H EBP fires | EBP → zone entry (OTE or discount/premium) → optional sweep → CISD or MSS | 2–3 (S1 optional, S2 zone, S3 trigger) | End of UTC week |
| T3 | Daily NY 17:00 close | Daily candle → 50–75% zone FVG (4H→1H fallback) → time gate NY 23:00 → CISD or MSS | 2 (S2 FVG entry, S3 trigger) | End of UTC week |
| T4 | Intraday MSS fires | Daily bias gate → MSS (1H or M30) → premium/discount FVG (1H→M30→M15) → M15 body close beyond FVG | 2 (S1 arm, S2 entry) | NY 17:00 same day |

**Old T3 (EBP → Sweep → MSS) dropped entirely.** All templates forex only — NSE excluded.

**T2 zone invalidation:** hard kill if price exits zone before trigger fires.

**T4 hard kill:** if previous day low (bear) / high (bull) swept before S2 fires — chain deleted, no alert.

**T4 daily bias — 4 scenarios:**
| Condition | Next day bias |
|---|---|
| Today close > yesterday high | Bullish |
| Today close < yesterday low | Bearish |
| Swept yesterday high + closed inside + today body < 50% of yesterday body | Bearish |
| Swept yesterday low + closed inside + today body < 50% of yesterday body | Bullish |
| All other cases | Neutral — T4 skips |

---

### Signal ID Scheme (T2)

T2 signal ID born at S1 (EBP fire). Suffix progression:
- User has 4H EBP alert ON: S1 silent → zone entry = base ID → sweep = `/S2` → trigger = `/S3` (or `/S2` if no sweep)
- User has 4H EBP alert OFF: S1 = `/S1` → zone entry = `/S2` → sweep = `/S3` → trigger = `/S4` (or `/S3` if no sweep)

`s1_sent INT` column tracks whether S1 alert was sent, so sweep-cron.js can compute correct suffix without re-querying ebp-configs.

---

### SMA Cloud Admin Config

- Parameters moved from hardcoded constants to D1 `sma_cloud_config` table
- `loadSmaCloudConfig(db)` called at top of `handleForexSmaCron()` — single read, fallback to defaults on error
- Admin routes added to `admin-worker`: `GET /admin/sma-config`, `PATCH /admin/sma-config`
- PATCH validates periods as positive integers, thresholds within [0.01, 1.0]
- Changes take effect on next compute-worker cron tick — no deploy needed

**Constants moved to DB:**
- `FOREX_SMA_SEPARATION_THRESHOLD` → `sma_cloud_config.separation_threshold`
- `FOREX_SMA_VELOCITY_THRESHOLD` → `sma_cloud_config.velocity_threshold`
- `FOREX_SMA_WICK_PENETRATION` → `sma_cloud_config.wick_penetration`
- Fast SMA period → `sma_cloud_config.fast_period`
- Slow SMA period → `sma_cloud_config.slow_period`

**Kept hardcoded:** `FOREX_SMA_WATCH_EXPIRY_MS`, `FOREX_SMA_TYPE2_COOLDOWN_MS` (TF-keyed timing objects — not user-configurable).

---

### Watchdog Telegram Fix

- `POST /health/watchdog-check` route moved from `watchdog-worker` to `market-breath-worker`
- `sendWatchdogAlert()`, `_watchdogAlertEnv`, and all Telegram send calls removed from `watchdog-worker`
- `logWatchdog()` in `watchdog-worker` is now DB-only (writes `watchdog_log`, no Telegram)
- `market-breath-worker` is the sole sender of Watchdog Telegram alerts
- cron-job.org `/health/watchdog-check` job URL updated to point to `market-breath-worker`

---

### Admin Panel Changes (frontend)

**Tab reorder:**
Old: `['Users', 'API Keys', 'User Limits', 'Price Feed']`
New: `['SMA Cloud', 'API Keys', 'Users', 'Price Feed']`

**Tab merge:** `User Limits` tab dropped — asset limit number input merged inline into each user card in the `Users` tab. `+3 Slots` increment button replaced by exact-value number input + Save.

**New component:** `frontend/src/components/SmaCloudAdminPanel.jsx` — reads `GET /admin/sma-config` on mount, displays 5 editable fields, PATCH on Save, shows `updated_at` timestamp.

**Bug fix:** Add New Key row overflow fixed — `flexWrap: 'wrap'` added to that specific `.config-row` only.

---

### Dead Code Removed

| Item | File | Reason |
|---|---|---|
| `checkFvgEntryChain()` | sweep-cron.js | Zero callers after T4 rewrite |
| `completeFvgEntryChain()` | sweep-cron.js | Zero callers after T4 rewrite |
| `formatFvgEntryAlert()` | sweep-cron.js | Zero callers after T4 rewrite |
| `isPriceInFVG()` | sweep-cron.js | Zero callers after T4 rewrite |
| `getChains()` | sweep-cron.js | Zero callers after old T3 removal |
| `advanceT3Chain()` | sweep-cron.js | Old T3 retired |
| `completeT3Chain()` | sweep-cron.js | Old T3 retired |
| `formatT3Alert()` | sweep-cron.js + ebp-worker.js | Old T3 retired |
| `formatT3Step2CompleteAlert()` | sweep-cron.js | Old T3 retired |
| `initiateT3Chain()` | ebp-worker.js | Old T3 retired |
| `endOfUTCMonthISO()` | sweep-cron.js | Zero callers after old T4 removal |
| `endOfUTCWeekISO()` | sweep-cron.js | Zero callers (pre-existing dead code) |
| `FOREX_SMA_SEPARATION_THRESHOLD` | compute-worker | Moved to DB |
| `FOREX_SMA_VELOCITY_THRESHOLD` | compute-worker | Moved to DB |
| `FOREX_SMA_WICK_PENETRATION` | compute-worker | Moved to DB |
| `sendWatchdogAlert()` | watchdog-worker | Telegram removed from watchdog |
| `_watchdogAlertEnv` | watchdog-worker | Telegram removed from watchdog |
