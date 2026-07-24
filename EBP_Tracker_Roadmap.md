# EBP Tracker — Project Roadmap v2.0

**Updated:** July 2026
**Previous version:** Roadmap v1.0 (July 2026)
**Technical Reference:** EBP_Tracker_Technical_Reference.md (v2.1 — needs regeneration, see Immediate Fixes)
**Repository:** github.com/aicubeapps/EBP_TRACKER
**Live site:** ebp-tracker.pages.dev

---

## Implementation Protocol

| Context | Tool |
|---|---|
| Planning, architecture, roadmap decisions | This chat (Claude.ai) |
| All implementation | Claude Code in VS Code |
| Real-world signal verification | Manual — TradingView / broker cross-reference |

---

## Status Legend

- ✅ Live in production
- 📋 Planned — not started
- ⏸ Deferred indefinitely
- ❌ Cancelled / superseded

---

## What Is Live (as of 2026-07-25)

| Item | Status |
|---|---|
| EBP alerts (M15/1H/4H/D/W), HTF bias gated | ✅ |
| Sweep alerts (M15/M30/1H/4H), HTF bias gated | ✅ |
| MSS alerts — fires on both EBP and Sweep TFs | ✅ |
| T3 chain (HTF EBP → LTF Sweep → LTF MSS) | ✅ |
| FVG engine backend (detected_fvgs, mitigation) | ✅ |
| Swing state engine (swing_state table) | ✅ |
| Twelve Data 3-key rotation (2,400 credits/day, D1-managed) | ✅ |
| Yahoo Finance fallback | ✅ |
| Per-TF EBP/Sweep configs (user_ebp_configs / user_sweep_configs) | ✅ |
| bias_cache, api_keys, api_key_state, api_call_log tables | ✅ |
| Frontend custom CSS design system (Manrope + Outfit, warm palette) | ✅ |
| All pages (Dashboard / Alerts / Settings / Admin) | ✅ |
| Clerk auth, Telegram bot + 4-digit pairing | ✅ |
| 9 cron-job.org jobs (EBP×5, Sweep×4), HTTP POST, X-Cron-Secret | ✅ |
| Admin Price Feed panel (WebSocket, 1-symbol Basic plan) | ✅ |
| Combined alert system | ❌ Deprecated — superseded by T3. Dead code pending cleanup. |
| Upgrade page / tier UI | ❌ Removed from frontend. Backend routes pending Worker deploy. |

---

## Deployment Status (as of 2026-07-25)

| Component | Deployed commit | Repo HEAD | Status |
|---|---|---|---|
| Frontend (CF Pages) | f3ba615 | f3ba615 | ✅ Up to date |
| EBP Worker | 5f07390 (2026-07-24 06:05 UTC) | 6122bb1 | ⚠️ Pending deploy |
| Sweep Worker | 5f07390 (2026-07-24 06:00 UTC) | f3ba615 | ✅ Up to date |
| D1 migration 003 | Not run | — | ⚠️ Pending — blocker below |

### ⚠️ Pending Deployment — Ordered Sequence

**Step 1 — Fix pending_signals blocker in Sweep Worker:**
`sweep-worker/src/sweep-cron.js` lines 489/519/525/530 and `sweep-worker/src/sweep.js` lines 126/158/172/181 still actively read/write `pending_signals`. Migration 003 drops this table. Must remove all `pending_signals` references from Sweep Worker code before running migration — otherwise every sweep cron run will throw SQL errors against a missing table.

**Step 2 — Deploy EBP Worker:**
```powershell
cd worker; npx wrangler deploy
```
Ships commit `6122bb1`: new-user `asset_limit=5` default, payment/tier route removal.

**Step 3 — Run D1 migration 003:**
```powershell
npx wrangler d1 execute ebp-tracker-db --remote --file=migrations/003_drop_tier_tables.sql
```
Drops `payment_log`, `tier_config`, `pending_signals` (safe only after Step 1).

**Step 4 — Verify:**
- Removed routes return 404/405 in production
- New user signup gets `asset_limit = 5`
- Sweep cron runs clean post-migration (check Telegram alerts still firing)

---

## Subscription Model (Revised — Tiers Dropped)

All beverage tiers eliminated. Every user gets the same feature access.

| Asset type | Default slots | Unlock |
|---|---|---|
| Forex / Crypto | 5 | Admin raises per-user via dropdown (IRL $30.00 payment) |
| Indian markets (NSE/BSE) | Unlimited | No gate |

**$30.00 unlock banner:** When user hits forex/crypto slot limit:
> *"Pay $30.00 to unlock more assets. This is for server maintenance and data access."*

Dismissible. No payment UI. User and admin settle IRL.

**Admin slot control:** Per-user dropdown (5 / 10 / 15 / 20 / Unlimited). View-only asset list per user.

**Historical tier data:** `tier_config` and `payment_log` tables being dropped (migration 003).

---

## Immediate Fixes 📋

1. **Fix `pending_signals` in Sweep Worker** ← blocker for migration 003. Remove all references from `sweep-cron.js` and `sweep.js`. Deploy Sweep Worker after.
2. **Fix `/sweep/dashboard` broken import** — `./sweep.js` does not exist. One-line fix.
3. **Remove legacy `user_assets` columns** — `timeframes`, `ebp_alert_mode`, `sweep_enabled` etc. Confirm no frontend reads, then drop.
4. **Regenerate Technical Reference v2.2** — v2.1 is stale. Regenerate from live codebase before building new phases.

*Note: `tier_config` schema fix and M5 cron activation moved to Phase A and deployment steps respectively.*

---

## Phase A — Asset Slot Control + $30 Banner + Admin Controls 📋

**Status:** Partially live in frontend (f3ba615). EBP Worker backend pending deploy (6122bb1).

### Backend (pending — deploy after Immediate Fix Step 1)
- Universal `asset_limit` default = 5 on new user creation ← in 6122bb1, not yet deployed
- Asset add route checks only `asset_limit`, no tier logic ← in 6122bb1, not yet deployed
- New `user_tf_access` JSON column on `users` table — array of enabled TFs per user. Default: all enabled.
- Cron handlers check `user_tf_access` before allowing config to fire

### Frontend (live in f3ba615)
- Dismissible $30.00 banner on `asset_limit_reached` 403
- Dashboard section headers: "Forex & Crypto" and "NSE Market"
- NSE Market placeholder with "Add Share Market Asset" button (UI only)
- Logo top of sidebar, all pages
- Last API call pill (NY + IST timestamps, no interaction)
- Upgrade page removed, tier references removed from Settings

### Still pending in frontend
- Admin Users tab: per-user asset list (view only) + slot limit dropdown + TF access checkboxes
- `user_tf_access` backend route + enforcement

**Estimated time (Claude Code):** 0.5 day remaining

---

## Phase B — Admin Price Feed Panel (WebSocket) ✅

**Complete.** Twelve Data OHLC validated against TradingView and broker feed (5ers + IC Markets) across EUR/USD, GBP/USD, USD/CHF, USD/CAD, EUR/CHF, GBP/CHF, GBP/JPY, EUR/JPY via M15 bot alerts. Pipette-level accuracy confirmed.

**WebSocket note:** Basic plan limited to 1 simultaneous symbol subscription. Panel retained for admin spot-checks. Multi-symbol validation done via live bot alerts cross-referenced against TradingView.

**Twelve Data locked in as confirmed long-term primary for forex/crypto.**

---

## Phase C — Twelve Data Asset Browser 📋

Replace manual symbol entry with curated browsable list of Twelve Data free-tier symbols.

### Backend
- `GET /assets/catalogue` — fetches and caches forex/crypto symbol lists from Twelve Data
- `symbol_catalogue` D1 table, 24-hour TTL, refreshed on daily EBP cron

### Frontend
- Searchable modal replacing text input for forex/crypto add flow
- Forex tab: filter by major/minor/exotic
- Crypto tab: filter by exchange
- One-tap add — no validation call needed

**Estimated time (Claude Code):** 1–2 days

---

## Phase D — Indian Market Section (NSE/BSE) 📋

### Architecture
- Dedicated `nse-detector` Worker (`nse-worker/src/index.js`, `nse-worker/wrangler.toml`)
- Separate cron jobs for NSE TFs: M1, M5, M15, M30, 1H, D (6 new cron-job.org jobs)
- Shared D1 database — new `nse_candle_cache` table, separate from `candle_cache`
- Isolated from forex/crypto signal engine — clean sandbox for Indian market logic and indicator testing

### Data source — Upstox Analytics Token
- Token stored in D1 `api_keys` table — admin pastes via Admin panel API Keys tab
- Shows created_at, expiry (created_at + 1 year), warning badge within 30 days of expiry
- Activates immediately when token is saved — no code deployment needed
- Fallback: Yahoo Finance (auto-activates when token absent, expired, or call fails)
- UI labels NSE section as "~15 min delayed" when on Yahoo fallback

### Timeframes
M1, M5, M15, M30, 1H, D — 4H and W excluded (Yahoo fallback has no true 4H)

### Dashboard
- "NSE Market" section (placeholder already live in f3ba615)
- Delay label when Upstox token not configured

### Slot counting
NSE assets: unlimited, not counted against forex/crypto limit

### Prerequisite
No Upstox account required to build — system built Upstox-ready, Yahoo runs until token added

**Estimated time (Claude Code):** 1–2 days

---

## Phase E — T1 Template Backend 📋

**Chain:** HTF FVG (unmitigated) → price at zone → LTF MSS/Sweep confirms → alert + Signal ID

- `initiateT1Chain` — EBP Worker, triggers on new unmitigated FVG
- `advanceT1Chain` — Sweep Worker, triggers when `isPriceInFVG`
- `completeT1Chain` — Sweep Worker, triggers on LTF MSS or Sweep in FVG direction
- Signal ID generated at completion: `T1-{PAIR}-{SERIES}{COUNT}`
- `fvg_id` FK on `chain_state` already exists

**Estimated time (Claude Code):** 1–2 days

---

## Phase F — T4 Template Backend 📋

**Chain:** HTF Sweep → HTF FVG pullback → LTF MSS → alert + Signal ID

Depends on Phase E (shares FVG zone detection logic).

**Estimated time (Claude Code):** 1 day

---

## Phase G — T2 Template Backend 📋

**Chain:** HTF EBP → LTF FVG on retracement → price at LTF FVG → LTF MSS → alert + Signal ID

Most complex. `chain_state` must carry EBP timestamp — only post-EBP FVGs qualify.
Depends on Phases E and F.

**Estimated time (Claude Code):** 2 days

---

## Phase I — Trade Journal Signal Integration 📋

**Purpose:** Link EBP Tracker signals to Trade Journal trade outcomes for win rate and R-multiple analysis per template over time. Side quest — does not block any other phase.

**The Trade Journal is the analytics hub.** EBP Tracker generates and stores signals. Trade Journal links them to trade outcomes at closure. User discretion applies — not all signals will be traded.

### Signal ID Format (locked)
`{TEMPLATE}-{PAIR}-{SERIES}{COUNT}`

Examples: `T3-EURUSD-A001` · `T3-GBPUSD-A002` · `T4-XAUUSD-A001`

Rules:
- Template prefix: T1 / T2 / T3 / T4
- Pair: uppercase, no slash (EUR/USD → EURUSD)
- Series: A–Z, resets count to 001 on advance
- Count: 001–999 per series
- Counter is **per template globally** (not per symbol) — one counter shared across all pairs for that template
- 26,000 signals per template before series exhausts (A001→Z999)

### New D1 Tables

```sql
CREATE TABLE IF NOT EXISTS signals (
  signal_id      TEXT PRIMARY KEY,
  template_type  TEXT NOT NULL,  -- 'T1' | 'T2' | 'T3' | 'T4'
  symbol         TEXT NOT NULL,  -- e.g. 'EURUSD'
  htf_tf         TEXT,
  ltf_tf         TEXT,
  direction      TEXT,           -- 'bullish' | 'bearish'
  fired_at       TEXT NOT NULL,  -- ISO 8601 UTC
  traded         INTEGER DEFAULT 0  -- 0 = not linked, 1 = linked to Journal trade
);

CREATE TABLE IF NOT EXISTS signal_counters (
  template  TEXT PRIMARY KEY,   -- 'T1' | 'T2' | 'T3' | 'T4'
  series    TEXT DEFAULT 'A',   -- current series letter A–Z
  count     INTEGER DEFAULT 0   -- current count within series (1–999)
);
```

### EBP Worker Changes
- `generateSignalId(template, symbol)` — increments `signal_counters`, formats ID
- Counter logic: count++ → if count > 999, series++ and count = 1
- Insert into `signals` table at alert fire time (before Telegram send)
- Append to Telegram message: `🔗 Signal ID: T3-EURUSD-A001`
- New route: `GET /signals/:id` — returns signal JSON, requires `X-Journal-Secret` header
- New route: `PATCH /signals/:id/traded` — sets `traded = 1`, requires `X-Journal-Secret`
- OPTIONS preflight handler for both routes (CORS — Trade Journal is a browser app)
- New Wrangler secret: `JOURNAL_API_SECRET` (32+ char random string)

### Which templates get Signal IDs
| Template | Signal ID | When |
|---|---|---|
| T3 | ✅ | Already live in prod — add Signal ID in this phase |
| T4 | ✅ | Add Signal ID when T4 backend built (Phase F) |
| T1 | 📋 | Add Signal ID when T1 backend built (Phase E) |
| T2 | 📋 | Add Signal ID when T2 backend built (Phase G) |

### Trade Journal side (for awareness — built separately)
- New Supabase columns on `trades`: `signal_id TEXT`, `signal_data JSONB`
- Intraday Close Modal: "Was this signal-based?" → Signal ID input → fetch + display signal summary
- On save: store signal_id + signal_data, call `PATCH /signals/:id/traded`
- Settings: EBP Integration card (Worker URL + API Secret input + Test Connection button)

### Verification checklist
- [ ] T3 alert fires → row in `signals` D1 with correct fields
- [ ] Telegram message includes Signal ID line
- [ ] `GET /signals/:id` with correct secret → 200 + JSON
- [ ] `GET /signals/:id` with wrong secret → 401
- [ ] `GET /signals/INVALID` → 404
- [ ] `PATCH /signals/:id/traded` → `traded` flips to 1
- [ ] OPTIONS preflight → correct CORS headers

**Estimated time (Claude Code):** 0.5–1 day

---

## Phase H — Watchdog Worker 📋

**Now unblocked** — Twelve Data confirmed reliable via Phase B IRL validation.
Build after Phase G (templates complete).

### Spec
- Worker: `ebp-watchdog`, `watchdog-worker/src/index.js`
- Cloudflare native cron `*/30 * * * *`
- Staleness check: `candle_cache` + `sweep_candle_cache` `updated_at` vs interval + 2 min tolerance
- `watchdog_log` D1 table, 7-day retention
- Consolidated Telegram alert to `@EBP_Watchdog_bot`

### Staleness thresholds

| TF | Max staleness |
|---|---|
| M1 | 2 min |
| M5 | 7 min |
| M15 | 17 min |
| M30 | 32 min |
| 1H | 62 min |
| 4H | 242 min |
| D | 1442 min |
| W | 10082 min |

### Open decisions before build
1. **Commodity pip tolerances** — WTI, XAG, BRENT. Park until Twelve Data free tier adds commodity support.
2. **Price drift source** — Twelve Data REST `/price` vs WebSocket tick. Decide at build time.

**Estimated time (Claude Code):** 1–2 days

---

## Infrastructure (Final)

| Component | Service | Cost |
|---|---|---|
| Frontend | Cloudflare Pages | $0 |
| EBP Worker | Cloudflare Workers | $0 |
| Sweep Worker | Cloudflare Workers | $0 |
| NSE Worker (Phase D) | Cloudflare Workers | $0 |
| Watchdog Worker (Phase H) | Cloudflare Workers | $0 |
| Database | Cloudflare D1 | $0 |
| Auth | Clerk | $0 |
| Forex/Crypto primary | Twelve Data (3-key rotation, 2,400 credits/day) | $0 |
| Forex/Crypto fallback | Yahoo Finance | $0 |
| NSE/BSE primary | Upstox Analytics Token (when configured) | $0 |
| NSE/BSE fallback | Yahoo Finance | $0 |
| User alerts | @EbP_Tracker_bot | $0 |
| Dev monitoring | @EBP_Watchdog_bot (Phase H) | $0 |
| Cron scheduling | cron-job.org (15 jobs after NSE) | $0 |
| **Total** | | **$0/month** |

---

## Build Sequence

```
Immediate Fixes (pending_signals blocker, broken import, legacy columns, tech ref)
    ↓
Deployment: EBP Worker (6122bb1) + D1 migration 003
    ↓
Phase A — Admin TF control + user_tf_access (remaining backend)
    ↓
Phase C — Twelve Data asset browser
    ↓
Phase D — NSE Worker + Upstox/Yahoo
    ↓
Phase E — T1 template backend + Signal ID
    ↓
Phase I — Trade Journal signal integration (T3 Signal ID retrofit + routes)
    ↓
Phase F — T4 template backend + Signal ID
    ↓
Phase G — T2 template backend + Signal ID
    ↓
Phase H — Watchdog Worker
```

---

## Timeline Estimate

| Phase | Claude Code | Calendar (part-time) |
|---|---|---|
| Immediate Fixes + Deploy | 0.5 day | 2–3 days |
| Phase A remaining | 0.5 day | 2–3 days |
| Phase C | 1–2 days | 1–2 weeks |
| Phase D | 1–2 days | 1–2 weeks |
| Phase E | 1–2 days | 1–2 weeks |
| Phase I | 0.5–1 day | 3–5 days |
| Phase F | 1 day | 1 week |
| Phase G | 2 days | 1–2 weeks |
| Phase H | 1–2 days | 1–2 weeks |
| **Total** | **8–13 days** | **7–12 weeks** |

---

## Deferred / Cancelled

| Item | Decision |
|---|---|
| Tier model (Chai/Coffee/Beer/Wine/Whiskey) | Dropped entirely |
| Tier-based TF gating | Dropped — admin controls per-user TF access individually |
| Commodity pip tolerances | Parked — revisit only if Twelve Data adds commodity support |
| Oracle Cloud VM + IC Markets bridge | Deferred indefinitely |
| Order Blocks | Dropped |
| MetaTrader / MT5 data feed | Rejected — requires persistent VPS |
| Fully arbitrary alert rule builder | Rejected |
| Finnhub as primary | Never implemented |
| Combined alert system | Deprecated — superseded by T3 |
| FVG zone visualisation in UI | Deferred |
| Twelve Data indicators via API | Rejected — compute from OHLC |
| Breeze (ICICI) for NSE | Rejected — daily manual token refresh |
| Angel One SmartAPI for NSE | Rejected — daily TOTP, broken refresh flow |
| Dhan for NSE | Rejected — ₹499/month Data API |
| Zerodha Kite Connect for NSE | Rejected — ₹500/month |
| Fyers for NSE | Rejected — daily OAuth redirect |

---

## Open Decisions

1. **Commodity pip tolerances** — WTI, XAG, BRENT. Pin before Phase H. Conditioned on Twelve Data free tier adding commodity support.
2. **Watchdog price drift source** — REST `/price` vs WebSocket tick. Decide at Phase H build time.

---

## Closed Decisions

| Decision | Resolution |
|---|---|
| Twelve Data as primary | ✅ Confirmed — OHLC validated vs TradingView + 5ers + IC Markets. Pipette accuracy. Closed. |
| WebSocket multi-symbol | Basic plan = 1 symbol. Validation done via bot alerts cross-ref TradingView. Closed. |
| MSS definition | TTrades fractal style — live in production. Closed. |
| Finnhub as primary | Never built. Twelve Data confirmed. Closed. |
| Combined alert | Deprecated. Superseded by T3. Closed. |
| Tier model | Dropped. Flat model: 5 forex/crypto slots, unlimited NSE. Closed. |
| NSE data source | Upstox Analytics Token (D1-managed, admin pastes). Yahoo fallback. Closed. |
| NSE broker evaluation | All evaluated (Breeze/Angel One/Dhan/Zerodha/Fyers/Upstox). Upstox wins. Closed. |
| NSE data build | Through EBP Tracker alerts only. No export feature. Closed. |
| NSE Worker architecture | Dedicated `nse-detector` Worker. Separate cron jobs. Shared D1. Closed. |
| Signal ID format | `{TEMPLATE}-{PAIR}-{SERIES}{COUNT}`. Per-template global counter. A001→Z999. Closed. |
| Signal analytics home | Trade Journal is analytics hub. EBP Tracker stores signals only. Closed. |
| Watchdog timing | Now unblocked after Phase B. Build after Phase G. Closed. |

---

*Roadmap version 2.0 — July 2026*
*All implementation via Claude Code. Planning maintained in this chat only.*
