# Forex/Crypto SMA Cloud Readiness Audit — 2026-08-03

**Scope**: Read-only audit of `worker/src/ebp-worker.js`, `sweep-worker/src/sweep-cron.js`,
and `watchdog-worker/src/index.js` to assess readiness for porting the NSE SMA Cloud to
forex, crypto, and commodity assets.

**No source files were modified.**

---

## Source Files Audited

| File | Lines | Status |
|---|---|---|
| `worker/src/ebp-worker.js` | ~2300 | Fully read |
| `sweep-worker/src/sweep-cron.js` | ~1142 | Fully read |
| `watchdog-worker/src/index.js` | 933 | Fully read |

---

## Q1 — Does any SMA Cloud logic exist in `ebp-worker.js` or `sweep-cron.js`?

**Answer: No.**

### `ebp-worker.js`

No SMA Cloud computation exists. The only SMA-related code is CRUD for the NSE indicator
config table and a cleanup hook:

- **Lines 1615–1732**: HTTP routes `GET/POST/PATCH/DELETE /user/nse-indicator-configs/:id` —
  read and write `nse_indicator_configs`. These are config management endpoints, not signal
  computation.
- **Delete route (line 1705)**: When the last SMA config for a symbol+TF is removed, cleans
  up the corresponding `nse_sma_state` row:
  ```js
  // Only if no other SMA configs remain for this symbol+TF
  await env.DB.prepare(
    'DELETE FROM nse_sma_state WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, tf).run();
  ```

No `runSMAForAsset`, `advanceSmaPhase`, `computeSMAMetrics`, `checkStack`, `checkSmaCooldown`,
`smaCloud`, or any phase state machine function exists in `ebp-worker.js`.

### `sweep-cron.js`

No SMA-related code whatsoever beyond the shared `BIAS_SOURCE` constant (which is not SMA
Cloud logic). No references to `nse_indicator_configs`, `nse_sma_state`, or any SMA function.
The file implements EBP Sweep pullback detection and closure-type classification only.

**Conclusion**: SMA Cloud is exclusively implemented in `nse-worker/src/nse-cron.js` and
runs only for NSE assets. No port to forex/crypto exists.

---

## Q2 — Candle History Available for Forex/Crypto

### Intraday: `candle_cache`

Written by Watchdog (`watchdog-worker/src/index.js`) via `writeCandleCache` (line 469):

```js
async function writeCandleCache(db, symbol, tf, candles) {
  await db.prepare(`
    INSERT OR REPLACE INTO candle_cache (symbol, tf, candles_json, fetched_at)
    VALUES (?, ?, ?, ?)
  `).bind(symbol, tf, JSON.stringify(candles), new Date().toISOString()).run();
}
```

- **Bar count**: Twelve Data `outputsize=50` → minus the forming (unclosed) candle →
  practical max ~49 closed bars. Only written if `candles.length >= 20`
  (`fetchSignalAndStore`, line 508).
- **Fields**: `{open, high, low, close, time}` (no volume — see Q4)
- **Freshness gate** (`getCandlesFromCache`, ebp-worker.js line 275):
  ```js
  const maxAge = tf === '4H' ? 1.25 * intervalMs['4H'] : 2 * intervalMs[tf];
  if (age > maxAge) return null;
  ```
- **TFs fetched**: M15 (every 15 min), M30 (every 30 min), 1H (every hour), 4H (every NY
  4H boundary). No M5 — `TF_TO_INTERVAL` in Watchdog is
  `{ M15: '15min', M30: '30min', '1H': '1h', '4H': '4h' }`.

### Daily: `daily_candle_cache`

Synthesized by `attemptDailySynthesis` (Watchdog, runs every hour, line 675). Forex trading
day is 17:00 NY → 16:00 NY next calendar day. A day is complete only once its 16:00 NY
bar exists in `candle_cache` `1H`.

- **Bars stored per symbol**: Up to 130 (DELETE trims: `LIMIT 130`)
- **Bars read by signal logic** (`getDailyCandlesFromCache`, ebp-worker.js line 328):
  ```js
  'SELECT date_ny, open, high, low, close FROM daily_candle_cache
   WHERE symbol = ? ORDER BY date_ny DESC LIMIT 5'
  ```
  **Max 5 daily bars returned to any indicator.**
- **Fields stored**: `open, high, low, close, date_ny, synthesised_at` — no volume, no
  intraday timestamp (the `time` field in the returned object is reconstructed by
  `nyDateAtHourToUTCms(addDaysToDateStr(r.date_ny, -1), 17)`)

### Weekly: `weekly_candle_cache`

Synthesized by `attemptWeeklySynthesis` (Watchdog, runs Friday 17:00 NY only, line 731).
Requires both Monday and Friday daily rows for a week to be stored.

- **Bars stored per symbol**: Up to 26 weeks (DELETE trims: `LIMIT 26`)
- **Bars read by signal logic** (`getWeeklyCandlesFromCache`, ebp-worker.js line 339):
  `LIMIT 5` → **max 5 weekly bars**.
- **Fields stored**: `open, high, low, close, week_start_ny, week_end_ny` — no volume, no
  precise timestamp

### Candle Depth Summary

| Cache | Bars stored | Bars readable by signal logic | Volume |
|---|---|---|---|
| `candle_cache` (M15/M30/1H/4H) | ~49 | ~49 | No |
| `daily_candle_cache` | Up to 130 | **5 max** | No |
| `weekly_candle_cache` | Up to 26 | **5 max** | No |

**Critical gap**: `runSMAForAsset` (NSE) requires `htfCandles.length >= 9`. When the
HTF is `D` or `W`, current readers return at most 5 bars — the minimum guard fails
immediately and the function returns without processing. The daily/weekly `LIMIT` must
be raised (to at least 25 for `D`, 9 for `W`) before they can serve as viable HTF sources
for SMA Cloud.

---

## Q3 — Forex/Crypto Indicator Config Table Existence

**Answer: None of the NSE-equivalent tables exist for forex/crypto.**

| NSE Table | Purpose | Forex Equivalent |
|---|---|---|
| `nse_indicator_configs` | Per-user SMA/TDI config per asset+TF | **None** |
| `nse_sma_state` | Phase state persistence (symbol+TF) | **None** |
| `nse_indicator_candle_cache` | 60-bar rolling history accumulator | **None** |

### `nse_indicator_configs` detail

The CRUD routes in `ebp-worker.js` (lines 1615–1732) are NSE-only throughout:

- POST validation enforces `asset_type = 'nse'` (the config lookup joins `user_assets`
  with `WHERE ua.asset_type='nse'`)
- Valid timeframes for SMA indicator: `['M15', 'M5']`
- Valid `bias_mode` values: `['ttrades', 'htf_sma']`
- Valid `htf_timeframe` values: `['M30', '1H']`

None of these constraints map to forex M15/1H/4H signal timeframes. No parallel forex
routes exist in either `ebp-worker.js` or `sweep-cron.js`.

### `nse_indicator_candle_cache` gap

The NSE accumulator stores up to 60 bars per symbol+TF+userId over multiple Watchdog
ticks, ensuring enough history for ATR(14) even if a single Twelve Data fetch returns
fewer closed bars. No equivalent accumulator exists for forex — the 49-bar intraday
`candle_cache` is sufficient for M15/M30/1H/4H (ATR(14) needs 15 bars), but if Watchdog
ever returns fewer than 20 closed bars for a forex symbol, the data is discarded and
no history accumulation catches the gap.

---

## Q4 — Volume Data in Forex/Crypto Candles

**Answer: No. Volume is never stored in any forex/crypto candle cache.**

### Twelve Data path

`fetchChunkWithKey` (watchdog-worker/src/index.js, lines 411–417) maps the API response
to candle objects, explicitly omitting `volume`:

```js
const raw = entry.values.map(v => ({
  open:  parseFloat(v.open),
  high:  parseFloat(v.high),
  low:   parseFloat(v.low),
  close: parseFloat(v.close),
  time:  nyLocalStringToUTCms(v.datetime),
  // v.volume is present in the Twelve Data response but intentionally not mapped
}));
```

### Yahoo Finance fallback path

`fetchYahooFinance` (watchdog-worker/src/index.js) returns candles as
`{open, high, low, close, time}` — no volume field in the returned objects.

### DXY synthetic

`computeSyntheticDXY` (line 547) builds DXY candles from the ICE formula applied to 6
forex pair candles. Output: `{time, open, close, high, low}` — no volume.

### Daily/weekly synthesis

`attemptDailySynthesis` and `attemptWeeklySynthesis` aggregate OHLC only. Even if volume
were added to `candle_cache`, the synthesis functions do not read or forward it.

### Implication

Any SMA Cloud port to forex/crypto cannot use volume-based conditions (e.g., volume-gated
candle strength, volume confirmation of phase transitions) without first adding volume to
both the Twelve Data mapper and Yahoo fallback mapper, propagating through `candle_cache`,
and updating the daily/weekly synthesis functions.

---

## Q5 — Bias Cache TF Coverage

`bias_cache` schema: `symbol, timeframe, bias, closure_type, close_pos, bar1_time, updated_at`

Bias is written for the **HTF** of the signal TF (not the signal TF itself). The mapping
comes from `BIAS_SOURCE` (ebp-worker.js, line 135):

```js
const BIAS_SOURCE = {
  ebp:      { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null },
  sweep:    { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
  template: { 'W': null, 'D': 'W', '4H': 'D', '1H': '4H' },
};
```

Both `handleEBPCron` and `handleSweepCron` call `resolveHTF(biasType, tf, row.htf_override)`
which reads the above map (with per-config override support). The resolved HTF is what is
written to `bias_cache`.

### EBP bias writes

| Signal TF (cron input) | HTF written to `bias_cache` |
|---|---|
| M15 | 4H |
| 1H | D |
| 4H | W |
| D | W |
| W | *(null — no entry written)* |

### Sweep bias writes

| Signal TF (cron input) | HTF written to `bias_cache` |
|---|---|
| M5 | 1H *(but Watchdog never fetches M5 candles — dead path)* |
| M15 | 1H |
| M30 | 4H |
| 1H | D |
| 4H | W |

### Coverage note

The `bias_cache` is **already populated for forex/crypto symbols** for TFs 4H, 1H, D, and W
as a side-effect of the existing EBP and Sweep crons. A hypothetical SMA Cloud cron for
forex could read `bias_cache` for the bias filter without any additional bias machinery.

However, `bias_mode = 'htf_sma'` (used in NSE SMA Cloud) reads `nse_sma_state` rather than
`bias_cache` — a path that has no forex equivalent (see Q3).

---

## Q6 — Which Worker Handles EBP/Sweep Crons for M15/M30/1H

### EBP Cron — `handleEBPCron` in `worker/src/ebp-worker.js`

- **Trigger**: External POST to `/cron/ebp` with `{ tf }` in body
- **Processed TFs**: M15, 1H, 4H, D, W
  - `tf: 'BREADTH'` → routes to `handleMarketBreadthCron` instead
- **Asset types covered**: forex, crypto, commodity (query filters `user_assets.asset_type`)
- **NOT M30**: No M30 EBP path. `BIAS_SOURCE.ebp` has no M30 entry.

### Sweep Cron — `handleSweepCron` in `sweep-worker/src/sweep-cron.js`

- **Trigger**: External POST to `/cron/sweep` with `{ tf }` in body (separate worker)
- **Processed TFs**: M15, M30, 1H, 4H
- **M5 status**: Present in `BIAS_SOURCE.sweep` but Watchdog's `TF_TO_INTERVAL` has no
  M5 entry → no M5 candles are ever fetched → M5 sweep is effectively a dead path

### Watchdog — `watchdog-worker/src/index.js`

- **Trigger**: Cloudflare native scheduled cron `*/15 * * * *`
- **Role**: Candle fetcher only. Fetches Twelve Data/Yahoo, writes `candle_cache`,
  synthesizes `daily_candle_cache`/`weekly_candle_cache`.
- **Does NOT run** EBP, Sweep, or any signal detection logic.

### TF-to-Worker Matrix

| TF | EBP cron (ebp-worker) | Sweep cron (sweep-worker) | Watchdog (candles) |
|---|---|---|---|
| M5 | — | map entry only, dead path | — |
| M15 | Yes | Yes | Yes (every tick) |
| M30 | — | Yes | Yes (every 30 min) |
| 1H | Yes | Yes | Yes (every hour) |
| 4H | Yes | Yes | Yes (NY 4H boundaries) |
| D | Yes | — | synthesized from 1H |
| W | Yes | — | synthesized from daily |

---

## Summary: Readiness for Forex/Crypto SMA Cloud Port

### What already exists (reusable without modification)

| Asset | Status |
|---|---|
| Intraday candle data (M15/M30/1H/4H) | Available — ~49 bars, adequate for ATR(14) |
| `bias_cache` entries for forex/crypto | Already populated by EBP and Sweep crons |
| `BIAS_SOURCE` maps | Include all relevant forex TFs |
| Telegram delivery infrastructure | Exists — would need `nse_tf_access` → `forex_tf_access` equivalent |

### What must be built before porting `runSMAForAsset`

| Gap | Severity | Detail |
|---|---|---|
| No `indicator_configs` table for forex | Blocker | No per-user SMA config routing for forex/crypto. `nse_indicator_configs` is NSE-only. |
| No `sma_state` table for forex | Blocker | Phase state (`accumulation → transition → distribution`) cannot be persisted. No `nse_sma_state` equivalent for forex. |
| Daily/weekly reader depth too shallow | Blocker for D/W HTF | `getDailyCandlesFromCache` and `getWeeklyCandlesFromCache` return max 5 bars. `runSMAForAsset` requires `htfCandles.length >= 9`. Readers must use `LIMIT 25` (daily) and `LIMIT 9` (weekly) at minimum. |
| No volume in candles | Missing feature | `v.volume` is discarded in `fetchChunkWithKey`. Yahoo fallback has no volume. Any volume-gated SMA condition cannot be implemented without plumbing changes through Watchdog. |
| No candle history accumulator for forex | Risk | NSE uses `nse_indicator_candle_cache` to accumulate 60 bars across ticks. Forex has no equivalent — a single bad tick with <20 candles leaves a symbol unprocessable. |
| No SMA cron dispatch path | Blocker | No route in `ebp-worker.js` or `sweep-cron.js` dispatches to a forex SMA handler. A new cron handler (or extension of `handleEBPCron`) must be built. |
| Alert delivery is NSE-gated | Minor | `deliverNseIndicatorAlert` checks `nse_tf_access`. A forex port needs a `forex_tf_access` column or a generalized TF-access check. |
| `bias_mode = 'htf_sma'` reads `nse_sma_state` | Blocker for htf_sma mode | The NSE `htf_sma` bias path reads the HTF's `nse_sma_state.phase`. No forex SMA state to read — this bias mode is unavailable for forex unless a forex state table is added first. |

### Minimum viable port checklist

1. Create `indicator_configs` table (generalized, with `asset_type` column) or separate
   `forex_indicator_configs` mirroring `nse_indicator_configs` schema.
2. Create `sma_state` table (generalized or `forex_sma_state`) mirroring `nse_sma_state`.
3. Raise `LIMIT` in `getDailyCandlesFromCache` to 25 and `getWeeklyCandlesFromCache` to 9.
4. Add a forex SMA cron handler (e.g., `handleForexSmaCron`) in `ebp-worker.js` or a new
   worker, routing via the new `indicator_configs` table.
5. Map `asset_type IN ('forex','crypto','commodity')` in the handler's config query.
6. Either accept that `bias_mode = 'htf_sma'` is unavailable initially, or build forex
   SMA state before enabling that mode.
7. Skip any volume-based conditions until volume is plumbed through Watchdog.

---

*Audit completed 2026-08-03. All findings derive from static code reading only.*
