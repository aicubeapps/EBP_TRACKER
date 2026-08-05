-- EBP Tracker D1 Schema — Phase 3
-- Run: npx wrangler d1 execute ebp-tracker-db --file=../schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  name           TEXT,
  plan           TEXT DEFAULT 'free',
  asset_limit    INTEGER DEFAULT 3,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  active         INTEGER DEFAULT 1,
  is_admin       INTEGER DEFAULT 0,
  user_tf_access TEXT DEFAULT '["M5","M15","M30","1H","4H","D","W"]',
  nse_tf_access  TEXT DEFAULT '["M1","M5","M15","M30","1H","D"]'
);

CREATE TABLE IF NOT EXISTS user_assets (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  asset_type     TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  bias_overrides TEXT DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_telegram (
  user_id    TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  link_code  TEXT,
  verified   INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- fired_at is TEXT ISO 8601, not an INTEGER ms epoch (migration 013,
-- 2026-08-06) — matches signals.fired_at's format, eliminating the
-- cross-table type-mismatch landmine that existed when this was INTEGER.
CREATE TABLE IF NOT EXISTS alert_history (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,
  trend_bias  TEXT NOT NULL,
  candle_time INTEGER NOT NULL,
  fired_at    TEXT NOT NULL,
  alert_type  TEXT DEFAULT 'ebp',
  details     TEXT DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Unified candle cache (IM-1) — replaces the old per-bar-column
-- candle_cache/sweep_candle_cache pair. Watchdog Worker is the sole
-- writer (Twelve Data + Yahoo); EBP Worker and Sweep Worker both read
-- this same table, filtered by tf, so there is no separate sweep cache.
CREATE TABLE IF NOT EXISTS candle_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol       TEXT NOT NULL,
  tf           TEXT NOT NULL,
  candles_json TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  UNIQUE (symbol, tf)
);

-- Watchdog-synthesized daily/weekly OHLC per symbol, read by EBP/Sweep for
-- D/W-timeframe HTF bias. Row-capped by Watchdog itself (130/26 rows per
-- symbol), not time-expired. Added 2026-08-06: previously live in
-- production with no CREATE TABLE statement anywhere in this file.
CREATE TABLE IF NOT EXISTS daily_candle_cache (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  date_ny        TEXT NOT NULL,
  open           REAL NOT NULL,
  high           REAL NOT NULL,
  low            REAL NOT NULL,
  close          REAL NOT NULL,
  synthesised_at TEXT NOT NULL,
  UNIQUE(symbol, date_ny)
);

CREATE TABLE IF NOT EXISTS weekly_candle_cache (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  week_start_ny  TEXT NOT NULL,
  week_end_ny    TEXT NOT NULL,
  open           REAL NOT NULL,
  high           REAL NOT NULL,
  low            REAL NOT NULL,
  close          REAL NOT NULL,
  synthesised_at TEXT NOT NULL,
  UNIQUE(symbol, week_start_ny)
);

-- Watchdog Worker's own event/error log (info/warning/error rows from
-- logWatchdog()) — failures/warnings only, by design; successful writes
-- are not logged. Write-only from every worker's perspective except the
-- new POST /health/watchdog-check route on the EBP Worker, which reads
-- recent error/warning rows here and relays them to Telegram (Section 5
-- of the architecture report). Added 2026-08-06, same as above.
CREATE TABLE IF NOT EXISTS watchdog_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ORPHANED TABLE: sma_cloud_states exists in production D1 but is never read or written
-- by any worker code. The active SMA Cloud state table is nse_sma_state (different name,
-- different schema). Do not use this table. Do not drop it without a migration.
CREATE TABLE IF NOT EXISTS sma_cloud_states (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                    TEXT NOT NULL,
  tf                        TEXT NOT NULL,
  phase                     TEXT NOT NULL,
  phase_started_at          TEXT NOT NULL,
  sma1_last                 REAL,
  sma9_last                 REAL,
  atr_last                  REAL,
  crossovers_in_transition  INTEGER DEFAULT 0,
  widening_candles          INTEGER DEFAULT 0,
  last_signal_date          TEXT,
  updated_at                TEXT NOT NULL,
  UNIQUE(symbol, tf)
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER,
  active     INTEGER DEFAULT 1
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ua_user_id      ON user_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_ua_symbol       ON user_assets(symbol);
CREATE INDEX IF NOT EXISTS idx_ah_user_id      ON alert_history(user_id);
CREATE INDEX IF NOT EXISTS idx_ah_fired_at     ON alert_history(fired_at);
-- FVG Zones (Phase 1, migration_phase1_to_3.sql) — forex/crypto. NSE gets
-- an identical nse_fvg_zones table (defined further down, Phase D section).
CREATE TABLE IF NOT EXISTS fvg_zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol           TEXT NOT NULL,
  tf               TEXT NOT NULL,
  direction        TEXT NOT NULL,        -- 'bullish' | 'bearish'
  top              REAL NOT NULL,
  bottom           REAL NOT NULL,
  midpoint         REAL NOT NULL,
  formed_at        TEXT NOT NULL,        -- ISO datetime
  expires_at       TEXT NOT NULL,        -- formed_at + 14 days
  mitigated_at     TEXT,
  mitigated_by_tf  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fvg_zones_lookup ON fvg_zones(symbol, tf, mitigated_at, expires_at);

-- Swing State (Phase 1.5/2, migration_phase1_to_3.sql) — forex/crypto.
-- NSE gets an identical nse_swing_states table (Phase D section).
CREATE TABLE IF NOT EXISTS swing_states (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                          TEXT NOT NULL,
  tf                              TEXT NOT NULL,
  run_dir                         TEXT,
  run_start_time                  TEXT,
  run_candle_count                INTEGER DEFAULT 0,
  last_confirmed_swing_high       REAL,
  last_confirmed_swing_high_time  TEXT,
  last_confirmed_swing_low        REAL,
  last_confirmed_swing_low_time   TEXT,
  pending_swing_high              REAL,
  pending_swing_high_time         TEXT,
  pending_swing_low               REAL,
  pending_swing_low_time          TEXT,
  updated_at                      TEXT,
  UNIQUE(symbol, tf)
);

-- ── Phase 3 ──────────────────────────────────────────────────

-- Bias Cache — HTF TTradesBias result per symbol/TF
CREATE TABLE IF NOT EXISTS bias_cache (
  symbol       TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  bias         TEXT NOT NULL,
  closure_type TEXT NOT NULL,
  close_pos    REAL,
  bar1_time    INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
CREATE INDEX IF NOT EXISTS idx_bias_cache_lookup ON bias_cache(symbol, timeframe);

-- User Templates — T3/T1/T4/T2 named template config per asset
CREATE TABLE IF NOT EXISTS user_templates (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  asset_id       TEXT NOT NULL,
  template       TEXT NOT NULL,
  enabled        INTEGER DEFAULT 0,
  htf            TEXT NOT NULL,
  ltf            TEXT NOT NULL,
  window_mins    INTEGER DEFAULT 60,
  step3_enabled  INTEGER DEFAULT 1,
  bias_gate      INTEGER DEFAULT 1,
  fvg_rule       TEXT DEFAULT '50_percent',
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (asset_id) REFERENCES user_assets(id)
);
CREATE INDEX IF NOT EXISTS idx_user_templates_lookup ON user_templates(user_id, asset_id, template, enabled);

-- Chain State (Phase 3, migration_phase1_to_3.sql) — in-progress multi-step
-- template chains for T1/T2/T3/T4 (forex/crypto only — NSE has no
-- template-chain machinery). state is a TEXT state machine per template:
--   T1/T2/T4: 'awaiting_fvg_entry' | 'awaiting_retracement' (T2 only) | 'complete'
--   T3:       'awaiting_sweep' | 'awaiting_mss' | 'complete'
-- htf_candle_*: T2 only, bounds the retracement-FVG formed_at window.
CREATE TABLE IF NOT EXISTS chain_state (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  template_type          TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  asset_id               TEXT NOT NULL,
  symbol                 TEXT NOT NULL,
  htf                    TEXT NOT NULL,
  ltf                    TEXT NOT NULL,
  direction              TEXT NOT NULL,
  state                  TEXT NOT NULL,
  step1_signal_id        TEXT,
  step2_signal_id        TEXT,
  step3_signal_id        TEXT,
  fvg_id                 INTEGER,
  htf_candle_open        REAL,
  htf_candle_close       REAL,
  htf_candle_open_time   TEXT,
  htf_candle_close_time  TEXT,
  expires_at             TEXT NOT NULL,
  created_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chain_state_lookup ON chain_state(template_type, state, symbol, expires_at);
CREATE INDEX IF NOT EXISTS idx_chain_state_asset ON chain_state(asset_id);

-- D1 Console commands (run once on live DB):
-- ALTER TABLE user_assets ADD COLUMN bias_overrides TEXT DEFAULT '{}';
-- UPDATE user_assets SET combined_enabled=0;

-- ── Phase 4 ──────────────────────────────────────────────────

-- Per-asset EBP alert configs (replaces user_assets.timeframes)
CREATE TABLE IF NOT EXISTS user_ebp_configs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  alert_mode   TEXT DEFAULT 'aligned',
  enabled      INTEGER DEFAULT 1,
  created_at   INTEGER NOT NULL,
  htf_override TEXT DEFAULT NULL, -- '1H'->4H/D, '4H'->D/W; null = BIAS_SOURCE default
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (asset_id) REFERENCES user_assets(id)
);
CREATE INDEX IF NOT EXISTS idx_ebp_configs_lookup ON user_ebp_configs(user_id, asset_id, enabled);

-- Per-asset Sweep alert configs (replaces user_assets.sweep_timeframes)
CREATE TABLE IF NOT EXISTS user_sweep_configs (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  timeframe    TEXT NOT NULL,
  alert_mode   TEXT DEFAULT 'aligned',
  enabled      INTEGER DEFAULT 1,
  created_at   INTEGER NOT NULL,
  htf_override TEXT DEFAULT NULL, -- '1H'->4H/D, '4H'->D/W; null = BIAS_SOURCE default
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (asset_id) REFERENCES user_assets(id)
);
CREATE INDEX IF NOT EXISTS idx_sweep_configs_lookup ON user_sweep_configs(user_id, asset_id, enabled);

-- Forex/crypto SMA Cloud (2026-08-05, migration_forex_sma.sql) — runs in
-- Sweep Worker (handleForexSmaCron), phase machine ported from the NSE SMA
-- Cloud revamp. forex_indicator_configs.indicator is always 'sma' today —
-- kept for parity with nse_indicator_configs in case TDI is ever added here.
CREATE TABLE IF NOT EXISTS forex_indicator_configs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL,
  indicator         TEXT NOT NULL DEFAULT 'sma',
  timeframe         TEXT NOT NULL,      -- 'M15' | 'M30' | '1H' | '4H'
  bias_mode         TEXT DEFAULT 'ttrades',  -- 'ttrades' | 'htf_sma' | 'none'
  htf_timeframe     TEXT DEFAULT '4H',       -- valid options depend on timeframe — see FOREX_SMA_HTF_OPTIONS
  confirmation_mode TEXT DEFAULT 'either',   -- 'mss' | 'cisd' | 'either'
  enabled           INTEGER DEFAULT 1,
  created_at        INTEGER NOT NULL
);

-- SMA Cloud phase state — one row per (symbol, timeframe), shared across
-- every user configured on that symbol+TF, read/written every cron run
-- regardless of whether a signal fires. Same shape as nse_sma_state.
CREATE TABLE IF NOT EXISTS forex_sma_state (
  symbol                  TEXT NOT NULL,
  timeframe               TEXT NOT NULL,
  direction               TEXT,          -- 'bullish' | 'bearish' | null
  phase                   TEXT,          -- 'accumulation' | 'distribution' | null
  stack_active            INTEGER DEFAULT 0,
  consecutive_widening    INTEGER DEFAULT 0,  -- retired — always written as 0
  separation              REAL,
  velocity_label          TEXT,          -- 'Sharp⚡' | 'Gradual📉'
  atr14                   REAL,
  cloud_top               REAL,
  cloud_bottom            REAL,
  sma1_last               REAL,          -- prior run's SMA1, for fresh-cross detection
  sma9_last               REAL,          -- prior run's SMA9, for fresh-cross detection
  distribution_started_at TEXT,          -- ISO time — set on Type 1, cleared on exhaustion
  last_signal_date        TEXT,
  last_signal_time        INTEGER,       -- Unix ms — Type 2 cooldown
  cisd_watch_active       INTEGER DEFAULT 0,  -- Type 2 arm/confirm chain
  cisd_watch_direction    TEXT,
  cisd_pullback_start     TEXT,          -- ISO time — swing_states.run_start_time at arm
  cisd_watch_armed_at     TEXT,          -- ISO time — watch expiry reference
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

-- Note: this table was created ad hoc in D1 before schema.sql existed.
-- Production schema reflects actual D1 columns (verified 2026-08-02 via PRAGMA table_info).
-- key_id column from original spec does not exist in production and has been removed.
-- called_at is a Unix timestamp integer (not ISO string), success defaults to 1.
CREATE TABLE api_call_log (
  id        TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  called_at INTEGER NOT NULL,
  success   INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_api_call_log_source_time ON api_call_log(source, called_at);

-- ── Twelve Data key rotation ─────────────────────────────────
-- api_keys holds the actual key material (admin-managed via /admin/api-keys)
-- so rotation works dynamically regardless of how many keys are configured.
-- api_key_state.key_name references api_keys.id.
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  key_value  TEXT NOT NULL,
  label      TEXT NOT NULL,
  enabled    INTEGER DEFAULT 1,
  added_at   INTEGER NOT NULL,
  added_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_source ON api_keys(source, enabled);

CREATE TABLE IF NOT EXISTS api_key_state (
  key_name     TEXT PRIMARY KEY,
  exhausted    INTEGER DEFAULT 0,
  exhausted_at INTEGER,
  calls_today  INTEGER DEFAULT 0,
  reset_at     INTEGER
);

-- Seed rows (D1 Console — INSERT OR IGNORE is safe to re-run):
-- INSERT INTO api_keys (id, source, key_value, label, enabled, added_at, added_by)
-- VALUES ('tdkey-001', 'twelvedata', 'YOUR_KEY_1', 'Twelve Data Key 1', 1, unixepoch()*1000, 'system'),
--        ('tdkey-002', 'twelvedata', 'YOUR_KEY_2', 'Twelve Data Key 2', 1, unixepoch()*1000, 'system'),
--        ('tdkey-003', 'twelvedata', 'YOUR_KEY_3', 'Twelve Data Key 3', 1, unixepoch()*1000, 'system');
-- INSERT OR IGNORE INTO api_key_state (key_name, exhausted, calls_today, reset_at)
-- VALUES ('tdkey-001', 0, 0, 0), ('tdkey-002', 0, 0, 0), ('tdkey-003', 0, 0, 0);

-- ── Phase D — NSE Worker ──────────────────────────────────────
-- Own candle cache, separate from candle_cache/sweep_candle_cache to avoid
-- TF-set conflicts (NSE runs M1/M5/M15/M30/1H/D; forex/crypto workers don't).
CREATE TABLE IF NOT EXISTS nse_candle_cache (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  bar_0_open  REAL, bar_0_high REAL, bar_0_low REAL, bar_0_close REAL,
  bar_1_open  REAL, bar_1_high REAL, bar_1_low REAL, bar_1_close REAL,
  bar_2_open  REAL, bar_2_high REAL, bar_2_low REAL, bar_2_close REAL,
  bar_0_time  INTEGER, bar_1_time INTEGER,
  updated_at  INTEGER,
  PRIMARY KEY (symbol, timeframe)
);

-- NSE FVG zones (Phase 1, migration_phase1_to_3.sql). TFs M5/M15/1H only.
CREATE TABLE IF NOT EXISTS nse_fvg_zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol           TEXT NOT NULL,
  tf               TEXT NOT NULL,
  direction        TEXT NOT NULL,
  top              REAL NOT NULL,
  bottom           REAL NOT NULL,
  midpoint         REAL NOT NULL,
  formed_at        TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  mitigated_at     TEXT,
  mitigated_by_tf  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nse_fvg_zones_lookup ON nse_fvg_zones(symbol, tf, mitigated_at, expires_at);

-- NSE swing state (Phase 1.5/2, migration_phase1_to_3.sql) — own table
-- (not the shared swing_states) since NSE's M1 timeframe never collides
-- with forex/crypto TFs on the same physical row anyway, but keeping them
-- separate avoids any accidental cross-market key collision.
CREATE TABLE IF NOT EXISTS nse_swing_states (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                          TEXT NOT NULL,
  tf                              TEXT NOT NULL,
  run_dir                         TEXT,
  run_start_time                  TEXT,
  run_candle_count                INTEGER DEFAULT 0,
  last_confirmed_swing_high       REAL,
  last_confirmed_swing_high_time  TEXT,
  last_confirmed_swing_low        REAL,
  last_confirmed_swing_low_time   TEXT,
  pending_swing_high              REAL,
  pending_swing_high_time         TEXT,
  pending_swing_low               REAL,
  pending_swing_low_time          TEXT,
  updated_at                      TEXT,
  UNIQUE(symbol, tf)
);

-- ── Phase D++ — NSE Indicators (TDI + SMA Cloud) ───────────────
-- Separate 60-candle JSON-blob cache, distinct from nse_candle_cache above
-- (that table's fixed 3-bar-per-row layout is already live under
-- EBP/Sweep/MSS and stays untouched — this is a new table, not a migration
-- of it, to avoid any risk to what's already deployed).
CREATE TABLE IF NOT EXISTS nse_indicator_candle_cache (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  candles     TEXT NOT NULL,  -- JSON array of up to 60 OHLCV objects, newest first
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

-- Per-user per-asset per-indicator config. id/asset_id are TEXT (UUID) to
-- match user_assets.id and every other config table's convention — the
-- spec draft used INTEGER, which doesn't match this schema anywhere else.
CREATE TABLE IF NOT EXISTS nse_indicator_configs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  indicator     TEXT NOT NULL,      -- 'tdi' | 'sma'
  timeframe     TEXT NOT NULL,      -- 'M15' | 'M30' for tdi; 'M15' | 'M5' | 'M30' for sma
  confirmation_mode TEXT DEFAULT 'either',  -- 'mss' | 'cisd' | 'either' — sma Type 2 confirmation (renamed from stack_mode; old 'strict'/'loose' rows fall back to 'either' at read time)
  day_filter    INTEGER DEFAULT NULL, -- 1 | 0 — sma only, unused since the SMA Cloud corrective patch (column kept, code no longer reads it)
  enabled       INTEGER DEFAULT 1,
  created_at    INTEGER NOT NULL,
  bias_mode     TEXT DEFAULT 'ttrades',  -- 'ttrades' | 'htf_sma' | 'none' — sma only
  htf_timeframe TEXT DEFAULT '1H'        -- '1H' | 'D' — sma only, HTF bias reference leg (paired to signal TF via SMA_HTF_PAIRING)
);

-- Per-user indicator settings not tied to a specific asset config.
-- sma_forex_hours: scaffolding for the forex SMA Cloud working-hours gate
-- (Session 2) — not yet read by any Worker as of the NSE SMA corrective patch.
CREATE TABLE IF NOT EXISTS user_indicator_settings (
  user_id         TEXT PRIMARY KEY,
  sma_forex_hours TEXT DEFAULT 'session',
  updated_at      INTEGER NOT NULL
);

-- TDI pending-chain state (State 1 — exhaustion + momentum confirmed,
-- awaiting MSS). One row per active chain per user/asset/TF.
CREATE TABLE IF NOT EXISTS nse_indicator_chain (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,   -- 'bullish' | 'bearish'
  state       INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL  -- created_at + (4 × TF minutes in ms)
);

-- SMA Cloud phase state — one row per (symbol, timeframe), read/written
-- every cron run regardless of whether a signal fires.
CREATE TABLE IF NOT EXISTS nse_sma_state (
  symbol                TEXT NOT NULL,
  timeframe             TEXT NOT NULL,
  direction             TEXT,          -- 'bullish' | 'bearish' | null
  phase                 TEXT,          -- 'accumulation' | 'distribution' | null
  stack_active          INTEGER DEFAULT 0,
  consecutive_widening  INTEGER DEFAULT 0,  -- retired — always written as 0
  separation            REAL,
  velocity_label        TEXT,          -- 'Sharp⚡' | 'Gradual📉'
  atr14                 REAL,
  cloud_top             REAL,
  cloud_bottom          REAL,
  sma1_last             REAL,          -- prior run's SMA1, for fresh-cross detection
  sma9_last             REAL,          -- prior run's SMA9, for fresh-cross detection
  stack_formed_date     TEXT,          -- IST date 'YYYY-MM-DD'
  last_signal_date      TEXT,          -- IST date — M15 session gate
  last_signal_time      INTEGER,       -- Unix ms — Type 2 cooldown
  cisd_watch_active     INTEGER DEFAULT 0,  -- Type 2 arm/confirm chain
  cisd_watch_direction  TEXT,          -- 'bullish' | 'bearish' | null
  cisd_pullback_start   TEXT,          -- ISO time — nse_swing_states.run_start_time at arm
  cisd_watch_armed_at   TEXT,          -- ISO time — watch expiry reference
  updated_at            TEXT NOT NULL, -- ISO string (written via toISOString(), despite legacy INTEGER-affinity declaration)
  PRIMARY KEY (symbol, timeframe)
);

-- ── Phase I (retrofit) / Phase D — Signal IDs ─────────────────
-- signals is append-only from Workers; Trade Journal only PATCHes `traded`.
-- signal_counters holds one row per template ('t3','t4','NSE',...) — series
-- runs A-Z, count runs 1-999 per series, shared globally across all symbols
-- for that template.
CREATE TABLE IF NOT EXISTS signals (
  signal_id        TEXT PRIMARY KEY,
  template_type    TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  htf_tf           TEXT,
  ltf_tf           TEXT,
  direction        TEXT,
  fired_at         TEXT NOT NULL,
  traded           INTEGER DEFAULT 0,
  expires_at       TEXT,
  price_at_signal  REAL,
  htf_bias         TEXT,
  session          TEXT,
  htf_close        REAL
);

CREATE TABLE IF NOT EXISTS signal_counters (
  template  TEXT PRIMARY KEY,
  series    TEXT DEFAULT 'A',
  count     INTEGER DEFAULT 0
);
-- Seed: INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('NSE', 'A', 0);
-- Seed (migration 008): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-4H', 'A', 0);
-- Seed (migration 008): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-1D', 'A', 0);
-- Seed (migration 008): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-1W', 'A', 0);
-- Seed (migration_phase1_to_3.sql): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T1', 'A', 0);
-- Seed (migration_phase1_to_3.sql): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T2', 'A', 0);
-- Seed (migration_phase1_to_3.sql): INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T4', 'A', 0);

-- ── Market Breadth ────────────────────────────────────────────────
-- Migration: npx wrangler d1 execute ebp-tracker-db --remote --command="CREATE TABLE IF NOT EXISTS market_breadth_cache ..."
-- (run each CREATE TABLE statement below separately, or re-run the full schema file)
-- Hourly snapshot of 28-pair cross strength scores and heatmap.
CREATE TABLE IF NOT EXISTS market_breadth_cache (
  tf           TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  heatmap      TEXT NOT NULL,
  strength     TEXT NOT NULL,
  PRIMARY KEY (tf)
);

-- Intraday strength snapshots for the line chart (one row per TF per hour).
CREATE TABLE IF NOT EXISTS market_breadth_intraday (
  tf           TEXT NOT NULL,
  snapshot_at  INTEGER NOT NULL,
  strength     TEXT NOT NULL,
  PRIMARY KEY (tf, snapshot_at)
);

-- Correlation matrix snapshot per TF (Pearson on 10-candle strength series).
CREATE TABLE IF NOT EXISTS market_breadth_correlation (
  tf           TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  matrix       TEXT NOT NULL,
  PRIMARY KEY (tf)
);

-- (daily_candle_cache, weekly_candle_cache, watchdog_log, and
-- sma_cloud_states — previously undocumented here, "live but not in
-- schema" — now have proper CREATE TABLE statements above, after
-- candle_cache. Reconciled 2026-08-06.)
