# EBP Tracker — Project Report
**Generated:** 2026-07-24
**Repository:** github.com/aicubeapps/EBP_TRACKER
**Live site:** ebp-tracker.pages.dev

---

## 1. Project Overview

EBP Tracker is a real-time trading signal alerting platform that monitors financial assets across multiple timeframes and delivers alerts via Telegram when key price action patterns are detected. It implements three core signal types — EBP (Engulfing Body Pattern), Sweep (liquidity sweep), and MSS (Market Structure Shift) — using a TTrades-derived closure bias engine to filter signals against the higher-timeframe trend. The entire stack runs on Cloudflare's free tier (Pages, Workers, D1), using Twelve Data (3-key rotation) and Yahoo Finance as price data sources, making the total infrastructure cost $0/month.

---

## 2. Current Production Status

| Component | Status | Notes |
|---|---|---|
| Frontend (Cloudflare Pages) | ✅ Live | ebp-tracker.pages.dev — React 18 + Vite, custom CSS design system |
| EBP Worker | ✅ Live | ebp-tracker-worker.aicube-apps.workers.dev — handles EBP, MSS, FVG, T3 chain, all API routes |
| Sweep Worker | ✅ Live | sweep-detector.aicube-apps.workers.dev — handles Sweep, MSS (on sweep TFs), FVG, T3 completion |
| D1 Database | ✅ Live | ebp-tracker-db (ID: b93b206a-5537-4d12-8c86-a4b2372aae7f) — shared across both workers |
| Clerk Auth | ✅ Live | JWT verified via Web Crypto / JWKS — zero npm dependencies in workers |
| Telegram Bot | ✅ Live | @EbP_Tracker_bot — webhook registered on EBP Worker; 4-digit link-code pairing |
| cron-job.org (9 active jobs) | ✅ Live | EBP: 5 jobs (M15, 1H, 4H, D, W); Sweep: 4 jobs (M15, M30, 1H, 4H). HTTP POST with X-Cron-Secret |
| Watchdog Worker | ❌ Not deployed | Planned — references in cron schedule but no Worker code or schema table yet |
| Twelve Data (3-key rotation) | ✅ Live | Keys stored in D1 api_keys table; rotation managed dynamically; resets at UTC midnight |
| Yahoo Finance fallback | ✅ Live | No key required; activated automatically when all Twelve Data keys are exhausted |

---

## 3. Backend Architecture

### 3.1 Workers

**EBP Worker**
- **Name:** `ebp-tracker-worker`
- **URL:** `https://ebp-tracker-worker.aicube-apps.workers.dev`
- **File:** `worker/src/ebp-worker.js` (single zero-dependency bundle, no npm imports)
- **Cron trigger method:** HTTP POST to `/cron/ebp` from cron-job.org; secured by `X-Cron-Secret` header. Native Cloudflare crons are disabled (commented out in `worker/wrangler.toml`).
- **Routes implemented:**
  - `GET  /health` — public health check
  - `GET  /user/me` — authenticated user profile (plan, asset_limit, expires_at, active, is_admin)
  - `GET  /user/assets` — user's active assets with per-TF EBP status from candle_cache
  - `POST /user/assets` — add asset (validates via Yahoo Finance, enforces asset_limit cap)
  - `GET  /user/assets/count` — count/limit/remaining for asset slot display
  - `DELETE /user/assets/:id` — soft-delete (sets active=0)
  - `PATCH /user/assets/:id/bias-overrides` — update per-TF manual bias overrides JSON
  - `GET  /user/assets/validate?symbol=` — validate symbol via Twelve Data symbol_search (falls back to Yahoo or guessAssetType)
  - `GET  /user/ebp-configs/:assetId` — list EBP alert configs for an asset
  - `POST /user/ebp-configs/:assetId` — create EBP config (timeframe, alert_mode)
  - `PATCH /user/ebp-configs/:id` — update timeframe, alert_mode, or enabled flag
  - `DELETE /user/ebp-configs/:id` — delete EBP config
  - `GET  /user/sweep-configs/:assetId` — list Sweep alert configs for an asset
  - `POST /user/sweep-configs/:assetId` — create Sweep config (timeframe, alert_mode)
  - `PATCH /user/sweep-configs/:id` — update Sweep config
  - `DELETE /user/sweep-configs/:id` — delete Sweep config
  - `GET  /user/templates/:assetId` — list AI alert templates (T3/T1/T4/T2)
  - `POST /user/templates/:assetId` — create template (template, htf, ltf, window_mins, enabled)
  - `PATCH /user/template/:id` — update template fields (enabled, htf, ltf, window_mins)
  - `DELETE /user/template/:id` — delete template
  - `GET  /dashboard` — dashboard asset list with last_alert_at per asset
  - `GET  /user/bias/:symbol` — bias_cache entries for a symbol (all timeframes)
  - `GET  /health/datasources` — api_call_log stats per source + Twelve Data key state
  - `GET  /alerts/history` — paginated alert history (filterable by type, assetId, days)
  - `GET  /alerts/export` — bulk alert export (up to 5000 rows, date-range filterable)
  - `GET  /user/telegram` — connected status + masked chat ID
  - `POST /user/telegram/initlink` — generate 4-digit link code
  - `POST /user/telegram/test` — send test Telegram message
  - `POST /user/telegram/verify` — poll for bot-side code verification
  - `DELETE /user/telegram` — disconnect Telegram
  - `POST /payment/submit` — submit UPI payment reference (logs to payment_log, notifies developer via Telegram)
  - `GET  /payment/status` — user's recent payment history
  - `GET  /tiers` — public tier pricing (from tier_config D1 table, with hardcoded fallback)
  - `GET  /invite/:token` — validate invite token
  - `POST /cron/ebp` — HTTP cron trigger (X-Cron-Secret required, tf in body)
  - `POST /telegram/webhook` — Telegram Bot webhook handler (public, no Clerk auth)
  - `GET  /admin/users` — admin: all users with asset/alert counts and Telegram status
  - `GET  /admin/payments` — admin: all payment submissions
  - `GET  /admin/tokens` — admin: all invite tokens
  - `POST /admin/invite` — admin: generate invite token
  - `POST /admin/approve/:id` — admin: approve payment, update user plan/asset_limit/expires_at, notify via Telegram
  - `POST /admin/reject/:id` — admin: reject payment
  - `POST /admin/expire/:id` — admin: force-expire user account
  - `GET  /admin/api-keys` — admin: list Twelve Data keys with state (redacted key preview)
  - `POST /admin/api-keys` — admin: add new API key to D1
  - `PATCH /admin/api-keys/:id` — admin: enable/disable key
  - `DELETE /admin/api-keys/:id` — admin: delete key and its state row
  - `PATCH /admin/users/:id/asset-limit` — admin: override per-user asset_limit (1–50)
  - `GET  /admin/tiers` — admin: tier config list
  - `PATCH /admin/tiers/:tier` — admin: update tier pricing and asset slots
- **Key functions:** `handleEBPCron`, `detectEBP`, `detectFVG`, `processFVGs`, `updateSwingState`, `detectMSS`, `calcTTradesBias`, `fetchTwelveDataWithRotation`, `fetchYahooFinance`, `fetchCandles`, `initiateT3Chain`, `formatEBPAlert`, `formatMSSAlert`, `formatT3Alert`, `verifyClerkToken`, `getOrCreateUser`, `normaliseSymbol`, `validateSymbol`

**Sweep Worker**
- **Name:** `sweep-detector`
- **URL:** `https://sweep-detector.aicube-apps.workers.dev`
- **Files:** `sweep-worker/src/index.js` (entry point + auth/routing), `sweep-worker/src/sweep-cron.js` (all signal logic, inlined — no cross-package imports)
- **Cron trigger method:** HTTP POST to `/cron/sweep` from cron-job.org; secured by `X-Cron-Secret` header. Native Cloudflare crons are disabled (commented out in `sweep-worker/wrangler.toml`). Valid TFs: M5, M15, M30, 1H, 4H.
- **Routes implemented:**
  - `GET  /health` — public health check (returns `worker: "sweep-detector"`)
  - `POST /cron/sweep` — HTTP cron trigger (X-Cron-Secret required, tf in body)
  - `GET  /sweep/dashboard` — authenticated; sweep status per asset per TF from sweep_candle_cache
  - `GET  /sweep/history` — authenticated; recent sweep and combined alerts
- **Key functions:** `handleSweepCron`, `detectSweep`, `updateSweepCandleCache`, `checkPendingSignals`, `consumePendingSignal`, `cleanupExpiredSignals`, `updateSwingState`, `detectMSS`, `processFVGs`, `advanceT3Chain`, `completeT3Chain`, `formatSweepAlert`, `formatMSSAlert`, `formatT3Alert`, `calcTTradesBias`, `fetchTwelveDataWithRotation`, `fetchYahooFinance`, `fetchCandles`, `normaliseSymbol`
- **M5 cleanup duty:** When tf=M5, the sweep cron also cleans expired pending_signals, detected_fvgs, chain_state, api_key_state, and api_call_log (retains 48h).

---

### 3.2 Data Sources

**Primary — Twelve Data (3-key rotation via D1)**

API keys are stored in the `api_keys` D1 table (source='twelvedata', managed via the Admin panel at `/admin/api-keys`). Key rotation state is tracked per-key in `api_key_state`. The rotation algorithm:

1. At fetch time, `resetExhaustedKeys` first checks whether any previously exhausted key has passed its `reset_at` UTC midnight timestamp and restores it.
2. `getActiveTwelveDataKey` queries all enabled Twelve Data keys ordered by label ascending and returns the first non-exhausted one.
3. If the API returns HTTP 429 or a message containing "run out" / "api credits", the key is marked exhausted (`exhausted=1`) with `reset_at` set to the next UTC midnight.
4. The loop retries with the next available key (up to 5 attempts).
5. Per-key `calls_today` counter is incremented on each successful fetch and logged to `api_call_log`.
6. Each free-tier Twelve Data key provides 800 credits/day. With 3 keys the combined daily limit is 2,400 credits, visible in the Settings → Data Sources panel.

**Fallback — Yahoo Finance (no key)**

Used automatically when all Twelve Data keys are exhausted or when no keys are configured. Yahoo Finance is also the exclusive source for symbol validation (`validateSymbol`) to preserve Twelve Data quota for candle fetching. Symbol translation: `XAU/USD → GC=F`, `XAG/USD → SI=F`, `WTI/USD → CL=F`, `BRENT/USD → BZ=F`, `SPX → ^GSPC`, `DJI → ^DJI`, `NDX → ^NDX`, `NIFTY → ^NSEI`, `SENSEX → ^BSESN`, all other forex pairs `BASE/QUOTE → BASEQUOTE=X`.

**Limitation:** Yahoo Finance does not provide a true 4H interval — the 4H TF maps to `1h` interval on Yahoo, meaning the candle data for 4H is not accurate when Yahoo fallback is active.

**Symbol normalisation:** Bare 6-character symbols such as `EURUSD` or `XAUUSD` are normalised to slash format (`EUR/USD`, `XAU/USD`) by `normaliseSymbol()` before any data source call. NSE stocks, indices, and unrecognised symbols are passed through unchanged.

---

### 3.3 Signal Engine

**TTrades Bias Engine — `calcTTradesBias({ bar1, bar2 })`**

Accepts the two most recent closed bars (bar1 = current, bar2 = prior). Classifies bar1's closure relative to bar2's range into six closures:

| Closure | Condition |
|---|---|
| `outside_bar` | bar1.high > bar2.high AND bar1.low < bar2.low |
| `inside_bar` | bar1.high <= bar2.high AND bar1.low >= bar2.low |
| `swept_high_closed_inside` | bar1.high > bar2.high AND bar1.close <= bar2.high |
| `swept_low_closed_inside` | bar1.low < bar2.low AND bar1.close >= bar2.low |
| `above_prev_high` | bar1.close > bar2.high |
| `below_prev_low` | bar1.close < bar2.low |
| `none` | none of the above |

Bias output:
- **bullish:** `above_prev_high` or `swept_low_closed_inside`
- **bearish:** `below_prev_low` or `swept_high_closed_inside`
- **outside_bar:** bullish if close position in bar ≥ 50%, bearish if < 50%
- **neutral:** `inside_bar` or `none`

Returns `{ bias, closure, closePos }`. Result is written to `bias_cache` and used by all signal alert filters.

---

**EBP Detection — `detectEBP(candles)`**

Candles array is newest-first. Takes bar0 (current) and bar1 (previous).

- **Bullish EBP:** `bar0.low < bar1.low` (swept prior candle's low) AND `bar0.close > max(bar1.open, bar1.close)` (closed above prior candle's body)
- **Bearish EBP:** `bar0.high > bar1.high` (swept prior candle's high) AND `bar0.close < min(bar1.open, bar1.close)` (closed below prior candle's body)

Returns `{ direction, candleTime, sweptLevel, closedLevel }` or null.

---

**Sweep Detection — `detectSweep(candles)`**

Candles array is newest-first. Takes bar0 (current) and bar1 (previous).

- **Bullish Sweep:** `bar0.low < bar1.low` (swept low) AND `bar0.close > bar1.low` (closed back inside prior range)
- **Bearish Sweep:** `bar0.high > bar1.high` (swept high) AND `bar0.close < bar1.high` (closed back inside prior range)

EBP is a stricter version of Sweep — it additionally requires the close to exceed the prior candle's body, not just its wick. Returns `{ direction, candleTime, sweptLevel, closedInsideLevel, prevHigh, prevLow }` or null.

---

**MSS Detection — `detectMSS(swingState, currentCandle)`**

Market Structure Shift is detected after `updateSwingState` has confirmed a swing high or swing low.

- **Bullish MSS:** `swingState.run_direction === 'bearish'` AND `confirmed_swing_high != null` AND `currentCandle.close > confirmed_swing_high`
- **Bearish MSS:** `swingState.run_direction === 'bullish'` AND `confirmed_swing_low != null` AND `currentCandle.close < confirmed_swing_low`

The swing state engine tracks `run_direction`, `run_extreme`, and promotes confirmed swing highs/lows whenever direction reverses. State is persisted to `swing_state` D1 table keyed by (symbol, timeframe). MSS alerts are fired from both the EBP Worker (on EBP timeframes) and the Sweep Worker (on sweep timeframes).

---

**FVG Detection — `detectFVG(candles)`**

Candles array is oldest-first: `[c0, c1, c2]`.

- **Bullish FVG:** `c2.low > c0.high` — gap between the high of the oldest candle and the low of the newest
- **Bearish FVG:** `c2.high < c0.low` — gap between the high of the newest and the low of the oldest

FVGs are stored in `detected_fvgs` with a 7-day TTL (`expires_at`). Duplicate detection uses a 0.1% price tolerance. Mitigation rules:
- `50_percent` (default): mitigated when price touches the zone's midpoint
- `body_close`: mitigated when a candle body closes fully within the zone

FVG data is tracked and stored in D1 but is not yet surfaced directly in the frontend UI. It is used internally by the T3 chain state machine and will be the foundation for T1 and T4 templates.

---

### 3.4 Nomenclature Standard

The following lowercase string conventions are enforced across all signal engines, D1 writes, and Telegram message formatters:

| Context | Values |
|---|---|
| `direction` (all signals, D1, chain_state) | `'bullish'` / `'bearish'` (lowercase) |
| `bias` (bias_cache, calcTTradesBias output) | `'bullish'` / `'bearish'` / `'neutral'` (lowercase) |
| `alert_type` (alert_history) | `'ebp'` / `'sweep'` / `'mss'` / `'t3'` / `'combined'` (lowercase) |
| `closure` (bias_cache.closure_type) | `'outside_bar'` / `'inside_bar'` / `'swept_high_closed_inside'` / `'swept_low_closed_inside'` / `'above_prev_high'` / `'below_prev_low'` / `'none'` |
| Telegram headers | `'BULLISH EBP'` / `'BEARISH EBP'` / `'BULLISH SWEEP'` / `'BEARISH SWEEP'` / `'BULLISH MSS'` / `'BEARISH MSS'` (uppercase via format functions) |
| Frontend display | Lowercase strings capitalised via `capitalise()` utility; direction shown as `● Bullish` / `● Bearish` using `dir-bull` / `dir-bear` CSS classes |

---

## 4. Database Schema

Both workers share a single D1 database (`ebp-tracker-db`).

### Tables

| Table | Purpose | Key columns |
|---|---|---|
| `users` | User accounts (created on first Clerk login) | id (Clerk sub), email, name, plan, asset_limit (default 3), created_at, expires_at, active, is_admin |
| `user_assets` | Assets (symbols) added to a user's watchlist | id, user_id, symbol, display_name, asset_type, active, bias_overrides (JSON), added_at; legacy columns: timeframes, ebp_alert_mode, sweep_enabled, sweep_timeframes, sweep_alert_mode, combined_enabled, combined_pairs |
| `user_telegram` | Telegram connection per user | user_id (PK), chat_id, link_code (4-digit, cleared after verification), verified, updated_at |
| `user_ebp_configs` | Per-asset EBP alert configurations (replaces user_assets.timeframes) | id, user_id, asset_id, timeframe, alert_mode (aligned/price_action/all), enabled |
| `user_sweep_configs` | Per-asset Sweep alert configurations (replaces user_assets.sweep_timeframes) | id, user_id, asset_id, timeframe, alert_mode (aligned/price_action/all), enabled |
| `user_templates` | AI alert template configs per asset | id, user_id, asset_id, template (t1/t2/t3/t4), enabled, htf, ltf, window_mins (default 60), step3_enabled, bias_gate, fvg_rule |
| `alert_history` | All fired alerts log | id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type |
| `candle_cache` | EBP Worker's last 3 candles per symbol/TF | symbol, timeframe (PK), bar_0 through bar_2 (open/high/low/close), bar_0_time, bar_1_time, updated_at |
| `sweep_candle_cache` | Sweep Worker's last 3 candles per symbol/TF | Identical structure to candle_cache; separate to avoid TF set conflicts |
| `bias_cache` | Cached TTrades bias result per symbol/TF | symbol, timeframe (PK), bias, closure_type, close_pos, bar1_time, updated_at |
| `swing_state` | Rolling swing high/low tracking per symbol/TF | symbol, timeframe (PK), run_direction, run_start, run_extreme, extreme_time, confirmed_swing_high, confirmed_swing_high_time, confirmed_swing_low, confirmed_swing_low_time, updated_at |
| `detected_fvgs` | Active and mitigated FVG zones | id, symbol, timeframe, direction, zone_low, zone_high, midpoint, formed_at, candle_time, mitigated, mitigated_at, mitigation_rule, expires_at, created_at |
| `chain_state` | In-progress multi-step template signal chains | id, user_id, asset_id, symbol, template, direction, current_step, htf_tf, ltf, htf_signal_time, ltf_sweep_time, expires_at, created_at |
| `pending_signals` | Legacy: HTF EBP signals awaiting LTF sweep (used by deprecated Combined alert system) | id, user_id, symbol, direction, signal_type, timeframe, fired_at, expires_at, consumed_pairs (JSON) |
| `payment_log` | UPI payment submissions and approvals | id, user_id, tier, amount_inr, upi_ref, status (pending/approved/rejected), submitted_at, approved_at, approved_by |
| `invite_tokens` | Single-use invite tokens for account creation | token (PK), created_at, used_by, used_at, active |
| `tier_config` | Admin-configurable tier pricing and asset limits | tier (PK), label, emoji, price_inr, asset_limit, updated_at — **Note:** not in schema.sql; created directly via D1 Console |
| `api_keys` | Twelve Data (and future) API key values | id, source, key_value, label, enabled, added_at, added_by |
| `api_key_state` | Per-key exhaustion and daily call counter | key_name (PK, refs api_keys.id), exhausted, exhausted_at, calls_today, reset_at (UTC midnight ms) |
| `api_call_log` | Per-call log for data source health dashboard | id, source, symbol, timeframe, called_at, success; retained for 48h (cleaned on M5 sweep cron) |
| `watchdog_log` | Planned for Watchdog Worker — **not yet created in schema.sql or deployed** | — |

---

## 5. Alert System

### 5.1 Live Alert Types

| Type | Logic | Status |
|---|---|---|
| EBP | Current candle sweeps prior candle's wick AND closes beyond prior candle's body; filtered against HTF TTrades bias | ✅ Live |
| Sweep | Current candle sweeps prior candle's wick AND closes back inside prior range (less strict than EBP — no body-close requirement); filtered against HTF bias | ✅ Live |
| MSS | Swing state machine detects close beyond a confirmed swing high (bullish) or swing low (bearish); fired on both EBP and Sweep timeframes | ✅ Live |
| T3 Chain | 3-step chain: HTF EBP (step 1) → LTF Sweep (step 2) → LTF MSS (step 3); completes within configurable window (default 60 min) | ✅ Live |
| Combined | HTF EBP + LTF Sweep fired within a window — original combined alert system | ❌ Deprecated (superseded by T3 template chain) |

### 5.2 Template System (AI Alerts)

| Template | Chain | Status |
|---|---|---|
| T3 | HTF EBP → LTF Sweep → LTF MSS | ✅ Built (step 1 fires in EBP Worker; steps 2 & 3 fire in Sweep Worker) |
| T1 | HTF FVG → Price at zone → LTF confirmation | 📋 Planned (requires wine tier; UI checkbox exists but backend not implemented) |
| T4 | HTF Sweep → HTF FVG pullback → LTF MSS | 📋 Planned (requires wine tier; UI checkbox exists but backend not implemented) |
| T2 | HTF EBP → LTF FVG retracement → LTF MSS | 📋 Planned (requires wine tier; UI checkbox exists but backend not implemented) |

T3 chain state flow:
- **Step 1 (current_step=2 after creation):** EBP Worker detects an HTF EBP signal, creates a `chain_state` row via `initiateT3Chain`. The chain expires after `window_mins` minutes.
- **Step 2 (current_step=3 after advance):** Sweep Worker detects a matching LTF Sweep with the same direction, calls `advanceT3Chain` to record the ltf_sweep_time.
- **Step 3 (chain deleted):** Sweep Worker detects a matching LTF MSS, fires the T3 alert via Telegram, writes to alert_history with `alert_type='t3'`, and deletes the chain_state row via `completeT3Chain`.

Tier requirements:
- **T3:** beer tier (₹249) or above
- **T1, T2, T4:** wine tier (₹499) or above

### 5.3 Bias Engine — HTF Pairing Table

The `BIAS_SOURCE` map defines which HTF timeframe provides the bias filter for each signal type and LTF:

```javascript
const BIAS_SOURCE = {
  ebp:      { 'M15': '4H', '1H': 'D', '4H': 'W', 'D': 'W', 'W': null },
  sweep:    { 'M5': '1H', 'M15': '1H', 'M30': '4H', '1H': 'D', '4H': 'W' },
  template: { 'W': null, 'D': 'W', '4H': 'D', '1H': '4H' },
};
```

`null` means no HTF bias filter applies (signal fires regardless). The effective bias respects per-asset manual overrides stored in `user_assets.bias_overrides` JSON; setting a TF to `'auto'` reverts to the live `bias_cache` value.

Alert modes per config row:
- **aligned:** only fire if signal direction matches the effective HTF bias
- **price_action:** fire regardless of bias but mark alignment in the Telegram message
- **all:** fire regardless of bias (no filter applied)

### 5.4 Telegram Alert Format

**EBP Alert example:**
```
🟢 BULLISH EBP — EUR/USD
⏱ Timeframe: M15
🕐 Candle: Jul 24, 02:30 PM NY
📊 Trend: bullish (4H bias) ✅
━━━━━━━━━━━━━━
Low swept: 1.08123
Closed above body: 1.08456
━━━━━━━━━━━━━━
EBP Tracker
```

**Sweep Alert example:**
```
🟢 BULLISH SWEEP — GBP/USD
⏱ Timeframe: 1H
🕐 Candle: Jul 24, 10:00 AM NY
📊 Trend: bullish (Daily bias) ✅
━━━━━━━━━━━━━━
Low swept: 1.27800
Closed inside: 1.27950
━━━━━━━━━━━━━━
EBP Tracker
```

**MSS Alert example:**
```
🟢 BULLISH MSS — XAU/USD
⏱ Timeframe: M15
🕐 Candle: Jul 24, 03:15 PM NY
📊 Trend: bullish (4H bias) ✅
━━━━━━━━━━━━━━
Swing high reclaimed: 2345.67800
━━━━━━━━━━━━━━
EBP Tracker
```

**T3 Chain Complete example:**
```
⛓ T3 Chain Complete — EUR/USD
Direction: 🟢 Bullish
Step 1 — 4H EBP: 24 Jul 2026 08:00:00
Step 2 — M15 Sweep: 24 Jul 2026 09:30:00
Step 3 — M15 MSS: 24 Jul 2026 10:15:00
```

All alerts use HTML parse mode (`parse_mode: 'HTML'`) with `disable_web_page_preview: true`.

---

## 6. Frontend

### 6.1 Tech Stack

| Item | Detail |
|---|---|
| Framework | React 18 (`react@^18`, `react-dom@^18`) |
| Build tool | Vite (latest) + `@vitejs/plugin-react` |
| Router | `react-router-dom@^6` |
| Auth | `@clerk/clerk-react` (latest) — JWT token obtained via `useAuth().getToken()` |
| CSS | Custom design system — plain CSS with CSS variables; no MUI, no Tailwind, no CSS-in-JS |
| Export | `xlsx@^0.18.5` — XLSX alert export from the Alerts page |
| Fonts | Manrope (sans-serif body), Outfit (monospace/headings) — Google Fonts |
| No icon library | No Heroicons, no MUI icons |

### 6.2 Pages

| Route | Page | Status |
|---|---|---|
| `/` | Landing (invite-gated) | ✅ Live — shows invite token prompt; Clerk sign-in |
| `/dashboard` | Dashboard | ✅ Live — asset search/add, AssetCard list, asset limit tracking |
| `/alerts` | Alerts | ✅ Live — alert history table, type/asset/direction/day filters, XLSX export |
| `/settings` | Settings | ✅ Live — account info, upgrade selector, data source health, Telegram connect |
| `/admin` | Admin | ✅ Live — 6 tabs: Users, Payments, Invite Tokens, Tier Config, API Keys, User Limits |
| `/upgrade` | Upgrade | ✅ Live — pricing cards, UPI payment submission flow |
| `/invite/:token` | Invite | ✅ Live — validates token, redirects to Clerk sign-up |

### 6.3 Design System

The CSS design system is derived from a Trade Journal project and implemented entirely in `frontend/src/styles/tokens.css` (CSS custom properties) and `frontend/src/styles/global.css` (all component styles).

**Typography:**
- `--font-sans: 'Manrope'` — body text, labels, paragraphs
- `--font-mono: 'Outfit'` — all UI chrome: nav items, card titles, badges, tables, page titles, inputs, buttons

**Colour palette (light/warm theme — no dark mode toggle; the design is intentionally warm/paper-toned):**
- `--paper: #f3ede3` — page background
- `--surface: #faf6ee` — card backgrounds
- `--cream: #eae2d4` — subtle alternates (config panels, table headers)
- `--ink: #0e0c0a` — primary text
- `--muted: #6b6050` — secondary/muted text
- `--border: #c4b9a4` — all borders
- `--bull: #0f3d1e` / `--bull-lt: #cce8d6` — bullish signal colours
- `--bear: #3d0f0f` / `--bear-lt: #ead0d0` — bearish signal colours
- `--gold: #7a5c00` / `--gold-lt: #f7e8c0` — index badges, MSS badges, upgrade locks
- `--nav-bg: #0f172a` — dark sidebar/topbar background (slate-900)
- `--nav-active-accent: #38bdf8` — active nav highlight (sky-400)

**Component patterns:** cards with `1.5px` warm border, `font-mono` badge chips, inline config panels (indented, cream background), select dropdowns with custom SVG caret, progress bars, filter tab groups, spinner animation, skeleton loading, modal overlays, dark topbar + dark sidebar with per-nav accent colours.

**Responsive:** Sidebar collapses to icon-only at 860px; full mobile layout at 640px (56px icon sidebar, full-width shell).

### 6.4 Asset Card

Each asset is rendered as an `AssetCard` component with the following structure:

**Header row:** `symbol` (Outfit font, bold) + asset type badge (colour-coded: forex=blue, crypto=purple, index=gold, nse=green, commodity=yellow, equity=light green, etf=amber) + remove button (✕, top-right)

**Last alert indicator:** clickable link showing `DIRECTION ALERT_TYPE TIMEFRAME — timestamp` (navigates to /alerts page)

**EBP Alerts section:**
- Checkbox to enable/disable EBP alerts for this asset
- When enabled: "Override Bias" toggle button → reveals `BiasOverridePanel` (per-TF dropdowns: W, D, 4H, 1H; options: Auto / Bullish / Bearish / Neutral)
- `EBPConfigPanel`: per-row config (TF select from [M15, 1H, 4H, D, W], alert mode select, live bias label showing cached HTF bias, delete button); "+ Add EBP Alert" link

**Sweep Alerts section:**
- Checkbox to enable/disable Sweep alerts
- `SweepConfigPanel`: same structure as EBP panel but TF options are [M5, M15, M30, 1H, 4H]

**AI Alerts section:**
- Checkbox to enable/disable AI alerts
- `AIAlertsPanel`: lists T1, T2, T3, T4 templates with lock icons for tier requirements; T3 available at beer+, T1/T2/T4 require wine+

---

## 7. Cron Schedule

All scheduling is via cron-job.org HTTP POST requests. Each job sends `{ "tf": "<timeframe>" }` in the request body with `X-Cron-Secret` header. Native Cloudflare cron triggers are commented out in both `wrangler.toml` files.

| Job | Worker | TF | Schedule (UTC) | HTTP endpoint |
|---|---|---|---|---|
| EBP M15 | EBP Worker | M15 | Every 15 min | POST /cron/ebp |
| EBP 1H | EBP Worker | 1H | Every 60 min (at :00) | POST /cron/ebp |
| EBP 4H | EBP Worker | 4H | Every 4 hours | POST /cron/ebp |
| EBP D | EBP Worker | D | 21:00 UTC Mon–Fri | POST /cron/ebp |
| EBP W | EBP Worker | W | 21:00 UTC Friday | POST /cron/ebp |
| Sweep M15 | Sweep Worker | M15 | Every 15 min | POST /cron/sweep |
| Sweep M30 | Sweep Worker | M30 | Every 30 min | POST /cron/sweep |
| Sweep 1H | Sweep Worker | 1H | Every 60 min (at :00) | POST /cron/sweep |
| Sweep 4H | Sweep Worker | 4H | Every 4 hours | POST /cron/sweep |
| Watchdog | Watchdog Worker | — | Every 30 min | Not yet deployed |

**DST note:** The EBP D (21:00 UTC Mon–Fri) and EBP W (21:00 UTC Friday) jobs are timed to correspond to the 4pm NY close (21:00 UTC in winter / 20:00 UTC in summer). These jobs must be manually updated on cron-job.org each March (clocks forward → change to 20:00 UTC) and each November (clocks back → change back to 21:00 UTC).

**M5 Sweep cleanup:** Although M5 is a valid TF in the sweep endpoint, it is not currently deployed as a cron-job.org job. The cleanup tasks (expiring pending_signals, FVGs, chain_state, api_call_log) that would run on M5 instead run incidentally on the M15 or another low-TF job. When M5 is activated, it becomes the dedicated cleanup runner.

---

## 8. Infrastructure

| Component | Service | Cost |
|---|---|---|
| Frontend | Cloudflare Pages | $0 |
| EBP Worker | Cloudflare Workers (free tier) | $0 |
| Sweep Worker | Cloudflare Workers (free tier) | $0 |
| Database | Cloudflare D1 (free tier) | $0 |
| Auth | Clerk (free tier) | $0 |
| Cron scheduling | cron-job.org (free tier) | $0 |
| Price data | Twelve Data (3 × free tier accounts) | $0 |
| Price fallback | Yahoo Finance (public API, no key) | $0 |
| Alerts | Telegram Bot API (@EbP_Tracker_bot) | $0 |
| **Total** | | **$0/month** |

**Combined Twelve Data daily capacity:** 3 keys × 800 credits/day = 2,400 credits/day. Each candle fetch = 1 credit per symbol per TF. The full key state (calls_today, exhausted, reset_at) is visible in real time via the Settings → Data Sources panel and Admin → API Keys tab.

---

## 9. Known Issues and Limitations

1. **`tier_config` table missing from `schema.sql`:** The Admin Tier Config panel (and `/admin/tiers`, `/admin/approve/:id`, `/tiers` routes) all depend on this table, but it was created directly via the D1 Console rather than added to schema.sql. Running `schema.sql` on a fresh database will miss this table. Manual SQL insert required: `CREATE TABLE tier_config (tier TEXT PRIMARY KEY, label TEXT, emoji TEXT, price_inr INTEGER, asset_limit INTEGER, updated_at INTEGER)`.

2. **Yahoo Finance 4H limitation:** `toYahooInterval('4H')` maps to `'1h'` because Yahoo Finance free tier does not expose a 4H interval. When Twelve Data keys are exhausted, 4H candle data fetched from Yahoo will be 1-hour candles, making EBP/Sweep signals on 4H unreliable.

3. **Symbol validation always returns `valid: true` on Yahoo failure:** In `validateSymbol()`, if Yahoo Finance returns no data, the fallback returns `{ valid: true, source: 'fallback' }`. This can allow unrecognised symbols to be added to user_assets.

4. **Legacy columns in `user_assets`:** The table still holds `timeframes`, `ebp_alert_mode`, `sweep_enabled`, `sweep_timeframes`, `sweep_alert_mode`, `combined_enabled`, `combined_pairs`, `combined_window_mins` from the old system, pre-dating the migration to `user_ebp_configs`/`user_sweep_configs` (commit `7c49ea9`). These columns are no longer read by cron handlers but remain in the schema.

5. **T1, T2, T4 templates are UI-only:** The AI Alerts panel renders checkboxes and saves `user_templates` rows for T1, T2, and T4, but the EBP Worker and Sweep Worker have no backend logic to process these templates. Enabling them has no effect on alerts until the backend is built.

6. **Combined alert system deprecated but not removed:** `formatCombinedAlert`, `checkPendingSignals`, `consumePendingSignal`, and `cleanupExpiredSignals` remain in `sweep-cron.js`. The `pending_signals` table still exists. However, no code in the current cron handlers writes to `pending_signals` or fires combined alerts — the T3 chain system replaces this mechanism entirely.

7. **`/sweep/dashboard` dynamic import fragility:** The `/sweep/dashboard` route in `sweep-worker/src/index.js` uses `const { detectSweep } = await import('./sweep.js')` — a dynamic import of a file that does not appear to exist in the codebase. This route will throw at runtime if called.

8. **`watchdog_log` table not in schema or codebase:** The Watchdog Worker is referenced in the cron schedule but has no corresponding Worker code, `wrangler.toml`, or D1 table.

9. **DST requires manual cron-job.org updates:** The EBP D and EBP W cron jobs must be manually changed on cron-job.org each March and November to stay aligned with the NY 4pm daily close.

10. **`TWELVE_DATA_API_KEY` worker secret may be stale:** The `validateSymbol()` function accepts an `apiKey` parameter but the current implementation only uses Yahoo Finance for validation (not Twelve Data). The secret is still referenced in the POST `/user/assets` route call (`validateSymbol(symbolStr, env.TWELVE_DATA_API_KEY)`) but the parameter is unused. Keys are now fully managed via D1.

---

## 10. Pending Work

### Immediate
- Deploy the Watchdog Worker and create the `watchdog_log` table in schema.sql
- Add `tier_config` CREATE TABLE to schema.sql so fresh deployments work correctly
- Fix the `/sweep/dashboard` dynamic import (`./sweep.js` — file does not exist; `detectSweep` is already inlined in `sweep-cron.js`)
- Activate the M5 Sweep cron-job.org job (the logic already runs when tf=M5)

### Phase Completion

| Phase | Status |
|---|---|
| Pre-Phase (Infrastructure — Cloudflare Workers, D1, Clerk, Telegram, cron-job.org) | ✅ Complete |
| Phase 1 (FVG Engine — detectFVG, processFVGs, detected_fvgs table, mitigation rules) | ✅ Complete (backend); ❌ Not surfaced in UI |
| Phase 1.5 + 2 (Swing State + MSS Detection — updateSwingState, detectMSS, swing_state table, MSS Telegram alerts) | ✅ Complete |
| Phase 3 — T3 Template (chain_state, initiateT3Chain, advanceT3Chain, completeT3Chain, T3 Telegram alert) | ✅ Complete |
| Phase 3 remaining (T1, T4, T2 templates — backend signal logic) | ❌ Not built |
| Phase 4 (UI/UX — Admin API key management, user asset limits, tier config, CSS redesign) | ✅ Substantially complete; minor items outstanding |

### Deferred
- FVG zone visualisation in the frontend UI (data is tracked in D1 but not displayed)
- T1 template backend: HTF FVG detection → price-at-zone check → LTF confirmation
- T4 template backend: HTF Sweep → HTF FVG pullback → LTF MSS
- T2 template backend: HTF EBP → LTF FVG retracement → LTF MSS
- Watchdog Worker: health-check the cron execution cadence and alert developer if jobs go silent
- Removing legacy `user_assets` columns (`timeframes`, `sweep_enabled`, etc.) after confirming no reads depend on them
- Proper M5 sweep cron-job.org activation

---

## 11. Environment Variables and Secrets

### EBP Worker Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `CLERK_SECRET_KEY` | Clerk API secret for JWKS retrieval during JWT verification |
| `SHARED_BOT_TOKEN` | Telegram Bot API token for @EbP_Tracker_bot |
| `CRON_SECRET` | Shared secret sent in `X-Cron-Secret` header by cron-job.org jobs |
| `DEVELOPER_TELEGRAM_CHAT_ID` | Developer's Telegram chat ID for payment submission notifications |
| `APP_URL` | Base URL for invite links (optional; defaults to `https://ebp-tracker.pages.dev`) |
| `TWELVE_DATA_API_KEY` | Legacy residual — no longer used functionally (keys are D1-managed). May be safe to remove. |

### Sweep Worker Secrets (set via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `CLERK_SECRET_KEY` | Clerk JWT verification for authenticated sweep routes |
| `SHARED_BOT_TOKEN` | Telegram Bot API token (same bot as EBP Worker) |
| `CRON_SECRET` | Shared secret for cron-job.org HTTP trigger security |

### Frontend Environment Variables (Cloudflare Pages environment)

| Variable | Purpose |
|---|---|
| `VITE_WORKER_URL` | EBP Worker base URL (optional; defaults to `https://ebp-tracker-worker.aicube-apps.workers.dev`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key for `@clerk/clerk-react` initialisation |

---

## 12. Deployment Commands

```bash
# EBP Worker
cd worker && npx wrangler deploy

# Sweep Worker
cd sweep-worker && npx wrangler deploy

# Frontend (Cloudflare Pages via git push)
cd frontend && npm run build
# Build is automatic on push to main via Cloudflare Pages GitHub integration.
# Manual deploy:
git add . && git commit -m "message" && git push origin main

# D1 Schema (run once on fresh DB, or run new statements manually in D1 Console)
npx wrangler d1 execute ebp-tracker-db --file=schema.sql --remote

# Set a worker secret
npx wrangler secret put SHARED_BOT_TOKEN --name ebp-tracker-worker
npx wrangler secret put SHARED_BOT_TOKEN --name sweep-detector
```

---

## 13. Recent Changes Log

Based on `git log --oneline -10` as of 2026-07-24:

1. **`5f07390` — D1-backed API key management, asset cap, Twelve Data symbol validation**
   Moved Twelve Data API keys from Wrangler secrets into the D1 `api_keys` / `api_key_state` tables so they can be managed at runtime via the Admin panel (add/enable/disable/delete). Added per-user `asset_limit` enforcement enforced on POST `/user/assets` (returns 403 with `asset_limit_reached` error). Symbol validation on asset add now goes through Twelve Data's `symbol_search` endpoint with a Yahoo fallback; added `/user/assets/validate` endpoint accessible to authenticated users.

2. **`08b80c8` — Replace Finnhub with 3-key Twelve Data rotation + Yahoo fallback**
   Removed Finnhub as the primary price data source entirely. Replaced with `fetchTwelveDataWithRotation()` — a key rotation loop that selects the next non-exhausted Twelve Data key from D1, marks exhausted keys until UTC midnight, and falls through to `fetchYahooFinance()` when all keys are spent. This change introduced `api_keys`, `api_key_state`, and `api_call_log` tables and the `/health/datasources` endpoint.

3. **`55a5735` — Migrate EBP Worker off Cloudflare native crons onto cron-job.org HTTP triggers**
   Removed the `[triggers] crons = [...]` block from `worker/wrangler.toml`. Added POST `/cron/ebp` route secured by `X-Cron-Secret` header. Each cron-job.org job now calls this endpoint with `{ "tf": "<timeframe>" }` in the body, eliminating reliance on Cloudflare's free-tier cron execution (which was unreliable at scale).

4. **`0b252c9` — Normalise bare forex/crypto symbols so candle fetches actually resolve**
   Added `normaliseSymbol()` function to both workers. Bare 6-character pairs like `EURUSD` or `XAUUSD` were failing on Twelve Data and Yahoo because those APIs expect slash-separated format. Now converts to `EUR/USD`, `XAU/USD` etc. on the way in, before any data source call.

5. **`09ae22c` — Graceful health/datasources fallback, api_call_log retention cleanup**
   Made the `/health/datasources` endpoint return an empty-state object (all zeros) instead of a 500 error when api_call_log is empty or queries fail. Added api_call_log cleanup to the M5 sweep cron (deletes rows older than 48h) to prevent unbounded table growth.

6. **`d237665` — Asset type classification via Yahoo instrumentType, mobile responsive CSS**
   The symbol validation endpoint now reads `result.meta.instrumentType` from the Yahoo Finance chart API response to classify asset type (forex, crypto, equity, index, etc.) rather than guessing from symbol format alone. Added mobile-responsive CSS breakpoints for the sidebar and card layouts.

7. **`f946a23` — Full CSS redesign — drop MUI, port Trade Journal design system**
   Removed Material UI entirely. Replaced with a custom CSS design system ported from a Trade Journal project: Manrope + Outfit fonts, warm paper/cream/ink palette, dark sidebar, CSS custom properties in `tokens.css`, all component styles in `global.css`. No external UI library dependencies in the frontend.

8. **`e098d5a` — Require auth on GET /user/assets/validate**
   The `/user/assets/validate` endpoint was accidentally public (no auth check), allowing unauthenticated callers to consume Twelve Data quota via symbol searches. Added Clerk JWT verification requirement.

9. **`41b4c59` — Full UI rebuild — Dashboard search/add flow, AssetCard sections, Alerts + Settings rework**
   Rebuilt the Dashboard with a search input + "Add" button flow with real-time symbol validation feedback, asset slot counter, and plan-expiry overlay. Rebuilt AssetCard with three collapsible sections (EBP Alerts, Sweep Alerts, AI Alerts) and the BiasOverridePanel. Rebuilt Alerts page with type/asset/direction/day filter tabs and XLSX export. Rebuilt Settings with Telegram connection flow (4-digit code + polling), account details, and data source health display.

10. **`7c49ea9` — Refactor: migrate cron handlers to read from user_ebp_configs/user_sweep_configs**
    Changed EBP Worker's `handleEBPCron` and Sweep Worker's `handleSweepCron` to query the new `user_ebp_configs` / `user_sweep_configs` tables (keyed by timeframe and enabled flag) rather than the legacy `user_assets.timeframes` JSON column. This enables per-timeframe enable/disable and per-timeframe alert mode without touching the asset row itself.

---

*Report generated by Claude Code — based on live codebase audit of commit `5f07390` (2026-07-24)*
*For planning and architecture decisions, refer to planning chat*
