-- EBP Tracker — Phase 1 / 1.5 / 2 / 3 migration
-- Drops the old FVG/swing/chain tables and replaces them with the new
-- fvg_zones / swing_states / chain_state schema (+ NSE FVG/swing tables).
-- Run: npx wrangler d1 execute ebp-tracker-db --file=migration_phase1_to_3.sql --remote
--
-- IMPORTANT: run this only AFTER all three workers (worker/, sweep-worker/,
-- nse-worker/) have been deployed with code that targets this new schema —
-- see migration_phase1_to_3_NOTES at the bottom of this file.

DROP TABLE IF EXISTS detected_fvgs;
DROP TABLE IF EXISTS swing_state;
DROP TABLE IF EXISTS chain_state;

CREATE TABLE fvg_zones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol           TEXT NOT NULL,
  tf               TEXT NOT NULL,
  direction        TEXT NOT NULL,        -- 'bullish' | 'bearish'
  top              REAL NOT NULL,
  bottom           REAL NOT NULL,
  midpoint         REAL NOT NULL,
  formed_at        TEXT NOT NULL,        -- ISO datetime of bar[i] that completed the FVG
  expires_at       TEXT NOT NULL,        -- formed_at + 14 days
  mitigated_at     TEXT,                 -- NULL until mitigated
  mitigated_by_tf  TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_fvg_zones_lookup ON fvg_zones(symbol, tf, mitigated_at, expires_at);

CREATE TABLE nse_fvg_zones (
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
CREATE INDEX idx_nse_fvg_zones_lookup ON nse_fvg_zones(symbol, tf, mitigated_at, expires_at);

CREATE TABLE swing_states (
  id                              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol                          TEXT NOT NULL,
  tf                              TEXT NOT NULL,
  run_dir                         TEXT,    -- 'bullish', 'bearish', or NULL
  run_start_time                  TEXT,    -- ISO datetime of first candle in current run
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

CREATE TABLE nse_swing_states (
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

-- template_type: 'T1' | 'T2' | 'T3' | 'T4'
-- state values per template:
--   T1/T2/T4: 'awaiting_fvg_entry' | 'awaiting_retracement' (T2 only) | 'complete'
--   T3:       'awaiting_sweep' | 'awaiting_mss' | 'complete'
-- asset_id: not in the original spec draft, added because user_templates
-- and the EBP-worker asset-delete cascade (DELETE /user/assets/:id) are
-- both asset_id-keyed — dropping it would break that cascade.
-- htf_candle_*: T2 only, used to bound the retracement-FVG formed_at window.
CREATE TABLE chain_state (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  template_type          TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  asset_id               TEXT NOT NULL,
  symbol                 TEXT NOT NULL,
  htf                    TEXT NOT NULL,   -- '' for T4 (no HTF EBP step)
  ltf                    TEXT NOT NULL,
  direction              TEXT NOT NULL,   -- 'bullish' | 'bearish'
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
CREATE INDEX idx_chain_state_lookup ON chain_state(template_type, state, symbol, expires_at);
CREATE INDEX idx_chain_state_asset ON chain_state(asset_id);

INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T1', 'A', 0);
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T2', 'A', 0);
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('T4', 'A', 0);

-- migration_phase1_to_3_NOTES:
-- signal_counters' real column is `template` (not `counter_key` as an
-- earlier spec draft assumed) — matches the existing live 'T3' row and the
-- generateSignalId(db, template, symbol) helper already used by both
-- worker/src/ebp-worker.js and sweep-worker/src/sweep-cron.js.
