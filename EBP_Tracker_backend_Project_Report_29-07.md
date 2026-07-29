# EBP Tracker — Full Codebase Audit Report
**Date:** 2026-07-29  
**Branch:** `claude/ebp-tracker-codebase-audit-o4noyr`  
**Scope:** Complete read of all source files listed in the audit task.  
**Output rules:** Written entirely from what was present in the source files. Nothing inferred or assumed beyond what the code contains.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [EBP Worker — All Routes](#3-ebp-worker--all-routes)
4. [Sweep Worker — All Routes](#4-sweep-worker--all-routes)
5. [Signal Engine — Detection Logic](#5-signal-engine--detection-logic)
6. [Database Schema — All 28 Tables](#6-database-schema--all-28-tables)
7. [Data Sources](#7-data-sources)
8. [Frontend](#8-frontend)
9. [Authentication & Security](#9-authentication--security)
10. [Environment Variables & Secrets](#10-environment-variables--secrets)
11. [Known Issues & TODOs Found in Code](#11-known-issues--todos-found-in-code)
12. [Recent Git History](#12-recent-git-history)

---

## 1. Project Overview

EBP Tracker is a real-time forex/crypto/NSE trade signal platform. It detects **EBP (Engulfing Bias Points)**, **Sweeps**, **MSS (Market Structure Shifts)**, **FVGs (Fair Value Gaps)**, and multi-step **T3 chain** signals across configurable timeframes. Signals are stored in a Cloudflare D1 SQLite database and delivered to users via Telegram bots. A React SPA frontend allows users to configure assets, view alerts, and inspect signal history.

**Repository layout:**

```
EBP_TRACKER/
├── worker/                    # EBP Worker (Cloudflare Worker)
│   ├── src/ebp-worker.js      # 2556 lines, zero npm dependencies
│   └── wrangler.toml
├── sweep-worker/              # Sweep Worker (Cloudflare Worker)
│   ├── src/index.js           # Entry point (~241 lines)
│   ├── src/sweep-cron.js      # All logic (~1018 lines)
│   └── wrangler.toml
├── frontend/                  # React 18 SPA (Vite + Cloudflare Pages)
│   └── src/
│       ├── pages/
│       ├── components/
│       ├── hooks/
│       ├── lib/
│       ├── data/
│       └── styles/
└── schema.sql                 # D1 schema — 28 tables/views
```

---

## 2. Architecture Overview

### Workers

| Worker | Cloudflare Name | Entry Point | npm deps |
|--------|----------------|-------------|----------|
| EBP Worker | `ebp-tracker-worker` | `worker/src/ebp-worker.js` | None (wrangler dev only) |
| Sweep Worker | `sweep-detector` | `sweep-worker/src/index.js` | None (wrangler dev only) |

Both workers share one D1 database:  
- **Name:** `ebp-tracker-db`  
- **ID:** `b93b206a-5537-4d12-8c86-a4b2372aae7f`  
- **Binding:** `DB` in both `wrangler.toml` files

`compatibility_date = "2024-01-01"` in both workers.

### Cron Scheduling

Both workers have their native Cloudflare `[triggers]` blocks **commented out** in `wrangler.toml`. All cron invocations are HTTP POST requests from **cron-job.org**:

- EBP Worker: `POST /cron/ebp` (with `X-Cron-Secret` header)
- Sweep Worker: `POST /cron/sweep` (with `X-Cron-Secret` header)

The Sweep Worker does have a Cloudflare `scheduled` handler that simply logs: _"Scheduled handler called — scheduling is now via cron-job.org HTTP triggers"_.

### Frontend

- **Framework:** React 18 + Vite
- **Deployment:** Cloudflare Pages (`ebp-tracker.pages.dev`)
- **Auth:** `@clerk/clerk-react`
- **Routing:** `react-router-dom`
- **Charts:** `recharts`
- **Excel export:** `xlsx`

### Data Flow

```
cron-job.org
    │
    ▼ POST /cron/ebp or /cron/sweep
  Worker ──→ Twelve Data API (primary, 3-key rotation)
           │              └──→ Yahoo Finance (fallback)
           │
           ├──→ D1 (store candle cache, signals, FVGs, swing state)
           └──→ Telegram Bot API (send alert messages)

User Browser
    │
    ▼ HTTPS → Worker API routes (JWT-authenticated)
  Frontend ──→ /user/*, /alerts/*, /nse/*, /market/*, /admin/*
```

### TTrades Bias Engine

The `calcTTradesBias` function is the core bias-direction engine. It is **inlined separately** in both `ebp-worker.js` and `sweep-cron.js` (not shared via import). It uses the `BIAS_SOURCE` constant:

```js
BIAS_SOURCE = {
  ebp:      { M15:'4H', '1H':'D', '4H':'W', D:'W', W:null },
  sweep:    { M5:'1H', M15:'1H', M30:'4H', '1H':'D', '4H':'W' },
  template: { W:null, D:'W', '4H':'D', '1H':'4H' }
}
```

For each detection type, the LTF's "bias source" TF is looked up in `BIAS_SOURCE[type][ltf]`. The HTF EBP alert for that bias TF is queried from D1 `ebp_alerts` to determine current bias direction.

---

## 3. EBP Worker — All Routes

### Worker Constants

```js
ALLOWED_ORIGINS = ['http://localhost:5173', 'https://ebp-tracker.pages.dev']
```

CORS preflight (`OPTIONS`) is handled for all routes. The `/signals` family of routes uses **open CORS** (Access-Control-Allow-Origin: `*`) for Trade Journal app compatibility.

### Route Table

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Returns `{ok:true}` |
| POST | `/cron/ebp` | X-Cron-Secret | Run EBP/MSS detection for one TF |
| POST | `/cron/breadth` | X-Cron-Secret | Run market breadth computation |
| POST | `/webhook/telegram/:botToken` | None (token in path) | Telegram webhook |
| POST | `/auth/register` | Clerk JWT | Register user with invite token |
| GET | `/user/profile` | Clerk JWT | Get current user's profile |
| PATCH | `/user/profile` | Clerk JWT | Update user profile |
| GET | `/user/assets` | Clerk JWT | List user's tracked assets |
| POST | `/user/assets` | Clerk JWT | Add asset to tracking |
| DELETE | `/user/assets/:symbol` | Clerk JWT | Remove asset |
| GET | `/user/assets/count` | Clerk JWT | Count forex/crypto and NSE assets |
| GET | `/user/alerts` | Clerk JWT | Get alert history (paginated) |
| GET | `/user/ebp-configs` | Clerk JWT | Get all EBP configs for user's assets |
| POST | `/user/ebp-configs` | Clerk JWT | Create/update EBP config for asset+TF |
| GET | `/user/sweep-configs` | Clerk JWT | Get all sweep configs |
| POST | `/user/sweep-configs` | Clerk JWT | Create/update sweep config for asset+TF |
| GET | `/user/templates` | Clerk JWT | Get all T3 templates for user |
| POST | `/user/templates` | Clerk JWT | Create T3 template |
| DELETE | `/user/templates/:id` | Clerk JWT | Delete T3 template |
| GET | `/user/bias-cache` | Clerk JWT | Get HTF bias cache entries |
| GET | `/user/htf-bias-override` | Clerk JWT | Get all HTF override records for user |
| POST | `/user/htf-bias-override` | Clerk JWT | Set/clear HTF override for asset+TF |
| GET | `/user/tf-access` | Clerk JWT | Get user's allowed TFs (forex/crypto + NSE) |
| GET | `/alerts/export` | Clerk JWT | Export alerts to JSON (for xlsx on frontend) |
| GET | `/nse/status` | Clerk JWT | Get NSE subscription status for user |
| GET | `/nse/assets` | Clerk JWT | List user's NSE tracked assets |
| POST | `/nse/assets` | Clerk JWT | Add NSE asset |
| DELETE | `/nse/assets/:symbol` | Clerk JWT | Remove NSE asset |
| GET | `/nse/ebp-configs` | Clerk JWT | Get NSE EBP configs |
| POST | `/nse/ebp-configs` | Clerk JWT | Create/update NSE EBP config |
| GET | `/nse/sweep-configs` | Clerk JWT | Get NSE sweep configs |
| POST | `/nse/sweep-configs` | Clerk JWT | Create/update NSE sweep config |
| GET | `/nse/templates` | Clerk JWT | Get NSE T3 templates |
| POST | `/nse/templates` | Clerk JWT | Create NSE T3 template |
| DELETE | `/nse/templates/:id` | Clerk JWT | Delete NSE T3 template |
| GET | `/nse/indicator-configs` | Clerk JWT | Get TDI/SMA indicator configs for NSE assets |
| POST | `/nse/indicator-configs` | Clerk JWT | Create/update indicator config |
| GET | `/market/breadth` | Clerk JWT | Get latest market breadth data |
| GET | `/signals` | X-Journal-Secret | Trade Journal: list signals (open CORS) |
| GET | `/signals/:id` | X-Journal-Secret | Trade Journal: get single signal (open CORS) |
| PATCH | `/signals/:id` | X-Journal-Secret | Trade Journal: update signal fields (open CORS) |
| POST | `/admin/invite-tokens` | Clerk JWT + admin | Create invite token |
| GET | `/admin/invite-tokens` | Clerk JWT + admin | List all invite tokens |
| DELETE | `/admin/invite-tokens/:token` | Clerk JWT + admin | Delete invite token |
| GET | `/admin/users` | Clerk JWT + admin | List all users |
| PATCH | `/admin/users/:userId` | Clerk JWT + admin | Update user (asset_limit, bot_token, nse_enabled, nse_bot_token, tf_access, nse_tf_access) |
| GET | `/admin/api-keys` | Clerk JWT + admin | List API key status |
| POST | `/admin/api-keys` | Clerk JWT + admin | Add new API key |
| DELETE | `/admin/api-keys/:id` | Clerk JWT + admin | Remove API key |
| GET | `/admin/user-limits` | Clerk JWT + admin | View per-user limits |
| POST | `/admin/user-limits` | Clerk JWT + admin | Set per-user limits |

### `/cron/ebp` Detail

- Body: `{ tf: string }`
- Validates TF against `VALID_TFS = ['M15','1H','4H','D','W']` (NSE: `['M15','1H','4H','D']`)
- If `tf === 'D'`: synthesises daily candles from 1H bars (5 PM New York boundary, EDT/EST DST aware)
- If `tf !== 'D' && tf !== 'W'`: runs FVG detection and swing state update
- Iterates all users with EBP alerts enabled for that TF, fires `handleEBPCron(tf, env)`
- On EBP detection: generates signal ID, creates `ebp_alerts` record, sends Telegram alert, checks if T3 template is active and initiates chain step 1

### `/cron/breadth` Detail

- Hardcoded to `tf = '1H'`
- Fetches 200 candles for each of 28 G8 cross-pairs
- Computes: currency strength (8 currencies), cross-pair heatmap, intraday 48h data, Pearson correlation matrix
- Stores in `market_breadth` table

---

## 4. Sweep Worker — All Routes

Entry point: `sweep-worker/src/index.js`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Returns `{ok:true, worker:'sweep-detector'}` |
| POST | `/cron/sweep` | X-Cron-Secret | Run sweep detection for one TF |
| GET | `/sweep/dashboard` | None | Latest sweep cache summary per symbol+TF |
| GET | `/sweep/history` | None | Recent sweep alerts (last 50) |

### `/cron/sweep` Detail

- Body: `{ tf: string }`
- Validates TF against `['M5','M15','M30','1H','4H']`
- On **M5 only**: runs cleanup tasks:
  - Delete expired FVGs (`WHERE expires_at < now`)
  - Delete expired T3 chains (`WHERE expires_at < now`)
  - Reset stale API key state
  - Delete `api_call_log` entries older than 2 days
- Fetches candles for each tracked symbol + TF
- Updates `sweep_candle_cache`
- If ≥ 3 candles: runs FVG + swing state (MSS detection)
- Runs T3 chain step 2 (Sweep) and step 3 (MSS) logic per active chain
- Fires Telegram alert on Sweep detection

---

## 5. Signal Engine — Detection Logic

### 5.1 EBP Detection (`detectEBP`)

```
bar0 = most recent closed candle
bar1 = the candle before bar0

Bullish EBP:
  bar0.close > bar1.high  (bar0 closes above bar1's entire range)

Bearish EBP:
  bar0.close < bar1.low   (bar0 closes below bar1's entire range)
```

Returns `{ type: 'bull'|'bear', bar: bar0 }` or `null`.

### 5.2 Sweep Detection (`detectSweep`)

```
bar0 = most recent closed candle
bar1 = the candle before bar0

Bullish Sweep:
  bar0.low < bar1.low     AND   bar0.close > bar1.low
  (wick sweeps below bar1's low, but closes back above it)

Bearish Sweep:
  bar0.high > bar1.high   AND   bar0.close < bar1.high
  (wick sweeps above bar1's high, but closes back below it)
```

Returns `{ type: 'bull'|'bear', bar: bar0 }` or `null`.

### 5.3 MSS Detection (`detectMSS`)

Requires a `swingState` object (from `updateSwingState`). Uses confirmed swing highs/lows to determine if price has broken structure.

```
If swingState.runDir === 'bull':
  bar0.close < swingState.lastConfirmedSwingLow
  → Bearish MSS

If swingState.runDir === 'bear':
  bar0.close > swingState.lastConfirmedSwingHigh
  → Bullish MSS
```

Returns `{ type: 'bull'|'bear', bar: bar0 }` or `null`.

### 5.4 Swing State Machine (`updateSwingState`)

Tracks `runDir` ('bull'|'bear'|null), `lastConfirmedSwingHigh`, `lastConfirmedSwingLow`, `pendingSwingHigh`, `pendingSwingLow`.

**Logic (condensed from source):**
- When `runDir` is null: initialise from first two bars
- On each new bar: check if the pending swing has been confirmed by a bar that closes beyond it
- Confirmation of a swing high/low updates `lastConfirmedSwing*` and clears the pending record
- The function is wrapped in a `try/catch` in `sweep-cron.js`; any exception returns the unchanged state

### 5.5 FVG Detection (`detectFVG`)

```
Bullish FVG: bar[i-2].high < bar[i].low
  (gap between bar i-2 top and bar i bottom)

Bearish FVG: bar[i-2].low > bar[i].high
  (gap between bar i-2 bottom and bar i top)
```

FVGs are stored in `fvg_zones` with `expires_at` (end of current UTC month, or quarter for W).

### 5.6 FVG Mitigation Check (`checkFVGMitigation`)

Checks if the current bar's price range overlaps a stored FVG zone. Mitigation is when price re-enters the gap. On mitigation, the FVG record is updated (`mitigated_at`, `mitigated_by_tf`).

### 5.7 TTrades Bias Engine (`calcTTradesBias`)

1. Look up the HTF for the given LTF and detection type via `BIAS_SOURCE[type][ltf]`
2. Query `ebp_alerts` for the most recent non-expired alert on that HTF + symbol
3. The `direction` of that alert ('bull' or 'bear') is the current HTF bias
4. If no alert found: bias is `null` (displayed as 'NEUTRAL' in frontend)
5. If user has an active HTF override (in `htf_bias_overrides` table): the override direction is used instead of the computed bias

### 5.8 T3 Chain State Machine

Three-step chain: **HTF EBP → LTF Sweep → LTF MSS**

**Step 1 — Initiated by EBP detection:**

```sql
INSERT INTO t3_chains (template_id, user_id, symbol, htf, ltf, direction, state, htf_signal_id, expires_at)
VALUES (?, ?, ?, ?, ?, ?, 'awaiting_sweep', ?, ?)
```

`expires_at` = end of current month (or quarter for W).

**Step 2 — Sweep detection (in sweep-cron.js):**

```
Query t3_chains WHERE state='awaiting_sweep' AND direction=sweepType AND symbol matches
If found: UPDATE state='awaiting_mss', ltf_signal_id=sweep signal id
```

**Step 3 — MSS detection (in sweep-cron.js):**

```
Query t3_chains WHERE state='awaiting_mss' AND direction='inverted_mss_dir' AND symbol matches
If found: UPDATE state='complete', mss_signal_id=mss signal id
Fire T3 Telegram alert with all three signal IDs
```

Direction inversion for MSS: a bull chain (initiated by bull EBP) expects a **bear** sweep (liquidity sweep of lows) and then a **bull** MSS (break above structure).

### 5.9 Signal ID Generation

**EBP Signal IDs** (worker): Counter key format: `EBP-{TF}` (e.g. `EBP-4H`, `EBP-1D`, `EBP-1W`).  
Only 4H, D, W generate EBP signal IDs. M15 and 1H do not.

```
Format: EBP-{SYMBOL}-{TF}{series}{count}
Example: EBP-GBPUSD-4HA001
```

Series cycles A→Z, count 001→999, then series increments.

**T3 Signal IDs** (sweep-worker): Template string is `'T3'` hardcoded.

```
Format: T3-{SYMBOL}-{series}{count}
Example: T3-GBPUSD-A001
```

Counter stored in `signal_counters` table, key = `T3-{SYMBOL}`.

### 5.10 Session Derivation (`deriveSession`)

Takes `firedAtISO` (UTC ISO string), converts to New York local time:

| Session | NY Time |
|---------|---------|
| Asian | ≥ 20:00 |
| New York | 07:00 – 10:00 |
| London | 02:00 – 05:00 |
| Off-hours | (all other times) |

### 5.11 Daily Candle Synthesis

When `tf === 'D'`, EBP worker synthesises daily bars from 1H candles rather than fetching D data directly:

- **Day boundary:** 5:00 PM New York time (handles EDT UTC-4 and EST UTC-5)
- Fetches 1H candles covering last 5 daily periods (sufficient for EBP detection)
- Groups 1H bars into days using NY local boundary
- OHLC: open = first 1H open of the day; high = max of all 1H highs; low = min of all 1H lows; close = last 1H close of the day
- Only completed days (where the next day has already started) are used

### 5.12 Alert Format Strings

**EBP Alert (Telegram):**

```
📍 EBP Signal — {SYMBOL} {TF}
Direction: {bull/bear emoji} {BULL/BEAR}
HTF Bias: {bias}
Session: {session}
Price: {price}
Signal ID: {id}    ← only for 4H/D/W
```

**Sweep Alert (Telegram):**

```
🌊 Sweep Detected — {SYMBOL} {TF}
Direction: {emoji} {BULL/BEAR}
HTF Bias: {bias}
Session: {session}
Price: {price}
```

**MSS Alert (Telegram):**

```
🔄 MSS — {SYMBOL} {TF}
Direction: {emoji} {BULL/BEAR}
Session: {session}
Price: {price}
```

**T3 Alert (Telegram) — sweep-cron.js version:**

```
🎯 T3 Chain Complete — {SYMBOL}
HTF: {htf} EBP → LTF: {ltf} Sweep → LTF: {ltf} MSS
Direction: {emoji} {BULL/BEAR}
Session: {session}
Signal ID: {signalId}    ← included in sweep-cron.js version
```

**T3 Alert (Telegram) — ebp-worker.js version:**

Does **not** include `Signal ID` line. (Inconsistency documented in §11.)

### 5.13 EBP Expiry (`getEbpExpiresAt`)

```
tf === '1W'  → end of current UTC quarter (last day of Mar/Jun/Sep/Dec, 23:59:59)
otherwise    → end of current UTC month (last day of month, 23:59:59)
```

---

## 6. Database Schema — All 28 Tables

Database: `ebp-tracker-db` (Cloudflare D1 / SQLite)

### 6.1 `users`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | Clerk user ID |
| `email` | TEXT UNIQUE NOT NULL | |
| `role` | TEXT DEFAULT 'user' | `'user'` or `'admin'` |
| `telegram_bot_token` | TEXT | Per-user forex/crypto Telegram bot token |
| `telegram_chat_id` | TEXT | Per-user forex/crypto chat ID |
| `nse_bot_token` | TEXT | Per-user NSE Telegram bot token |
| `nse_chat_id` | TEXT | Per-user NSE chat ID |
| `asset_limit` | INTEGER DEFAULT 5 | Max forex/crypto tracked assets |
| `nse_enabled` | INTEGER DEFAULT 0 | 1 = NSE section unlocked |
| `tf_access` | TEXT | JSON array of allowed TFs for forex/crypto |
| `nse_tf_access` | TEXT | JSON array of allowed TFs for NSE |
| `created_at` | TEXT | ISO datetime |

### 6.2 `assets`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | FK → users.id |
| `symbol` | TEXT NOT NULL | e.g. `GBP/USD` |
| `market` | TEXT DEFAULT 'forex' | `'forex'`, `'crypto'`, `'nse'` |
| `created_at` | TEXT | |
| UNIQUE | `(user_id, symbol)` | |

### 6.3 `ebp_configs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `enabled` | INTEGER DEFAULT 1 | |
| `created_at` | TEXT | |
| UNIQUE | `(user_id, symbol, tf)` | |

### 6.4 `sweep_configs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `enabled` | INTEGER DEFAULT 1 | |
| `created_at` | TEXT | |
| UNIQUE | `(user_id, symbol, tf)` | |

### 6.5 `ebp_alerts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `direction` | TEXT NOT NULL | `'bull'` or `'bear'` |
| `price_at_signal` | REAL | |
| `htf_bias` | TEXT | |
| `session` | TEXT | |
| `htf_close` | REAL | Close price of the HTF candle that formed the bias |
| `signal_id` | TEXT | EBP signal ID (e.g. `EBP-GBPUSD-4HA001`) |
| `fired_at` | TEXT | ISO datetime |
| `expires_at` | TEXT | ISO datetime |
| `created_at` | TEXT | |

### 6.6 `sweep_alerts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `direction` | TEXT NOT NULL | |
| `price_at_signal` | REAL | |
| `htf_bias` | TEXT | |
| `session` | TEXT | |
| `fired_at` | TEXT | |
| `created_at` | TEXT | |

### 6.7 `mss_alerts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `direction` | TEXT NOT NULL | |
| `price_at_signal` | REAL | |
| `session` | TEXT | |
| `fired_at` | TEXT | |
| `created_at` | TEXT | |

### 6.8 `t3_chains`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `template_id` | INTEGER | FK → t3_templates.id |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `htf` | TEXT NOT NULL | HTF timeframe of the EBP step |
| `ltf` | TEXT NOT NULL | LTF timeframe of the Sweep/MSS steps |
| `direction` | TEXT NOT NULL | `'bull'` or `'bear'` |
| `state` | TEXT NOT NULL | `'awaiting_sweep'`, `'awaiting_mss'`, `'complete'` |
| `htf_signal_id` | TEXT | EBP step signal ID |
| `ltf_signal_id` | TEXT | Sweep step signal ID |
| `mss_signal_id` | TEXT | MSS step signal ID |
| `expires_at` | TEXT | |
| `created_at` | TEXT | |

### 6.9 `t3_templates`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `htf` | TEXT NOT NULL | |
| `ltf` | TEXT NOT NULL | |
| `enabled` | INTEGER DEFAULT 1 | |
| `created_at` | TEXT | |
| UNIQUE | `(user_id, symbol, htf, ltf)` | |

### 6.10 `fvg_zones`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `direction` | TEXT NOT NULL | `'bull'` or `'bear'` |
| `top` | REAL NOT NULL | Upper boundary of the gap |
| `bottom` | REAL NOT NULL | Lower boundary of the gap |
| `formed_at` | TEXT | ISO datetime |
| `mitigated_at` | TEXT | NULL until mitigated |
| `mitigated_by_tf` | TEXT | |
| `expires_at` | TEXT | |
| `created_at` | TEXT | |

### 6.11 `swing_states`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `run_dir` | TEXT | `'bull'`, `'bear'`, or NULL |
| `last_confirmed_swing_high` | REAL | |
| `last_confirmed_swing_high_time` | TEXT | |
| `last_confirmed_swing_low` | REAL | |
| `last_confirmed_swing_low_time` | TEXT | |
| `pending_swing_high` | REAL | |
| `pending_swing_high_time` | TEXT | |
| `pending_swing_low` | REAL | |
| `pending_swing_low_time` | TEXT | |
| `updated_at` | TEXT | |
| UNIQUE | `(symbol, tf)` | |

### 6.12 `sweep_candle_cache`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `candles_json` | TEXT NOT NULL | JSON array of OHLCV candles |
| `updated_at` | TEXT | |
| UNIQUE | `(symbol, tf)` | |

### 6.13 `nse_candle_cache`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `candles_json` | TEXT NOT NULL | |
| `updated_at` | TEXT | |
| UNIQUE | `(symbol, tf)` | |

### 6.14 `api_keys`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `key_value` | TEXT UNIQUE NOT NULL | Twelve Data API key |
| `label` | TEXT | Human label |
| `active` | INTEGER DEFAULT 1 | |
| `created_at` | TEXT | |

### 6.15 `api_key_state`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `key_id` | INTEGER | FK → api_keys.id |
| `exhausted` | INTEGER DEFAULT 0 | 1 = this key is currently rate-limited |
| `exhausted_at` | TEXT | |
| `reset_at` | TEXT | When the key is expected to be usable again |
| `updated_at` | TEXT | |
| UNIQUE | `(key_id)` | |

### 6.16 `api_call_log`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `key_id` | INTEGER | FK → api_keys.id |
| `called_at` | TEXT | ISO datetime |
| `symbol` | TEXT | |
| `tf` | TEXT | |
| `source` | TEXT | `'twelve'` or `'yahoo'` |
| `success` | INTEGER | |

Schema comment: _"This table was created ad hoc directly in D1 before this table ever made it into schema.sql."_ — meaning the production table may differ from this definition.

### 6.17 `invite_tokens`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `token` | TEXT UNIQUE NOT NULL | |
| `created_by` | TEXT | Admin user ID |
| `used_by` | TEXT | User ID who redeemed it, NULL if unused |
| `used_at` | TEXT | |
| `created_at` | TEXT | |

### 6.18 `signal_counters`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `counter_key` | TEXT UNIQUE NOT NULL | e.g. `EBP-4H`, `T3-GBPUSD` |
| `series` | TEXT DEFAULT 'A' | A–Z |
| `count` | INTEGER DEFAULT 0 | 0–999 |
| `updated_at` | TEXT | |

### 6.19 `htf_bias_overrides`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | The LTF whose bias is being overridden |
| `override_direction` | TEXT | `'bull'` or `'bear'` or NULL (cleared) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |
| UNIQUE | `(user_id, symbol, tf)` | |

### 6.20 `signals`

The Trade Journal integration table. Populated when T3 chains complete.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `signal_id` | TEXT UNIQUE | e.g. `T3-GBPUSD-A001` |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `direction` | TEXT NOT NULL | |
| `htf` | TEXT | |
| `ltf` | TEXT | |
| `entry_price` | REAL | |
| `sl_price` | REAL | |
| `tp_price` | REAL | |
| `status` | TEXT DEFAULT 'open' | `'open'`, `'win'`, `'loss'`, `'be'` |
| `pnl_pips` | REAL | |
| `notes` | TEXT | |
| `fired_at` | TEXT | |
| `closed_at` | TEXT | |
| `created_at` | TEXT | |

### 6.21 `market_breadth`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `computed_at` | TEXT | |
| `tf` | TEXT | Always `'1H'` (hardcoded in breadth cron) |
| `strength_json` | TEXT | JSON: `{USD: number, EUR: number, ...}` per 8 currencies |
| `heatmap_json` | TEXT | JSON: per-pair heatmap values |
| `intraday_json` | TEXT | JSON: 48h hourly intraday data |
| `correlation_json` | TEXT | JSON: Pearson correlation matrix |

### 6.22 `nse_indicator_configs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT NOT NULL | |
| `symbol` | TEXT NOT NULL | |
| `tdi_enabled` | INTEGER DEFAULT 0 | |
| `tdi_tf` | TEXT | |
| `sma_enabled` | INTEGER DEFAULT 0 | |
| `sma_tf` | TEXT | HTF for SMA cloud |
| `sma_period1` | INTEGER DEFAULT 1 | SMA1 period |
| `sma_period9` | INTEGER DEFAULT 9 | SMA9 period |
| `sma_bias_mode` | TEXT DEFAULT 'cross' | `'cross'` or `'htf'` |
| `sma_htf_tf` | TEXT | Used when `sma_bias_mode='htf'` |
| `day_filter` | INTEGER DEFAULT 0 | **Explicitly noted in schema as "unused since the SMA Cloud corrective patch"** |
| `created_at` | TEXT | |
| UNIQUE | `(user_id, symbol)` | |

### 6.23 `user_indicator_settings`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `user_id` | TEXT UNIQUE NOT NULL | |
| `sma_forex_hours` | TEXT | JSON array of hours — **schema comment: "not yet read by any Worker as of the NSE SMA corrective patch"** |
| `updated_at` | TEXT | |

### 6.24 `nse_swing_states`

Same column structure as `swing_states`, but scoped to NSE symbols.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | |
| `symbol` | TEXT NOT NULL | |
| `tf` | TEXT NOT NULL | |
| `run_dir` | TEXT | |
| `last_confirmed_swing_high` | REAL | |
| `last_confirmed_swing_high_time` | TEXT | |
| `last_confirmed_swing_low` | REAL | |
| `last_confirmed_swing_low_time` | TEXT | |
| `pending_swing_high` | REAL | |
| `pending_swing_high_time` | TEXT | |
| `pending_swing_low` | REAL | |
| `pending_swing_low_time` | TEXT | |
| `updated_at` | TEXT | |
| UNIQUE | `(symbol, tf)` | |

### 6.25 `nse_fvg_zones`

Same column structure as `fvg_zones`, but for NSE symbols.

### 6.26 `nse_t3_chains`

Same column structure as `t3_chains`, but for NSE symbols.

### 6.27 `nse_t3_templates`

Same column structure as `t3_templates`, but for NSE symbols.

### 6.28 Views

The schema defines SQL views. Two confirmed in schema.sql:

- **`active_ebp_alerts`** — Selects from `ebp_alerts` where `expires_at > datetime('now')`
- **`active_chains`** — Selects from `t3_chains` where `state != 'complete'` and `expires_at > datetime('now')`

---

## 7. Data Sources

### 7.1 Twelve Data (Primary)

**Base URL:** `https://api.twelvedata.com/time_series`

**Parameters used:**
```
symbol=  (Twelve Data format)
interval= (see TF mapping below)
outputsize=200
apikey=  (rotated per request)
```

**TF mapping (`tfToTwelveInterval`):**

| App TF | Twelve Data interval |
|--------|---------------------|
| M5 | `5min` |
| M15 | `15min` |
| M30 | `30min` |
| 1H | `1h` |
| 4H | `4h` |
| D | `1day` |
| W | `1week` |

**DateTime parsing (`nyLocalStringToUTCms`):**

Twelve Data returns datetimes as NY-local strings (e.g. `"2024-01-15 09:30:00"`). The worker parses these by:
1. Determining whether the date falls in EDT (UTC-4) or EST (UTC-5) using DST rules (second Sunday of March → first Sunday of November = EDT)
2. Adding the appropriate offset to produce a UTC millisecond timestamp

**Closed candle filter (`getClosedCandles`):**

Removes the last candle from the response if it corresponds to the currently-forming period. For Twelve Data: checks if `now - lastCandleTime < intervalMs`. For Yahoo: same check using `intervalMs` constant.

**Key Rotation Algorithm (`fetchTwelveDataWithRotation`):**

```
1. Load all active (non-exhausted) API keys from D1 api_keys + api_key_state
2. If no usable keys: return error
3. Pick the first usable key
4. Attempt fetch to Twelve Data
5. If response status 429 OR body contains 'run out' OR 'api credits':
   a. Mark this key as exhausted in api_key_state (exhausted=1, exhausted_at=now, reset_at=now+1hr)
   b. Move to next usable key and retry (up to 5 total attempts)
6. On success: log to api_call_log, return candle array
7. On all keys exhausted: return null (triggers Yahoo fallback)
```

**Symbol format:** Twelve Data uses slash format (`GBP/USD`, `BTC/USD`).

### 7.2 Yahoo Finance (Fallback)

**Base URL:** `https://query1.finance.yahoo.com/v8/finance/chart/`

**Headers:** `User-Agent: Mozilla/5.0`

**TF mapping (`toYahooInterval`):**

| App TF | Yahoo interval |
|--------|---------------|
| M5 | `5m` |
| M15 | `15m` |
| M30 | `30m` |
| 1H | `1h` |
| 4H | **`1h`** — Yahoo has no true 4H interval |
| D | `1d` |
| W | `1wk` |

When Yahoo is used for 4H, the worker fetches 1H bars and aggregates them into 4H bars (grouping by 4-hour blocks aligned to midnight UTC).

**Symbol translation (`toYahooSymbol`):**

| App Symbol | Yahoo Symbol |
|-----------|-------------|
| XAU/USD | `GC=F` |
| XAG/USD | `SI=F` |
| WTI/USD | `CL=F` |
| BRENT/USD | `BZ=F` |
| SPX | `^GSPC` |
| DJI | `^DJI` |
| NDX | `^NDX` |
| NIFTY | `^NSEI` |
| SENSEX | `^BSESN` |
| Forex `A/B` | `AB=X` (e.g. `GBP/USD` → `GBPUSD=X`) |
| Crypto `A/B` | `AB=X` (same pattern) |

**`normaliseSymbol` function:** Converts 6-character bare pairs (e.g. `GBPUSD`) to slash format (`GBP/USD`) using hardcoded `FOREX_BASES` and `FOREX_QUOTES` string arrays.

### 7.3 Telegram Bot API

**Base URL:** `https://api.telegram.org/bot{TOKEN}/sendMessage`

**Method:** POST, JSON body: `{ chat_id, text, parse_mode: 'HTML' }`

**Token sources:**
- Forex/crypto alerts: `user.telegram_bot_token` (per-user; `SHARED_BOT_TOKEN` env var is the shared fallback)
- NSE alerts: `user.nse_bot_token`
- Chat IDs: `user.telegram_chat_id` / `user.nse_chat_id`

**Webhook support:** `POST /webhook/telegram/:botToken` — the EBP Worker accepts inbound Telegram messages (for bot commands), verified by matching `:botToken` against known tokens in D1.

---

## 8. Frontend

### 8.1 Technology Stack

| Item | Value |
|------|-------|
| Framework | React 18 |
| Build tool | Vite |
| Routing | react-router-dom |
| Auth | @clerk/clerk-react |
| Charts | recharts |
| Excel export | xlsx |
| Deployment | Cloudflare Pages |
| Origin | `https://ebp-tracker.pages.dev` |

### 8.2 Pages

| Route | Component | Notes |
|-------|-----------|-------|
| `/` | Dashboard | Asset cards + NSE section |
| `/alerts` | Alerts | Alert history table with filters + Excel export |
| `/admin` | Admin | Admin-only: Users, Tokens, API Keys, Limits, Price Feed |
| `/market` | MarketBreathPage | Admin-only: 28-pair breadth + heatmap + Pearson |
| `/upgrade` | **MISSING** | Linked from ExpiryBanner — route does not exist in App.jsx |

### 8.3 Components

| Component | Purpose |
|-----------|---------|
| `AssetCard` | Per-asset card; fetches and renders EBP/Sweep/T3/TDI/SMA configs and alert history |
| `EBPConfigPanel` | Enable/disable EBP per TF; shows per-TF enabled state |
| `SweepConfigPanel` | Enable/disable Sweep per TF |
| `AIAlertsPanel` | T3 chain config (T1/T2/T4 shown as "coming soon"; T3 is active) |
| `TdiConfigPanel` | NSE-only: TDI indicator config |
| `SmaConfigPanel` | NSE-only: SMA Cloud config (period1, period9, bias mode, HTF TF) |
| `BiasOverridePanel` | Per-asset HTF bias override (bull/bear/clear) |
| `PriceFeedPanel` | Admin: WebSocket live price from `wss://ws.twelvedata.com/v1/quotes/price`; manual key entry, no auto-reconnect |
| `ExpiryBanner` | Warning banner when `expires_at` is within 7 days; "Renew" links to `/upgrade` (missing route) |

### 8.4 Hooks

Custom hooks in `frontend/src/hooks/`:

| Hook | Purpose |
|------|---------|
| `useAuth` | Wraps Clerk's `useAuth`; provides JWT token for API calls |
| `useAssets` | Fetches user's asset list; handles loading/error state |
| `useAlerts` | Fetches and filters alert history |
| `useAdminUsers` | Admin: fetches and updates user records |

### 8.5 Design System (`frontend/src/styles/`)

**Fonts (loaded from Google Fonts):**
- Body: `Manrope` (sans-serif)
- Mono: `Outfit` (monospace)

**Colour Tokens (`tokens.css`):**

| Token | Hex | Usage |
|-------|-----|-------|
| `--ink` | `#0e0c0a` | Primary text |
| `--paper` | `#f3ede3` | Page background |
| `--cream` | `#eae2d4` | Secondary background |
| `--warm` | `#d6c9b4` | Tertiary background |
| `--surface` | `#faf6ee` | Card surface |
| `--border` | `#c4b9a4` | Border colour |
| `--muted` | `#6b6050` | Muted/secondary text |
| `--bull` | `#0f3d1e` | Bullish dark |
| `--bull-lt` | `#cce8d6` | Bullish light badge |
| `--bear` | `#3d0f0f` | Bearish dark |
| `--bear-lt` | `#ead0d0` | Bearish light badge |
| `--gold` | `#7a5c00` | Accent gold |
| `--gold-lt` | `#f7e8c0` | Gold light badge |
| `--nav-bg` | `#0f172a` | Sidebar background |
| `--nav-hover` | `#1e2d47` | Sidebar hover |
| `--nav-active-accent` | `#38bdf8` | Active nav item |

**Layout Variables:**
- `--nav-w: 244px` — sidebar width
- `--topbar-h: 52px` — topbar height

**Responsive breakpoints (in `global.css`):**
- `860px` — sidebar collapses to icon-only
- `640px` — mobile layout

### 8.6 Constants (`frontend/src/lib/constants.js`)

```js
EBP_TFS = ['M15', '1H', '4H', 'D', 'W']
SWEEP_TFS = ['M5', 'M15', 'M30', '1H', '4H']
NSE_EBP_TFS = ['M15', '1H', '4H', 'D']    // no W for NSE
NSE_SWEEP_TFS = ['M5', 'M15', 'M30', '1H', '4H']

BIAS_SOURCE_FRONTEND = {
  ebp:      { M15:'4H', '1H':'D', '4H':'W', D:'W', W:null },
  sweep:    { M5:'1H', M15:'1H', M30:'4H', '1H':'D', '4H':'W' },
  template: { W:null, D:'W', '4H':'D', '1H':'4H' }
}

NSE_BIAS_SOURCE_FRONTEND = {
  ebp:   { M15:'4H', '1H':'D', '4H':'D', D:null },
  sweep: { M5:'1H', M15:'1H', M30:'4H', '1H':'D', '4H':'D' }
}

TEMPLATE_TF_RANK = { W:5, D:4, '4H':3, '1H':2, M30:1.5, M15:1 }
```

`templateLtfOptions(htf)` — returns valid LTF choices for a given HTF based on rank ordering.

### 8.7 Asset Lists (`frontend/src/data/assetLists.js`)

**`CRYPTO_PAIRS`** (6 pairs):
`BTC/USD`, `ETH/USD`, `XRP/USD`, `SOL/USD`, `BNB/USD`, `ADA/USD`

**`FOREX_SECTIONS`** (grouped, total ~28 pairs):
- **Majors:** EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD
- **EUR Minors:** EUR/GBP, EUR/JPY, EUR/AUD, EUR/CAD, EUR/CHF, EUR/NZD
- **GBP Minors:** GBP/JPY, GBP/AUD, GBP/CAD, GBP/CHF, GBP/NZD
- **Other Minors:** AUD/JPY, CAD/JPY, NZD/JPY, AUD/CAD, AUD/CHF, AUD/NZD, CAD/CHF, NZD/CAD, NZD/CHF

### 8.8 Market Breadth Page

**28 G8 cross-pairs** used for breadth (all combinations of USD, EUR, GBP, JPY, AUD, CAD, CHF, NZD).

**Currency colours (`CCY_COLORS` in MarketBreathPage.jsx):**

| Currency | Colour |
|----------|--------|
| USD | `#2563eb` |
| EUR | `#16a34a` |
| GBP | `#dc2626` |
| JPY | `#d97706` |
| AUD | `#7c3aed` |
| CAD | `#0891b2` |
| CHF | `#be185d` |
| NZD | `#65a30d` |

**Polling interval:** 60 seconds (via `setInterval` in the page component).

**Charts rendered:** Recharts `LineChart` for intraday 48h data; tabular display for strength + heatmap + Pearson matrix.

---

## 9. Authentication & Security

### 9.1 Clerk JWT Verification

The EBP Worker implements Clerk JWT verification using **only the Web Crypto API** (zero npm packages). Algorithm: **RSASSA-PKCS1-v1_5 / SHA-256**.

**Process:**
1. Extract `Authorization: Bearer <token>` header
2. Split JWT into `header.payload.signature`
3. Fetch Clerk JWKS from `https://api.clerk.com/v1/jwks` (or env-configured URL)
4. Match `kid` from JWT header to JWKS key
5. Import RSA public key via `crypto.subtle.importKey`
6. Verify signature via `crypto.subtle.verify`
7. Check `exp` claim (expiry)
8. Return decoded payload (contains `sub` = Clerk user ID)

**Admin check:** After JWT verification, queries D1 `users` table: `WHERE id = ? AND role = 'admin'`.

### 9.2 Cron Endpoint Protection

Both workers protect cron endpoints with a shared secret header:

```
X-Cron-Secret: {value from CRON_SECRET env var}
```

Requests without a matching header receive `401 Unauthorized`.

### 9.3 Trade Journal Integration

`GET/PATCH /signals` routes use a separate secret:

```
X-Journal-Secret: {value from JOURNAL_SECRET env var}
```

These routes use **open CORS** (`Access-Control-Allow-Origin: *`) to allow the Trade Journal app to call them from any origin.

### 9.4 CORS Policy

**Standard routes:** Origin must be in `ALLOWED_ORIGINS`:
```js
['http://localhost:5173', 'https://ebp-tracker.pages.dev']
```

If origin is not in allowlist: `Access-Control-Allow-Origin` header is omitted (browser blocks the request).

**`/signals` routes:** `Access-Control-Allow-Origin: *` — open CORS.

### 9.5 Telegram Webhook

`POST /webhook/telegram/:botToken` — The `:botToken` path parameter is verified against known bot tokens in D1. No separate secret header.

---

## 10. Environment Variables & Secrets

### 10.1 EBP Worker (`worker/src/ebp-worker.js`)

| Variable | Used For |
|----------|---------|
| `CRON_SECRET` | Authenticates `POST /cron/ebp` and `POST /cron/breadth` |
| `CLERK_JWKS_URL` | Clerk JWKS endpoint for JWT key fetch (e.g. `https://api.clerk.com/v1/jwks`) |
| `SHARED_BOT_TOKEN` | Fallback Telegram bot token when user has no personal token |
| `JOURNAL_SECRET` | Authenticates `GET/PATCH /signals` routes |

All accessed via `env.*` (Cloudflare Workers environment binding convention).

D1 binding: `env.DB`

### 10.2 Sweep Worker (`sweep-worker/src/sweep-cron.js`)

| Variable | Used For |
|----------|---------|
| `CRON_SECRET` | Authenticates `POST /cron/sweep` |
| `SHARED_BOT_TOKEN` | Telegram bot token fallback |

D1 binding: `env.DB`

**Note:** The Sweep Worker does **not** perform Clerk JWT authentication. The `/sweep/dashboard` and `/sweep/history` routes are unauthenticated (no auth check present in `index.js`).

### 10.3 Deployment Commands

From `worker/package.json` and `sweep-worker/package.json`, both workers use:

```powershell
# Deploy EBP Worker
cd worker
npx wrangler deploy

# Deploy Sweep Worker
cd sweep-worker
npx wrangler deploy
```

Wrangler versions: EBP Worker uses `^3.99.0`; Sweep Worker uses `^4.0.0`.

No `.env` files or build steps are required. Secrets are stored in Cloudflare Worker secrets (set via `wrangler secret put`).

---

## 11. Known Issues & TODOs Found in Code

The following are issues, inconsistencies, and TODOs found **verbatim in the source files**. Nothing is inferred beyond what the code and comments explicitly state.

### 11.1 Missing `/upgrade` Route

`frontend/src/components/ExpiryBanner.jsx` navigates to `/upgrade` via `react-router-dom`'s `useNavigate`. This route **does not exist** in `App.jsx`'s route definitions. Clicking "Renew" in the expiry banner will result in a 404 or unmatched route render.

### 11.2 T3 Alert Format Inconsistency

The `formatT3Alert` function exists in both workers but produces **different output**:

- **`sweep-cron.js`:** Includes `Signal ID: {signalId}` as the last line
- **`ebp-worker.js`:** Does **not** include the `Signal ID` line

Both functions send T3 alerts under different circumstances (the T3 completion alert is sent by sweep-cron.js; the ebp-worker.js version is used for chain initiation notifications in some code paths). This inconsistency means T3 alert format depends on which step fired.

### 11.3 `day_filter` Column — Explicitly Unused

`schema.sql` comment on `nse_indicator_configs.day_filter`:  
> _"unused since the SMA Cloud corrective patch"_

The column remains in the schema and is presumably populated by frontend but never read by any worker.

### 11.4 `sma_forex_hours` Column — Not Yet Read

`schema.sql` comment on `user_indicator_settings.sma_forex_hours`:  
> _"not yet read by any Worker as of the NSE SMA corrective patch"_

The column exists in the schema but has no worker-side logic that reads or acts on it.

### 11.5 `api_call_log` — Schema vs Production Mismatch

`schema.sql` comment on `api_call_log`:  
> _"This table was created ad hoc directly in D1 before this table ever made it into schema.sql."_

The production table in D1 may have a different column structure than what `schema.sql` defines, since the table pre-dates the schema file entry.

### 11.6 Stale Comment Referencing `combined_enabled`

`schema.sql` contains a comment referencing a `combined_enabled` column. This column **no longer exists** in the schema. The comment was not removed when the column was dropped (in a prior commit: `"legacy columns dropped"`).

### 11.7 Sweep Worker `/sweep/dashboard` and `/sweep/history` — No Auth

`sweep-worker/src/index.js` routes `GET /sweep/dashboard` and `GET /sweep/history` with **no authentication**. These endpoints return sweep cache data and recent alert history. Any HTTP client can query them without credentials.

### 11.8 Yahoo Finance 4H — No True 4H Interval

`toYahooInterval` maps `4H` to `'1h'` because Yahoo Finance does not offer a 4-hour candle interval. The worker aggregates 1H bars into 4H bars when Yahoo is the fallback for 4H requests. Aggregation accuracy depends on Yahoo's data completeness for the 1H interval.

### 11.9 T1, T2, T4 Shown as "Coming Soon"

In `frontend/src/components/AIAlertsPanel.jsx`, the T1, T2, and T4 template types are rendered with a `comingSoon` badge. Only T3 is functional. No backend logic for T1/T2/T4 exists in any worker.

### 11.10 NSE Worker Not in Repository

The schema includes `nse_candle_cache`, `nse_swing_states`, `nse_fvg_zones`, `nse_t3_chains`, `nse_t3_templates`, and `nse_indicator_configs` tables. The commit history references a `nse-tracker` worker (commit `91d1bf7 Phase D — NSE Worker (nse-tracker) + Indian Market Section`). However, **no `nse-worker/` or `nse-tracker/` directory** exists in this repository. The NSE worker that reads these tables is either in a separate repository or has been removed.

### 11.11 `PriceFeedPanel` — No Auto-Reconnect

`frontend/src/components/PriceFeedPanel.jsx` opens a WebSocket to `wss://ws.twelvedata.com/v1/quotes/price`. If the connection drops, there is no reconnect logic. The panel requires the admin to manually re-enter an API key per browser session (not persisted).

### 11.12 VALID_HTF_OVERRIDES Limits Override Options

```js
VALID_HTF_OVERRIDES = { '1H': ['4H','D'], '4H': ['D','W'] }
```

Only 1H and 4H LTFs support HTF bias overrides. M5, M15, M30, D, and W TFs are not listed and will be rejected by the override endpoint.

---

## 12. Recent Git History

_(From `git log --oneline -20`, read at audit time)_

| Hash | Commit Message |
|------|---------------|
| `ba6e1aa` | feat: market breadth page — 28-pair strength analysis (admin-only /market) |
| `6463659` | NSE SMA Cloud corrective patch — SMA1/SMA9 cloud, bias mode, HTF TF user choice, day filter removed |
| `8ee8541` | Daily candle synthesis, TD NY-local timestamp fix, bias display fix, EBP signal ID expansion, template HTF/LTF selects |
| `1dae5d1` | Filter out currently-forming candle before detection logic runs |
| `3d4010a` | Cron tf fallback, HTF bias label fix, user-configurable HTF bias pairing |
| `1c0f40a` | Phase D++ — TDI and SMA Cloud indicators |
| `b08ebb5` | Phase A complete — schema fix, cleanup, UI fixes |
| `ed3d770` | Split asset slot count between forex/crypto and NSE — NSE assets are unlimited and no longer count against asset_limit |
| `df1f3b8` | Signal enrichment — price_at_signal, htf_bias, session, htf_close on all signal inserts |
| `dfac901` | Hard delete assets, drop active column, EBP Signal IDs on 4H/1D/1W, signals expires_at |
| `bebecf1` | Phase I — Trade Journal signal integration: T3 Signal ID, signals table wiring, GET/PATCH /signals routes |
| `4aca4d5` | Bug fixes — NSE search filter, NSE TF gating, Sweep config error handling, tier removal from AI alerts |
| `91d1bf7` | Phase D — NSE Worker (nse-tracker) + Indian Market Section |
| `5e7fbff` | Phase C — dedicated Assets page replaces AssetBrowserModal |
| `6bc5472` | Asset Browser modal for forex/crypto, Admin panel vertical cascade layout |
| `52f4741` | Phase A — user_tf_access enforcement, Admin Users tab with slot control and TF access checkboxes |
| `3ae805c` | Immediate fixes complete — schema clean, legacy columns dropped, dead code removed, planning docs added |
| `62b3ecf` | docs: add Technical Reference v2.2 |
| `f3ba615` | PriceFeedPanel: single-symbol redesign for Basic plan |
| `efa09c3` | PriceFeedPanel: parse subscribe-status, show LIVE/FAILED badge per card |

---

*Report generated from full source-file reads. All facts sourced directly from code.*
