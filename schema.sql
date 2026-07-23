-- EBP Tracker D1 Schema — Phase 3
-- Run: npx wrangler d1 execute ebp-tracker-db --file=../schema.sql --remote

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT,
  plan        TEXT DEFAULT 'free',
  asset_limit INTEGER DEFAULT 3,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  active      INTEGER DEFAULT 1,
  is_admin    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_assets (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  symbol               TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  asset_type           TEXT NOT NULL,
  timeframes           TEXT DEFAULT 'W,D,4H,1H,M15',
  ebp_alert_mode       TEXT DEFAULT 'aligned',
  sweep_enabled        INTEGER DEFAULT 0,
  sweep_timeframes     TEXT DEFAULT '4H,1H,M15',
  sweep_alert_mode     TEXT DEFAULT 'aligned',
  combined_enabled     INTEGER DEFAULT 0,
  combined_pairs       TEXT DEFAULT '[]',
  combined_window_mins INTEGER DEFAULT 60,
  active               INTEGER DEFAULT 1,
  added_at             INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS pending_signals (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  direction      TEXT NOT NULL,
  signal_type    TEXT NOT NULL,
  timeframe      TEXT NOT NULL,
  fired_at       INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_pairs TEXT DEFAULT '[]',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payment_log (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  tier         TEXT NOT NULL,
  amount_inr   INTEGER NOT NULL,
  upi_ref      TEXT,
  status       TEXT DEFAULT 'pending',
  submitted_at INTEGER NOT NULL,
  approved_at  INTEGER,
  approved_by  TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
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
CREATE INDEX IF NOT EXISTS idx_ps_user_symbol  ON pending_signals(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_pl_status       ON payment_log(status);

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

-- Phase 4 additions
ALTER TABLE alert_history ADD COLUMN details TEXT DEFAULT '{}';

CREATE TABLE IF NOT EXISTS user_ebp_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  alert_mode  TEXT DEFAULT 'aligned',
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (asset_id) REFERENCES user_assets(id)
);
CREATE INDEX IF NOT EXISTS idx_ebp_configs_lookup ON user_ebp_configs(user_id, asset_id, enabled);

CREATE TABLE IF NOT EXISTS user_sweep_configs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  alert_mode  TEXT DEFAULT 'aligned',
  enabled     INTEGER DEFAULT 1,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (asset_id) REFERENCES user_assets(id)
);
CREATE INDEX IF NOT EXISTS idx_sweep_configs_lookup ON user_sweep_configs(user_id, asset_id, enabled);

CREATE TABLE IF NOT EXISTS api_call_log (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  called_at   INTEGER NOT NULL,
  success     INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_api_call_log_time ON api_call_log(source, called_at DESC);
