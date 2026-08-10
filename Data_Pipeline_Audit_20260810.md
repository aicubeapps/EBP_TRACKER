# Data Pipeline Audit — Full Five-Worker Review
**Date:** 2026-08-10  
**Branch:** `claude/ebp-tracker-codebase-audit-o4noyr`  
**Scope:** Read-only audit. No code changes.  
**Files audited:**
- `watchdog-worker/src/index.js` (1432 lines, fully read)
- `compute-worker/src/index.js` (1142 lines, fully read)
- `worker/src/ebp-worker.js` (2358 lines; lines 1–1430 read; key detector and cache functions fully captured)
- `sweep-worker/src/sweep-cron.js` (1156 lines, fully read)
- `nse-worker/src/nse-cron.js` (1736 lines; lines 1–1392 read; all helper functions fully captured)

---

## Specific Answers to the Four Targeted Questions

### 1. Does `candle_cache` store a full JSON array blob per symbol+TF, or one row per candle?

**Full JSON array blob, one row per symbol+TF.**

Schema: `(symbol, tf, candles_json TEXT, fetched_at)` — primary key is `(symbol, tf)`.

`writeCandleCache` always does `INSERT OR REPLACE`, which atomically deletes the old row and inserts a new one containing the entire candle array serialised as `JSON.stringify(candles)`. There is no partial-update path. Every write cycle replaces the entire history blob for that symbol+TF.

---

### 2. Does `computeSyntheticDXY` write its output to D1, or only compute in-memory?

**Writes to D1 via `candle_cache`.**

`computeSyntheticDXY` assembles a full DXY OHLC array across every common timestamp found in the six constituent-pair 1H blobs, then calls `writeCandleCache(env.DB, 'DXY', '1H', candles)` — a full `INSERT OR REPLACE` into `candle_cache` with `symbol='DXY'` and `tf='1H'`. The result is a persisted blob that downstream signal workers read just like any other symbol's candle_cache row.

---

### 3. Does `attemptDailySynthesis` / `attemptWeeklySynthesis` read from accumulated D1 rows or recompute from a fresh Yahoo fetch?

**`attemptDailySynthesis`** — reads from the 1H `candle_cache` blob, **not** Yahoo.

It reads the stored 1H candle array for each symbol (`SELECT candles_json FROM candle_cache WHERE symbol=? AND tf='1H'`), groups all ~49 bars by trading day via `groupHourlyByTradingDay`, and writes complete trading days to `daily_candle_cache` using `INSERT OR IGNORE` (idempotent — existing rows are skipped). It retains the most recent 130 rows. No network call is made.

**`attemptWeeklySynthesis`** — reads from accumulated `daily_candle_cache` D1 rows, **not** Yahoo.

It reads `ORDER BY date_ny DESC LIMIT 7` from `daily_candle_cache` and inspects the Monday + Friday bars to determine if a week is complete. It writes to `weekly_candle_cache` using `INSERT OR IGNORE`. No network call is made.

---

### 4. For SMA Cloud — does it recompute across full candle history every tick, or read state from `forex_sma_state` / `nse_sma_state` and only look at the latest candle?

**Both Forex and NSE SMA Cloud read prior state AND still recompute full arrays every tick. ⚠️ FULL-HISTORY RECOMPUTE.**

**Forex (compute-worker `handleForexSmaCron`):**
- Loads the full ~49-bar blob from `candle_cache`
- Computes `sma1` (full array), `sma9` (full array via `computeSMA` then reverse), `atr14` (full traversal), `countSma1x9Crossovers(5, ...)`, `countSma1x9Crossovers(3, ...)`, `separation5Ago` (index 5)
- Then reads `priorState` from `forex_sma_state` for `sma1_last`/`sma9_last` (fresh-cross detection) and `phase`/`cisd_watch_*` (signal gating)
- Calls `advanceSmaPhase(priorState, { crossover3, crossover5, separationNow, atr14, sma1Now, sma9Now, freshCrossBull, freshCrossBear })`
- Upserts state back to `forex_sma_state`

The prior-state read enables fresh-cross detection (comparing `candles[0].close` to `priorState.sma1_last`), but this does **not** eliminate the full-history recompute — the full SMA/ATR arrays are still computed across all ~49 bars before any state is consulted.

**NSE (nse-cron.js `runSMAForAsset`):**
- Loads the full 60-bar accumulator from `nse_indicator_candle_cache`
- Computes `sma1` (60 values), `sma9` (60 values), `atr14` (60 values), and crossover counts for windows 3, 5, 10, and 20
- Then reads `priorState` from `nse_sma_state` for the same fresh-cross and phase-gating logic
- Same pattern as forex — full recompute before state is consulted

---

## Worker 1: Watchdog Worker

**File:** `watchdog-worker/src/index.js`  
**Triggers:**
- `POST /cron/candle-fetch` — every 15 min via cron-job.org (signal TF ETL)
- `POST /cron/breadth-fetch` — hourly via cron-job.org (DXY synthesis + daily/weekly synthesis)
- Native `scheduled()` — heartbeat only (no ETL)

**Role:** Pure ETL — fetch raw candles from Twelve Data / Yahoo Finance, normalize, store to `candle_cache`. Does not run any signal detectors.

| TF | Fetch — Source & Window | Candles Fetched | Compute Scope | Write Target & Mode | What Downstream Consumes | Anti-Pattern |
|---|---|---|---|---|---|---|
| **M15** | Twelve Data batch (chunks of 7 symbols), `outputsize=50`, `order=DESC`; every 15-min tick; forex skipped during Fri 17:00–Sun 17:00 NY; crypto fetched regardless | 50 raw → `getClosedCandles` filters forming bar → **~49 closed** | Filter only — no indicator computation | `candle_cache` full JSON blob overwrite (`INSERT OR REPLACE`) | Downstream workers read full blob; slice as needed | — |
| **M30** | Same source; only when `minute % 30 === 0` | 50 raw → ~49 closed | Filter only | `candle_cache` full blob overwrite | Full blob | — |
| **1H** | Same source; only when `minute === 0`; **plus** `computeSyntheticDXY` runs after all pair 1H blobs are stored | 50 raw → ~49 closed per pair; DXY: reads ALL ~49 bars × 6 constituent pairs from cache | **DXY: computes OHLC for every common timestamp across all ~49 bars** | `candle_cache` full blob overwrite for each pair; full DXY candle array written separately as `symbol='DXY', tf='1H'` | Full blob | **⚠️ FULL-HISTORY RECOMPUTE** (DXY) |
| **4H** | Same source; only when `minute === 0 && NY_4H_BOUNDARIES.includes(nyHour)` | 50 raw → ~49 closed | Filter only | `candle_cache` full blob overwrite | Full blob | — |
| **D** *(synthesis)* | `candle_cache` 1H blob per symbol (~49 bars) — **no network call** | ~49 1H bars per symbol | `groupHourlyByTradingDay` runs on ALL bars every hourly cycle; `INSERT OR IGNORE` for complete days (idempotent for already-stored days) | `daily_candle_cache` — individual date rows; retain latest 130 | Individual rows read by downstream | **⚠️ REDUNDANT-REPROCESS** — re-examines all ~49 hourly bars every hour to find complete days that were already inserted on prior cycles |
| **W** *(synthesis)* | `daily_candle_cache` D1 rows — `LIMIT 7`, `ORDER BY date_ny DESC`; **no network call** | 7 daily bars | Checks Monday + Friday bar pair per symbol; `INSERT OR IGNORE` for complete weeks | `weekly_candle_cache` — individual date rows; retain latest 26 | Individual rows read by downstream | — |

**Key notes:**
- `writeCandleCache` always does `INSERT OR REPLACE` — full blob overwrite, every cycle, for every symbol+TF processed that tick.
- Fields stored: `{open, high, low, close, time}` — volume is explicitly excluded from the Twelve Data mapping (`v.volume` intentionally not mapped).
- `computeSyntheticDXY` joins all 6 constituent pairs by timestamp, computes DXY for **every** common timestamp in the blobs (~49), then overwrites the full DXY array. Only the latest 1–2 DXY bars are ever consumed by downstream signal workers.

---

## Worker 2: Compute Worker

**File:** `compute-worker/src/index.js`  
**Triggers:**
- Native CF `scheduled()` — Market Breadth cron, hourly at :05
- `POST /cron/sma` — Forex SMA Cloud, via cron-job.org

**Role:** Market Breadth (strength + correlation heatmap) and Forex SMA Cloud phase computation for all subscribed symbols+TFs.

| TF / Feature | Fetch — Source & Window | Candles Fetched | Compute Scope | Write Target & Mode | What Is Consumed | Anti-Pattern |
|---|---|---|---|---|---|---|
| **1H — Market Breadth (strength)** | `candle_cache` blobs for all tracked pairs — full blob per pair | ~49 bars per pair | Strength: uses **only `candles[0]`** (latest closed bar change) | `market_breadth_cache` `tf='1H'` (`INSERT OR REPLACE`); `market_breadth_intraday` snapshot (`INSERT OR REPLACE`); prunes intraday > 40 days | Latest snapshot row | — *(only 1 bar used, not a recompute across history)* |
| **1H — Market Breadth (correlation)** | Same `candle_cache` blobs | ~49 bars per pair | Pearson correlation: `seriesLen = Math.min(10, ...)` — **uses at most 10 bars** despite loading ~49 | Same write targets as above | Latest heatmap | **⚠️ OVER-FETCH** — loads ~49 bars per pair, uses ≤10 for correlation |
| **1W — Weekly Breadth** | `market_breadth_intraday` table — **all rows in last 35 days** | All hourly snapshots for 35 days | Averages all hourly snapshots across the latest completed week | `market_breadth_cache` `tf='1W'` and `tf='1W_current'` (`INSERT OR REPLACE`) | Latest weekly aggregate | **⚠️ FULL-HISTORY RECOMPUTE** — reads entire 35-day snapshot history to compute one weekly average |
| **M15 — Forex SMA Cloud** | `candle_cache` full blob per symbol | ~49 bars | Full `sma1` array (49 vals), full `sma9` array (49 vals), full `atr14` traversal, crossover counts over 3- and 5-bar windows, `separation5Ago` (index 5) — **then** reads `forex_sma_state` prior state for fresh-cross and phase-gating | `forex_sma_state` upsert (`INSERT … ON CONFLICT DO UPDATE`) | `priorState.sma1_last`, `priorState.sma9_last`, `priorState.phase`, `cisd_watch_*` | **⚠️ FULL-HISTORY RECOMPUTE** |
| **M30 — Forex SMA Cloud** | Same | ~49 bars | Same full recompute pattern | `forex_sma_state` upsert | Same | **⚠️ FULL-HISTORY RECOMPUTE** |
| **1H — Forex SMA Cloud** | Same | ~49 bars | Same full recompute pattern | `forex_sma_state` upsert | Same | **⚠️ FULL-HISTORY RECOMPUTE** |
| **4H — Forex SMA Cloud** | Same | ~49 bars | Same full recompute pattern | `forex_sma_state` upsert | Same | **⚠️ FULL-HISTORY RECOMPUTE** |

**Key notes:**
- `getDailyCandlesFromCache` in this worker uses `LIMIT 25` (not `LIMIT 5` as in ebp-worker.js). The comment explains: "forex SMA Cloud's `htf_sma` bias mode needs 9 daily closes minimum for SMA9."
- `handleForexSmaCron` phase computation is shared across all users — one SMA computation per symbol+TF serves all subscribers. Signal firing is per-user after the shared phase is established.
- The prior-state read from `forex_sma_state` (`sma1_last`, `sma9_last`) is used for **fresh-cross detection** only — it does not replace or skip the full SMA recompute. The full `sma1[0..48]` and `sma9[0..48]` arrays are still computed before the state read.
- `last_signal_date` / `last_signal_time` are intentionally absent from the `DO UPDATE` clause — they are updated separately only when a signal actually fires.

---

## Worker 3: EBP Worker

**File:** `worker/src/ebp-worker.js`  
**Trigger:** cron-job.org (every 15 min, aligned with candle-fetch)

**Role:** EBP (Engulfing Bar Pattern) detection, FVG zone tracking, Swing High/Low state, HTF bias via SMA Cloud or BIAS_SOURCE map. Handles signal TFs and their configured HTF.

**BIAS_SOURCE map (EBP):** `M15 → 4H`, `1H → D`, `4H → W`, `D → W`, `W → null`

| TF | Fetch — Source & Window | Candles Fetched | Compute Scope | Write Target & Mode | What Is Consumed | Anti-Pattern |
|---|---|---|---|---|---|---|
| **M15** | `candle_cache` full blob; HTF bias: `candle_cache` 4H blob | ~49 bars (signal) + ~49 bars (4H HTF) | `detectEBP(candles)` uses **`candles[0]`** and **`candles[1]`** only; FVG uses 3 bars (`candles[2,1,0]`); Swing uses 3 bars + D1 state; Bias uses `htfCandles[0]` and `htfCandles[1]` | EBP signal tables, FVG zone tables, swing state D1 | 2 bars for signal; 2 bars for bias | **⚠️ FULL-HISTORY RECOMPUTE** — ~49 bars loaded for signal TF and ~49 bars for HTF; only 2–3 bars used |
| **1H** | `candle_cache` full blob; HTF bias: `daily_candle_cache` via `getDailyCandlesFromCache` (`LIMIT 5`) | ~49 bars (signal) + 5 bars (D HTF) | Same as M15 pattern; `detectEBP` uses 2 bars; bias uses `htfCandles[0,1]` | Signal + swing + FVG tables | 2 bars | **⚠️ FULL-HISTORY RECOMPUTE** (signal TF; HTF over-fetch is mild: 5 bars, 2 used) |
| **4H** | `candle_cache` full blob; HTF bias: `weekly_candle_cache` | ~49 bars (signal) + N bars (W) | Same 2-bar detection pattern | Signal + swing + FVG tables | 2 bars | **⚠️ FULL-HISTORY RECOMPUTE** |
| **D** | `daily_candle_cache` via `getDailyCandlesFromCache` (`LIMIT 5`) | 5 bars | `detectEBP` uses 2 bars; bias = W | Signal tables | 2 bars | mild over-fetch (5 loaded, 2 used) |
| **W** | `weekly_candle_cache` (all stored rows) | Up to 26 bars | `detectEBP` uses 2 bars; no HTF bias | Signal tables | 2 bars | mild over-fetch |

**Key notes:**
- `getDailyCandlesFromCache` uses **`LIMIT 5`** in ebp-worker.js — this is **not** updated to `LIMIT 25` as in compute-worker and sweep-worker. The 5-bar limit is sufficient for the EBP 2-bar check but would fail if SMA Cloud `htf_sma` daily bias mode were added here.
- `calcTTradesBias` for EBP reads `{bar1: htfCandles[0], bar2: htfCandles[1]}` — exactly 2 bars. Loading the full candle_cache blob for the HTF symbol to use 2 bars is the same over-fetch pattern as the signal TF.
- The full `candle_cache` blob is the smallest addressable unit from D1 — there is no SQL to fetch only the first N elements of the JSON array without reading the entire `candles_json` column.

---

## Worker 4: Sweep Worker

**File:** `sweep-worker/src/sweep-cron.js`  
**Trigger:** cron-job.org (every 15 min)

**Role:** Sweep (liquidity sweep) detection, FVG zone tracking, Swing state, HTF bias. Processes signal TFs and template chains (T4/T1/T2).

**BIAS_SOURCE map (Sweep):** `M15 → 1H`, `M30 → 4H`, `1H → D`, `4H → W`

| TF | Fetch — Source & Window | Candles Fetched | Compute Scope | Write Target & Mode | What Is Consumed | Anti-Pattern |
|---|---|---|---|---|---|---|
| **M15** | `candle_cache` full blob; HTF bias: `candle_cache` 1H blob | ~49 bars (signal) + ~49 bars (1H HTF) | `detectSweep(candles)` uses **`candles[0]`** and **`candles[1]`**; FVG uses 3 bars; Swing uses newest bar + D1 state; bias uses `htfCandles[0,1]` | Sweep signal tables, FVG zones, swing state | 2 bars signal; 2 bars bias | **⚠️ FULL-HISTORY RECOMPUTE** |
| **M30** | `candle_cache` full blob; HTF: `candle_cache` 4H blob | ~49 bars + ~49 bars | Same 2-bar detection; same bias pattern | Same targets | 2 bars | **⚠️ FULL-HISTORY RECOMPUTE** |
| **1H** | `candle_cache` full blob; HTF: `daily_candle_cache` (`LIMIT 25`) | ~49 bars + 25 daily bars | Same 2-bar detection; bias uses `htfCandles[0]` close only (1 value) | Same targets | 2 bars signal; 1 value bias | **⚠️ FULL-HISTORY RECOMPUTE** (signal TF); HTF: 25 bars loaded, 9 bars minimum required for SMA9 bias — intentional |
| **4H** | `candle_cache` full blob; HTF: `weekly_candle_cache` | ~49 bars + N weekly bars | Same 2-bar detection | Same targets | 2 bars | **⚠️ FULL-HISTORY RECOMPUTE** |

**Template chain handling (`processTemplateChains`):**
- **T4:** calls `getCandlesFromCache` → `detectSweep` (2 bars used) — same ⚠️ pattern
- **T1/T2:** calls `getCandlesFromCache` → reads only `candles[0].close` (1 value) — same ⚠️ pattern

**Key notes:**
- `getDailyCandlesFromCache` uses **`LIMIT 25`** in this worker (updated to support `htf_sma` bias mode needing 9 daily closes for SMA9). Comment reads: "LIMIT 25 (not the original 5) — forex SMA Cloud's `htf_sma` bias mode needs 9 daily closes minimum for SMA9."
- The HTF 1H bias load of 25 daily bars vs the 9 actually needed for SMA9 is a documented over-fetch, not an oversight.

---

## Worker 5: NSE Worker

**File:** `nse-worker/src/nse-cron.js`  
**Trigger:** cron-job.org schedule (per-TF cron)

**Role:** NSE instrument coverage — EBP/Sweep/MSS detection (3-bar path), TDI (RSI/Bollinger Band), SMA Cloud phase. Uses a completely separate data path from the forex `candle_cache`.

**NSE data path (not `candle_cache`):**
- Primary: Upstox API — 30-day rolling window, includes volume
- Fallback: Yahoo Finance NSE — capped at 60 bars, includes volume
- **`nse_indicator_candle_cache`** — rolling 60-bar accumulator (JSON blob, `(symbol, timeframe, candles, updated_at)`). `mergeAndCacheNSECandles` merges fresh + cached bars, deduplicates by timestamp, sorts newest-first, slices to 60.
- **`nse_candle_cache`** — separate fixed 3-column layout (`bar_0_*`, `bar_1_*`, `bar_2_*`) for the EBP/Sweep/MSS detection path. NOT a JSON blob. NOT shared with `nse_indicator_candle_cache`.

| TF | Fetch — Source & Window | Candles Fetched / Stored | Compute Scope | Write Target & Mode | What Is Consumed | Anti-Pattern |
|---|---|---|---|---|---|---|
| **All TFs — EBP/Sweep/MSS path** | Upstox (30-day window) or Yahoo (60-bar cap); live fetch every cron cycle | Full live fetch → `mergeAndCacheNSECandles` keeps 60 bars | `updateNseCandleCache` stores exactly the **3 newest bars** (fixed column schema) | `nse_candle_cache` `INSERT OR REPLACE` (3-bar fixed columns) | Detectors read 3 fixed bars directly | — *(live fetch overhead is real but the 3-bar write is minimal)* |
| **All TFs — TDI path** | `nse_indicator_candle_cache` (60-bar accumulator) | 60 bars | `runTDIForAsset`: requires ≥48 bars; computes full `RSI(13)` series (Wilder smoothing across all 60 bars), full `BB(34)` series across all RSI values; reads `nse_swing_states` from D1 for swing context | D1 TDI signal state tables | `rsiSeries[0]`, `rsiSeries[1]`, `bbUpperNow`, `bbLowerNow` | **⚠️ FULL-HISTORY RECOMPUTE** — full RSI+BB series computed; only the 1–2 latest values used for signal |
| **All TFs — SMA Cloud path** | `nse_indicator_candle_cache` (60 bars) + `fetchHTFCandles` (live Upstox/Yahoo, `slice(0, 15)`) | 60 bars (signal) + up to 15 bars (HTF live) | `runSMAForAsset`: full `sma1` (60 vals), full `sma9` (60 vals), full `atr14` traversal, crossovers for windows 3/5/10/20; reads `nse_sma_state` prior state | `nse_sma_state` upsert (`INSERT … ON CONFLICT DO UPDATE`) | `priorState.sma1_last`, `priorState.sma9_last`, `priorState.phase`, `cisd_watch_*` | **⚠️ FULL-HISTORY RECOMPUTE** |

**Key notes for NSE:**
- The `nse_sma_state` table stores `updated_at` as **INTEGER (ms epoch)**, unlike `forex_sma_state` which stores `updated_at` as **TEXT (ISO string)**. This is a schema inconsistency between the two tables.
- `runSMAForAsset` has a minimum guard: `if (!candles || candles.length < 25 || !htfCandles || htfCandles.length < 9) return;` — ensures SMA9 has enough bars, but the computation still runs over all 60 available bars, not just the required 25.
- `runTDIForAsset` minimum guard: `if (!candles || candles.length < 48) return;` — but the RSI(13) computation is Wilder smoothing from the oldest bar forward, so all 60 bars participate in initialisation even though only the last 1–2 RSI values drive the signal.
- `fetchHTFCandles` makes a **live Upstox/Yahoo call every NSE cron cycle** for the HTF timeframe — this is not cached. 15 bars are returned; the SMA Cloud needs 9 closes minimum.
- NSE volume is included in both Upstox and Yahoo fetches (unlike forex/crypto, which explicitly excludes volume).
- The `nse_indicator_candle_cache` (60-bar JSON blob) and `nse_candle_cache` (3-bar fixed columns) are entirely separate tables serving different pipeline branches — not aliases.

---

## Summary: All ⚠️ FULL-HISTORY RECOMPUTE / OVER-FETCH Instances

| # | Worker | Feature / Function | TF(s) | History Loaded | Actually Needed | Nature of Waste |
|---|---|---|---|---|---|---|
| 1 | watchdog-worker | `computeSyntheticDXY` | 1H | ~49 bars × 6 constituent pairs | Latest 1–2 DXY bars for downstream signal | Computes DXY OHLC for every common timestamp; writes entire history array; downstream uses 1–2 bars |
| 2 | watchdog-worker | `attemptDailySynthesis` | D | ~49 1H bars per symbol | Only bars from the **current incomplete trading day** matter (completed days already inserted via `INSERT OR IGNORE`) | Re-examines all ~49 hourly bars every cycle; INSERT OR IGNORE makes it idempotent but the full grouping runs regardless |
| 3 | compute-worker | `handleMarketBreadthCron` — correlation | 1H | ~49 bars per pair | ≤10 bars (`seriesLen = Math.min(10, ...)`) | Full blob loaded from `candle_cache`; Pearson correlation uses at most the 10 most-recent bars |
| 4 | compute-worker | `computeWeeklyBreadth` | 1W | All `market_breadth_intraday` rows in last 35 days | One week of hourly snapshots (~168 rows) | Reads the entire 35-day snapshot table to average one completed week |
| 5 | compute-worker | `handleForexSmaCron` | M15 | ~49-bar `candle_cache` blob | `sma1[0]`, `sma9[0]`, `atr14[0]`, last 5 bars for crossover/separation, `priorState.sma1_last`/`sma9_last` | Full SMA1/SMA9/ATR14 arrays computed before prior state is consulted |
| 6 | compute-worker | `handleForexSmaCron` | M30 | ~49 bars | Same as M15 | Same |
| 7 | compute-worker | `handleForexSmaCron` | 1H | ~49 bars | Same | Same |
| 8 | compute-worker | `handleForexSmaCron` | 4H | ~49 bars | Same | Same |
| 9 | ebp-worker | `handleEBPCron` (signal TF) | M15 | ~49-bar blob | `candles[0]`, `candles[1]` for EBP; `candles[0..2]` for FVG; `candles[0..2]` for Swing | Full blob read; `detectEBP` uses 2 bars |
| 10 | ebp-worker | `handleEBPCron` (signal TF) | 1H | ~49-bar blob | Same 2–3 bars | Same |
| 11 | ebp-worker | `handleEBPCron` (signal TF) | 4H | ~49-bar blob | Same 2–3 bars | Same |
| 12 | ebp-worker | `handleEBPCron` (HTF bias load) | M15 (reads 4H), 1H (reads D cached), 4H (reads W) | ~49 bars (4H/W blobs) or 5 bars (daily) | `htfCandles[0]`, `htfCandles[1]` for bias | HTF blob loaded to use 2 bars for bias |
| 13 | sweep-worker | `handleSweepCron` (signal TF) | M15 | ~49-bar blob | `candles[0]`, `candles[1]` for Sweep; `candles[0..2]` for FVG/Swing | Full blob; `detectSweep` uses 2 bars |
| 14 | sweep-worker | `handleSweepCron` (signal TF) | M30 | ~49-bar blob | Same 2–3 bars | Same |
| 15 | sweep-worker | `handleSweepCron` (signal TF) | 1H | ~49-bar blob | Same | Same |
| 16 | sweep-worker | `handleSweepCron` (signal TF) | 4H | ~49-bar blob | Same | Same |
| 17 | sweep-worker | `processTemplateChains` (T4/T1/T2) | M15, M30, 1H, 4H | ~49-bar blob per chain step | T4: 2 bars; T1/T2: 1 value (`candles[0].close`) | Full blob loaded for each chain step |
| 18 | nse-worker | `runTDIForAsset` | All NSE TFs | 60-bar `nse_indicator_candle_cache` | `rsiSeries[0]`, `rsiSeries[1]`, `bbUpperNow`, `bbLowerNow` | Full RSI(13) Wilder series + BB(34) computed across 60 bars; only 1–2 latest values drive signal |
| 19 | nse-worker | `runSMAForAsset` | All NSE TFs | 60-bar `nse_indicator_candle_cache` + 15-bar live HTF fetch | `sma1[0]`, `sma9[0]`, `atr14[0]`, last 20 bars for crossover, `priorState` fields | Full SMA1/SMA9/ATR14 + crossover counts 3/5/10/20 computed; prior state consulted only after full recompute |

---

## Additional Findings

### Schema Inconsistency: `updated_at` Type Mismatch
- `forex_sma_state.updated_at` — TEXT (ISO string)
- `nse_sma_state.updated_at` — INTEGER (ms epoch)

These parallel tables use different timestamp representations. Any code that queries across both tables for recency must handle the type difference explicitly.

### LIMIT Discrepancy: `getDailyCandlesFromCache`
- `ebp-worker.js` — `LIMIT 5`
- `compute-worker/src/index.js` — `LIMIT 25`
- `sweep-worker/src/sweep-cron.js` — `LIMIT 25`

If `htf_sma` daily bias mode is ever activated for EBP signals, the 5-bar limit will cause `runSMAForAsset`'s minimum guard (`candles.length < 25`) to fail silently, returning no bias output. Sweep and compute workers are already corrected.

### NSE HTF Live Fetch Per Cycle
`fetchHTFCandles` makes a live Upstox/Yahoo network call every NSE cron cycle for each symbol's HTF timeframe. Unlike the forex path (which reads HTF from `candle_cache`), NSE HTF candles are not persisted between cycles. This adds latency and Upstox API quota pressure proportional to the number of subscribed symbols × TFs.

### candle_cache Full-Blob Atomic Overwrite
Since `candle_cache` has no sub-row addressing, any worker that needs `candles[0..1]` must deserialise the entire `candles_json` blob from D1, then slice in JavaScript. The over-fetch at the network layer (Twelve Data → `candle_cache`) and at the DB layer (`candle_cache` → JS slice) are structurally coupled to the current storage model.
