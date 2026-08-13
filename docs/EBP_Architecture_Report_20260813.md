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
| `POST /cron/daily-digest` | watchdog | weekdays 21:05 UTC | — |
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
**Migration count:** 13 (migration-001 through migration-013)

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
| `invite_tokens` | admin-worker | ebp-worker |

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
| All other `/user/*`, `/dashboard`, `/market/*`, `/alerts/*`, `/telegram/*`, `/signals/*`, `/sweep/*`, `/invite/*`, `/health/*` | ebp-worker |

---

## 12. Known Issues and Open Items

Each issue is classified: **Bug** (incorrect behavior), **Maintenance Hazard** (no current breakage but likely to cause future bugs), or **Limitation** (intentional gap, documented here for completeness).

---

### 12.1 NSE Indicator Orphan on Asset Delete — Bug

**Location:** `worker/src/ebp-worker.js`, `DELETE /user/assets/:id` handler.

**Problem:** Deleting a user asset cascades to `user_ebp_configs`, `user_sweep_configs`, `user_templates`, and `chain_state`, but does **not** delete `nse_indicator_configs` or `nse_indicator_chain` rows for that asset. These rows become orphans with a foreign key on a deleted asset.

**Impact:** Orphaned NSE configs are never cleaned up. If `nse_indicator_configs.asset_id` has a foreign key constraint with `ON DELETE CASCADE`, D1 will handle it; if not (no FK enforcement in SQLite by default without `PRAGMA foreign_keys = ON`), the orphans accumulate silently.

**Status:** NOT VERIFIED whether D1 enforces foreign keys — manual check needed. The cascade omission in ebp-worker code is confirmed from source.

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

### 12.5 Chunk-Dropping Under Key Exhaustion — Bug

**Location:** `watchdog-worker/src/index.js`, `POST /cron/candle-fetch`.

**Problem:** If all Twelve Data keys are exhausted for a given TF, batches (chunks of 7 symbols) are silently dropped. No error is written to `watchdog_log` and no alert is sent for skipped batches. Downstream consumers (`candle_cache`) receive stale data without warning.

**Impact:** Signal evaluation in ebp-worker and compute-worker uses stale candles for affected symbols until the next successful fetch.

**Fix path:** Write a `watchdog_log` entry and consider a Telegram alert to `WATCHDOG_ADMIN_CHAT_ID` when a full TF exhaustion occurs.

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

*End of report. All facts are sourced from direct file reads of the production codebase as of 2026-08-13. Sections marked NOT VERIFIED require a live database query or runtime observation to confirm.*
