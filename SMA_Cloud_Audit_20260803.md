# SMA Cloud Implementation Audit — nse-worker/src/nse-cron.js
**Date:** 2026-08-03  
**File:** `nse-worker/src/nse-cron.js` (1542 lines)  
**Scope:** Read-only audit. No source files modified.

---

## 1. Data Inputs

### Native-TF Candles
Entry point: `runSMAForAsset(symbol, timeframe, userId, assetId, candles, htfCandles, stackMode, biasMode, htfTimeframe, env)` — line 1008.

`candles` arrives pre-merged from the caller (`handleNseCron`, line 1504):
```js
const indicatorCandles = await mergeAndCacheNSECandles(symbol, tf, candles, env);
```
Format: newest-first array of `{ time, open, high, low, close, volume }`.  
Minimum required: `candles.length >= 25` (line 1009 guard).  
Additional internal guards:
- `sma1[0] == null || sma9[0] == null || atr14 == null` → return (line 1018)
- `sma1.length < 21 || sma9.length < 21` → return (line 1019) — see §10

### HTF Candles
Fetched once per distinct `htf_timeframe` in `handleNseCron` via `fetchHTFCandles(symbol, htfTimeframe, env)` and cached in a `Map` (lines 1510–1519). Default HTF is `'1H'` (`cfg.htf_timeframe ?? '1H'`).

Format: newest-first. Minimum required: `htfCandles.length >= 9` (checked inside `computeSMAHTF`).

### Derived Metrics (computed every run)

| Variable | Formula | Notes |
|---|---|---|
| `sma1` | `candles.map(c => c.close)` | Identity — SMA1 is just the close |
| `sma9` | reverse → `computeSMA(closes, 9)` → reverse | Wraps shared `computeSMA` helper |
| `atr14` | `computeATR(candles, 14)` | Must be non-null |
| `crossover20` | `countSma1x9Crossovers(20, sma1, sma9)` | |
| `crossover10` | `countSma1x9Crossovers(10, sma1, sma9)` | |
| `crossover5` | `countSma1x9Crossovers(5, sma1, sma9)` | |
| `separationNow` | `Math.abs(sma1[0] - sma9[0])` | |
| `separation5Ago` | `Math.abs(sma1[5] - sma9[5])` | Falls back to `separationNow` if either is null |
| `separationVelocity` | `(separationNow - separation5Ago) / 5` | Not stored; only used for `velocityLabel` |
| `velocityLabel` | `separationVelocity > atr14 * 0.03 ? 'Sharp' : 'Gradual'` | Written to state; shown in Type 1 message |
| `widening` | `separationNow > separation5Ago` | Boolean |
| `cloudTop` | `Math.max(sma1[0], sma9[0])` | |
| `cloudBottom` | `Math.min(sma1[0], sma9[0])` | |
| `side0/1/2` | `sma1x9CandleSide(candles, sma1, sma9, i)` | null = inside cloud or missing SMA |
| `candidateDirection3` | all of side0, side1, side2 identical and non-null | |
| `sameSide3` | `priceSameSide(candles, sma1, sma9, candidateDirection3, 3)` | 0 when candidateDirection3 is null |
| `sameSide5Direction` | `priorState?.direction ?? candidateDirection3 ?? null` | Uses established direction first |
| `sameSide5` | `priceSameSide(candles, sma1, sma9, sameSide5Direction, 5)` | 0 when sameSide5Direction is null |

**`sma1x9CandleSide(candles, sma1Arr, sma9Arr, i)` — line 808**
```js
const c = candles[i].close;
if (c > sma1Arr[i] && c > sma9Arr[i]) return 'bullish';
if (c < sma1Arr[i] && c < sma9Arr[i]) return 'bearish';
return null; // inside cloud, or either SMA is null
```

**`priceSameSide(candles, sma1Arr, sma9Arr, direction, count)` — line 816**
Counts candles[0..count-1] (newest-first) where close is outside both SMAs in `direction`.
```js
if (direction === 'bearish' && c < sma1Arr[i] && c < sma9Arr[i]) consistent++;
if (direction === 'bullish' && c > sma1Arr[i] && c > sma9Arr[i]) consistent++;
```

---

## 2. Phase State Machine

**`advanceSmaPhase(prev, m)` — line 909**

### Starting state
```js
const prevPhase = prev?.phase ?? 'accumulation';
let direction = prev?.direction ?? null;
let consecutiveWidening = prev?.consecutive_widening ?? 0;
```

### Derived conditions
```js
const stillAccumulating  = m.crossover20 >= 3 || m.separationNow < (m.atr14 * 0.15);
const transitionCondition = m.crossover5 === 0 && m.widening && m.sameSide3 === 3;
const armedCandidate      = transitionCondition ? m.candidateDirection3 : null;
const distributionActive  = m.crossover10 === 0 && m.separationNow > (m.atr14 * 0.15) && m.sameSide5 >= 4;
const exhaustionCondition = m.separationNow < (m.atr14 * 0.15) && m.crossover5 >= 1 && m.sameSide5 <= 3;
```

### Transitions

```
accumulation:
  if (!stillAccumulating && armedCandidate):
    → transition (direction = armedCandidate, consecutiveWidening = 1)
  else:
    → stay accumulation (direction = null, consecutiveWidening = 0)

transition:
  if armedCandidate === direction:
    consecutiveWidening += 1
    if distributionActive:
      → distribution (justEnteredDistribution = true)
  elif armedCandidate (non-null, different direction):
    → stay transition (direction = armedCandidate, consecutiveWidening = 1) [direction flip]
  else:
    → accumulation (direction = null, consecutiveWidening = 0)

distribution:
  if exhaustionCondition:
    → accumulation (justExhausted = true)
  else:
    → stay distribution
```

### Return value
```js
{ phase, direction, consecutiveWidening, justEnteredDistribution, justExhausted }
```
Both `justEnteredDistribution` and `justExhausted` can never both be true in the same call — entering distribution comes from transition; exhaustion comes from distribution.

### ATR thresholds
- `atr14 * 0.15` — gap must exceed this to leave accumulation or enter/stay in distribution
- `atr14 * 0.03` — gap velocity threshold for `'Sharp'` vs `'Gradual'` label

---

## 3. Stack Check — Strict vs Loose

**`checkStack(currentSMA1, currentSMA9, close, stackMode)` — line 826**

```js
// strict:
bullish: currentSMA1 > currentSMA9 && close > currentSMA1
bearish: currentSMA1 < currentSMA9 && close < currentSMA1

// loose:
bullish: close > currentSMA9
bearish: close < currentSMA9
```

**Default in `runSMAForAsset`:**
```js
const mode = stackMode === 'loose' ? 'loose' : 'strict';
```
Any value other than `'loose'` (including null/undefined) resolves to `'strict'`.

Used only in the Type 1 gate — not checked for Type 2 or exhaustion.

---

## 4. Type 1 Alert — Trend Initiation

**Fires:** exactly on the `justEnteredDistribution` edge (transition → distribution), line 1088.

**All gates must pass (in order):**

```js
const beyondCloud = direction === 'bullish' ? close > cloudTop : close < cloudBottom;
const stack       = checkStack(sma1[0], sma9[0], close, mode);
const stackOk     = direction === 'bullish' ? stack.bullish : stack.bearish;
```
1. `beyondCloud && stackOk` — close must be outside the cloud AND satisfy the stack condition
2. `bias.passes` from `checkSMABias(...)` (see §9)
3. **Stocks only** (non-index): `candles.length >= 20` AND `candles[0].volume > avgVol * 1.5`
   - `avgVol` = average of candles[0..19].volume
   - If avgVol is 0 (or volume field absent), gate fails → `return`

**Volume computation:**
```js
const volSeries  = candles.slice(0, 20).map(c => c.volume ?? 0);
const avgVol     = volSeries.reduce((a, b) => a + b, 0) / volSeries.length;
volumeRatio      = avgVol > 0 ? (candles[0].volume ?? 0) / avgVol : null;
if (!(avgVol > 0 && (candles[0].volume ?? 0) > avgVol * 1.5)) return;
```

**On fire:**
1. Calls `deliverNseIndicatorAlert(env, { ..., alertType: 'sma_type1', message })`
2. Updates `nse_sma_state.last_signal_date` (IST date) and `last_signal_time` (ms)
3. `return;` — Type 2 cannot fire on the same run

**Telegram message:** `formatSmaType1Alert(...)` — line 950:
```
🟢/🔴 <b>BUY/SELL — SYMBOL</b>
⏱ Timeframe: TF
🕐 Candle: DDD IST
━━━━━━━━━━━━━━
SMA Cloud: Bullish markup/Bearish distribution — Sharp/Gradual ⚡/📉
SMA 1: X.XX
SMA 9 (TF): X.XX
HTF SMA 9 (htfTF): X.XX or N/A
Bias: Bullish/Bearish (biasLabel) ✅
📦 Volume: X.X× average    ← stocks only
━━━━━━━━━━━━━━
EBP Tracker
```

---

## 5. Type 2 Alert — Cloud Rejection Re-entry

**Fires:** during steady-state distribution only — both current and prior phase must be `'distribution'` (line 1128).

**All gates must pass (in order):**

1. `direction !== null`
2. **Cooldown** — `checkSmaCooldown(timeframe, priorState)` (line 1131):
   - `M15`: once per IST calendar day — `!smaState?.last_signal_date || smaState.last_signal_date < nowIstDate`
   - `M5` (and all others): 60-minute cooldown — `(Date.now() - smaState.last_signal_time) > 60 * 60 * 1000`
3. `bar1 = candles[1]` must exist
4. **Cloud touch** (line 1136):
   ```js
   const entered = direction === 'bearish' ? bar0.high >= cloudBottom : bar0.low <= cloudTop;
   ```
5. **Rejection** (line 1137):
   ```js
   const rejected = direction === 'bearish' ? bar0.close < cloudBottom : bar0.close > cloudTop;
   ```
6. **Candle strength** — `checkCandleStrength(bar0, direction).passes` (line 1140):
   ```js
   const closePosition = (candle.close - candle.low) / range;
   // bearish: passes if closePosition < 0.50 (close in bottom half)
   // bullish: passes if closePosition >= 0.50 (close in top half)
   ```
7. `bias.passes` from `checkSMABias(...)`

**Cloud boundary used in message:** `cloudBottom` for bearish, `cloudTop` for bullish.

**On fire:**
1. Calls `deliverNseIndicatorAlert(env, { ..., alertType: 'sma_type2', message })`
2. Updates `last_signal_date` and `last_signal_time`

**Telegram message:** `formatSmaType2Alert(...)` — line 972:
```
🟢/🔴 <b>BUY/SELL — SYMBOL</b>
⏱ Timeframe: TF
🕐 Candle: DDD IST
━━━━━━━━━━━━━━
SMA Cloud: Bullish/Bearish re-entry
Rejected from cloud top/bottom: X.XX
Close strength: X% — strong ✅
Bias: Bullish/Bearish (biasLabel) ✅
━━━━━━━━━━━━━━
EBP Tracker
```

Note: `bar1` (`candles[1]`) is fetched but not used in any gate or message for Type 2 — it's a vestigial read. The alert is generated entirely from `bar0 = candles[0]`.

---

## 6. Exhaustion Alert

**Fires:** when `advance.justExhausted` is true (distribution → accumulation), line 1078.

**No additional gates** — fires unconditionally on phase transition.

**Telegram message:** `formatSmaExhaustionAlert(...)` — line 991:
```
⚠️ <b>SYMBOL — SMA Trend Exhausting</b>
⏱ Timeframe: TF
🕐 Candle: DDD IST
━━━━━━━━━━━━━━
SMAs converging — distribution phase ending
Consider tightening stops or exiting position
━━━━━━━━━━━━━━
EBP Tracker
```

**`direction` in alert_history:** `priorState?.direction ?? null` — always non-null in practice (exhaustion requires prior distribution, which always has a direction), but the null fallback is harmless.

**After exhaustion fires:** `return;` at line 1084 — prevents any Type 1 or Type 2 check on the same run.

---

## 7. State Persistence

**Table:** `nse_sma_state`, primary key `(symbol, timeframe)`.

**UPSERT on every run** — line 1056:
```sql
INSERT INTO nse_sma_state (
  symbol, timeframe, direction, phase, stack_active, consecutive_widening,
  separation, velocity_label, atr14, cloud_top, cloud_bottom,
  stack_formed_date, last_signal_date, last_signal_time, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(symbol, timeframe) DO UPDATE SET
  direction = excluded.direction,
  phase = excluded.phase,
  stack_active = excluded.stack_active,
  consecutive_widening = excluded.consecutive_widening,
  separation = excluded.separation,
  velocity_label = excluded.velocity_label,
  atr14 = excluded.atr14,
  cloud_top = excluded.cloud_top,
  cloud_bottom = excluded.cloud_bottom,
  stack_formed_date = excluded.stack_formed_date,
  updated_at = excluded.updated_at
  -- last_signal_date and last_signal_time intentionally absent from UPDATE
```

**`last_signal_date` / `last_signal_time`:** preserved from `priorState` in the INSERT value — not in DO UPDATE SET. Updated only via explicit `UPDATE nse_sma_state SET last_signal_date=?, last_signal_time=? WHERE ...` after each signal fires (lines 1117–1121, 1155–1159).

**`stack_formed_date`:** set to current IST date when `justEnteredDistribution`, else `priorState?.stack_formed_date ?? null` — preserved on all other runs.

**`stack_active`:** `advance.phase === 'distribution' ? 1 : 0` — computed fresh every run.

---

## 8. User Config Fields

**Table:** `nse_indicator_configs` — queried in `handleNseCron` at line 1354:
```sql
SELECT ic.id as config_id, ic.indicator, ic.stack_mode, ic.enabled,
       ic.bias_mode, ic.htf_timeframe,
       ua.id as asset_id, ua.symbol,
       u.id as user_id
FROM nse_indicator_configs ic
JOIN user_assets ua ON ic.asset_id = ua.id
JOIN users u ON ic.user_id = u.id
WHERE ua.asset_type='nse' AND ic.timeframe=? AND ic.enabled=1 AND u.active=1
```

| Field | Type | Values | Default (applied in code) | Used by |
|---|---|---|---|---|
| `indicator` | string | `'tdi'` or `'sma'` | required | routes to runTDIForAsset or runSMAForAsset |
| `stack_mode` | string | `'strict'` or `'loose'` | `'strict'` (any non-`'loose'` value) | checkStack |
| `bias_mode` | string | `'htf_sma'` or `'ttrades'` | `'ttrades'` (`cfg.bias_mode ?? 'ttrades'`) | checkSMABias |
| `htf_timeframe` | string | `'M30'` or `'1H'` | `'1H'` (`cfg.htf_timeframe ?? '1H'`) | fetchHTFCandles, bias label |
| `enabled` | integer | 0 or 1 | filtered in WHERE | (already filtered) |
| `timeframe` | string | e.g. `'M5'`, `'M15'` | filtered in WHERE | (already filtered) |

`ic.timeframe` is the native (LTF) candle timeframe — it matches the cron's `tf` argument. The HTF is a separate `htf_timeframe` field in the same row.

Note: `nse_indicator_configs` has **no `alert_mode` column** — unlike `user_ebp_configs` and `user_sweep_configs`. SMA Cloud (and TDI) alerts are not gated on directional alignment with any user preference; the internal conditions themselves are the gate.

---

## 9. Alert Delivery

### `deliverNseIndicatorAlert(env, { userId, symbol, timeframe, direction, candleTime, alertType, message })` — line 541

Shared by TDI (`alertType: 'tdi'`) and SMA Cloud (`sma_type1`, `sma_type2`, `sma_exhaustion`).

**Steps:**
1. Reads `users.nse_tf_access` for `userId` — JSON string, default `'["M1","M5","M15","M30","1H","D"]'`
2. If `timeframe` not in parsed array → silent return (admin-controlled gate)
3. Reads `user_telegram WHERE user_id = ? AND verified = 1`
4. If no verified `chat_id` → silent return
5. Calls `sendTelegramMessage(env.SHARED_BOT_TOKEN, tg.chat_id, message)` with `parse_mode: 'HTML'`
6. Inserts into `alert_history`:
   ```js
   (id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type)
   values (randomUUID(), userId, symbol, timeframe, direction, null, candleTime, Date.now(), alertType)
   ```
   `trend_bias` is hardcoded `null` — no HTF bias is recorded for SMA indicator alerts.

**No `alert_mode` gate** — the per-config internal conditions are the gate.

**No deduplication** — each config row fires independently; two users watching the same symbol+TF each get their own message.

### `checkSMABias(symbol, htfTimeframe, biasMode, htfCandles, direction, env)` — line 849

**`biasMode === 'htf_sma'`:**
```js
const smaHTFValue = computeSMAHTF(htfCandles); // SMA9 of htfCandles[0..8].close
// → if null: { passes: false, label: 'HTF SMA unavailable' }
const bullish = currentClose > smaHTFValue;
const bearish = currentClose < smaHTFValue;
const passes = direction === 'bullish' ? bullish : bearish;
return { passes, label: `HTF SMA ${htfTimeframe}` };
```

**`biasMode === 'ttrades'` (default):**
```js
const row = await env.DB.prepare(
  'SELECT bias FROM bias_cache WHERE symbol = ? AND timeframe = ?'
).bind(symbol, htfTimeframe).first();
// → if null: { passes: false, label: 'TTrades bias unavailable' }
const passes = row.bias === direction;
return { passes, label: `TTrades ${htfTimeframe}` };
```
`bias_cache` is written earlier in the same cron tick by `writeBiasCache` (line 1398) for the htf TF used by EBP/Sweep. For SMA Cloud, if `htf_timeframe` differs from `biasTF` (the EBP/Sweep HTF), the bias_cache row may not exist for this tick — `checkSMABias` returns `passes: false`.

---

## 10. Dead / Unused Fields and Code

### a) `sma1.length < 21` check — line 1019 🐛
```js
if (sma1.length < 21 || sma9.length < 21) return;
```
`sma1` is `candles.map(c => c.close)` and `sma9` has the same length as `candles`. Both arrays always have the same length as `candles`. The outer guard at line 1009 already requires `candles.length >= 25`. So `sma1.length` and `sma9.length` are always ≥ 25 when this line is reached. This check can never trigger. It should instead verify that at least 21 positions in `sma9` are non-null (the first 8 oldest positions have null SMA9 when candles.length ≈ 25).

### b) `sameSide3 === 3` is redundant — line 918 🐛
```js
const transitionCondition = m.crossover5 === 0 && m.widening && m.sameSide3 === 3;
```
`sameSide3` is computed as `priceSameSide(..., candidateDirection3, 3)`. `candidateDirection3` is non-null only when `side0 === side1 === side2 !== null`, where each `sideN` requires `close > both SMAs` (bullish) or `close < both SMAs` (bearish). `priceSameSide` checks the identical condition. So whenever `candidateDirection3` is non-null, `sameSide3` is guaranteed to be 3. The `sameSide3 === 3` condition adds no filtering.

### c) `stack_formed_date` not cleared on exhaustion — line 1072 🐛
```js
advance.justEnteredDistribution
  ? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  : (priorState?.stack_formed_date ?? null),
```
When `justExhausted = true`, `advance.justEnteredDistribution = false`, so `stack_formed_date` is preserved as `priorState.stack_formed_date` (the old entry date). It stays stale until the next `justEnteredDistribution`. The field in `nse_sma_state` will show the prior distribution's start date while the asset is actually in accumulation.

### d) `bar1 = candles[1]` is fetched but unused in Type 2 — line 1133 🐛 (minor)
```js
const bar0 = candles[0], bar1 = candles[1];
if (!bar1) return;
```
`bar1` is checked for existence as a safety guard, but its OHLC data is never read. The entered/rejected conditions both use `bar0`. The `closedInsideLevel` in Type 2 message (`cloudBoundary`) comes from `cloudTop`/`cloudBottom`, not from `bar1`. The guard against a missing `bar1` is therefore a redundant check on a 2-candle minimum that `runSMAForAsset`'s outer guard (`candles.length < 25`) already enforces.

### e) State observability fields — written but never read back by state machine
The following columns are written every run to `nse_sma_state` and are available externally for inspection, but the state machine itself never reads them back — it recomputes them from raw candles each run:
- `stack_active` (boolean 0/1 derived from `phase`)
- `separation` (= `separationNow`)
- `velocity_label`
- `atr14`
- `cloud_top`
- `cloud_bottom`

These are pure observability/debugging fields.

### f) `trend_bias = null` in `alert_history` for indicator alerts — line 558
All SMA Cloud and TDI alerts write `trend_bias = null` to `alert_history`. This means post-hoc queries on alert quality (did alert direction match the prevailing bias?) cannot be answered from `alert_history` alone for indicator alerts — the `bias_cache` table would need to be joined with a time window. By contrast, EBP/Sweep alerts write `effectiveBias` (the live htfBias) to `trend_bias` in `tryDeliverNseAlert`.

### g) `deriveSession(firedAtISO)` — session label used only in EBP/Sweep/MSS signals
The FX-session labelling function at line 1212 (Asian/London/New York/Off-hours buckets) is used in the `signals` INSERT for NSE_EBP, NSE_SWEEP, NSE_MSS (lines 1426, 1451, 1479), but **not** for SMA Cloud or TDI alerts (those go through `deliverNseIndicatorAlert` which inserts into `alert_history`, not `signals`). The `signals` table is not written for indicator alert types.

---

## Summary Table

| Signal type | Phase gate | Stack gate | Beyond-cloud gate | Volume gate | Bias gate | Candle-strength gate | Cooldown gate |
|---|---|---|---|---|---|---|---|
| Type 1 | `justEnteredDistribution` | yes | yes | stocks only, 1.5× avg | yes | no | no |
| Type 2 | steady distribution (both phases = distribution) | no | no (touch+reject) | no | yes | yes (50% rule) | yes |
| Exhaustion | `justExhausted` | no | no | no | no | no | no |
