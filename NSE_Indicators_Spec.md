# EBP Tracker — NSE Indicators Spec
**Version:** 1.0 — July 2026
**Phase:** D++ (NSE Worker extension — after Phase D NSE Worker is live)
**Scope:** Two standalone indicators: TDI and SMA Cloud. Both implemented as extensions of the existing NSE Worker. Independent signal logic, shared infrastructure.

---

## Architecture Overview

Both indicators are implemented inside the existing NSE Worker as extensions of the `/cron/nse` route. They share:
- `nse_candle_cache` D1 table — 60 candles JSON array per (symbol, timeframe)
- `nse_indicator_configs` D1 table — per-asset per-indicator config rows
- Upstox candle fetch function already present in NSE Worker
- `swing_state` D1 table — already live, shared with EBP/Sweep Workers
- `bias_cache` D1 table — already live, populated by EBP Worker daily cron

They do NOT share state tables — TDI has `nse_indicator_chain`, SMA has `nse_sma_state`.

---

## Shared Infrastructure

### D1 Table: `nse_candle_cache`

```sql
CREATE TABLE IF NOT EXISTS nse_candle_cache (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  candles     TEXT NOT NULL,  -- JSON array of 60 OHLCV objects, newest first
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
```

Each candle object in the array:
```json
{ "open": 1280.5, "high": 1285.0, "low": 1278.2, "close": 1282.3, "volume": 485000, "time": 1722000000000 }
```

Rolling update — each cron run fetches latest candles, merges with stored array, trims to 60, writes back.

### D1 Table: `nse_indicator_configs`

```sql
CREATE TABLE IF NOT EXISTS nse_indicator_configs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  asset_id        INTEGER NOT NULL,
  indicator       TEXT NOT NULL,     -- 'tdi' | 'sma'
  timeframe       TEXT NOT NULL,     -- 'M15' | 'M30' for tdi; 'M15' | 'M5' for sma
  stack_mode      TEXT DEFAULT NULL, -- 'strict' | 'loose' — sma only, null for tdi
  day_filter      INTEGER DEFAULT NULL, -- 1 | 0 — sma only, null for tdi
  enabled         INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL
);
```

### Shared Helper Functions (pure JS, stateless)

```javascript
// RSI — Wilder smoothing
function computeRSI(candles, period = 13) {
  // candles: newest-first array of {close}
  // reverse to oldest-first for computation
  const closes = [...candles].reverse().map(c => c.close);
  // standard Wilder RSI implementation
  // return array of RSI values, newest-first
}

// SMA — simple moving average
function computeSMA(values, period) {
  // values: array (oldest-first)
  // return array of SMA values same length (nulls for first period-1)
}

// ATR — 14-period average true range
function computeATR(candles, period = 14) {
  // candles: newest-first
  // return single ATR value for current bar
}

// Bollinger Bands on a series
function computeBB(values, period = 34, stdDevMult = 1.6185) {
  // values: array (oldest-first)
  // return { upper, middle, lower } arrays
}
```

---

## Indicator 1: TDI (Traders Dynamic Index)

### Parameters — Fixed (not user configurable)

| Parameter | Value |
|---|---|
| RSI length | 13 (Wilder smoothing) |
| Red line | SMA(2) of RSI series |
| Yellow line | SMA(7) of RSI series |
| Bollinger Band on RSI | 34-period, 1.6185 std dev |
| Divergence lookback | 20 candles |
| Volume threshold | 1.5× 20-bar SMA of volume |
| Candles fetched | 60 per run |
| Supported TFs | M15, M30 (user choice per config row) |

### Signal Chain — 4 Conditions

**Bullish signal (BUY):**

```
Condition 1: RSI red line <= lower BB band (exhaustion at lower band)
Condition 2: Bullish divergence confirmed:
  - swing_state.run_direction === 'bearish'
  - current RSI low > prior RSI at swing_state.run_extreme candle
  - current price low <= swing_state.run_extreme price
  Fallback if swing_state.confirmed_swing_low is null:
  - use 20-candle lookback min close as proxy swing reference
  - compare RSI at that candle vs current RSI
Condition 3: Red line crosses above yellow line
  (simultaneous with conditions 1+2 is acceptable)
Condition 4: MSS confirmed — close > swing_state.confirmed_swing_high
  AND volume > 1.5× 20-bar SMA of volume (equity assets only)
  (index assets: skip volume check, MSS alone is sufficient)
```

**Bearish signal (SELL):**

```
Condition 1: RSI red line >= upper BB band
Condition 2: Bearish divergence:
  - swing_state.run_direction === 'bullish'
  - current RSI high < prior RSI at swing_state.run_extreme candle
  - current price high >= swing_state.run_extreme price
  Fallback: 20-candle lookback max close as proxy
Condition 3: Red line crosses below yellow line
Condition 4: MSS confirmed — close < swing_state.confirmed_swing_low
  AND volume > 1.5× (equity) or skip (index)
```

### Chain State Machine

```
State 0 — Watching (no D1 row)
  Every cron run: evaluate conditions 1+2+3
  All three met → create nse_indicator_chain row (State 1)
  One or more not met → remain in State 0

State 1 — Exhaustion + Momentum Confirmed
  Every cron run: evaluate condition 4 (MSS + volume)
  Met → fire alert, delete chain row
  Not met → check expiry
  Expired (4 candles elapsed) → delete chain row, reset to State 0
```

### D1 Table: `nse_indicator_chain`

```sql
CREATE TABLE IF NOT EXISTS nse_indicator_chain (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  asset_id    INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,   -- 'bullish' | 'bearish'
  state       INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL  -- created_at + (4 × TF minutes in ms)
);
```

One row per active pending chain per user per asset per TF. If a new conditions 1+2+3 trigger fires while a chain row already exists for that user/asset/TF — overwrite the existing row (reset expiry).

### SMA Context Line

At TDI alert fire time, read `nse_sma_state` for (symbol, timeframe):

| nse_sma_state condition | Line appended to Telegram |
|---|---|
| phase = 'distribution', direction = same as TDI signal | `📊 SMA Context: Bearish distribution — aligned ✅` |
| phase = 'distribution', direction = opposite to TDI signal | `📊 SMA Context: Bearish distribution active ⚠️` |
| phase = 'accumulation' or null | `📊 SMA Context: Accumulation phase` |
| nse_sma_state row does not exist for this asset | Line omitted entirely |

### Telegram Alert Format

**BUY signal (equity):**
```
🟢 BUY — RELIANCE
⏱ Timeframe: M15
🕐 Candle: Jul 28, 10:00 AM IST
━━━━━━━━━━━━━━
TDI: RSI exhaustion at lower band
Divergence: Price LL, RSI HL confirmed
Momentum: Red crossed Yellow ↑
MSS: Swing high reclaimed: 1,391.50
📦 Volume: 2.3× average
📊 SMA Context: Bearish distribution active ⚠️
━━━━━━━━━━━━━━
EBP Tracker
```

**SELL signal (equity):**
```
🔴 SELL — RELIANCE
⏱ Timeframe: M15
🕐 Candle: Jul 28, 11:45 AM IST
━━━━━━━━━━━━━━
TDI: RSI exhaustion at upper band
Divergence: Price HH, RSI LH confirmed
Momentum: Red crossed Yellow ↓
MSS: Swing low broken: 1,441.20
📦 Volume: 3.1× average
📊 SMA Context: Bullish markup active ⚠️
━━━━━━━━━━━━━━
EBP Tracker
```

**Index asset (no volume line):**
```
🟢 BUY — NIFTY 50
⏱ Timeframe: M15
🕐 Candle: Jul 28, 10:00 AM IST
━━━━━━━━━━━━━━
TDI: RSI exhaustion at lower band
Divergence: Price LL, RSI HL confirmed
Momentum: Red crossed Yellow ↑
MSS: Swing high reclaimed: 23,847.50
━━━━━━━━━━━━━━
EBP Tracker
```

### alert_history entry
```
alert_type = 'tdi'
direction = 'bullish' | 'bearish'
```

---

## Indicator 2: SMA Cloud

### Parameters — Fixed except where noted

| Parameter | Value | User configurable? |
|---|---|---|
| SMA LTF | SMA(9) on native TF (M15 or M5) | No |
| SMA HTF | SMA(9) on 1H (separate fetch) | No |
| ATR | ATR(14) on native TF | No |
| Separation threshold | ATR(14) × 0.15 | No |
| Velocity threshold | ATR(14) × 0.03 per candle | No |
| Crossover lookback | 20 candles | No |
| Transition confirmation | 2 consecutive widening candles | No |
| Volume threshold (Type 1) | 1.5× 20-bar SMA (equity only) | No |
| HTF bias gate | Daily TTrades bias from bias_cache | No |
| Stack mode | strict (default) | Yes — strict / loose |
| Day filter | ON (default) | Yes — on / off |
| Type 2 cooldown M15 | Session gate (1 per calendar date IST) | No |
| Type 2 cooldown M5 | 12-candle (1 hour) cooldown | No |
| Candles fetched (native TF) | 60 | No |
| Candles fetched (1H) | 15 | No |
| Supported TFs | M15, M5 | Yes — user choice |

### Cloud Definition

```javascript
cloud_top    = Math.max(sma9_ltf, sma9_htf)
cloud_bottom = Math.min(sma9_ltf, sma9_htf)
cloud_width  = cloud_top - cloud_bottom
separation   = Math.abs(sma9_ltf - sma9_htf)
```

### Stack Definitions

**Strict bullish:** `close > sma9_ltf > sma9_htf`
**Strict bearish:** `close < sma9_ltf < sma9_htf`
**Loose bullish:** `close > sma9_ltf AND close > sma9_htf` (order between MAs doesn't matter)
**Loose bearish:** `close < sma9_ltf AND close < sma9_htf`

### Phase State Machine

Computed every cron run. Written to `nse_sma_state`.

```
ACCUMULATION
  crossover_count_20 >= 3  (SMAs crossed >= 3 times in last 20 candles)
  OR separation < ATR × 0.15
  → No signal eligible

  ↓ crossovers stop, separation starts widening

TRANSITION (armed)
  crossover_count_5 === 0  (no crossovers in last 5 candles)
  AND separation widening vs 5 candles ago (consecutive_widening_count >= 1)
  AND price closed same side of both SMAs for last 3 candles
  → Count consecutive widening candles
  → After 2 consecutive widening candles: advance to DISTRIBUTION

DISTRIBUTION ACTIVE
  crossover_count_10 === 0
  AND separation > ATR × 0.15
  AND price_consistency_5 >= 4  (4 of last 5 candles closed on trend side of both MAs)
  → Type 1 eligible (on transition from TRANSITION)
  → Type 2 eligible (on subsequent sessions)

  ↓ separation narrows, crossovers resume

EXHAUSTION
  separation narrowing (current < 5-candle-ago separation)
  AND crossover_count_5 >= 1
  AND price_consistency_5 <= 3
  → Fire exhaustion notification
  → Reset to ACCUMULATION
```

### Crossover Detection

A crossover occurs when sma9_ltf and sma9_htf swap relative position between consecutive candles:
```javascript
function didCrossover(i) {
  // i = candle index in array (0 = current, newest first)
  const curr = sma9_ltf[i] > sma9_htf[i];
  const prev = sma9_ltf[i+1] > sma9_htf[i+1];
  return curr !== prev;
}
crossover_count_20 = sum of didCrossover(i) for i in 0..19
crossover_count_10 = sum of didCrossover(i) for i in 0..9
crossover_count_5  = sum of didCrossover(i) for i in 0..4
```

### Velocity Computation

```javascript
separation_now   = Math.abs(sma9_ltf[0] - sma9_htf[0])
separation_5ago  = Math.abs(sma9_ltf[5] - sma9_htf[5])
separation_velocity = (separation_now - separation_5ago) / 5
velocity_label = separation_velocity > (atr14 × 0.03) ? 'Sharp' : 'Gradual'
```

### Day of Week Filter (when day_filter = 1)

```javascript
const istDate   = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' });
const istHour   = parseInt(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
```

| Day | Type 1 | Type 2 |
|---|---|---|
| Monday | ✅ Allowed | ✅ Allowed |
| Tuesday | ✅ Allowed | ✅ Allowed |
| Wednesday | ✅ Allowed but require crossover_count_8 === 0 (stricter) | ✅ Allowed with stricter crossover rule |
| Thursday | ✅ Allowed | ✅ Allowed |
| Friday | ✅ Before 12:00 IST only | ✅ Before 12:00 IST only |

When day_filter = 0: skip all day checks entirely.

### Type 1 Signal — Trend Initiation

Fires when:
1. Phase transitions from TRANSITION to DISTRIBUTION (2nd consecutive widening candle confirmed)
2. Stack satisfied (strict or loose per config)
3. Close fully beyond cloud (bullish: close > cloud_top; bearish: close < cloud_bottom)
4. Daily bias from bias_cache (symbol, 'D') matches direction
5. Volume > 1.5× 20-bar SMA (equity only; skip for nse_index)
6. Day filter passes

Cooldown: Type 1 cannot refire until stack breaks and reforms (phase resets to ACCUMULATION and a new DISTRIBUTION begins).

### Type 2 Signal — Cloud Rejection Re-entry

Fires when:
1. Phase = DISTRIBUTION ACTIVE (stack already formed, Type 1 already fired in prior session)
2. Daily bias still aligned
3. Day filter passes
4. Session/cooldown gate cleared:
   - M15: last_signal_date < today (IST calendar date)
   - M5: current_time - last_signal_time > 60 minutes
5. Price entered cloud: (bearish) candle high >= cloud_bottom; (bullish) candle low <= cloud_top
6. Price rejected from cloud: (bearish) close < cloud_bottom; (bullish) close > cloud_top
7. TTrades M15 closure on rejection candle aligned with direction:
   - Bearish: close < max(open, close) of prior candle body
   - Bullish: close > min(open, close) of prior candle body

### Exhaustion Notification

Fires when phase transitions from DISTRIBUTION to ACCUMULATION/EXHAUSTION.
- One notification per distribution cycle
- Cannot refire until new distribution phase forms and exhausts
- Write to alert_history with alert_type = 'sma_exhaustion'

### HTF Bias Gate

Read from `bias_cache` WHERE symbol = X AND timeframe = 'D'.
If no row exists → attempt to compute TTrades Daily bias from available Daily candle data.
If no Daily candles available → skip signal (do not fire without bias confirmation).

TTrades bias computation (same as calcTTradesBias in EBP Worker):
```javascript
// bar1 = most recent closed Daily bar, bar2 = prior Daily bar
// Returns 'bullish' | 'bearish' | 'neutral'
function calcTTradesBias({ bar1, bar2 }) { ... }
```

### D1 Table: `nse_sma_state`

```sql
CREATE TABLE IF NOT EXISTS nse_sma_state (
  symbol                    TEXT NOT NULL,
  timeframe                 TEXT NOT NULL,
  direction                 TEXT,          -- 'bullish' | 'bearish' | null
  phase                     TEXT,          -- 'accumulation' | 'transition' | 'distribution' | 'exhaustion' | null
  stack_active              INTEGER DEFAULT 0,
  consecutive_widening      INTEGER DEFAULT 0,  -- counts consecutive widening candles during transition
  separation                REAL,          -- last computed separation value
  velocity_label            TEXT,          -- 'Sharp' | 'Gradual'
  atr14                     REAL,          -- last computed ATR(14) value
  cloud_top                 REAL,
  cloud_bottom              REAL,
  stack_formed_date         TEXT,          -- IST date string 'YYYY-MM-DD'
  last_signal_date          TEXT,          -- IST date string — for M15 session gate
  last_signal_time          INTEGER,       -- Unix ms timestamp — for M5 cooldown
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
```

### Telegram Alert Formats

**Type 1 — Sharp distribution (equity):**
```
🔴 SELL — RELIANCE
⏱ Timeframe: M15
🕐 Candle: Jul 28, 10:30 AM IST
━━━━━━━━━━━━━━
SMA Stack: Bearish distribution — Sharp ⚡
Close: 1,424.60
SMA 9 (M15): 1,425.80
SMA 9 (1H): 1,430.40
Cloud gap: widening
HTF Bias: Bearish (Daily) ✅
📦 Volume: 2.4× average
━━━━━━━━━━━━━━
EBP Tracker
```

**Type 1 — Gradual markup (equity):**
```
🟢 BUY — RELIANCE
⏱ Timeframe: M15
🕐 Candle: Aug 3, 11:00 AM IST
━━━━━━━━━━━━━━
SMA Stack: Bullish markup — Gradual 📉
Close: 1,399.40
SMA 9 (M15): 1,392.60
SMA 9 (1H): 1,388.40
Cloud gap: widening
HTF Bias: Bullish (Daily) ✅
📦 Volume: 1.9× average
━━━━━━━━━━━━━━
EBP Tracker
```

**Type 2 — Cloud rejection:**
```
🔴 SELL — RELIANCE
⏱ Timeframe: M15
🕐 Candle: Jul 29, 10:00 AM IST
━━━━━━━━━━━━━━
SMA Re-entry: Cloud rejection confirmed
Rejected from: 1,414.60 (cloud bottom)
Closure: Bearish ✅
HTF Bias: Bearish (Daily) ✅
━━━━━━━━━━━━━━
EBP Tracker
```

**Exhaustion notification:**
```
⚠️ RELIANCE — SMA Trend Exhausting
⏱ Timeframe: M15
🕐 Candle: Jul 30, 02:15 PM IST
━━━━━━━━━━━━━━
SMAs converging — distribution phase ending
Consider tightening stops or exiting position
━━━━━━━━━━━━━━
EBP Tracker
```

**Index asset — no volume line on Type 1:**
Same format as equity Type 1 but omit the 📦 Volume line entirely.

### alert_history entries
```
Type 1:        alert_type = 'sma_type1'
Type 2:        alert_type = 'sma_type2'
Exhaustion:    alert_type = 'sma_exhaustion'
direction:     'bullish' | 'bearish'
```

---

## API Routes — New (EBP Worker)

Both indicators share the same config route pattern as EBP/Sweep configs:

```
GET    /user/nse-indicator-configs/:assetId   
  → list all nse_indicator_configs rows for this asset (user scoped)

POST   /user/nse-indicator-configs/:assetId   
  → create config row
  Body: { indicator: 'tdi'|'sma', timeframe: 'M15'|'M30'|'M5', stack_mode?: 'strict'|'loose', day_filter?: 1|0 }
  Validation:
    - tdi: timeframe must be M15 or M30; stack_mode and day_filter ignored
    - sma: timeframe must be M15 or M5; stack_mode defaults to 'strict'; day_filter defaults to 1
  Max 1 config per indicator per timeframe per asset

PATCH  /user/nse-indicator-configs/:id        
  → update enabled (0|1), stack_mode, or day_filter
  → cannot change indicator or timeframe after creation

DELETE /user/nse-indicator-configs/:id        
  → delete config row
  → also delete associated nse_indicator_chain row (TDI) or nse_sma_state row (SMA) for this asset+TF
```

---

## Frontend — AssetCard NSE Indicators Section

Only rendered when asset_type = 'nse_asset' OR asset_type = 'nse_index'.
Never rendered on forex/crypto assets.

Two separate collapsible panels below the existing AI Alerts section:

### TDI Panel

```
─────────────────────────────────
TDI ALERTS          [ ✓ enabled ]

  M15   [Enabled ▾]   [✕]
  + Add TDI Alert
```

Add TDI Alert → renders a timeframe select (M15 / M30) + Add button.
No other user-configurable options.

### SMA Cloud Panel

```
─────────────────────────────────
SMA CLOUD ALERTS    [ ✓ enabled ]

  M15   Strict   Day filter: On   [Enabled ▾]   [✕]
  + Add SMA Alert
```

Add SMA Alert → renders:
- Timeframe select: M15 / M5
- Stack mode select: Strict / Loose
- Day filter select: On / Off

### Enable/Disable behaviour
Top-level checkbox enables/disables ALL configs for that indicator on that asset — same pattern as EBP/Sweep section checkboxes. Individual row [Enabled ▾] toggles individual config rows.

---

## Cron Integration

Both indicators run inside the existing `/cron/nse` route handler in the NSE Worker.

Execution order per cron run:
```
1. Fetch 60 native TF candles (Upstox, already implemented for Phase D EBP/Sweep)
2. Update nse_candle_cache
3. For each user with nse_indicator_configs on this asset+TF:
   a. Run TDI computation → check/advance chain state
   b. Run SMA computation → check/advance sma state
4. Fire any alerts (Telegram + alert_history)
```

Both indicators share the same candle fetch — one Upstox call per asset per TF per run regardless of how many indicators are enabled.

SMA additionally requires a 1H candle fetch for the HTF SMA:
```
fetchUpstoxCandles(symbol, '1H', 15)
```
This is one additional Upstox call per asset per NSE cron run when SMA is enabled.

---

## Cron Schedule (new jobs on cron-job.org)

| Job | TF | Schedule IST | Schedule UTC | Notes |
|---|---|---|---|---|
| NSE Indicators M15 | M15 | 09:15–15:30 every 15 min Mon–Fri | 03:45–10:00 every 15 min | Market hours only |
| NSE Indicators M30 | M30 | 09:30–15:30 every 30 min Mon–Fri | 04:00–10:00 every 30 min | For TDI M30 configs |
| NSE Indicators M5 | M5 | 09:15–15:30 every 5 min Mon–Fri | 03:45–10:00 every 5 min | For SMA M5 configs |

All secured by same X-Cron-Secret pattern as existing EBP/Sweep cron jobs.
IST = UTC+5:30 fixed, no DST adjustment needed.

---

## Volume Handling by Asset Type

| Asset type | TDI volume check | SMA volume check |
|---|---|---|
| nse_asset (equity) | Required — 1.5× 20-bar SMA | Required on Type 1 — 1.5× 20-bar SMA |
| nse_index | Skipped — volume field is 0 from Upstox | Skipped — volume line omitted from alert |

Check: `if (asset.asset_type === 'nse_index') skip volume`

---

## swing_state Dependency

Both TDI (MSS check) and SMA (TTrades closure check) read from `swing_state` table keyed by (symbol, timeframe).

swing_state is populated by `updateSwingState()` which already runs in EBP Worker and Sweep Worker.

For NSE assets the NSE Worker must also call `updateSwingState()` on every cron run before running TDI/SMA signal checks — otherwise swing_state may be stale for NSE-specific TFs.

`updateSwingState()` and `detectMSS()` functions must be copied/inlined into NSE Worker (same pattern as how sweep-cron.js inlines all its dependencies) — do not import from EBP Worker.

---

## D1 Schema Summary — New Tables

```sql
-- Run against ebp-tracker-db before deploying NSE Worker with indicators

CREATE TABLE IF NOT EXISTS nse_candle_cache (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  candles     TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS nse_indicator_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  asset_id    INTEGER NOT NULL,
  indicator   TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  stack_mode  TEXT DEFAULT NULL,
  day_filter  INTEGER DEFAULT NULL,
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nse_indicator_chain (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  asset_id    INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,
  state       INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nse_sma_state (
  symbol                TEXT NOT NULL,
  timeframe             TEXT NOT NULL,
  direction             TEXT,
  phase                 TEXT,
  stack_active          INTEGER DEFAULT 0,
  consecutive_widening  INTEGER DEFAULT 0,
  separation            REAL,
  velocity_label        TEXT,
  atr14                 REAL,
  cloud_top             REAL,
  cloud_bottom          REAL,
  stack_formed_date     TEXT,
  last_signal_date      TEXT,
  last_signal_time      INTEGER,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
```

---

## Verification Checklist (post-deployment)

- [ ] nse_candle_cache populated after first cron run for an NSE asset
- [ ] TDI chain created in nse_indicator_chain when conditions 1+2+3 met
- [ ] TDI chain expires after 4 candles if MSS not confirmed
- [ ] TDI BUY alert fires to Telegram with correct format
- [ ] TDI SELL alert fires to Telegram with correct format
- [ ] TDI volume line absent for nse_index assets
- [ ] SMA context line present in TDI alert when nse_sma_state exists
- [ ] SMA context line absent when nse_sma_state does not exist for asset
- [ ] SMA phase transitions correctly: accumulation → transition → distribution
- [ ] SMA Type 1 fires on 2nd consecutive widening candle with all gates passed
- [ ] SMA Type 2 fires on cloud rejection with correct cooldown enforcement
- [ ] SMA exhaustion notification fires on phase reset
- [ ] SMA velocity label correct — Sharp vs Gradual
- [ ] Day filter blocks Friday signals after 12:00 IST when enabled
- [ ] Day filter bypass works when day_filter = 0
- [ ] GET /user/nse-indicator-configs/:assetId returns correct rows
- [ ] POST creates config with correct defaults
- [ ] PATCH updates enabled/stack_mode/day_filter correctly
- [ ] DELETE removes config and cleans up associated state rows
- [ ] Frontend TDI panel renders only on nse_asset and nse_index asset cards
- [ ] Frontend SMA panel renders only on nse_asset and nse_index asset cards
- [ ] alert_history entries written correctly for all alert types

---

*Spec v1.0 — July 2026*
*Implementation: Claude Code in VS Code*
*Planning: Claude.ai planning chat*
