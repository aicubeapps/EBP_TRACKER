# EBP Tracker — Architecture Report
**Date:** 2026-08-13  
**Scope:** All six Cloudflare Workers, shared D1 database, frontend, and cron infrastructure.  
**Convention:** Present tense throughout. PowerShell syntax for all CLI examples. Where a fact cannot be confirmed from source files, the note reads `NOT VERIFIED — manual check needed`.

---

## Table of Contents

1. [Worker Inventory](#1-worker-inventory)
2. [Cron Architecture](#2-cron-architecture)
3. [Authentication Model](#3-authentication-model)
4. [D1 Database — Tables and Ownership](#4-d1-database--tables-and-ownership)
5. [Twelve Data API Key Rotation](#5-twelve-data-api-key-rotation)
6. [Candle Cache ETL Pipeline](#6-candle-cache-etl-pipeline)
7. [Market Breadth and Synthetic DXY](#7-market-breadth-and-synthetic-dxy)
8. [Forex SMA Cloud Phase Machine](#8-forex-sma-cloud-phase-machine)
9. [NSE Worker](#9-nse-worker)
10. [Alert History and Telegram Integration](#10-alert-history-and-telegram-integration)
11. [Frontend](#11-frontend)
12. [Known Issues and Open Items](#12-known-issues-and-open-items)

---

## 1. Worker Inventory

Six Cloudflare Workers share a single D1 database. There are no cross-package imports; each worker is a self-contained bundle. The database ID (`b93b206a-5537-4d12-8c86-a4b2372aae7f`) is declared identically in every `wrangler.toml` that binds it.

| Worker | `name` in wrangler.toml | Main entry | Approx. source lines |
|---|---|---|---|
| EBP Worker | `ebp-tracker-worker` | `src/ebp-worker.js` | 2 358 |
| Sweep Worker | `sweep-detector` | `src/index.js` | ~1 275 (index 119 + sweep-cron ~1 156) |
| NSE Worker | `nse-tracker` | `src/index.js` | ~2 163 (index 406 + nse-cron ~1 757) |
| Compute Worker | `compute-worker` | `src/index.js` | 1 167 |
| Watchdog Worker | `ebp-watchdog` | `src/index.js` | 1 977 |
| Admin Worker | `admin-worker` | `src/index.js` | 399 |

**Live hostnames** (derived from `wrangler.toml` `name` fields and Cloudflare's `.workers.dev` convention):

| Worker | URL |
|---|---|
| EBP Worker | `https://ebp-tracker-worker.aicube-apps.workers.dev` |
| Sweep Worker | `https://sweep-detector.aicube-apps.workers.dev` |
| NSE Worker | `https://nse-tracker.aicube-apps.workers.dev` |
| Compute Worker | `https://compute-worker.aicube-apps.workers.dev` |
| Watchdog Worker | `https://ebp-watchdog.aicube-apps.workers.dev` |
| Admin Worker | `https://admin-worker.aicube-apps.workers.dev` |
| Frontend (Pages) | `https://ebp-tracker.pages.dev` |

**D1 binding:** All workers that touch the database bind it as `DB`. Only compute-worker and watchdog-worker are read-heavy on tables they do not own (see Section 4).

---

## 2. Cron Architecture

### 2.1 Native Cloudflare Scheduled Triggers

Only **compute-worker** has a `[triggers]` block in its `wrangler.toml`:

```toml
[triggers]
crons = ["5 * * * *"]
```

This fires `scheduled()` at :05 past every hour and calls `handleMarketBreadthCron`.

**Watchdog-worker** has a `scheduled()` handler but carries **no** `[triggers]` block. The handler logs a heartbeat string only; it is never invoked in production.

All other workers (`ebp-tracker-worker`, `sweep-detector`, `nse-tracker`, `admin-worker`) have no `[triggers]` at all.

> **Historical note (sweep-worker):** `sweep-worker/wrangler.toml` contains a comment block showing five cron expressions that were removed: `*/5 * * * *`, `*/15 * * * *`, `*/30 * * * *`, `0 * * * *`, `0 */4 * * *`. All sweep crons now run via cron-job.org HTTP POST triggers.

### 2.2 cron-job.org HTTP Triggers

Every cron that is not native CF fires as an HTTP `POST` to a worker route. Authentication is a shared secret sent in the `X-Cron-Secret` header, validated against the `CRON_SECRET` binding in each worker.

Full inventory of cron-driven HTTP routes:

| Route | Worker | Cadence (cron-job.org) | Body |
|---|---|---|---|
| `POST /cron/candle-fetch` | watchdog | every 15 min | — |
| `POST /cron/breadth-fetch` | watchdog | every 1 hour | — |
| `POST /cron/daily-digest` | watchdog | weekdays 21:05 UTC — gated: only executes if NY hour = 17 and NY minute < 15; module-level `lastDigestNYDate` dedup prevents double-firing within the same NY calendar date; outside the window returns 200 with `{skipped:true}` | — |
| `POST /health/watchdog-check` | watchdog | every 2 hours | — |
| `POST /cron/sweep` | sweep | every 15 min × 4 jobs (M15/M30/1H/4H) | `{tf}` |
| `POST /cron/sma` | compute | via cron-job.org | `{tf}` |
| `POST /cron/nse` | nse | configurable | `{tf}` or query param |
| `POST /cron/ebp` | ebp-worker | configurable | — |

> The `POST /cron/sma` route exists in compute-worker alongside the native `scheduled()` breadth trigger. Both co-exist in the same worker. `POST /cron/sma` handles Forex SMA; `scheduled()` handles market breadth.

### 2.3 Forex-Closed-Window Gate (`isForexClosedWindow`)

`POST /cron/candle-fetch` in watchdog-worker gates candle fetches for forex and commodity symbols using `isForexClosedWindow`. The closed window is:

- Saturday: all day (00:00–23:59 NY)
- Friday: from 17:00 NY onward
- Sunday: before 17:00 NY

The function uses `toLocaleString` with `timeZone: 'America/New_York'` to determine the local hour and day. Crypto symbols are **not** gated and are fetched at all hours. The breadth-fetch route (`POST /cron/breadth-fetch`) also skips processing on the forex weekend but has no symbol-level gate — it simply exits early.

### 2.4 Candle-Fetch Timeframe Schedule Logic

Within a single execution of `POST /cron/candle-fetch`, only timeframes whose boundary aligns with the current minute are processed:

| TF | Condition |
|---|---|
| M15 | every execution (every 15 min) |
| M30 | `minute % 30 === 0` |
| 1H | `minute === 0` |
| 4H | `minute === 0` AND `NY_4H_BOUNDARIES.includes(nyHour)` |

`NY_4H_BOUNDARIES = [17, 21, 1, 5, 9, 13]` — six NY-hour boundaries that define the 4H candle open times.

**Deploy command (PowerShell — do not run wrangler deploy on live workers without confirmation):**
```powershell
# Example — read only, do not execute without explicit user instruction
npx wrangler deploy --config watchdog-worker/wrangler.toml
```

---

## 3. Authentication Model

### 3.1 Clerk JWT (User Routes)

Three workers validate Clerk JWTs: **ebp-worker**, **admin-worker**, and **nse-worker**. Each implements its own JWKS fetch and cache using the Web Crypto API (no npm Clerk SDK). The JWKS response is cached in memory for **1 hour** per worker instance.

**Critical limitation:** There are three independent JWKS caches — one per worker. A Clerk key rotation propagates at different times to each worker depending on when each instance's 1-hour TTL expires. This creates a window during which one worker accepts tokens another has already invalidated. See Section 12.

Admin routes additionally require `is_admin = 1` on the `users` row. Standard Clerk JWT auth alone is not sufficient.

### 3.2 Cron Secret (Machine-to-Machine)

All cron-triggered HTTP routes require the `X-Cron-Secret` header to match the `CRON_SECRET` secret binding. The header is not a bearer token — it is compared directly (string equality). Workers that expose cron routes: ebp-worker, sweep-worker, nse-worker, compute-worker, watchdog-worker.

### 3.3 Journal Secret (Trade Journal Integration)

EBP Worker exposes two signal routes for the external Trade Journal integration:

```
GET  /signals/:id
PATCH /signals/:id/traded
```

These require an `X-Journal-Secret` header matched against the `JOURNAL_API_SECRET` secret binding. Both routes have open CORS headers.

### 3.4 Telegram Bot Authentication

- `POST /telegram/webhook` in ebp-worker is **publicly** reachable (no secret header). It validates via a 4-digit link code embedded in the message payload, using the `SHARED_BOT_TOKEN` binding.
- `POST /health/watchdog-check` in watchdog-worker sends alerts via `WATCHDOG_BOT_TOKEN` and targets `WATCHDOG_ADMIN_CHAT_ID`. This is a separate bot from the shared one.

### 3.5 Secret Bindings Summary

| Secret | Workers that hold it |
|---|---|
| `CRON_SECRET` | ebp-worker, sweep-worker, nse-worker, compute-worker, watchdog-worker |
| `CLERK_SECRET_KEY` | ebp-worker, admin-worker, nse-worker |
| `SHARED_BOT_TOKEN` | ebp-worker, sweep-worker, nse-worker, compute-worker |
| `WATCHDOG_BOT_TOKEN` | watchdog-worker only |
| `WATCHDOG_ADMIN_CHAT_ID` | watchdog-worker only |
| `JOURNAL_API_SECRET` | ebp-worker only |
| `TWELVE_DATA_API_KEY` | ebp-worker only |
| `APP_URL` | admin-worker (env var, not secret) |

NSE Worker also holds `CRON_SECRET` and `CLERK_SECRET_KEY`. NSE Worker `wrangler.toml` lists an `ENVIRONMENT = "production"` `[vars]` block — the only static var declared in any wrangler.toml.

---

## 4. D1 Database — Tables and Ownership

**Database:** `ebp-tracker-db` | ID: `b93b206a-5537-4d12-8c86-a4b2372aae7f`  
**Migration count:** 15 (migration-001 through migration-013, plus migration-014 and migration-015 applied 2026-08-14)

"Writer" = worker that INSERTs or UPDATEs rows. "Reader" = reads only. A worker omitted for a table does not touch it.

### 4.1 Core User Tables

| Table | Primary Writer | Readers |
|---|---|---|
| `users` | ebp-worker | admin-worker, compute-worker |
| `user_assets` | ebp-worker | watchdog-worker, compute-worker, sweep-worker |
| `user_ebp_configs` | ebp-worker | sweep-worker, compute-worker |
| `user_sweep_configs` | ebp-worker | sweep-worker |
| `user_templates` | ebp-worker | — |
| `chain_state` | ebp-worker (cron) | ebp-worker (user read) |
| `user_telegram` | ebp-worker | watchdog-worker, compute-worker |
| `user_indicator_settings` | ebp-worker | compute-worker |

### 4.2 Candle Cache Tables

| Table | Writer | Readers |
|---|---|---|
| `candle_cache` | watchdog-worker | compute-worker, ebp-worker |
| `yahoo_candle_cache` | watchdog-worker | compute-worker |
| `dxy_candle_cache` | watchdog-worker | compute-worker, ebp-worker |
| `daily_candle_cache` | watchdog-worker | ebp-worker |
| `weekly_candle_cache` | watchdog-worker | ebp-worker |
| `nse_candle_cache` | nse-worker | watchdog-worker (health read) |

### 4.3 Signal and Alert Tables

| Table | Writer | Readers |
|---|---|---|
| `signals` | ebp-worker (cron) | ebp-worker (user + journal routes) |
| `signal_counters` | ebp-worker (cron) | — |
| `alert_history` | compute-worker, sweep-worker | ebp-worker |
| `watchdog_log` | watchdog-worker | — |
| `api_call_log` | watchdog-worker | — |

**`alert_history.fired_at`:** TEXT column storing ISO 8601 timestamps (e.g. `2026-08-13T21:00:00.000Z`). This was converted from INTEGER millisecond epoch in migration-013. Any code that compares `fired_at` using numeric arithmetic is broken.

### 4.4 State and Config Tables

| Table | Writer | Readers |
|---|---|---|
| `swing_states` | ebp-worker (cron) | watchdog-worker |
| `fvg_zones` | ebp-worker (cron) | watchdog-worker |
| `bias_cache` | ebp-worker | compute-worker |
| `forex_indicator_configs` | ebp-worker | compute-worker |
| `forex_sma_state` | compute-worker | ebp-worker, watchdog-worker |
| `api_keys` | admin-worker | watchdog-worker |
| `api_key_state` | watchdog-worker | watchdog-worker |

### 4.5 Market Breadth Tables

| Table | Writer | Readers |
|---|---|---|
| `market_breadth_cache` | compute-worker | ebp-worker |
| `market_breadth_correlation` | compute-worker | ebp-worker |
| `market_breadth_intraday` | compute-worker | ebp-worker |

`market_breadth_intraday` rows older than 40 days are purged by compute-worker on each breadth run.

**Known limitation:** `market_breadth_cache` rows for `tf = '1W'` always store `heatmap_json = '{}'`. No pair-level data is produced at weekly granularity. The column exists and is written but carries no meaningful content. See Section 12.

### 4.6 NSE Tables

| Table | Writer | Readers |
|---|---|---|
| `nse_candle_cache` | nse-worker | watchdog-worker |
| `nse_swing_states` | nse-worker | watchdog-worker |
| `nse_fvg_zones` | nse-worker | watchdog-worker |
| `nse_indicator_configs` | nse-worker | nse-worker |
| `nse_indicator_chain` | nse-worker | nse-worker |
| `nse_sma_state` | nse-worker | nse-worker |

### 4.7 Migration History (significant schema changes)

| Migration | Change |
|---|---|
| 003 | Drop `payment_log`, `tier_config`, `pending_signals` |
| 004–005 | Drop legacy per-asset config columns from `user_assets` |
| 006 | `ADD COLUMN user_tf_access` to `users` |
| 007 | Create all NSE tables (nse_candle_cache through nse_sma_state) |
| 008 | Hard-delete and signals-expiry changes |
| 009 | `ADD COLUMN price_at_signal, htf_bias, session, htf_close` to `signals` |
| 010 | `ADD COLUMN htf_override` to `user_ebp_configs` and `user_sweep_configs` |
| 011 | Seed `signal_counters` for EBP-M15 and EBP-1H |
| 012 | SMA Cloud: `bias_mode`/`htf_timeframe` on `nse_indicator_configs`; create `user_indicator_settings`, `forex_sma_state`, `forex_indicator_configs` |
| 013 | Convert `alert_history.fired_at` INTEGER ms → TEXT ISO 8601 |
| 014 | Drop `invite_tokens` — feature removed entirely 2026-08-14 |
| 015 | Drop `sma_cloud_states` — orphaned table, never read or written post-SMA migration, 0 rows at drop time |

**Apply a migration (PowerShell):**
```powershell
npx wrangler d1 execute ebp-tracker-db --remote --file migrations/013_alert_history_fired_at.sql
```

---

## 5. Twelve Data API Key Rotation

### 5.1 Key Storage

API keys are stored in the `api_keys` D1 table, managed through admin-worker (`GET /admin/api-keys`, `POST /admin/api-keys`, `PATCH /admin/api-keys/:id`, `DELETE /admin/api-keys/:id`). Each row carries a human-readable `label` field used by watchdog-worker to assign keys deterministically per timeframe.

### 5.2 Per-Timeframe Key Assignment

Watchdog-worker assigns one labeled key per timeframe. The assignment is stable against exhaustion — even if a key runs out of credits, the same key slot is always tried first for its assigned TF:

| Label | Assigned TF |
|---|---|
| `Twelve Data Key 1` | M15 |
| `Twelve Data Key 2` | M30 |
| `Twelve Data Key 3` | 1H |
| `Twelve Data Key 4` | 4H |

### 5.3 Batch Size and Exhaustion

`CHUNK_SIZE = 7` — symbols are grouped into batches of 7 for each Twelve Data time_series request. If a key has no remaining credits and all other keys are also exhausted for a given TF, watchdog-worker drops the batch (symbols in that chunk are not fetched). There is no retry with a different key; exhaustion for a TF means those candles are missing for that tick.

See Section 12 for the open issue regarding chunk-dropping under key shortage.

### 5.4 Yahoo Finance Fallback

Yahoo Finance (`yahoo_candle_cache`) serves as a fallback **only for signal symbols** when all Twelve Data keys are exhausted for a given TF. Market breadth always uses Yahoo Finance exclusively — Twelve Data is never called for breadth symbols. The DXY synthetic also uses Yahoo Finance data for its six constituent pairs.

### 5.5 `api_key_state` Table

Watchdog-worker tracks per-key credit state in `api_key_state`. On each candle-fetch run, it reads remaining credits and updates state after batch requests complete. The `api_call_log` table records individual API calls for audit/debugging.

---

## 6. Candle Cache ETL Pipeline

### 6.1 Data Sources

| Source | Feeds into |
|---|---|
| Twelve Data time_series API | `candle_cache` (signal symbols) |
| Yahoo Finance | `yahoo_candle_cache` (breadth + DXY constituents + fallback signals) |
| Derived (ICE formula) | `dxy_candle_cache` |
| Aggregated from candle_cache | `daily_candle_cache`, `weekly_candle_cache` |
| Upstox (NSE equities) | `nse_candle_cache` |
| Yahoo Finance (NSE indices) | `nse_candle_cache` (index rows) |

### 6.2 ETL Owner: Watchdog Worker

`POST /cron/candle-fetch` executes the full Twelve Data + Yahoo ETL every 15 minutes. The route is guarded by `X-Cron-Secret`.

Flow per execution:
1. Determine current NY time; check `isForexClosedWindow`.
2. For each active TF (M15 always; M30/1H/4H if boundary aligns):
   a. Query `user_assets` + `user_ebp_configs` to get the symbol list.
   b. Group into chunks of 7.
   c. Assign the labeled key for this TF.
   d. Fetch `time_series` from Twelve Data for each chunk.
   e. Upsert rows into `candle_cache`.
   f. Log call to `api_call_log`; update `api_key_state`.
3. Fetch yahoo candles for breadth pairs and DXY constituents → upsert `yahoo_candle_cache`.
4. Compute DXY (ICE formula) from 6 yahoo pairs → upsert `dxy_candle_cache`.
5. Synthesize daily and weekly aggregates → `daily_candle_cache`, `weekly_candle_cache`.

### 6.3 Symbol Universe

- **MAJOR_PAIRS:** 29 symbols — 28 pairs from C(8,2) on {EUR, GBP, AUD, NZD, USD, CAD, CHF, JPY} plus USD/SEK.
- **Signal symbols:** user-configured assets from `user_assets`.
- The breadth pairs (MAJOR_PAIRS) are always fetched from Yahoo Finance, not Twelve Data.

### 6.4 NSE ETL Owner: NSE Worker

`POST /cron/nse` fetches NSE equity candles from Upstox and index candles from Yahoo Finance. Results are upserted into `nse_candle_cache`. Watchdog-worker reads `nse_candle_cache` as part of the health-check route (`POST /health/watchdog-check`) to verify NSE data freshness.

---

## 7. Market Breadth and Synthetic DXY

### 7.1 Market Breadth

**Owner:** compute-worker, `scheduled()` handler → `handleMarketBreadthCron`.  
**Trigger:** Native CF cron `"5 * * * *"` (every hour at :05).  
**Data source:** `yahoo_candle_cache` (not `candle_cache`).  
**Output tables:** `market_breadth_cache`, `market_breadth_correlation`, `market_breadth_intraday`.

The breadth run skips entirely on the forex weekend (same logic as `isForexClosedWindow`). Intraday rows older than 40 days are purged on each run.

`GET /market/breadth` in ebp-worker serves the breadth data to the frontend. It reads from all three tables and returns daily and weekly arrays.

### 7.2 Weekly Breadth Limitation

`market_breadth_cache` rows where `tf = '1W'` have `heatmap_json = '{}'`. Pair-level directional data is not computed at weekly granularity. The column is populated with an empty object. Consumers of the weekly heatmap receive no pair breakdown. See Section 12.

### 7.3 Synthetic DXY

The DXY value is synthesized from six currency pairs using the ICE formula. Watchdog-worker computes this during `POST /cron/breadth-fetch` (hourly).

**Constituents (from `yahoo_candle_cache`):**

| Pair | ICE Weight |
|---|---|
| EUR/USD | 57.6% |
| USD/JPY | 13.6% |
| GBP/USD | 11.9% |
| USD/CAD | 9.1% |
| USD/SEK | 4.2% |
| USD/CHF | 3.6% |

Computed value is upserted into `dxy_candle_cache`. EBP Worker and compute-worker both read `dxy_candle_cache`.

### 7.4 Breadth Fetch vs. Candle Fetch

These are two separate routes in watchdog-worker on different schedules:

| Route | Schedule | Output |
|---|---|---|
| `POST /cron/candle-fetch` | every 15 min | `candle_cache`, `yahoo_candle_cache`, `dxy_candle_cache`, `daily_candle_cache`, `weekly_candle_cache` |
| `POST /cron/breadth-fetch` | every 1 hour | (reads from above; compute-worker writes breadth tables) |

The Yahoo fetches for DXY and breadth pairs happen inside `POST /cron/candle-fetch` (watchdog), not inside compute-worker's breadth run. Compute-worker reads pre-populated `yahoo_candle_cache` rows — it does not call Yahoo Finance directly.

---

## 8. Forex SMA Cloud Phase Machine

### 8.1 Entry Point

`POST /cron/sma` in compute-worker accepts `{tf}` in the request body. Valid TFs: `['M15', 'M30', '1H', '4H']`. The handler is `handleForexSmaCron`.

### 8.2 Phase Machine

The SMA Cloud state machine operates on two phases:

- **Accumulation** — price is building above the SMA cloud
- **Distribution** — price is building below the SMA cloud

State is persisted per (user, symbol, TF) in `forex_sma_state`. Config is read from `forex_indicator_configs` (written by ebp-worker via user routes `POST/PATCH /user/forex-indicator-configs/:assetId`).

HTF options per TF (from ebp-worker's `FOREX_SMA_HTF_OPTIONS`):

| TF | HTF Options |
|---|---|
| M15 | `['4H']` |
| M30 | `['4H']` |
| 1H | `['4H', 'D']` |
| 4H | `['D']` |

### 8.3 Constants

| Constant | Value | Meaning |
|---|---|---|
| `FOREX_SMA_SEPARATION_THRESHOLD` | 0.15 | Minimum cloud separation to register phase |
| `FOREX_SMA_VELOCITY_THRESHOLD` | 0.03 | Minimum slope velocity to confirm trend |
| `FOREX_SMA_WICK_PENETRATION` | 0.10 | Allowed wick penetration into cloud before invalidation |

### 8.4 Watch Expiry and Type-2 Cooldown

Per TF, the machine enforces a watch expiry (how long a watch state remains active) and a Type-2 signal cooldown:

| TF | Watch Expiry | Type-2 Cooldown |
|---|---|---|
| M15 | 4H | 4H |
| M30 | 4H | 4H |
| 1H | 4H (4H HTF), 24H (D HTF) | same as expiry |
| 4H | 24H | 24H |

### 8.5 Alert Output

Alerts from `handleForexSmaCron` are written to `alert_history`. Telegram notifications are sent via `SHARED_BOT_TOKEN` to users who have a linked Telegram account in `user_telegram`.

---

## 9. NSE Worker

### 9.1 Routes

| Route | Auth | Description |
|---|---|---|
| `GET /health` | public | Returns 200 |
| `GET /nse/status` | public | Returns `{upstox_configured: bool}` |
| `GET /nse/search` | Clerk JWT | Upstox equity search + Yahoo index search via `Promise.allSettled` |
| `POST /cron/nse` | X-Cron-Secret | Candle fetch; `{tf}` from body or query param fallback |
| `GET /user/nse-indicator-configs/:assetId` | Clerk JWT | Read indicator configs for asset |
| `POST /user/nse-indicator-configs/:assetId` | Clerk JWT | Create TDI or SMA config |
| `PATCH /user/nse-indicator-configs/:id` | Clerk JWT | Update config |
| `DELETE /user/nse-indicator-configs/:id` | Clerk JWT | Delete config (with shared-state cleanup) |

### 9.2 Indicator Types and Valid Timeframes

| Indicator | Valid TFs |
|---|---|
| TDI | M15, M30 |
| SMA | M5, M15, M30 |

### 9.3 SMA State Shared Cleanup

`DELETE /user/nse-indicator-configs/:id` performs conditional cleanup:

- If `indicator = 'tdi'` → deletes the associated `nse_indicator_chain` row unconditionally.
- If `indicator = 'sma'` → checks whether any other user has a config for the same `(symbol, tf)` combination. If no other user does, the corresponding `nse_sma_state` row is deleted. If another user shares the state, the row is retained.

This logic is present in `nse-worker/src/index.js` in `handleDeleteNseIndicatorConfig`.

### 9.4 NSE TF Access

`ALL_NSE_TF_ACCESS = ['M1', 'M5', 'M15', 'M30', '1H', 'D']`

This constant exists in two places:
- `admin-worker/src/index.js` (line ~321, named `ALL_NSE_TF_ACCESS`)
- `nse-worker/src/nse-cron.js` (named `NSE_VALID_TFS`)

A comment in admin-worker at line 321 explicitly notes: "ALL_NSE_TF_ACCESS is duplicated in nse-worker/src/nse-cron.js as NSE_VALID_TFS — both must be kept identical." This is a known maintenance hazard. See Section 12.

### 9.5 NSE Orphan Risk

When a user asset is deleted via `DELETE /user/assets/:id` in ebp-worker, the cascade deletes `user_ebp_configs`, `user_sweep_configs`, `user_templates`, `chain_state`, and then `user_assets`. It does **not** cascade to `nse_indicator_configs` or `nse_indicator_chain`. NSE indicator configs for a deleted asset become orphans. See Section 12.

---

## 10. Alert History and Telegram Integration

### 10.1 `alert_history` Schema Note

`fired_at` is TEXT ISO 8601 after migration-013 (e.g. `2026-08-13T21:05:00.000Z`). Before migration-013 it was an INTEGER storing milliseconds since epoch. Any query that filters or sorts by `fired_at` using numeric comparison is incorrect on the current schema. String comparison is safe for ISO 8601 timestamps of fixed format.

### 10.2 Telegram Bots

Two distinct bots are in use:

| Bot | Secret | Chat target | Used by |
|---|---|---|---|
| Shared bot | `SHARED_BOT_TOKEN` | Per-user `chat_id` from `user_telegram` | ebp-worker, sweep-worker, nse-worker, compute-worker |
| Watchdog bot | `WATCHDOG_BOT_TOKEN` | `WATCHDOG_ADMIN_CHAT_ID` (admin only) | watchdog-worker only |

### 10.3 Telegram Link Flow

1. User requests link code via `POST /user/telegram/initlink` (ebp-worker, Clerk JWT).
2. ebp-worker stores a 4-digit code in `user_telegram` with expiry.
3. User sends the 4-digit code to the shared Telegram bot.
4. `POST /telegram/webhook` (ebp-worker, public) receives the Telegram update, matches the code, stores `chat_id`.
5. `POST /user/telegram/verify` (Clerk JWT) confirms linkage.
6. `POST /user/telegram/test` (Clerk JWT) sends a test message.
7. `DELETE /user/telegram` (Clerk JWT) unlinks.

### 10.4 Watchdog Health Monitor

`POST /health/watchdog-check` runs every 2 hours and performs multiple health checks. It sends Telegram alerts to `WATCHDOG_ADMIN_CHAT_ID` on failures. It also sends:
- A **2-hourly all-clear** message when all checks pass.
- An **EOD summary** message on weekdays at approximately 21:05 UTC (the same window as `POST /cron/daily-digest`).

`POST /cron/daily-digest` fires `sendWatchdogDailyDigest`, a separate function from the watchdog-check routine.

### 10.5 Alert History Routes

| Route | Auth | Description |
|---|---|---|
| `GET /alerts/history` | Clerk JWT | Paginated alert history for current user |
| `GET /alerts/export` | Clerk JWT | Export alert history (format NOT VERIFIED — manual check needed) |

---

## 11. Frontend

### 11.1 Stack

Vite + React. Dev server runs on port 5173 (declared in `frontend/vite.config.js`). No dev server proxy is configured.

### 11.2 Worker URL Routing (`frontend/src/lib/api.js`)

The frontend routes API calls to three distinct worker bases:

```javascript
const BASE       = import.meta.env.VITE_WORKER_URL
                   ?? 'https://ebp-tracker-worker.aicube-apps.workers.dev';
const ADMIN_BASE = import.meta.env.VITE_ADMIN_WORKER_URL
                   ?? 'https://admin-worker.aicube-apps.workers.dev';
const NSE_BASE   = import.meta.env.VITE_NSE_WORKER_URL
                   ?? 'https://nse-tracker.aicube-apps.workers.dev';

function baseFor(path) {
  if (path.startsWith('/admin'))                               return ADMIN_BASE;
  if (path.startsWith('/nse/') ||
      path.startsWith('/user/nse-indicator-configs'))          return NSE_BASE;
  return BASE;
}
```

**Compute-worker and watchdog-worker are not browser-accessible.** No URL is defined for them in the frontend. All compute and watchdog routes are machine-to-machine only (cron-job.org → worker).

### 11.3 Environment Variables

From `frontend/.env.example`:

```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_WORKER_URL=https://your-worker.workers.dev
VITE_ADMIN_WORKER_URL=https://admin-worker.aicube-apps.workers.dev
VITE_NSE_WORKER_URL=https://nse-tracker.aicube-apps.workers.dev
```

No `VITE_COMPUTE_WORKER_URL` or `VITE_WATCHDOG_WORKER_URL` — these workers are intentionally not exposed to the browser.

**Build (PowerShell):**
```powershell
Set-Location frontend
npm run build
```

**Deploy to Pages (PowerShell):**
```powershell
npx wrangler pages deploy dist --project-name ebp-tracker
```

### 11.4 Route-to-Worker Mapping (Frontend Perspective)

| Path prefix | Target worker |
|---|---|
| `/admin/*` | admin-worker |
| `/nse/*`, `/user/nse-indicator-configs/*` | nse-worker |
| All other `/user/*`, `/dashboard`, `/market/*`, `/alerts/*`, `/telegram/*`, `/signals/*`, `/sweep/*`, `/health/*` | ebp-worker |

---

## 12. Known Issues and Open Items

Each issue is classified: **Bug** (incorrect behavior), **Maintenance Hazard** (no current breakage but likely to cause future bugs), or **Limitation** (intentional gap, documented here for completeness).

---

### 12.1 NSE Indicator Orphan on Asset Delete — CLOSED (2026-08-14)

**Location:** `worker/src/ebp-worker.js`, `DELETE /user/assets/:id` handler.

**Problem (fixed):** Deleting a user asset cascaded to `user_ebp_configs`, `user_sweep_configs`, `user_templates`, and `chain_state`, but did **not** delete `nse_indicator_configs` or `nse_indicator_chain` rows for that asset.

**Fix:** Two deletes (`nse_indicator_configs`, `nse_indicator_chain`) inserted into the existing cascade, between `chain_state` and `user_assets`.

**FK note:** `PRAGMA foreign_keys` confirmed `1` (enabled) on production D1, but `nse_indicator_configs.asset_id` has no `FOREIGN KEY REFERENCES` constraint declared in schema.sql — enforcement being on was never going to catch this regardless. Closed permanently, no further action.

---

### 12.2 Duplicated `ALL_NSE_TF_ACCESS` — Maintenance Hazard

**Locations:**  
- `admin-worker/src/index.js` → `ALL_NSE_TF_ACCESS = ['M1', 'M5', 'M15', 'M30', '1H', 'D']`  
- `nse-worker/src/nse-cron.js` → `NSE_VALID_TFS = ['M1', 'M5', 'M15', 'M30', '1H', 'D']`

A comment in admin-worker explicitly flags this duplication. Adding or removing a TF requires updating both files. There is no shared package or import between workers — each is bundled independently.

**Fix path:** Extract to a shared config file within each worker's source tree, or accept the duplication and document it as a required two-file change in the contributing guide.

---

### 12.3 Three Independent Clerk JWKS Caches — Maintenance Hazard

**Locations:** ebp-worker, admin-worker, nse-worker each implement their own JWKS fetch with a 1-hour in-memory TTL.

**Problem:** During a Clerk key rotation, the three workers may be serving requests under different public keys for up to 1 hour each. A user token rejected by one worker may be accepted by another, or vice versa, depending on when each worker's cache last refreshed.

**Impact:** Currently low risk because key rotations are rare and typically planned. Becomes a real hazard if Clerk rotates keys urgently (security incident).

**Fix path:** NOT VERIFIED whether a shared Clerk JWKS cache via KV or D1 is feasible in the current architecture — manual evaluation needed.

---

### 12.4 `market_breadth_cache` Weekly Heatmap Always Empty — Limitation

**Location:** compute-worker, `handleMarketBreadthCron`.

**Problem:** For `tf = '1W'` rows in `market_breadth_cache`, `heatmap_json` is always set to `'{}'`. No pair-level directional data is computed at weekly granularity. This is a known limitation, not a recent regression.

**Impact:** `GET /market/breadth` returns empty pair data for the weekly view. The frontend receives `heatmap_json = '{}'` for weekly rows and must handle this gracefully.

**Fix path:** Implement weekly heatmap computation in `handleMarketBreadthCron`, sourcing from `weekly_candle_cache`.

---

### 12.5 Chunk-Dropping Under Key Exhaustion — CLOSED (already implemented, verified 2026-08-14)

**Location:** `watchdog-worker/src/index.js`, `fetchSignalTF()`.

**Re-investigation finding:** This was already fixed in source prior to this session. When `chunks.length > keys.length`, `fetchSignalTF()` already calls `logWatchdog(env.DB, 'warning', ...)` with the TF, chunk/key counts, and the list of skipped symbols, before truncating to `keys.length` chunks. No code change was needed. Closed permanently, no further action.

---

### 12.6 T4 Template Chain — NOT VERIFIED on Live Data

**Location:** `worker/src/ebp-worker.js`, template chain state machine.

**Problem:** T4 is the final stage of the T1→T2→T3→T4 chain. From code review, T4 logic exists and is syntactically correct. However, it is not confirmed whether T4 has ever fired on live production data.

**Status:** NOT VERIFIED — manual check needed. Query `chain_state` for rows with `current_stage = 'T4'` or check `alert_history` for T4 entries to determine if T4 has ever been triggered.

```powershell
# PowerShell — query D1 for T4 chain state entries
npx wrangler d1 execute ebp-tracker-db --remote --command "SELECT COUNT(*) FROM chain_state WHERE current_stage = 'T4';"
```

---

### 12.7 `DELETE /user/forex-indicator-configs/:id` Shared State Cleanup

**Location:** `worker/src/ebp-worker.js`.

**Behavior (confirmed from source):** Deleting a forex indicator config performs special `forex_sma_state` cleanup, analogous to the NSE SMA state cleanup in nse-worker. Specifically, if no other user config references the same `(symbol, tf)`, the `forex_sma_state` row is deleted.

**Status:** This is working as designed. Documented here because the pattern differs from the simple cascade used for other config types and the behavior is non-obvious.

---

### 12.8 `POST /cron/nse` — Body vs. Query Param Fallback

**Location:** `nse-worker/src/index.js`.

The route reads `tf` from the request body, then falls back to a query parameter if the body is absent or missing the field. This dual-read pattern is inconsistent with all other cron routes (sweep, sma, ebp-worker cron) which read only from the body. cron-job.org jobs that POST with `tf` in the URL query string rather than the body will work for NSE but would fail for other workers.

**Status:** Functional but inconsistent. No immediate action required.

---

### 12.9 Invite Token Feature — REMOVED PERMANENTLY (2026-08-14)

Feature had zero enforcement: token was display-only text in `Landing.jsx`, never passed into the Clerk sign-in modal, never validated server-side by any frontend caller, no write path to `used_by` or `active`. Any visitor could register identically with or without a token. Full removal: `GET /invite/:token` removed from ebp-worker, `GET /admin/tokens` and `POST /admin/invite` removed from admin-worker, `Landing.jsx`'s token-display block and `.landing-invite` CSS removed, Admin.jsx's "Invite Tokens" tab removed, `invite_tokens` table dropped via migration 014. Closed permanently. No further action.

---

### 12.10 2026-08-14 Bug-Sweep Closures

A backlog of pre-diagnosed items was worked through this date. Items with their own dedicated subsection above (12.1, 12.5, 12.9) were updated in place; the remainder are consolidated here:

- **EOD digest wrong-time gate — CLOSED.** `runWatchdog()`'s digest gate was already correct (NY 17:00 via `getNYHour()`) prior to this session, but dead — that native cron is dormant (no `[triggers]` entry). The actual production trigger, `POST /cron/daily-digest` (called by cron-job.org with no gate of its own), had no time gate and no dedup. Added an NY 17:00 (±15 min) gate plus a module-level `lastDigestNYDate` dedup guard directly to that route.
- **Duplicate EOD Telegram alert — CLOSED.** `handleWatchdogHealthCheck()` had its own independent `isEodWindow` gate sending a second, shorter "EOD Report (NY 5PM)" message alongside the full "EOD Operations Report" from the item above — both fired in the same NY 17:00 window. Removed the redundant send and its now-unused `isEodWindow`/`nyMinute` variables; the 2-hourly all-clear and failure-alert paths are unaffected.
- **Yahoo breadth fetch parallelization — CLOSED, already implemented.** `fetchBreadthFromYahoo()` already used `Promise.all` with a per-symbol `.catch` prior to this session. No code change.
- **`validateSymbol()` dead `apiKey` param — CLOSED.** Parameter was never read in the function body; removed from the signature and its one call site.
- **`/upgrade` dead route — CLOSED, no code change.** `ExpiryBanner`'s `navigate('/upgrade')` hits the catch-all `NotFound` route (no `/upgrade` registered in `App.jsx`). Current behavior is the final intended implementation.
- **NSE `nse_tf_access` gate — CLOSED, already implemented.** Confirmed enforced in two places: `tryDeliverNseAlert()` (nse-cron.js) gates EBP/Sweep/MSS alerts, and `deliverNseIndicatorAlert()` gates TDI/SMA alerts. No code change.
- **`alerts/export` timestamp bug — CLOSED.** `from`/`to` were bound as raw integer ms epoch against `fired_at` (TEXT ISO 8601 per migration 013) — SQLite type-affinity ordering meant the WHERE clause could never match real rows. Now converted to ISO strings before binding.
- **Dead secrets audit (Check 5A) — no action, nothing found.** None of the three flagged secrets (`WATCHDOG_BOT_TOKEN`/`WATCHDOG_ADMIN_CHAT_ID` on `ebp-tracker-worker`, `TWELVE_DATA_API_KEY` on `compute-worker`) exist on those workers per `wrangler secret list` — the flag itself was stale. No secrets deleted.
- **D1 FK enforcement (Check 5B) — informational.** `PRAGMA foreign_keys` = `1` (enabled) on production D1.
- **`sma_cloud_states` orphaned table (Check 5C) — CLOSED.** Confirmed 0 rows, dropped via migration 015 (014 was already used for `invite_tokens`), also removed from schema.sql.

---

*End of report. All facts are sourced from direct file reads of the production codebase as of 2026-08-13. Sections marked NOT VERIFIED require a live database query or runtime observation to confirm.*

---

## 13. Complete Route Tables

> NSE Worker routes are documented in Section 9.

---

### 13.1 EBP Worker (`worker/src/ebp-worker.js`, Cloudflare script `ebp-tracker-worker`)

| Method | Path | Auth Type | Description |
|--------|------|-----------|-------------|
| GET | `/health` | public | Returns `{ status: 'ok' }`. No DB access. |
| GET | `/user/me` | Clerk JWT | Returns the current user row from `users`. Creates the row via `getOrCreateUser()` if it does not exist. Checks `expires_at` and deactivates if past. |
| GET | `/user/assets` | Clerk JWT | Returns all `user_assets` rows for the authenticated user. |
| POST | `/user/assets` | Clerk JWT | Creates a new asset. Validates symbol via Twelve Data API (env.TWELVE_DATA_API_KEY). Enforces `asset_limit` for non-NSE/non-system assets. |
| GET | `/user/assets/count` | Clerk JWT | Returns count of non-NSE/non-system assets owned by the user against their `asset_limit`. |
| DELETE | `/user/assets/:id` | Clerk JWT | Deletes asset and all dependent config rows (cascade via application code). |
| PATCH | `/user/assets/:id/bias-overrides` | Clerk JWT | Updates `bias_overrides` JSON on a `user_assets` row. |
| GET | `/user/assets/validate` | Clerk JWT | Validates a symbol string against the Twelve Data API without creating an asset. |
| GET | `/user/ebp-configs/:assetId` | Clerk JWT | Returns all EBP configs for the specified asset. |
| POST | `/user/ebp-configs/:assetId` | Clerk JWT | Creates an EBP config. Checks `user_tf_access` to gate the requested timeframe. |
| PATCH | `/user/ebp-configs/:id` | Clerk JWT | Updates fields on an EBP config row. |
| DELETE | `/user/ebp-configs/:id` | Clerk JWT | Deletes an EBP config row. |
| GET | `/user/sweep-configs/:assetId` | Clerk JWT | Returns all Sweep configs for the specified asset. |
| POST | `/user/sweep-configs/:assetId` | Clerk JWT | Creates a Sweep config. Checks `user_tf_access`. |
| PATCH | `/user/sweep-configs/:id` | Clerk JWT | Updates fields on a Sweep config row. |
| DELETE | `/user/sweep-configs/:id` | Clerk JWT | Deletes a Sweep config row. |
| GET | `/user/templates/:assetId` | Clerk JWT | Returns all template chain configs for the specified asset. |
| POST | `/user/templates/:assetId` | Clerk JWT | Creates a template chain config. |
| PATCH | `/user/template/:id` | Clerk JWT | Updates a template chain config. |
| DELETE | `/user/template/:id` | Clerk JWT | Deletes a template chain config. |
| GET | `/user/chain-state/:assetId` | Clerk JWT | Returns active `chain_state` rows for the specified asset. |
| GET | `/user/fvg-zones/:assetId` | Clerk JWT | Returns open `fvg_zones` rows for the specified asset. |
| GET | `/dashboard` | Clerk JWT | Returns aggregated dashboard data (assets, configs, active chains). |
| GET | `/user/forex-indicator-configs/:assetId` | Clerk JWT | Returns forex SMA indicator configs for the specified asset. |
| POST | `/user/forex-indicator-configs/:assetId` | Clerk JWT | Creates a forex SMA indicator config. |
| PATCH | `/user/forex-indicator-configs/:id` | Clerk JWT | Updates a forex SMA indicator config. |
| DELETE | `/user/forex-indicator-configs/:id` | Clerk JWT | Deletes a forex SMA indicator config. |
| GET | `/user/bias/:symbol` | Clerk JWT | Returns the computed bias for the specified symbol from `swing_states`. |
| GET | `/health/datasources` | Clerk JWT | Returns freshness status of `candle_cache` and `market_breadth_cache` rows relevant to the user. |
| GET | `/alerts/history` | Clerk JWT | Returns recent `alert_history` rows for the user. |
| GET | `/alerts/export` | Clerk JWT | Exports `alert_history` rows filtered by `from`/`to` query params (integer ms epoch). `from`/`to` are converted to ISO 8601 strings before binding so they compare correctly against the TEXT `fired_at` column. |
| GET | `/user/telegram` | Clerk JWT | Returns the user's linked Telegram chat record from `telegram_links`. |
| POST | `/user/telegram/initlink` | Clerk JWT | Initiates the Telegram deep-link flow; generates and stores a link token. |
| POST | `/user/telegram/test` | Clerk JWT | Sends a test Telegram message to the user's linked chat. |
| POST | `/user/telegram/verify` | Clerk JWT | Verifies the deep-link token and finalises the Telegram account link. |
| DELETE | `/user/telegram` | Clerk JWT | Unlinks the user's Telegram account. |
| GET | `/market/breadth` | Clerk JWT | Returns the latest `market_breadth_cache` snapshot for the user's configured timeframes. |
| POST | `/cron/ebp` | X-Cron-Secret | Main EBP cron handler. Accepts body `{ tf }`. Valid values: M15, M30, 1H, 4H, D, W. Runs swing detection for all active non-NSE configs where `users.active = 1`. |
| POST | `/telegram/webhook` | public | Incoming Telegram webhook. Receives bot updates; processes `/start` deep-link tokens for account linking. No auth header — URL secrecy is the access control. |
| GET | `/signals/:id` | X-Journal-Secret | Trade Journal integration. Returns a `signals` row by `signal_id`. Secured by `JOURNAL_API_SECRET` shared secret — CORS open (`Access-Control-Allow-Origin: *`). |
| PATCH | `/signals/:id/traded` | X-Journal-Secret | Trade Journal integration. Sets `traded = 1` on a `signals` row. Secured by `JOURNAL_API_SECRET`. |
| GET | `/sweep/dashboard` | Clerk JWT | Returns Sweep-specific dashboard data for the user's assets. |
| GET | `/sweep/history` | Clerk JWT | Returns recent Sweep alert history for the user. |

**43 routes total** (source: `router.get/post/patch/delete` calls in ebp-worker.js).

---

### 13.2 Sweep Worker (`sweep-worker/src/index.js`, Cloudflare script `sweep-detector`)

| Method | Path | Auth Type | Description |
|--------|------|-----------|-------------|
| GET | `/health` | public | Returns `{ status: 'ok', worker: 'sweep-detector', timestamp: <ISO> }`. |
| POST | `/cron/sweep` | X-Cron-Secret | Sweep cron handler. Accepts body `{ tf }`. Valid values: M15, M30, 1H, 4H. Delegates to `handleSweepCron()` in sweep-cron.js. |

**2 fetch routes total.** No `scheduled()` export.

---

### 13.3 Compute Worker (`compute-worker/src/index.js`, Cloudflare script `compute-worker`)

| Method | Path | Auth Type | Description |
|--------|------|-----------|-------------|
| GET | `/health` | public | Returns `{ status: 'ok', worker: 'compute-worker' }`. |
| POST | `/cron/sma` | X-Cron-Secret | SMA Cloud cron handler. Accepts body `{ tf }`. Valid values: M15, M30, 1H, 4H. Computes forex SMA phase transitions and market breadth. |

**2 fetch routes total.**

`scheduled()` handler → `handleMarketBreadthCron()`. Registered via `[triggers] crons = ["5 * * * *"]` in `compute-worker/wrangler.toml` (every hour at :05). Fires independently of the `POST /cron/sma` route.

---

### 13.4 Watchdog Worker (`watchdog-worker/src/index.js`, Cloudflare script `ebp-watchdog`)

| Method | Path | Auth Type | Description |
|--------|------|-----------|-------------|
| GET | `/health` | public | Returns `{ ok: true, worker: 'ebp-watchdog', ts: <ISO> }`. |
| POST | `/health/watchdog-check` | X-Cron-Secret | External health probe. Reads `candle_cache`, `swing_states`, `market_breadth_intraday`, `forex_sma_state`, `nse_candle_cache`, `nse_swing_states`, `nse_fvg_zones`, `nse_sma_state`, and `watchdog_log`. Sends Telegram alert on failures; sends all-clear every 2h. Driven by cron-job.org every 15 min. |
| POST | `/cron/candle-fetch` | X-Cron-Secret | Signal-symbol ETL. Fetches M15 every tick; M30 when `minute % 30 === 0`; 1H at `minute === 0`; 4H at `minute === 0` and NY hour in `NY_4H_BOUNDARIES`. Respects `isForexClosedWindow` (skips forex/commodity; fetches crypto). Driven by cron-job.org every 15 min. |
| POST | `/cron/breadth-fetch` | X-Cron-Secret | Breadth + DXY + daily/weekly synthesis ETL. Fetches all `BREADTH_SYMBOLS` from Yahoo Finance; computes synthetic DXY; synthesises 4H/Daily/Weekly DXY candles at their respective NY boundaries; runs `attemptDailySynthesis` at NY 17:00; runs `attemptWeeklySynthesis` on Friday NY 17:00. Driven by cron-job.org hourly. |
| POST | `/cron/daily-digest` | X-Cron-Secret | EOD operations report. Gated to NY 17:00 window (nyHour===17 && nyMinute<15) with NY-date dedup via module-level `lastDigestNYDate`. Outside the window returns 200 with `{skipped:true}`. Calls `sendWatchdogDailyDigest()` on gate pass. |

**5 fetch routes total.**

`scheduled()` handler → `runWatchdog()` (near-zero CPU heartbeat; sends `logWatchdog('info', 'heartbeat')`; also fires `sendWatchdogDailyDigest` at NY 17:00 — but this native CF trigger is dormant with no `[triggers]` entry in `watchdog-worker/wrangler.toml`). Real ETL runs entirely via the cron-job.org-driven POST routes above.

---

### 13.5 Admin Worker (`admin-worker/src/index.js`, Cloudflare script `admin-worker`)

All routes except `/health` require Clerk JWT (`Authorization: Bearer <token>`) **and** `users.is_admin = 1` in D1. A non-admin authenticated user receives 403.

| Method | Path | Auth Type | Description |
|--------|------|-----------|-------------|
| GET | `/health` | public | Returns basic health response. |
| GET | `/admin/users` | Clerk JWT + is_admin | Returns all `users` rows. |
| POST | `/admin/expire/:id` | Clerk JWT + is_admin | Sets `users.active = 0` and `users.expires_at = Date.now()` (current time, not future) for the specified user. |
| GET | `/admin/api-keys` | Clerk JWT + is_admin | Returns all rows from `api_keys` joined with `api_key_state`. |
| POST | `/admin/api-keys` | Clerk JWT + is_admin | Inserts a new row into `api_keys`. |
| PATCH | `/admin/api-keys/:id` | Clerk JWT + is_admin | Updates fields on an `api_keys` row (e.g. `label`, `key_name`). |
| DELETE | `/admin/api-keys/:id` | Clerk JWT + is_admin | Deletes from both `api_keys` AND `api_key_state` for the specified id. |
| PATCH | `/admin/users/:id/asset-limit` | Clerk JWT + is_admin | Updates `users.asset_limit`. Enforces range 1–50. |
| GET | `/admin/users/:id/assets` | Clerk JWT + is_admin | Returns all `user_assets` rows for the specified user. |
| GET | `/admin/users/:id/tf-access` | Clerk JWT + is_admin | Returns `users.user_tf_access` JSON for the specified user. |
| PATCH | `/admin/users/:id/tf-access` | Clerk JWT + is_admin | Updates `users.user_tf_access`. Valid values: `ALL_TF_ACCESS = ['M5','M15','M30','1H','4H','D','W']`. |
| GET | `/admin/users/:id/nse-tf-access` | Clerk JWT + is_admin | Returns `users.nse_tf_access` JSON for the specified user. |
| PATCH | `/admin/users/:id/nse-tf-access` | Clerk JWT + is_admin | Updates `users.nse_tf_access`. Valid values: `ALL_NSE_TF_ACCESS = ['M1','M5','M15','M30','1H','D']`. |

**13 routes total** (invite token routes removed 2026-08-14).

---

## 14. Deployment Procedures

All commands use PowerShell syntax. Do not run `wrangler deploy` from this document — these are reference procedures only.

---

### Procedure A — Deploy a Single Worker

1. Confirm you are on the coding branch (not `main`):
   ```powershell
   git branch --show-current
   ```
   If not on the coding branch, switch before deploying:
   ```powershell
   git checkout <coding-branch-name>
   ```

2. Deploy the worker (substitute the correct `wrangler.toml` path):
   ```powershell
   wrangler deploy --config .\worker\wrangler.toml
   ```
   Worker-specific config paths:
   - EBP Worker: `.\worker\wrangler.toml`
   - Sweep Worker: `.\sweep-worker\wrangler.toml`
   - NSE Worker: `.\nse-worker\wrangler.toml`
   - Compute Worker: `.\compute-worker\wrangler.toml`
   - Watchdog Worker: `.\watchdog-worker\wrangler.toml`
   - Admin Worker: `.\admin-worker\wrangler.toml`

3. Smoke-test the /health endpoint immediately after deploy:
   ```powershell
   Invoke-RestMethod -Uri "https://<worker-subdomain>.workers.dev/health"
   ```
   Expected response varies by worker (see Section 13). A non-200 response means the deploy failed or the worker is crashing at startup — check Cloudflare dashboard logs before proceeding.

4. If /health returns non-200:
   - Do NOT commit the broken state.
   - Check Cloudflare real-time logs: `wrangler tail --name <script-name>`
   - Roll back if needed: re-deploy the last working commit.

5. Commit and push the deployed state immediately:
   ```powershell
   git add .\<worker-dir>\src\
   git commit -m "deploy: <description of change>"
   git push -u origin <coding-branch-name>
   ```
   Never leave a deployed worker in an uncommitted state. An uncommitted deploy is unrecoverable if the working copy is lost.

---

### Procedure B — Deploy All Workers (Order)

**Order does not matter** for most deployments because all workers share the same D1 database and communicate only through D1 — there are no direct inter-worker calls. Any worker can be deployed in any sequence.

**Exception — schema migrations:** If a D1 migration must accompany the deploy, apply the migration FIRST (see Procedure F) before deploying any worker. All workers must be compatible with the new schema from the moment the migration is applied, since D1 changes take effect immediately across all workers. Deploy the workers immediately after the migration; do not leave workers in a mixed state overnight.

Recommended order when deploying all workers (minimises user-facing disruption):
1. Admin Worker (manages users — deploy first so admin control is available)
2. EBP Worker (main user API — deploy before cron workers go live)
3. NSE Worker
4. Sweep Worker
5. Compute Worker
6. Watchdog Worker (deploy last so it monitors the already-live workers)

---

### Procedure C — Add or Rotate a Secret

1. Rotate the secret value (interactive prompt — type or paste the new value):
   ```powershell
   wrangler secret put CRON_SECRET --name ebp-tracker-worker
   ```
   Replace `CRON_SECRET` with the secret name and `ebp-tracker-worker` with the target script name.

   To pipe the value non-interactively in PowerShell:
   ```powershell
   "new-secret-value" | wrangler secret put CRON_SECRET --name ebp-tracker-worker
   ```

2. The secret takes effect on the **next cold-start** of the worker, not immediately. Warm instances continue using the old value until they are cycled. To force a cycle, redeploy the worker with a trivial no-op change (e.g. add a comment), which resets all instances.

3. Verify the secret was registered (does not show the value):
   ```powershell
   wrangler secret list --name ebp-tracker-worker
   ```
   Confirm the secret name appears in the output.

4. If the same secret must be updated on multiple workers (e.g. `CRON_SECRET` or `SHARED_BOT_TOKEN`), repeat step 1 for each worker script name.

---

### Procedure D — Clear a Native Cloudflare Cron Schedule

**Why this is necessary:** Removing or commenting out `[triggers]` from `wrangler.toml` and redeploying does NOT clear the live Cloudflare cron registration. The `scheduled()` handler continues to fire on the old interval. The only way to clear it is via the Cloudflare API.

1. Send a PUT request with an empty array as the body:
   ```powershell
   Invoke-RestMethod `
     -Method Put `
     -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/workers/scripts/<script-name>/schedules" `
     -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" } `
     -Body "[]" `
     -ContentType "application/json"
   ```
   Replace `<script-name>` with the Cloudflare script name (e.g. `compute-worker`, `ebp-watchdog`).
   `$env:CF_ACCOUNT_ID` and `$env:CF_API_TOKEN` must be set in your environment.

2. Verify the schedule was cleared:
   ```powershell
   Invoke-RestMethod `
     -Method Get `
     -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CF_ACCOUNT_ID/workers/scripts/<script-name>/schedules" `
     -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" }
   ```
   The `result` array in the response should be empty (`[]`).

3. **Current state:** `compute-worker` retains an active native CF cron (`5 * * * *` via `wrangler.toml [triggers]`). All other workers have no active native CF crons — their `scheduled()` handlers exist in source but no cron fires them in production. Watchdog's `scheduled()` is a heartbeat-only no-op; real ETL runs via cron-job.org POST routes.

---

### Procedure E — Verify a Worker Is Live

Use `Invoke-RestMethod` to hit the `/health` route for each worker:

```powershell
# EBP Worker
Invoke-RestMethod -Uri "https://ebp-tracker-worker.<subdomain>.workers.dev/health"

# Sweep Worker
Invoke-RestMethod -Uri "https://sweep-detector.<subdomain>.workers.dev/health"

# NSE Worker
Invoke-RestMethod -Uri "https://nse-tracker.<subdomain>.workers.dev/health"

# Compute Worker
Invoke-RestMethod -Uri "https://compute-worker.<subdomain>.workers.dev/health"

# Watchdog Worker
Invoke-RestMethod -Uri "https://ebp-watchdog.<subdomain>.workers.dev/health"

# Admin Worker
Invoke-RestMethod -Uri "https://admin-worker.<subdomain>.workers.dev/health"
```

Replace `<subdomain>` with your Cloudflare account Workers subdomain.

Expected responses by worker:
- EBP Worker: `{ status: 'ok' }` (or similar — exact shape NOT VERIFIED without re-read of /health handler)
- Sweep Worker: `{ status: 'ok', worker: 'sweep-detector', timestamp: '<ISO>' }`
- Compute Worker: `{ status: 'ok', worker: 'compute-worker' }`
- Watchdog Worker: `{ ok: true, worker: 'ebp-watchdog', ts: '<ISO>' }`
- NSE Worker and Admin Worker: NOT VERIFIED — /health handler body not confirmed from source in this session

Any HTTP 5xx response or connection error indicates the worker has crashed on startup. Check Cloudflare dashboard logs immediately.

---

### Procedure F — Apply a D1 Migration

1. Apply the migration file to the remote production database:
   ```powershell
   wrangler d1 execute ebp-tracker-db --remote --file .\migrations\<migration-file>.sql
   ```
   Replace `<migration-file>.sql` with the actual filename (e.g. `migration-014-some-change.sql`).

2. Verify the migration was applied:
   ```powershell
   wrangler d1 execute ebp-tracker-db --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
   ```
   Or query a specific new table/column if the migration added one.

3. **Important notes:**
   - `schema.sql` at the repository root is a reference snapshot only — it is NOT auto-applied. All schema changes go through numbered migration files.
   - D1 migrations apply immediately to the live database. There is no staging environment. Test migration SQL locally against a local D1 copy first: `wrangler d1 execute ebp-tracker-db --local --file .\migrations\<migration-file>.sql`
   - Apply migrations before deploying workers that depend on the new schema.

---

## 15. User and Subscription Management

---

### 15.1 Runtime Access Gating

All gating runs at the time of each cron tick or API request. There is no background job that pre-computes access — it is evaluated live on every call.

**`users.active` (INTEGER 0/1)**

Checked in the EBP cron query (`WHERE u.active = 1`) before any signal detection runs. A user with `active = 0` receives no alerts from any worker. The check in the SQL JOIN means zero rows are returned for inactive users — no per-user code path is needed.

Source (ebp-worker.js, handleEBPCron):
```sql
WHERE ec.timeframe=? AND ec.enabled=1
AND u.active=1
AND ua.asset_type != 'nse'
```

**`users.expires_at` (INTEGER ms epoch)**

Checked inside `getOrCreateUser()`, which runs on every authenticated API request. If `user.active = 1` and `user.expires_at < Date.now()`, the user is immediately deactivated:
```javascript
if (user?.active && user.expires_at < now) {
  await db.prepare('UPDATE users SET active = 0 WHERE id = ?').bind(clerkUser.id).run();
  user.active = 0;
}
```
This means expiry is enforced lazily — the next API request after the expiry timestamp triggers deactivation. Users who stop using the app but are still configured will continue receiving cron alerts until any API request triggers the expiry check. Cron workers do not check `expires_at` directly.

**`users.asset_limit` (INTEGER, range 1–50)**

Enforced in `POST /user/assets` (ebp-worker.js) for non-NSE, non-system assets:
```javascript
if (assetType !== 'nse' && assetType !== 'system') {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_assets WHERE user_id = ? AND asset_type != 'nse' AND asset_type != 'system'"
  ).bind(clerkUser.id).first();
  if (count.cnt >= user.asset_limit) {
    return json({ error: 'asset_limit_reached', limit: user.asset_limit }, 403, origin);
  }
}
```
NSE assets are unlimited regardless of `asset_limit`. The count query excludes both `nse` and `system` asset types.

**`users.user_tf_access` (TEXT JSON array)**

Checked in two places:

1. On config creation (`POST /user/ebp-configs/:assetId` and `POST /user/sweep-configs/:assetId`) — returns 403 if the requested TF is not in the user's access list:
   ```javascript
   if (!tfAccess.includes(timeframe)) {
     return json({ error: 'tf_access_denied', message: 'This timeframe is not enabled for your account' }, 403, origin);
   }
   ```

2. During the EBP and Sweep cron loops — skips the user's config if the cron TF is not in their access list:
   ```javascript
   const userTfAccess = JSON.parse(row.user_tf_access || '["M5","M15","M30","1H","4H","D","W"]');
   if (!userTfAccess.includes(tf)) continue;
   ```
   The fallback `["M5","M15","M30","1H","4H","D","W"]` applies when the field is NULL — i.e. all TFs are allowed by default.

**`users.nse_tf_access` (TEXT JSON array)**

Controls NSE timeframe access. Read by NSE Worker cron in two places: `tryDeliverNseAlert()` (nse-cron.js:1482–1484) gates EBP/Sweep/MSS alerts, and `deliverNseIndicatorAlert()` (nse-cron.js:627–630) gates TDI/SMA alerts. If the cron TF is not in the user's `nse_tf_access` list, that user's processing is skipped. Fallback when NULL: all TFs allowed (`['M1','M5','M15','M30','1H','D']`).

---

### 15.2 Admin Panel Actions and Their D1 Effects

All actions are performed via admin-worker routes. All require Clerk JWT + `is_admin = 1`.

| Action | Route | D1 Effect |
|--------|-------|-----------|
| Deactivate user | `POST /admin/expire/:id` | Sets `users.active = 0`, `users.expires_at = Date.now()` (current time). User immediately stops receiving cron alerts. |
| Set asset limit | `PATCH /admin/users/:id/asset-limit` | Updates `users.asset_limit`. Range enforced: 1–50. Takes effect on the user's next `POST /user/assets` call. |
| Grant TF access | `PATCH /admin/users/:id/tf-access` | Updates `users.user_tf_access` JSON. Valid set: `['M5','M15','M30','1H','4H','D','W']`. |
| Grant NSE TF access | `PATCH /admin/users/:id/nse-tf-access` | Updates `users.nse_tf_access` JSON. Valid set: `['M1','M5','M15','M30','1H','D']`. |
| View all API keys | `GET /admin/api-keys` | Read-only. Returns `api_keys` joined with `api_key_state`. |
| Add API key | `POST /admin/api-keys` | Inserts into `api_keys`. |
| Update API key | `PATCH /admin/api-keys/:id` | Updates `api_keys` fields. |
| Delete API key | `DELETE /admin/api-keys/:id` | Deletes from **both** `api_keys` AND `api_key_state` for the specified id. |
| View user assets | `GET /admin/users/:id/assets` | Read-only. Returns `user_assets` for the specified user. |

---

## 16. Dead Secrets Audit

**Methodology:** wrangler.toml files in this repository do not list secrets. Secrets are registered via `wrangler secret put` and stored in Cloudflare only. `wrangler secret list` was run against all six workers on 2026-08-14. The "Configured" column reflects that audit.

The "Read by Source" column is confirmed from direct file reads.

---

### 16.1 ebp-tracker-worker (`worker/src/ebp-worker.js`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CRON_SECRET` | Yes — confirmed 2026-08-14 | Yes — `POST /cron/ebp` auth header check | Active |
| `CLERK_SECRET_KEY` | Yes — confirmed 2026-08-14 | Yes — all Clerk JWT route verification | Active |
| `SHARED_BOT_TOKEN` | Yes — confirmed 2026-08-14 | Yes — Telegram alert sending | Active |
| `JOURNAL_API_SECRET` | Yes — confirmed 2026-08-14 | Yes — `GET /signals/:id` and `PATCH /signals/:id/traded` (X-Journal-Secret header) | Active |
| `TWELVE_DATA_API_KEY` | No — confirmed not configured 2026-08-14 | `validateSymbol()`'s `apiKey` parameter was never read in its body — removed 2026-08-14 (Section 12.10) | Dead — not configured, and the one call site that used to pass this secret no longer does |

---

### 16.2 sweep-detector (`sweep-worker/src/index.js` + `sweep-cron.js`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CRON_SECRET` | Yes — confirmed 2026-08-14 | Yes — `POST /cron/sweep` auth header check | Active |
| `SHARED_BOT_TOKEN` | Yes — confirmed 2026-08-14 | Yes — Telegram alert sending in sweep-cron.js | Active |

---

### 16.3 nse-tracker (`nse-worker/`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CRON_SECRET` | Yes — confirmed 2026-08-14 | Confirmed from wrangler.toml comment | Active |
| `CLERK_SECRET_KEY` | Yes — confirmed 2026-08-14 | Confirmed from wrangler.toml comment | Active |
| `SHARED_BOT_TOKEN` | Yes — confirmed 2026-08-14 | Yes — `sendTelegramMessage(env.SHARED_BOT_TOKEN, ...)` in `tryDeliverNseAlert()` and `deliverNseIndicatorAlert()`, nse-cron.js | Active |

---

### 16.4 compute-worker (`compute-worker/src/index.js`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CRON_SECRET` | Yes — confirmed 2026-08-14 | Yes — `POST /cron/sma` auth header check | Active |
| `SHARED_BOT_TOKEN` | Yes — added 2026-08-14 | Yes — Telegram alert sending | Active. RESOLVED 2026-08-14 — was missing on this worker only (present on the other three). `deliverForexSmaAlert()` calls `sendTelegramMessage()` before the `alert_history` INSERT, and `sendTelegramMessage()` throws on a non-ok Telegram response, so a missing token means the send throws and the alert is dropped before ever reaching `alert_history` — not a silent no-op. `alert_history` shows `sma_exhaustion`/`sma_type1` deliveries succeeding as recently as 2026-08-13T06:31 UTC / 2026-08-12T09:46 UTC, so the secret was present and working until shortly before this session's 2026-08-14 audit found it missing — not missing since inception. Root cause of the gap itself (a lost token, likely an out-of-band rotation applied to the other three workers but missed here) is not established. Added via `wrangler secret put`; SMA Cloud Telegram alerts are operational again. |

---

### 16.5 ebp-watchdog (`watchdog-worker/src/index.js`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CRON_SECRET` | Yes — confirmed 2026-08-14 | Yes — all five POST routes check `X-Cron-Secret !== env.CRON_SECRET` | Active |
| `WATCHDOG_BOT_TOKEN` | Yes — confirmed 2026-08-14 | Yes — `sendWatchdogAlert()` uses this to send Telegram messages | Active |
| `WATCHDOG_ADMIN_CHAT_ID` | Yes — confirmed 2026-08-14 | Yes — `sendWatchdogAlert()` uses this as the Telegram chat target | Active |

---

### 16.6 admin-worker (`admin-worker/src/index.js`)

| Secret | Configured | Read by Source | Status |
|--------|-----------|----------------|--------|
| `CLERK_SECRET_KEY` | Yes — confirmed 2026-08-14 | Yes — all admin Clerk JWT verification | Active |
| `APP_URL` | No — confirmed not configured 2026-08-14 | Not read anywhere in current source | Dead — not configured, not referenced |

---

## 17. Repository and Branch Discipline

---

### Branch Policy

The repository operates on a two-branch model:

- **`coding` branch** (or equivalent named development branch, e.g. `claude/sync-verify-unmerged-h8k771`): All active development happens here. Worker source changes, migration files, and configuration changes are committed and pushed to this branch.

- **`main` branch**: Receives changes only via merge from the coding branch. Direct pushes to `main` for worker code are prohibited.

**Why this matters:** Cloudflare Pages is connected to `main` via GitHub integration. Any push to `main` triggers an automatic Pages rebuild and frontend deployment. Pushing worker changes directly to `main` can accidentally trigger a frontend rebuild with no frontend change, and bypasses code review on the coding branch.

---

### Cloudflare Pages Auto-Deploy

The frontend (`frontend/`) is deployed by Cloudflare Pages from `main`. The trigger is any push (or merge) to `main`. This happens automatically — there is no manual step.

Worker deployments are entirely separate: `wrangler deploy` pushes to Cloudflare Workers and has no connection to Pages or the `main` branch. Workers and Pages can be at different states.

---

### The Commit-After-Deploy Invariant

Every `wrangler deploy` must be immediately followed by `git commit` and `git push origin <coding-branch>`.

Rationale:
- An uncommitted deploy creates a state where the live Cloudflare Worker does not match the repository. If the working copy is lost (container reset, machine failure), the deployed version cannot be recovered from git.
- Two confirmed incidents in August 2026 where uncommitted deploys caused repo/production divergence: debugging was severely hampered because the git history did not reflect what was actually running.

Safe pattern:
```powershell
wrangler deploy --config .\<worker-dir>\wrangler.toml
# Verify /health returns 200 before committing
git add .\<worker-dir>\src\
git commit -m "deploy: <description>"
git push -u origin <coding-branch>
```

Never deploy from an uncommitted working copy if you are not immediately committing.

---

### No CI/CD Pipeline

There is no automated CI/CD. All deployments are performed manually by running `wrangler deploy` from the local machine or remote session. There are no GitHub Actions, no deploy-on-push workflows, and no staging environment. Production is the only environment.

---

## 18. Operational Constants Quick Reference

| Constant | Value | Location | Notes |
|----------|-------|----------|-------|
| **Alert Dedup Windows (ALERT_INTERVAL_MS)** | | | Defined identically in ebp-worker.js, sweep-cron.js, compute-worker/src/index.js |
| `M1` | not in map → fallback 3,600,000 ms (1H) | All three workers | M1 is not a key in ALERT_INTERVAL_MS. Unknown TF falls back to `60 * 60 * 1000`. |
| `M5` | not in map → fallback 3,600,000 ms (1H) | All three workers | Same fallback as M1. |
| `M15` | 900,000 ms (15 min) | All three workers | |
| `M30` | 1,800,000 ms (30 min) | All three workers | |
| `1H` | 3,600,000 ms (1 hour) | All three workers | |
| `4H` | 14,400,000 ms (4 hours) | All three workers | |
| `D` | 86,400,000 ms (24 hours) | All three workers | |
| `W` | 604,800,000 ms (7 days) | All three workers | |
| **Chain Expiry** | | | |
| T1, T2, T4 expiry | `endOfUTCMonthISO()` = `new Date(Date.UTC(year, month+1, 0, 23, 59, 59)).toISOString()` | ebp-worker.js, sweep-cron.js | Last second of the current UTC month. |
| T3 expiry | `Date.now() + window_mins × 60,000` | sweep-cron.js | `window_mins` range: 15–240 min. Countdown starts from chain arm time. |
| T4 dedup guard | `(window_mins \|\| 60) × 60,000` ms | sweep-cron.js | Separate from chain expiry. Prevents re-arming T4 within the window. Default 60 min if `window_mins` is null. |
| **Twelve Data / Candle Fetch** | | | |
| CHUNK_SIZE | 7 symbols per batch | watchdog-worker/src/index.js line 378 | Symbols are split into chunks of 7; one API key is assigned per chunk. |
| MAJOR_PAIRS | 29 forex pairs | watchdog-worker/src/index.js | 28 from C(8,2) over 8 major currencies + USD/SEK = 29. |
| NY_4H_BOUNDARIES | `[17, 21, 1, 5, 9, 13]` (NY hours) | watchdog-worker/src/index.js | 4H candle fetch triggers at these NY wall-clock hours at minute === 0. |
| Twelve Data key formula | `⌈N÷8⌉×4` | watchdog-worker notes | N = active signal symbols. Capacity: 4 current keys support up to 8 signal symbols. |
| Yahoo Finance candle fetch | used for all breadth symbols; fallback for signal symbols when all TD keys exhausted | watchdog-worker/src/index.js | Breadth is always Yahoo. Signal symbols try TD first; fall back to Yahoo only on full exhaustion. |
| **getDailyCandlesFromCache LIMIT** | | | Differs by worker — use care when reading source |
| sweep-cron.js | LIMIT 25 | sweep-worker/src/sweep-cron.js | |
| compute-worker | LIMIT 25 | compute-worker/src/index.js | |
| ebp-worker.js | LIMIT 5 | worker/src/ebp-worker.js | Smaller limit — reads only recent candles for EBP detection |
| **DXY** | | | |
| DXY_K (ICE constant) | 50.14348112 | watchdog-worker/src/index.js | ICE DXY formula coefficient |
| DXY constituents | EUR/USD, USD/JPY, GBP/USD, USD/CAD, USD/SEK, USD/CHF | watchdog-worker/src/index.js | See Section 7 for weights and formula |
| Minimum candles for DXY seed | 10 common timestamps required | watchdog-worker/src/index.js | `seedDXYHistory` aborts if fewer than 10 common timestamps across all 6 constituents |
| **SMA Watch Expiry** | | | Both FOREX_SMA_WATCH_EXPIRY_MS and FOREX_SMA_TYPE2_COOLDOWN_MS have identical values |
| `M15` | 14,400,000 ms (4 hours) | compute-worker/src/index.js | |
| `M30` | 14,400,000 ms (4 hours) | compute-worker/src/index.js | |
| `1H` (4H phase) | 14,400,000 ms (4 hours) | compute-worker/src/index.js | |
| `1H` (D phase) | 86,400,000 ms (24 hours) | compute-worker/src/index.js | 1H TF expiry depends on which HTF phase (4H or D) is being watched |
| `4H` | 86,400,000 ms (24 hours) | compute-worker/src/index.js | |
| NSE SMA equivalents | NOT FOUND IN SOURCE — nse-worker/src/nse-cron.js not read in this session. Manual verification required. | | |
| **Data Retention** | | | |
| market_breadth_intraday | 40 days | compute-worker/src/index.js | `DELETE WHERE snapshot_at < now - 40 × 24 × 60 × 60 × 1000`. Runs on every breadth computation. |
| dxy_candle_cache — 1H | LIMIT 168 rows | watchdog-worker/src/index.js | ~7 days of hourly rows |
| dxy_candle_cache — 4H | LIMIT 42 rows | watchdog-worker/src/index.js | ~7 days of 4H rows |
| dxy_candle_cache — Daily | LIMIT 30 rows | watchdog-worker/src/index.js | ~30 trading days |
| dxy_candle_cache — Weekly | LIMIT 12 rows | watchdog-worker/src/index.js | ~12 weeks |
| daily_candle_cache | LIMIT 130 per symbol | watchdog-worker/src/index.js | Rolling window; oldest rows deleted when count exceeds 130 |
| weekly_candle_cache | LIMIT 26 per symbol | watchdog-worker/src/index.js | ~26 weeks |
| watchdog_log | 7 days | watchdog-worker/src/index.js | `DELETE WHERE created_at < datetime('now', '-7 days')`. Runs on every breadth fetch tick. |
| nse_indicator_candle_cache | NOT FOUND IN SOURCE — nse-worker/src/nse-cron.js not read in this session. Manual verification required. | | |
| computeWeeklyBreadth cutoff | 35-day window; minimum 3 trading days | compute-worker/src/index.js | Week is only included in breadth if it has at least 3 completed trading days |
| **Staleness Thresholds (watchdog health check)** | | | Defined in `handleWatchdogHealthCheck()`, watchdog-worker/src/index.js |
| STALE_20MIN | 1,200,000 ms (20 min) | watchdog-worker/src/index.js | Used for: NSE `nse_candle_cache` freshness check |
| STALE_30MIN | 1,800,000 ms (30 min) | watchdog-worker/src/index.js | Used for: most recent `candle_cache` row (any symbol/TF) |
| STALE_35MIN | 2,100,000 ms (35 min) | watchdog-worker/src/index.js | Used for: `swing_states` (EBP cron activity), `forex_sma_state`, `nse_swing_states` |
| STALE_65MIN | 3,900,000 ms (65 min) | watchdog-worker/src/index.js | Used for: `market_breadth_intraday` last snapshot |
| STALE_2HR | 7,200,000 ms (2 hours) | watchdog-worker/src/index.js | Used for: `nse_sma_state` freshness check |
| **Candle Write Threshold** | | | |
| Minimum closed candles | 20 | watchdog-worker/src/index.js | Candle writes to D1 are skipped if fewer than 20 closed candles are returned for a symbol/TF. Prevents partial data from polluting the cache. |
| **Health Check Reporting Windows** | | | |
| 2-hourly all-clear | `utcHour % 2 === 0 && utcMinute < 15` | watchdog-worker/src/index.js | Sends healthy confirmation Telegram message on first 15-min tick of every even UTC hour |
| TF_STALE_MIN (EOD candle freshness) | M15=30, M30=35, 1H=65, 4H=245 (minutes) | watchdog-worker/src/index.js | Per-TF threshold for candle freshness reporting in EOD digest |

---

## 19. Key Operational Learnings

Concrete operational consequences from confirmed incidents and architectural constraints. Each bullet states: what, why it matters, and the safe pattern.

1. **Removing `[triggers]` from wrangler.toml does not clear the live Cloudflare cron.**
   The Cloudflare cron registration is separate from the wrangler.toml file. After commenting out or removing `[triggers]` and redeploying, the `scheduled()` handler continues to fire on the original schedule. This caused unexpected duplicate processing before cron responsibilities were migrated to cron-job.org. Safe pattern: after removing `[triggers]`, explicitly clear the schedule via `PUT .../schedules` with body `[]` (see Section 14, Procedure D). Verify with a follow-up GET that the `result` array is empty.

2. **Deploy-timestamp heuristics are unreliable — compare source directly.**
   Cloudflare's "last deployed" timestamp and the wrangler deployment output timestamp do not reliably indicate what code is actually running. Cold-start timing, gradual rollout, and partial failures can result in mixed instances. Safe pattern: after any deploy, hit `/health` and compare its response against the expected output for the version you just pushed. For deeper verification, add a version string to the health response temporarily.

3. **`strftime('%Y-%m-%dT%H:%M:%fZ', ...)` is the correct D1 ISO timestamp pattern.**
   D1 SQLite's `datetime()` function returns `YYYY-MM-DD HH:MM:SS` (no `T`, no `Z`, no milliseconds) — this is incompatible with JavaScript `new Date()` parsing and ISO 8601 string comparisons. Using `datetime()` in SQL WHERE clauses against JavaScript-generated ISO strings (`new Date().toISOString()`) produces silent wrong results. Safe pattern: always use `strftime('%Y-%m-%dT%H:%M:%fZ', col)` when converting stored values to ISO in SQL, or store and compare as UTC ms integers.

4. **All NY-time logic must use `Intl.DateTimeFormat` with `America/New_York` — never a manual UTC offset.**
   Hard-coded offsets (`-5`, `-4`) break twice yearly at DST transitions. The watchdog health check's manual DST rule (`getNYOffset()`) has a documented ~6-7 hour window on transition days where it is off by one hour. For gates where even one hour of error is unacceptable (e.g. the NY 17:00 daily digest gate), use `Intl.DateTimeFormat` with `timeZoneName: 'shortOffset'` to extract the current offset dynamically. The manual rule is retained only for 4H boundary gates where an occasional ±1h error on DST days is accepted.

5. **DXY asset type is `system` — use `!isNse` checks, not `isForex`.**
   DXY is stored in `user_assets` with `asset_type = 'system'`, not `asset_type = 'forex'`. Any code that filters for `asset_type = 'forex'` will exclude DXY. This was the source of DXY data appearing in the wrong cache tables and missing from breadth computations. Safe pattern: when you need "all non-NSE assets," use `WHERE asset_type != 'nse'`. When you need "signal symbols including DXY," use `WHERE asset_type IN ('forex','crypto','commodity','system')` or `WHERE asset_type != 'nse'`.

6. **Forex daily candle closes at NY 17:00 — not UTC midnight.**
   Grouping hourly bars by calendar date (UTC or NY) produces incorrect daily candles. A forex "trading day" runs from NY 17:00 to the next day's NY 16:59. Bars from NY 17:00–23:59 belong to the next calendar date's trading day. The `groupHourlyByTradingDay()` function handles this with a +1 day offset for hours ≥ 17. Any code that reads daily candles from `daily_candle_cache` must understand that the `date_ny` column represents the NY trading date — the close date, not the open date of the session.

7. **`getClosedCandles` filter rule is `openTime + intervalMs <= now`.**
   A candle is only included in the result if its close time has already passed. The filter is `c.time + intervalMs <= now` (strictly ≤, not <). A forming candle — one whose close time is in the future — is excluded. This is intentional: including a forming candle in signal detection produces false positives based on incomplete price action. If you see a missing latest candle in a freshness report, it is almost always a forming candle being correctly excluded, not a data gap.

8. **`alert_history.fired_at` is TEXT ISO 8601 — integer ms comparisons are broken.**
   `alert_history.fired_at` is stored as a TEXT ISO 8601 string (migration-013). Queries that compare this column against JavaScript `Date.now()` (an integer ms epoch) return wrong results because SQLite cannot compare text ISO strings against integers numerically. Safe pattern: when querying `alert_history`, always compare `fired_at` against another ISO string: `WHERE fired_at > ?` with `new Date(cutoffMs).toISOString()` as the bind parameter — the pattern `isDuplicateAlert()` and `GET /alerts/export` both use.

9. **Every `wrangler deploy` must be immediately committed and pushed to the coding branch.**
   An uncommitted deploy creates an unrecoverable divergence between the repository and production. If the working copy is lost (container reset, machine failure, session expiry), the deployed version cannot be reconstructed from git. Two incidents in August 2026 required manual reconstruction of deployed changes from Cloudflare's live worker source because the working copy was in a remote container that was reclaimed. Safe pattern: deploy → verify /health → `git commit` → `git push`. Never deploy from an uncommitted state unless you commit within minutes.

10. **Never push worker code changes directly to `main`.**
    Cloudflare Pages auto-deploys the frontend from `main` on every push. A push to `main` that only changes worker source code will still trigger a Pages rebuild, wasting build minutes and potentially deploying a partially-ready frontend if any frontend changes were staged. More critically, bypassing the coding branch removes the ability to review or roll back worker changes before they propagate. Safe pattern: all worker changes go to the coding branch; `main` receives changes only via explicit merge, and only when the frontend is ready to ship.

---

*Sections 13–19 appended 2026-08-13. All facts are sourced from direct file reads of the production codebase. Items marked NOT FOUND IN SOURCE or NOT VERIFIED require the specified supplementary source (wrangler secret list, or reading the named file) to confirm.*
