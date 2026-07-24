# EBP Tracker — Technical Reference v2.2

**Generated:** 2026-07-24
**Repository:** github.com/aicubeapps/EBP_TRACKER
**Live site:** ebp-tracker.pages.dev
**Supersedes:** `EBP_Tracker_Project_Report.md` (2026-07-24, commit `5f07390`) — that report predates the legacy-cleanup pass documented here (payments/tiers/upgrade removal, dead-code removal, `user_assets` column drops). Kept in the repo for history; this file is the current source of truth.

---

## 1. Project Overview

EBP Tracker is a real-time trading signal alerting platform that monitors financial assets across multiple timeframes and delivers alerts via Telegram when key price action patterns are detected. It implements three live signal types — EBP (Engulfing Body Pattern), Sweep (liquidity sweep), and MSS (Market Structure Shift) — plus a multi-step T3 template chain, filtered through a TTrades-derived closure bias engine. The entire stack runs on Cloudflare's free tier (Pages, Workers, D1) using Twelve Data (3-key rotation) and Yahoo Finance as price sources. Total infrastructure cost: $0/month.

---

## 2. Workers — Names, File Paths, Deployed Versions

| Worker | Name | File(s) | Last Deployed Version ID |
|---|---|---|---|
| EBP Worker | `ebp-tracker-worker` | `worker/src/ebp-worker.js` (single zero-dependency bundle) | `73b07f31-f823-4365-99cc-691fa6bfe4cc` |
| Sweep Worker | `sweep-detector` | `sweep-worker/src/index.js` (entry/routing) + `sweep-worker/src/sweep-cron.js` (all signal logic, inlined) | `9d12235f-f2ed-40a6-a402-1c3a7a980f4a` |

URLs:
- EBP Worker: `https://ebp-tracker-worker.aicube-apps.workers.dev`
- Sweep Worker: `https://sweep-detector.aicube-apps.workers.dev`

`sweep-worker/src/sweep.js` **no longer exists** — it was deleted in this pass. Its only live caller (`GET /sweep/dashboard`'s dynamic `import('./sweep.js')` for `detectSweep`) now statically imports `detectSweep` from `sweep-cron.js` instead, where the function was already inlined but previously unexported.

Both workers run scheduling via cron-job.org HTTP POST triggers (`/cron/ebp`, `/cron/sweep`), secured by an `X-Cron-Secret` header checked against `env.CRON_SECRET`. Native Cloudflare `[triggers]` cron blocks are removed from both `wrangler.toml` files (commented out with an explanatory note).

### 2.1 EBP Worker — Live Routes

```
GET    /health
GET    /user/me
GET    /user/assets                       — per-asset EBP status now sourced from user_ebp_configs
POST   /user/assets
GET    /user/assets/count
DELETE /user/assets/:id
PATCH  /user/assets/:id/bias-overrides
GET    /user/assets/validate              — Twelve Data symbol_search primary, Yahoo/heuristic fallback
GET    /user/ebp-configs/:assetId
POST   /user/ebp-configs/:assetId
PATCH  /user/ebp-configs/:id
DELETE /user/ebp-configs/:id
GET    /user/sweep-configs/:assetId
POST   /user/sweep-configs/:assetId
PATCH  /user/sweep-configs/:id
DELETE /user/sweep-configs/:id
GET    /user/templates/:assetId
POST   /user/templates/:assetId
PATCH  /user/template/:id
DELETE /user/template/:id
GET    /dashboard
GET    /user/bias/:symbol
GET    /health/datasources
GET    /alerts/history
GET    /alerts/export
GET    /user/telegram
POST   /user/telegram/initlink
POST   /user/telegram/test
POST   /user/telegram/verify
DELETE /user/telegram
POST   /cron/ebp                          — X-Cron-Secret required, { tf } in body
POST   /telegram/webhook                  — public, no Clerk auth
GET    /admin/users
GET    /admin/tokens
POST   /admin/invite
POST   /admin/expire/:id
GET    /admin/api-keys
POST   /admin/api-keys
PATCH  /admin/api-keys/:id
DELETE /admin/api-keys/:id
PATCH  /admin/users/:id/asset-limit
GET    /invite/:token
```

**Removed this pass** (confirmed absent via source grep — zero remaining matches): `POST /payment/submit`, `GET /payment/status`, `GET /tiers`, `GET /admin/payments`, `POST /admin/approve/:id`, `POST /admin/reject/:id`, `GET /admin/tiers`, `PATCH /admin/tiers/:tier`.

### 2.2 Sweep Worker — Live Routes

```
GET  /health
POST /cron/sweep       — X-Cron-Secret required, { tf } in body, valid TFs: M5, M15, M30, 1H, 4H
GET  /sweep/dashboard  — sweep status per asset per TF; now sourced from user_sweep_configs,
                          returns every active asset (sweepStatus: {} if unconfigured)
GET  /sweep/history    — recent sweep alerts (alert_type = 'sweep'; 'combined' branch removed,
                          nothing has written alert_type='combined' since the T3 chain replaced it)
```

---

## 3. D1 Database — Live Schema (post migrations 001–005)

Single shared database: `ebp-tracker-db` (ID `b93b206a-5537-4d12-8c86-a4b2372aae7f`). **17 tables**, confirmed live via `PRAGMA table_info` on 2026-07-24 (after migration 005):

| # | Table | Columns (live) |
|---|---|---|
| 1 | `users` | id, email, name, plan, asset_limit, created_at, expires_at, active, is_admin |
| 2 | `user_assets` | id, user_id, symbol, display_name, asset_type, active, added_at, bias_overrides |
| 3 | `user_telegram` | user_id, chat_id, link_code, verified, updated_at |
| 4 | `user_ebp_configs` | id, user_id, asset_id, timeframe, alert_mode, enabled, created_at |
| 5 | `user_sweep_configs` | id, user_id, asset_id, timeframe, alert_mode, enabled, created_at |
| 6 | `user_templates` | id, user_id, asset_id, template, enabled, htf, ltf, window_mins, step3_enabled, bias_gate, fvg_rule, created_at |
| 7 | `alert_history` | id, user_id, symbol, timeframe, direction, trend_bias, candle_time, fired_at, alert_type, details |
| 8 | `candle_cache` | symbol, timeframe (PK), bar_0/1/2 (open/high/low/close), bar_0_time, bar_1_time, updated_at |
| 9 | `sweep_candle_cache` | identical shape to `candle_cache`, kept separate to avoid TF-set conflicts |
| 10 | `bias_cache` | symbol, timeframe (PK), bias, closure_type, close_pos, bar1_time, updated_at |
| 11 | `swing_state` | symbol, timeframe (PK), run_direction, run_start, run_extreme, extreme_time, confirmed_swing_high(_time), confirmed_swing_low(_time), updated_at |
| 12 | `detected_fvgs` | id, symbol, timeframe, direction, zone_low, zone_high, midpoint, formed_at, candle_time, mitigated, mitigated_at, mitigation_rule, expires_at, created_at |
| 13 | `chain_state` | id, user_id, asset_id, symbol, template, direction, current_step, htf_tf, ltf, htf_signal_time, ltf_sweep_time, expires_at, created_at |
| 14 | `invite_tokens` | token (PK), created_at, used_by, used_at, active |
| 15 | `api_keys` | id, source, key_value, label, enabled, added_at, added_by |
| 16 | `api_key_state` | key_name (PK, refs api_keys.id), exhausted, exhausted_at, calls_today, reset_at |
| 17 | `api_call_log` | id, source, symbol, timeframe, called_at, success (retained 48h, cleaned on M5 sweep cron) |

`schema.sql` has been updated to match this exactly — the `user_assets` block was rewritten to drop all 8 legacy columns and add `bias_overrides` (which existed live but was previously undocumented in the file).

### 3.1 Migration history

| File | What it did | Status |
|---|---|---|
| `migrations/003_drop_tier_tables.sql` | Dropped `payment_log`, `tier_config`, `pending_signals` | ✅ Run |
| `migrations/004_drop_legacy_user_asset_columns.sql` | Dropped `ebp_alert_mode`, `sweep_alert_mode`, `combined_enabled`, `combined_pairs`, `combined_window_mins` from `user_assets` | ✅ Run |
| `migrations/005_drop_remaining_legacy_columns.sql` | Dropped `timeframes`, `sweep_enabled`, `sweep_timeframes` from `user_assets`, after migrating `GET /user/assets` and `GET /sweep/dashboard` onto `user_ebp_configs`/`user_sweep_configs` | ✅ Run |

Both `user_assets` migrations were row-count-verified before/after (9 rows, unchanged) with no data loss on surviving columns.

---

## 4. Data Source Architecture

**Primary — Twelve Data (3-key rotation via D1)**

Keys live in the `api_keys` table (`source='twelvedata'`), managed through Admin → API Keys. Per-key exhaustion state is tracked in `api_key_state`.

1. `resetExhaustedKeys` restores any key whose `reset_at` (next UTC midnight) has passed.
2. `getActiveTwelveDataKey` returns the first enabled, non-exhausted key ordered by label.
3. A `429` or a "run out"/"api credits" message marks the key exhausted until next UTC midnight.
4. Up to 5 rotation attempts per fetch before falling through to Yahoo.
5. Successful calls increment `calls_today` and log to `api_call_log`.
6. Each key: 800 credits/day free tier → 2,400 combined daily credits across 3 keys.

**Fallback — Yahoo Finance (no key required)**

Used when all Twelve Data keys are exhausted, or none are configured. Also used by `validateSymbol()` (the Yahoo-only path called from `POST /user/assets`) — note `env.TWELVE_DATA_API_KEY` (singular) is still passed into that function call but the parameter is unused inside it, and that secret no longer exists on either worker (only `_1/_2/_3` do). Harmless dead parameter, not a bug.

`GET /user/assets/validate` (the route the frontend actually calls when adding an asset) is Twelve-Data-primary: it calls `symbol_search`, with a short-circuit for bare index names (`NIFTY`, `SENSEX`, `SPX`, `DJI`, `NDX` — Twelve Data has no exact match for these and would otherwise resolve to an unrelated ETF/stock) and a heuristic (`guessAssetType`) / Yahoo fallback if Twelve Data is unavailable.

**No Finnhub anywhere** — fully removed in an earlier pass this project.

`normaliseSymbol()` converts bare 6-character pairs (`EURUSD` → `EUR/USD`) before any data-source call; duplicated identically in both worker bundles (no shared imports between the two Workers).

---

## 5. Cron Schedule

All scheduling is via cron-job.org HTTP POST requests with `X-Cron-Secret`; no native Cloudflare cron triggers are active. **9 active jobs** (per the last confirmed cron-job.org audit — I did not re-verify this against the cron-job.org dashboard directly in this pass, since I have no credentials/API access to it; the code-side TF handling that this schedule assumes is unchanged, so it's carried forward from the last confirmed state):

| Job | Worker | TF | Schedule (UTC) |
|---|---|---|---|
| EBP M15 | EBP | M15 | Every 15 min |
| EBP 1H | EBP | 1H | Every 60 min (:00) |
| EBP 4H | EBP | 4H | Every 4 hours |
| EBP D | EBP | D | 21:00 Mon–Fri |
| EBP W | EBP | W | 21:00 Friday |
| Sweep M15 | Sweep | M15 | Every 15 min |
| Sweep M30 | Sweep | M30 | Every 30 min |
| Sweep 1H | Sweep | 1H | Every 60 min (:00) |
| Sweep 4H | Sweep | 4H | Every 4 hours |

M5 is a valid TF on `/cron/sweep` (drives the FVG/chain/key-state cleanup block) but has no dedicated cron-job.org job — cleanup currently piggybacks on whichever low-TF job fires first. DST note: EBP D/W (21:00 UTC) track the NY 4pm close and need manual adjustment on cron-job.org each March/November.

---

## 6. Signal Types

### 6.1 Live

| Type | Logic |
|---|---|
| **EBP** | Current candle sweeps prior candle's wick AND closes beyond prior candle's *body*; filtered against HTF TTrades bias |
| **Sweep** | Current candle sweeps prior candle's wick AND closes back inside prior *range* (no body-close requirement — looser than EBP) |
| **MSS** | Swing-state machine detects a close beyond a confirmed swing high/low; fires on both EBP and Sweep timeframes |
| **T3** | 3-step chain: HTF EBP → LTF Sweep → LTF MSS, completes within a configurable window (default 60 min); step 1 fires in the EBP Worker, steps 2–3 in the Sweep Worker |

### 6.2 Planned (UI exists, no backend logic)

| Type | Chain | Status |
|---|---|---|
| **T1** | HTF FVG → price at zone → LTF confirmation | UI checkbox saves to `user_templates`; no signal logic |
| **T4** | HTF Sweep → HTF FVG pullback → LTF MSS | UI checkbox saves to `user_templates`; no signal logic |
| **T2** | HTF EBP → LTF FVG retracement → LTF MSS | UI checkbox saves to `user_templates`; no signal logic |

Enabling T1/T2/T4 in the Admin UI currently has no effect on alerts — this is unchanged from the prior audit.

---

## 7. Removed Features (this cleanup pass)

| Feature | What was removed | Verified by |
|---|---|---|
| **Tiers** | `tier_config` table, `/admin/tiers`, `PATCH /admin/tiers/:tier`, `GET /tiers`, Tier Config admin tab | Migration 003 dropped the table; route grep confirms zero remaining matches |
| **Payment** | `payment_log` table, `POST /payment/submit`, `GET /payment/status`, `/admin/payments`, `/admin/approve/:id`, `/admin/reject/:id`, Payments admin tab | Migration 003 dropped the table; live `/payment/status` and `/tiers` now return 404 |
| **Upgrade flow** | `/upgrade` route, `Upgrade.jsx` page-level UI, Dashboard plan-expired overlay's upgrade CTA | Confirmed absent from `App.jsx` routes |
| **Combined alerts** | `pending_signals` table; `checkPendingSignals`/`consumePendingSignal`/`cleanupExpiredSignals` (dead code — never actually called, no code ever inserted a `pending_signals` row); the `alert_type IN ('sweep','combined')` branch in `/sweep/history` | Call-graph traced to confirm zero live callers before deletion; migration 003 dropped the table; `/sweep/history` query narrowed to `alert_type = 'sweep'` |
| **`sweep-worker/src/sweep.js`** | Entire file deleted — its only live consumer (`/sweep/dashboard`'s dynamic import for `detectSweep`) was repointed to the already-inlined, now-exported `detectSweep` in `sweep-cron.js` | Repo-wide grep confirms zero remaining references outside a stale comment |
| **`user_assets` legacy columns** | `timeframes`, `ebp_alert_mode`, `sweep_enabled`, `sweep_timeframes`, `sweep_alert_mode`, `combined_enabled`, `combined_pairs`, `combined_window_mins` — all superseded by `user_ebp_configs`/`user_sweep_configs` | `GET /user/assets` and `GET /sweep/dashboard` migrated to read the new config tables first (verified against zero-config edge case with disposable test data); migrations 004+005 then dropped all 8 columns; row counts verified unchanged |

---

## 8. Pending Phases (A–I)

**Correction from the previous draft of this document:** the A–I list below was originally my own invented relabeling of this project's older Pre-Phase/1/1.5+2/3/4 progression, made without a canonical source — I'd searched the repo, found no phase-lettered document, and flagged that gap rather than guess blindly. The actual canonical definitions live in `EBP_Tracker_Roadmap.md` (repo root, v2.0), which has since been added locally. The table below is sourced from that document, not invented. The phase letters bear **no resemblance** to my earlier guess (e.g., roadmap-D is the NSE Worker, not "T3 template chain").

| Phase | Summary (per `EBP_Tracker_Roadmap.md` v2.0) | Status |
|---|---|---|
| **A** | Asset slot control + $30 contribution banner + admin controls — universal `asset_limit=5` default and asset-cap enforcement (both now deployed as of this session), plus a still-unbuilt `user_tf_access` JSON column on `users` for per-user per-timeframe enable/disable, enforced in both cron handlers | 📋 Partially live — asset-cap backend now deployed; per-user TF access control not built |
| **B** | Admin Price Feed panel (WebSocket) — Twelve Data OHLC validated pipette-accurate against TradingView + broker feeds (5ers, IC Markets) across 8 major pairs via live bot alerts. Twelve Data locked in as confirmed long-term primary source | ✅ Complete |
| **C** | Twelve Data Asset Browser — replace manual symbol entry with a curated, cached, browsable symbol list (`GET /assets/catalogue`, new `symbol_catalogue` D1 table, 24h TTL) | 📋 Not started |
| **D** | **Indian Market Section — dedicated `nse-detector` Worker** (`nse-worker/src/index.js` + its own `wrangler.toml`), **not** routing inside the existing EBP/Sweep Workers. Separate cron jobs for NSE timeframes (M1/M5/M15/M30/1H/D — 6 new cron-job.org jobs), new `nse_candle_cache` table (shared D1, isolated from `candle_cache`), Upstox Analytics Token as primary source (D1-managed, admin-pasted, 1-year expiry with 30-day warning) with Yahoo Finance fallback (~15 min delayed label). NSE assets are unlimited and don't count against the forex/crypto slot cap | 📋 Not started |
| **E** | T1 template backend — HTF unmitigated FVG → price re-enters zone → LTF MSS/Sweep confirms → alert + Signal ID (`initiateT1Chain`/`advanceT1Chain`/`completeT1Chain`) | 📋 Not started |
| **F** | T4 template backend — HTF Sweep → HTF FVG pullback → LTF MSS → alert + Signal ID. Depends on Phase E's FVG zone detection logic | 📋 Not started |
| **G** | T2 template backend — HTF EBP → LTF FVG on retracement → price at LTF FVG → LTF MSS → alert + Signal ID. Most complex; depends on Phases E and F | 📋 Not started |
| **H** | **Watchdog Worker — now unblocked** (Twelve Data reliability confirmed via Phase B's IRL validation). Dedicated `ebp-watchdog` Worker on a native Cloudflare cron (`*/30 * * * *`), checks `candle_cache`/`sweep_candle_cache` staleness per-TF (thresholds from 2 min at M1 to 10,082 min at W), logs to a new `watchdog_log` table (7-day retention), alerts a separate `@EBP_Watchdog_bot`. Scheduled to build after Phase G (all templates complete) | 📋 Not started — explicitly sequenced last, after G |
| **I** | **Trade Journal Signal Integration** — links EBP Tracker signals to Trade Journal (separate Supabase-backed app) trade outcomes for win-rate/R-multiple analysis per template. Full build spec in `EBP_Signal_Integration_Ref_1.md` (repo root); **Signal ID format finalized as the Roadmap's sequential scheme**, not that document's own random-suffix draft (see note below) | 📋 Not started — side quest, doesn't block other phases |

Roadmap-defined build sequence: **Immediate Fixes → EBP Worker deploy + migration 003 → Phase A (remaining) → Phase C → Phase D → Phase E → Phase I → Phase F → Phase G → Phase H.** The "Immediate Fixes" and initial EBP Worker/migration-003 deploy this sequence names are the work completed in this session (see §7 above) — the roadmap document itself still shows them as pending because it predates this deploy pass; the phase *scopes* above are otherwise unedited from the roadmap.

### 8.1 Phase I — Signal Integration build spec (authoritative)

`EBP_Signal_Integration_Ref_1.md` (repo root, v1.0) is the detailed build reference for Phase I and is authoritative for everything in it **except the Signal ID format**, which its own text flagged as "not finalised" — the format is now locked to the Roadmap's sequential scheme, confirmed directly by the user. Merged spec:

- **Signal ID format (locked):** `{TEMPLATE}-{PAIR}-{SERIES}{COUNT}`, e.g. `T3-EURUSD-A001` — **not** the Integration Ref's own `{TEMPLATE}-{PAIR}-{4-CHAR-RANDOM}` draft (e.g. `T3-EURUSD-A4K2`). Series runs A–Z, count runs 001–999, and the counter is **per-template globally** (one shared counter across every symbol for that template), giving 26,000 signals per template before series exhaustion. This requires the Roadmap's `signal_counters` table (`template` PK, `series`, `count`) and a `generateSignalId()` that increments it — the Integration Ref's own `generateSignalId()` code sample (random 4-char suffix, no counter) should **not** be used as written.
- **`signals` table:** as specified in the Integration Ref — `signal_id` (PK), `template_type`, `symbol`, `htf_tf`, `ltf_tf`, `direction`, `fired_at` (ISO 8601 UTC), `traded` (0/1). No `user_id` column — single-user system. Append-only from the EBP Worker side; Trade Journal only ever `PATCH`es `traded`.
- **Routes:** `GET /signals/:id` and `PATCH /signals/:id/traded`, both gated by a `X-Journal-Secret` header checked against a new `JOURNAL_API_SECRET` Wrangler secret (401 on mismatch, 404 if the signal doesn't exist), plus an `OPTIONS` preflight handler for both (Trade Journal is a browser SPA on a different origin, needs CORS).
- **Telegram message:** append `🔗 Signal ID: T3-EURUSD-A001` to the existing T3 (and future T4) alert format.
- **User flow:** signal fires → Signal ID appears in the Telegram message → user optionally trades it → at trade closure in Trade Journal's Close Trade modal, user pastes the Signal ID → Trade Journal calls `GET /signals/:id` to fetch and display the signal, stores `signal_id` + a full `signal_data` snapshot on its own Supabase `trades` row (so the link survives even if EBP's D1 `signals` table is later pruned), then calls `PATCH /signals/:id/traded`.
- **Discrepancy not yet resolved:** the Integration Ref lists T4 as "✅ Yes — Live in production — implement immediately" for Signal ID support. This is inconsistent with the actual codebase — I grepped both Workers and found no `formatT4Alert`, no `initiateT4Chain`, and no `'T4'` reference anywhere; T4 has no backend at all (matches the Roadmap's own Phase F status: 📋 not started). Signal ID support for T4 can only be added once Phase F actually builds a T4 backend to attach it to — treat the Integration Ref's claim there as an error in that document, not a signal that T4 secretly already works.
- **Direction casing:** the Integration Ref's `signals` table example uses `'BULL'/'BEAR'`, which differs from the uppercase-free convention used everywhere else in this codebase (`'bullish'/'bearish'` in `alert_history`, `bias_cache`, `chain_state` — see the Nomenclature Standard carried over from the prior audit report). Not flagged by the user as something to reconcile — noting it here so whoever builds Phase I makes a deliberate choice rather than an accidental inconsistency.

**One inconsistency worth flagging, not resolved here:** the roadmap specifies a **$30.00** contribution banner for Phase A, but the currently deployed Dashboard modal (built in an earlier session, still live) says **$15.00**. Also, the roadmap describes Phase A's "admin slot limit dropdown" as still pending frontend work, but `PATCH /admin/users/:id/asset-limit` and the Admin → User Limits tab are already live — only the separate `user_tf_access` per-timeframe gating is actually unbuilt. Recommend reconciling the roadmap's Phase A description against current reality before starting further Phase A work.

---

## 9. Environment Variables and Secrets

Confirmed live via `wrangler secret list` on 2026-07-24.

### EBP Worker (`ebp-tracker-worker`)

| Secret | Purpose |
|---|---|
| `APP_URL` | Base URL for invite links |
| `CLERK_SECRET_KEY` | Clerk JWKS retrieval for JWT verification |
| `CRON_SECRET` | Shared secret checked against `X-Cron-Secret` |
| `DEVELOPER_TELEGRAM_CHAT_ID` | Developer's Telegram chat ID (previously used for payment notifications — that call site is now removed; secret itself is untouched) |
| `SHARED_BOT_TOKEN` | Telegram Bot API token (@EbP_Tracker_bot) |
| `TWELVE_DATA_API_KEY_1` / `_2` / `_3` | Kept live as backup per standing instruction — pending user confirmation that D1-managed key rotation is stable in production before deletion |

`UPI_ID` (formerly listed here as stale, leftover from the removed payment flow) has been deleted via `wrangler secret delete UPI_ID --name ebp-tracker-worker`, confirmed absent from `wrangler secret list`.

### Sweep Worker (`sweep-detector`)

| Secret | Purpose |
|---|---|
| `CLERK_SECRET_KEY` | Clerk JWT verification for `/sweep/dashboard` and `/sweep/history` |
| `CRON_SECRET` | Shared secret checked against `X-Cron-Secret` |
| `SHARED_BOT_TOKEN` | Telegram Bot API token (same bot) |
| `TWELVE_DATA_API_KEY_1` / `_2` / `_3` | Same standing-backup status as the EBP Worker |

### Frontend (Cloudflare Pages)

| Variable | Purpose |
|---|---|
| `VITE_WORKER_URL` | EBP Worker base URL (defaults to the `.workers.dev` URL) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |

---

## 10. Deployment Commands

```bash
# EBP Worker
cd worker && npx wrangler deploy

# Sweep Worker
cd sweep-worker && npx wrangler deploy

# Frontend — auto-deploys on push to main via Cloudflare Pages GitHub integration
git add . && git commit -m "message" && git push origin main

# D1 — fresh database
npx wrangler d1 execute ebp-tracker-db --file=schema.sql --remote

# D1 — apply a specific migration
npx wrangler d1 execute ebp-tracker-db --remote --file=migrations/<name>.sql

# Inspect live D1 schema
npx wrangler d1 execute ebp-tracker-db --remote --command "PRAGMA table_info(<table>);"

# Secrets
npx wrangler secret put <NAME> --name ebp-tracker-worker
npx wrangler secret put <NAME> --name sweep-detector
npx wrangler secret list --name ebp-tracker-worker
```

---

*Generated by Claude Code from a live audit of the deployed code and D1 database on 2026-07-24, immediately after the legacy-cleanup deploy (Sweep Worker `9d12235f`, EBP Worker `73b07f31`, migrations 003–005).*
