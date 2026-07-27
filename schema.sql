-- EBP Tracker D1 Schema — Phase 3
-- Run: npx wrangler d1 execute ebp-tracker-db --file=../schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  name           TEXT,
  plan           TEXT DEFAULT 'free',
  asset_limit    INTEGER DEFAULT 5,
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

CREATE TABLE IF NOT EXISTS alert_history (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,
  trend_bias  TEXT NOT NULL,
  candle_time INTEGER NOT NULL,
  fired_at    INTEGER NOT NULL,
  alert_type  TEXT DEFAULT 'ebp',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS candle_cache (
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  bar_0_open  REAL, bar_0_high REAL, bar_0_low REAL, bar_0_close REAL,
  bar_1_open  REAL, bar_1_high REAL, bar_1_low REAL, bar_1_close REAL,
  bar_2_open  REAL, bar_2_high REAL, bar_2_low REAL, bar_2_close REAL,
  bar_0_time  INTEGER,
  bar_1_time  INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  used_by    TEXT,
  used_at    INTEGER,
  active     INTEGER DEFAULT 1
);

-- Sweep Candle Cache (separate from EBP cache — different TF set)
CREATE TABLE IF NOT EXISTS sweep_candle_cache (
  symbol        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  bar_0_open    REAL, bar_0_high REAL, bar_0_low REAL, bar_0_close REAL,
  bar_1_open    REAL, bar_1_high REAL, bar_1_low REAL, bar_1_close REAL,
  bar_2_open    REAL, bar_2_high REAL, bar_2_low REAL, bar_2_close REAL,
  bar_0_time    INTEGER,
  bar_1_time    INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ua_user_id      ON user_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_ua_symbol       ON user_assets(symbol);
CREATE INDEX IF NOT EXISTS idx_ah_user_id      ON alert_history(user_id);
CREATE INDEX IF NOT EXISTS idx_ah_fired_at     ON alert_history(fired_at);
-- FVG Detection Table (Phase 1)
CREATE TABLE IF NOT EXISTS detected_fvgs (
  id              TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  direction       TEXT NOT NULL,
  zone_low        REAL NOT NULL,
  zone_high       REAL NOT NULL,
  midpoint        REAL NOT NULL,
  formed_at       INTEGER NOT NULL,
  candle_time     INTEGER NOT NULL,
  mitigated       INTEGER DEFAULT 0,
  mitigated_at    INTEGER,
  mitigation_rule TEXT,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fvg_lookup ON detected_fvgs(symbol, timeframe, mitigated, expires_at);

-- Swing State Table (Phase 1.5)
CREATE TABLE IF NOT EXISTS swing_state (
  symbol                    TEXT NOT NULL,
  timeframe                 TEXT NOT NULL,
  run_direction             TEXT NOT NULL,
  run_start                 INTEGER NOT NULL,
  run_extreme               REAL NOT NULL,
  extreme_time              INTEGER NOT NULL,
  confirmed_swing_high      REAL,
  confirmed_swing_high_time INTEGER,
  confirmed_swing_low       REAL,
  confirmed_swing_low_time  INTEGER,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_swing_state_lookup ON swing_state(symbol, timeframe);

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

-- Chain State — in-progress multi-step template chains
CREATE TABLE IF NOT EXISTS chain_state (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  asset_id        TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  template        TEXT NOT NULL,
  direction       TEXT NOT NULL,
  current_step    INTEGER NOT NULL,
  htf_tf          TEXT,
  ltf             TEXT,
  htf_signal_time INTEGER,
  ltf_sweep_time  INTEGER,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chain_state_lookup ON chain_state(user_id, symbol, template, current_step, expires_at);

-- D1 Console commands (run once on live DB):
-- ALTER TABLE user_assets ADD COLUMN bias_overrides TEXT DEFAULT '{}';
-- UPDATE user_assets SET combined_enabled=0;

-- ── Phase 4 ──────────────────────────────────────────────────

-- ALTER TABLE alert_history ADD COLUMN details TEXT DEFAULT '{}';

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

-- Data-source call log — powers /health/datasources.
-- (Documented here for the first time — was created ad hoc directly in D1
-- before this table ever made it into schema.sql.)
CREATE TABLE IF NOT EXISTS api_call_log (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  symbol     TEXT NOT NULL,
  timeframe  TEXT NOT NULL,
  called_at  INTEGER NOT NULL,
  success    INTEGER DEFAULT 1
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
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  indicator   TEXT NOT NULL,      -- 'tdi' | 'sma'
  timeframe   TEXT NOT NULL,      -- 'M15' | 'M30' for tdi; 'M15' | 'M5' for sma
  stack_mode  TEXT DEFAULT NULL,  -- 'strict' | 'loose' — sma only
  day_filter  INTEGER DEFAULT NULL, -- 1 | 0 — sma only
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL
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
  phase                 TEXT,          -- 'accumulation' | 'transition' | 'distribution' | 'exhaustion' | null
  stack_active          INTEGER DEFAULT 0,
  consecutive_widening  INTEGER DEFAULT 0,
  separation            REAL,
  velocity_label        TEXT,          -- 'Sharp' | 'Gradual'
  atr14                 REAL,
  cloud_top             REAL,
  cloud_bottom          REAL,
  stack_formed_date     TEXT,          -- IST date 'YYYY-MM-DD'
  last_signal_date      TEXT,          -- IST date — M15 session gate
  last_signal_time      INTEGER,       -- Unix ms — M5 cooldown
  updated_at            INTEGER NOT NULL,
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
