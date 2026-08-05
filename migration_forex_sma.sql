-- Forex/Crypto SMA Cloud — new feature (2026-08-05)
-- Runs in Sweep Worker (handleForexSmaCron). Shared phase-machine logic
-- ported from the NSE SMA Cloud revamp (migration_sma_revamp.sql).

CREATE TABLE IF NOT EXISTS forex_indicator_configs (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL,
  indicator         TEXT NOT NULL DEFAULT 'sma',
  timeframe         TEXT NOT NULL,
  bias_mode         TEXT DEFAULT 'ttrades',
  htf_timeframe     TEXT DEFAULT '4H',
  confirmation_mode TEXT DEFAULT 'either',
  enabled           INTEGER DEFAULT 1,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forex_sma_state (
  symbol                  TEXT NOT NULL,
  timeframe               TEXT NOT NULL,
  direction               TEXT,
  phase                   TEXT,
  stack_active            INTEGER DEFAULT 0,
  consecutive_widening    INTEGER DEFAULT 0,
  separation              REAL,
  velocity_label          TEXT,
  atr14                   REAL,
  cloud_top               REAL,
  cloud_bottom            REAL,
  sma1_last               REAL,
  sma9_last               REAL,
  distribution_started_at TEXT,
  last_signal_date        TEXT,
  last_signal_time        INTEGER,
  cisd_watch_active       INTEGER DEFAULT 0,
  cisd_watch_direction    TEXT,
  cisd_pullback_start     TEXT,
  cisd_watch_armed_at     TEXT,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
