-- Migration 016: AI template refactor — chain_state step/zone/MSS columns
-- + new sma_cloud_config table.
-- Additive only: ALTER TABLE ADD COLUMN, one statement per column (SQLite
-- doesn't support multi-column ADD in a single ALTER TABLE). No existing
-- column is dropped, renamed, or retyped.
-- Date: 2026-08-15

ALTER TABLE chain_state ADD COLUMN signal_id TEXT;
ALTER TABLE chain_state ADD COLUMN step INT DEFAULT 1;
ALTER TABLE chain_state ADD COLUMN htf_high REAL;
ALTER TABLE chain_state ADD COLUMN htf_low REAL;
ALTER TABLE chain_state ADD COLUMN ote_top REAL;
ALTER TABLE chain_state ADD COLUMN ote_bottom REAL;
ALTER TABLE chain_state ADD COLUMN zone_type TEXT;
ALTER TABLE chain_state ADD COLUMN ote_enabled INT DEFAULT 1;
ALTER TABLE chain_state ADD COLUMN sweep_required INT DEFAULT 0;
ALTER TABLE chain_state ADD COLUMN trigger_type TEXT DEFAULT 'cisd';
ALTER TABLE chain_state ADD COLUMN cisd_level REAL;
ALTER TABLE chain_state ADD COLUMN pullback_run_high REAL;
ALTER TABLE chain_state ADD COLUMN pullback_run_low REAL;
ALTER TABLE chain_state ADD COLUMN sweep_signal_id TEXT;
ALTER TABLE chain_state ADD COLUMN zone_entry_price REAL;
ALTER TABLE chain_state ADD COLUMN zone_entry_time TEXT;
ALTER TABLE chain_state ADD COLUMN key_level_fvg_id INT;
ALTER TABLE chain_state ADD COLUMN mss_tf TEXT;
ALTER TABLE chain_state ADD COLUMN mss_run_high REAL;
ALTER TABLE chain_state ADD COLUMN mss_run_low REAL;
ALTER TABLE chain_state ADD COLUMN daily_bias TEXT;
ALTER TABLE chain_state ADD COLUMN bias_mode TEXT DEFAULT 'auto';
ALTER TABLE chain_state ADD COLUMN target_1 REAL;
ALTER TABLE chain_state ADD COLUMN target_2 REAL;
ALTER TABLE chain_state ADD COLUMN hard_kill_level REAL;

CREATE TABLE IF NOT EXISTS sma_cloud_config (
  id INTEGER PRIMARY KEY,
  fast_period INT NOT NULL DEFAULT 1,
  slow_period INT NOT NULL DEFAULT 9,
  separation_threshold REAL NOT NULL DEFAULT 0.15,
  velocity_threshold REAL NOT NULL DEFAULT 0.03,
  wick_penetration REAL NOT NULL DEFAULT 0.10,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO sma_cloud_config (id, fast_period, slow_period, separation_threshold, velocity_threshold, wick_penetration, updated_at) VALUES (1, 1, 9, 0.15, 0.03, 0.10, datetime('now'));
