# EBP Tracker — Backend Architecture & Failure Point Report

Generated: 2026-07-30 (live D1 data as of ~18:35 UTC)
Status: READ-ONLY audit — no files modified, no deploys, no git operations.

---

## 1. System Overview

Three Cloudflare Workers share a single D1 database (`ebp-tracker-db`). All candle data flows through the watchdog; signal detection workers read from the shared cache and write alerts back to D1. A React + Vite frontend (Cloudflare Pages) consumes worker APIs via Clerk JWT auth.

```
cron-job.org ──POST /cron/ebp──▶ ebp-tracker-worker ──▶ D1 (signals, chain_state)
                                       │  scheduled() at :05
                                       └──▶ handleMarketBreadthCron ──▶ D1 (breadth tables)

cron-job.org ──POST /cron/sweep─▶ sweep-detector ──▶ D1 (alert_history, chain_state, detected_fvgs)

CF native cron */15 ────────────▶ ebp-watchdog ──▶ Twelve Data / Yahoo ──▶ D1 (candle_cache, daily, weekly)

Frontend (ebp-tracker.pages.dev) ──Clerk JWT──▶ ebp-tracker-worker HTTP routes
```

---

## 2. Workers

### 2.1 `ebp-watchdog` (`watchdog-worker/`)

| Field | Value |
|-------|-------|
| CF name | `ebp-watchdog` |
| Entry | `src/index.js` |
| CF cron | `*/15 * * * *` (CF native) |
| DB binding | `DB` → `ebp-tracker-db` |

**Responsibility**: Candle data collection and synthesis. Every 15-minute tick it determines which timeframe windows are open and fetches only the relevant symbols via Twelve Data or Yahoo Finance.

**Per-tick logic** (`runWatchdog`):
- M15 → always
- M30 → `minute % 30 === 0`
- 1H → `minute === 0`
- 4H → `minute === 0` AND `nyHour ∈ NY_4H_BOUNDARIES`
- Daily synthesis → `minute === 0`
- Weekly synthesis → `nyDay === 5` AND `nyHour === 17`
- Market breadth Yahoo fetch → `minute === 0`

**Data source**: Twelve Data (4 API keys stored in `api_keys`/`api_key_state`, rotated by `fetchSignalAndStore`). Yahoo Finance used for all 28 breadth pairs and as fallback when all TD keys are exhausted.

**Chunking**: `CHUNK_SIZE = 7` symbols per Twelve Data batch request. Chunks are fetched in parallel (`Promise.all` per active key). HTTP 429 (per-minute rate limit) skips the chunk silently. All keys exhausted → falls back to Yahoo for signal symbols.

**Key exhaustion detection** (`isTwelveDataExhausted`): status field is `"error"` AND message contains `"run out"` or `"api credits"`. HTTP 429 is explicitly NOT treated as exhaustion.

**`candle_cache` write format**: `INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)` — stores a JSON array blob, not the column-per-bar layout in `schema.sql`.

**Daily synthesis** (`attemptDailySynthesis`): groups 1H bars by NY trading day (bar with `nyHour >= 17` → assigned to next calendar date). Day complete = `bars.some(b => b.nyHour === 16)`. INSERT OR IGNORE (no re-synthesis if row exists). Keeps last 130 rows per symbol.

**Weekly synthesis** (`attemptWeeklySynthesis`): requires both Monday and Friday bars present in `daily_candle_cache`. INSERT OR IGNORE. Keeps last 26 rows per symbol. Fires only Friday NY 17:00.

**Tables written**: `candle_cache`, `daily_candle_cache`, `weekly_candle_cache`, `api_call_log`, `api_key_state`

---

### 2.2 `ebp-tracker-worker` (`worker/`)

| Field | Value |
|-------|-------|
| CF name | `ebp-tracker-worker` |
| Entry | `src/ebp-worker.js` |
| CF cron | `5 * * * *` (market breadth only) |
| DB binding | `DB` → `ebp-tracker-db` |
| Env secrets | `CLERK_SECRET_KEY`, `SHARED_BOT_TOKEN`, `CRON_SECRET`, `JOURNAL_API_SECRET`, `APP_URL`, `TWELVE_DATA_API_KEY` |

**Responsibility**: EBP signal detection (via HTTP trigger), T3 chain initiation, market breadth computation (via CF cron), and all authenticated HTTP API routes for the frontend.

**`scheduled()` handler**: routes entirely to `handleMarketBreadthCron(env)`. EBP is NOT triggered by CF cron.

**EBP cron** (`handleEBPCron`):
- Triggered externally: `POST /cron/ebp` with `X-Cron-Secret` header + `{"tf":"..."}` body
- Queries `user_ebp_configs JOIN user_assets JOIN users WHERE enabled=1 AND user active`
- Reads candles from `candle_cache` via `getCandlesFromCache`
- `detectEBP`: bull = `bar0.low < bar1.low && bar0.close > prevBodyHigh`; bear = `bar0.high > bar1.high && bar0.close < prevBodyLow`
- HTF bias sourced from `bias_cache` (or computed live if stale)
- On detection: writes to `signals`, creates `chain_state` row (step 2), sends Telegram alert
- Signal IDs from `signal_counters` (series A-Z, count 1-999 per template)

**`BIAS_SOURCE.ebp`**: `{ M15: "4H", "1H": "D", "4H": "W", "D": "W", "W": null }`

**`getCandlesFromCache` staleness**: `age > 2 * intervalMs[tf]`. For 1H = 2h, 4H = 8h. Returns null if stale.

**Market breadth** (`handleMarketBreadthCron`):
- Reads 28 MAJOR_PAIRS from `candle_cache` at 1H via `getCandlesFromCache`
- Computes 8-currency strength scores (pair wins per currency), correlation matrix (Pearson on 10-candle series), heatmap
- Writes to `market_breadth_cache` (REPLACE), `market_breadth_intraday` (append), `market_breadth_correlation` (REPLACE)
- Deletes `market_breadth_intraday` rows older than 48h

**HTTP API routes** (partial):
- `GET /health`, `GET /health/datasources`
- `POST /cron/ebp` (X-Cron-Secret auth)
- `GET /signals/:id`, `PATCH /signals/:id`
- `GET /user/signals`, `GET /user/assets`, `POST /user/assets`, etc.
- `GET /admin/users`, `POST /admin/users/:id/toggle`, `/admin/api-keys/*`
- `GET /market/breadth`, `GET /market/breadth/intraday`, `GET /market/breadth/correlation`

---

### 2.3 `sweep-detector` (`sweep-worker/`)

| Field | Value |
|-------|-------|
| CF name | `sweep-detector` |
| Entry | `src/index.js` (imports from `src/sweep-cron.js`) |
| CF cron | None (disabled) |
| DB binding | `DB` → `ebp-tracker-db` |
| Env secrets | `CLERK_SECRET_KEY`, `SHARED_BOT_TOKEN`, `CRON_SECRET` |

**Responsibility**: Sweep detection, Market Structure Shift (MSS), FVG tracking, T3 chain advancement (steps 2→3 and completion).

**Sweep cron** (`handleSweepCron`):
- Triggered externally: `POST /cron/sweep` with `X-Cron-Secret` + `{"tf":"..."}`
- Valid TFs in HTTP route: `['M5', 'M15', 'M30', '1H', '4H']`
- Valid TFs in compiled bundle: `["M15", "M30", "1H", "4H"]` (no M5)
- M15 tick: cleanup expired FVGs and chains
- Queries `user_sweep_configs JOIN user_assets JOIN users WHERE enabled=1 AND user active`
- HTF bias computed via `calcTTradesBias` (TTradesBias method), cached to `bias_cache`
- Runs FVG detection + swing state update when ≥ 3 candles available
- `detectMSS`: bearish run broken when close > `confirmed_swing_high`; bullish run broken when close < `confirmed_swing_low`
- `detectSweep`: bull = `bar0.low < bar1.low && bar0.close > bar1.low`; bear = `bar0.high > bar1.high && bar0.close < bar1.high`

**`BIAS_SOURCE.sweep`**: `{ M15: "1H", M30: "4H", "1H": "D", "4H": "W" }`

**T3 chain lifecycle**:
- Step 2: created by `ebp-tracker-worker` on EBP detection (`initiateT3Chain`)
- Step 3: advanced by `sweep-detector` on matching sweep (`advanceT3Chain`)
- Complete: `sweep-detector` on matching MSS → writes final signal to `signals`, deletes chain row

**HTTP routes**: `/health`, `/cron/sweep`, `/sweep/dashboard`, `/sweep/history`

---

## 3. Database Schema (`ebp-tracker-db`)

### Tables and Purpose

| Table | Owner | Purpose |
|-------|-------|---------|
| `candle_cache` | watchdog | JSON blob of recent candles per symbol/TF |
| `daily_candle_cache` | watchdog | Synthesized daily OHLC from 1H bars |
| `weekly_candle_cache` | watchdog | Synthesized weekly OHLC from daily bars |
| `api_keys` | ebp-worker (admin API) | Twelve Data key registry |
| `api_key_state` | watchdog | Per-key exhaustion and daily call count |
| `api_call_log` | watchdog | Per-call log for /health/datasources |
| `users` | ebp-worker | Clerk user records, plan, access |
| `user_assets` | ebp-worker | Per-user symbol subscriptions |
| `user_telegram` | ebp-worker | Verified Telegram chat IDs |
| `user_ebp_configs` | ebp-worker | Per-asset EBP alert configs |
| `user_sweep_configs` | sweep-detector | Per-asset sweep alert configs |
| `user_templates` | ebp-worker | T3/T4/T1/T2 template configs |
| `signals` | ebp-worker / sweep-detector | Append-only signal log |
| `signal_counters` | ebp-worker | Signal ID series counter |
| `chain_state` | ebp-worker / sweep-detector | In-progress T3 chain rows |
| `bias_cache` | sweep-detector | HTF TTradesBias per symbol/TF |
| `alert_history` | sweep-detector / ebp-worker | All sent Telegram alerts |
| `swing_state` | sweep-detector | Per-symbol run direction + confirmed swings |
| `detected_fvgs` | sweep-detector | Active and mitigated FVG zones |
| `market_breadth_cache` | ebp-worker | Latest breadth strength + heatmap per TF |
| `market_breadth_intraday` | ebp-worker | Hourly strength time series (48h window) |
| `market_breadth_correlation` | ebp-worker | Latest Pearson correlation matrix per TF |
| `nse_candle_cache` | NSE worker (external) | NSE-specific 3-bar cache |
| `nse_indicator_candle_cache` | NSE worker (external) | NSE 60-candle JSON blob cache |
| `nse_indicator_configs` | NSE worker (external) | TDI/SMA indicator configs |
| `nse_indicator_chain` | NSE worker (external) | TDI pending chain state |
| `nse_sma_state` | NSE worker (external) | SMA Cloud phase state |
| `user_indicator_settings` | NSE worker (external) | Per-user indicator settings |
| `invite_tokens` | ebp-worker | One-time invite tokens |
| `sweep_candle_cache` | sweep-detector (legacy) | Fixed 3-bar layout; used by /sweep/dashboard only |

### Live Database State (2026-07-30 ~18:35 UTC)

| Table | Row Count | Notes |
|-------|-----------|-------|
| `candle_cache` | 41 | 29 symbols, 4 TFs; newest: 18:31 UTC |
| `daily_candle_cache` | 50 | 25 symbols × 2 days (Jul 28–29); today not yet complete |
| `weekly_candle_cache` | **0** | No weekly synthesis has ever run |
| `api_key_state` | 4 keys | All non-exhausted; calls today: 53/41/2/2 |
| `market_breadth_cache` | 1 | 1H only; computed 18:05 UTC |
| `market_breadth_intraday` | 6 | 1H only; ~4.7h span |
| `market_breadth_correlation` | 1 | 1H only; computed 18:05 UTC |
| `signals` | 26 | EBP:24, NSE_MSS:1, T3:1; 0 traded |
| `chain_state` | 0 active | No pending T3 chains |
| `detected_fvgs` | 105 | 25 active, 80 mitigated |
| `swing_state` | 26 | |
| `bias_cache` | 29 | |
| `alert_history` | 130 | sweep:92, mss:19, ebp:19 |
| `nse_indicator_configs` | 9 enabled | SMA M15: 4, TDI M30: 5 |
| `nse_sma_state` | 4 | |
| `users` | 2 | 2 active, both free plan |

---

## 4. Cron Schedule Summary

| Worker | Trigger | Timeframe Coverage | Route/Method |
|--------|---------|-------------------|--------------|
| ebp-watchdog | CF native `*/15 * * * *` | M15/M30/1H/4H + daily/weekly synthesis | `scheduled()` |
| ebp-tracker-worker | CF native `5 * * * *` | Market breadth (1H only) | `scheduled()` |
| ebp-tracker-worker | cron-job.org HTTP | EBP detection (M15/1H/4H/D/W) | `POST /cron/ebp` |
| sweep-detector | cron-job.org HTTP | Sweep/MSS/FVG (M15/M30/1H/4H) | `POST /cron/sweep` |

---

## 5. Failure Points

### CRITICAL

**[F1] `schema.sql` does not define `candles_json` column in `candle_cache`**

The schema file defines `candle_cache` with fixed per-bar columns (`bar_0_open`, `bar_0_high`, etc.). The live database uses `candles_json TEXT` and `fetched_at` columns instead. All three workers read/write via `candles_json`. The schema is permanently diverged from production. A fresh `wrangler d1 execute --file=schema.sql` would create a table that no worker can use. Any new environment setup (staging, disaster recovery) would silently fail — all candle reads would return null.

**[F2] `chain_state` missing `htf_signal_id` and `htf_close` columns in `schema.sql`**

`ebp-tracker-worker` populates `htf_signal_id` (the signal ID for T3 step-1 correlation) and `sweep-detector` reads `chain.htf_signal_id` and `chain.htf_close`. Both columns exist in the live DB (verified by successful queries returning T3 signals) but are absent from `schema.sql`. Same disaster-recovery risk as F1.

**[F3] Weekly synthesis has never run — `weekly_candle_cache` is empty**

0 rows in `weekly_candle_cache` as of 2026-07-30. Weekly synthesis fires only at `nyDay===5 && nyHour===17` (Friday 17:00 NY). The condition is evaluated in a single 15-minute window. If the watchdog is redeployed, rate-limited, or the 1H breadth fetch blocks that cron tick, synthesis is missed for the entire week. Additionally, synthesis requires BOTH Monday and Friday bars present in `daily_candle_cache`. Without weekly candles, the HTF bias for EBP-4H and EBP-D signals (`BIAS_SOURCE.ebp["4H"]="W"`, `["D"]="W"`) always resolves to "neutral", degrading signal quality for those timeframes.

**[F4] EBP detection has no CF native cron fallback**

EBP signal detection runs entirely via `POST /cron/ebp` from cron-job.org. If cron-job.org is unavailable, EBP signals stop. There is no CF native cron backup. The `scheduled()` handler in `ebp-tracker-worker` runs market breadth only.

---

### HIGH

**[F5] Sweep cron M5 TF is half-supported**

The HTTP route in `sweep-worker/src/index.js` accepts M5 in its valid TF list. But `BIAS_SOURCE.sweep` in the deployed bundle (`sweep-cron.js`) has no M5 key. If M5 is triggered, `defaultBiasTF` is null, `htfBias` is "neutral", and all alerts fire regardless of trend. No error is thrown. The frontend's `BIAS_SOURCE_FRONTEND.sweep` maps `M5: '1H'`, creating a frontend/backend mismatch for any M5 sweep config.

**[F6] No retry for Twelve Data per-minute 429s**

When a Twelve Data key returns HTTP 429 (per-minute rate limit), `fetchChunkWithKey` logs a warning and returns an empty map. The affected symbols' candles are not updated for that tick. They remain stale for the full 15 minutes until the next watchdog run. For volatile markets, a stale M15 candle misses a signal permanently. No backfill, no retry queue.

**[F7] `daily_candle_cache` permanently skips missed days**

`attemptDailySynthesis` uses `INSERT OR IGNORE`. If a day's synthesis is missed (e.g., the 16:00 NY bar never arrives due to a key outage), that date slot is never retried. The day simply doesn't exist in `daily_candle_cache`. Consequently, the daily bias for that date is missing, which affects subsequent HTF bias lookups. The current state (Jul 28–29 present, Jul 30 not yet complete) is expected, but an outage on any day leaves a permanent gap.

**[F8] Alert deduplication absent for sweeps and MSS**

Sweep and MSS alerts have no deduplication guard. If the watchdog refreshes `candle_cache` with an updated version of the same candle (e.g., a revised bar close during the candle formation period), the next sweep cron tick will re-evaluate the same bar and potentially fire the same alert again. `detected_fvgs` uses `INSERT OR IGNORE` (approximate zone match) to avoid duplicates, but sweep/MSS Telegram sends have no equivalent check.

**[F9] NSE worker source absent from repo**

The NSE worker has active state in D1 (`nse_indicator_configs`, `nse_sma_state`, `nse_indicator_chain`) but no source files in this repository. `user_indicator_settings`, `nse_candle_cache`, and `nse_indicator_candle_cache` are also referenced in `schema.sql` without a corresponding local worker. Any incident, schema change, or deployment for NSE requires finding and operating the external source repo.

---

### MEDIUM

**[F10] Market breadth is 1H-only despite multi-TF schema**

`market_breadth_cache`, `market_breadth_intraday`, and `market_breadth_correlation` all use `tf` as a primary key component, implying support for multiple TFs. In practice, `handleMarketBreadthCron` computes only 1H breadth. The frontend's breadth page is hardwired to 1H as well, but any future attempt to query M15 or 4H breadth returns empty results without an error — a silent no-data state.

**[F11] Daily synthesis lags by one trading day by design**

The newest `daily_candle_cache` row is always the prior trading day (today's day is not complete until the 16:00 NY 1H bar is confirmed). HTF daily bias for all active EBP-1H signals is therefore based on yesterday's price action. This is an intentional design choice (closed candles only) but means intraday events are not reflected in the daily bias until after NY close.

**[F12] `candle_cache` staleness threshold is loose for 4H**

`getCandlesFromCache` returns null if `age > 2 * intervalMs[tf]`. For 4H, that threshold is 8 hours. A 4H candle that failed to update at 09:00 NY would still be served as "fresh" until 17:00 — a full trading session. EBP-4H and EBP-D signals (which use 4H candles as LTF) could fire against a candle 7.9 hours old.

**[F13] Bias cache not warmed on first run per symbol**

`writeBiasCache` is called by sweep-detector after each HTF candle fetch. If a new symbol is added to `user_sweep_configs` before the sweep cron has run for it, `bias_cache` has no row for that symbol, and `getEffectiveBias` returns "neutral" for all HTF lookups. Alerts fire with neutral bias until at least one sweep cron run completes for that symbol.

**[F14] `market_breadth_intraday` retention only 6 rows today**

The 48h DELETE threshold was applied correctly, but only 6 intraday snapshots exist today. The breadth page's intraday chart and session grouping require enough snapshots to span multiple 4H blocks. If the cron fires at :05 and the watchdog's breadth fetch at :00 is not complete by :05, `handleMarketBreadthCron` reads stale candle data and the snapshot is written with stale strength values.

---

## 6. Data Flow Diagram

```
Twelve Data (4 keys)
       │ CHUNK_SIZE=7, parallel per key
       ▼
 fetchChunkWithKey ─429?─▶ skip chunk (no retry)
       │ exhausted?
       ▼
 markKeyExhausted ──────▶ api_key_state.exhausted=1
       │
       ▼
  candle_cache (candles_json blob)
       │               ▲
       │               │ Yahoo Finance fallback (always for breadth)
       ▼               │
 daily_candle_cache ◀──┘
       │
       ▼ (Friday NY 17:00 only, requires Mon+Fri present)
 weekly_candle_cache   [CURRENTLY EMPTY]
       │
       ├──▶ ebp-tracker-worker getCandlesFromCache
       │           │ staleness: age > 2×intervalMs
       │           ▼
       │     detectEBP ──▶ signals (INSERT)
       │                ──▶ chain_state step 2 (INSERT)
       │                ──▶ Telegram alert
       │
       ├──▶ sweep-detector getCandlesFromCache
       │           │
       │           ├──▶ calcTTradesBias ──▶ bias_cache
       │           ├──▶ processFVGs ──▶ detected_fvgs
       │           ├──▶ updateSwingState ──▶ swing_state
       │           │       └──▶ detectMSS ──▶ chain_state step 3 advance
       │           │                       ──▶ completeT3Chain ──▶ signals (T3)
       │           └──▶ detectSweep ──▶ chain_state step 2 advance
       │                            ──▶ Telegram sweep alert
       │
       └──▶ handleMarketBreadthCron (hourly at :05)
                   │
                   ├──▶ market_breadth_cache (REPLACE)
                   ├──▶ market_breadth_intraday (INSERT, 48h retention)
                   └──▶ market_breadth_correlation (REPLACE)
```

---

## 7. Frontend Routes

| Route | Page | Notes |
|-------|------|-------|
| `/` | Landing | Public; redirects to `/dashboard` if signed in |
| `/invite/:token` | Landing (invite flow) | |
| `/dashboard` | Dashboard | Protected |
| `/assets` | Assets | Protected |
| `/alerts` | Alerts | Protected |
| `/settings` | Settings | Protected |
| `/admin` | Admin | Protected (no role gate in frontend router — relies on worker) |
| `/market` | MarketBreathPage | Protected |

---

## 8. Summary of Actions Required

| Priority | Item | Action |
|----------|------|--------|
| P0 | F1: `schema.sql` missing `candles_json`/`fetched_at` in `candle_cache` | Add columns; document actual live schema |
| P0 | F2: `schema.sql` missing `htf_signal_id`/`htf_close` in `chain_state` | Add columns to schema.sql |
| P1 | F3: Weekly synthesis never fired | Investigate; add manual backfill endpoint or seed rows |
| P1 | F4: EBP cron has no CF backup | Consider adding `ebp` to CF native cron with a lock/debounce |
| P1 | F9: NSE worker source not in repo | Locate and commit NSE worker source |
| P2 | F5: M5 sweep TF mismatch between index.js and sweep-cron.js | Remove M5 from index.js validTFs or add to BIAS_SOURCE.sweep |
| P2 | F6: No retry for 429 missed symbols | Add next-tick backfill queue or retry logic |
| P2 | F8: No alert dedup for sweep/MSS | Add `alert_history` check before Telegram send |
| P3 | F10: Breadth hardcoded to 1H | Document or implement multi-TF if needed |
| P3 | F12: 4H staleness threshold too loose | Tighten to 1×intervalMs for 4H |
