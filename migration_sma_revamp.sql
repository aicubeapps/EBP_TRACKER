-- SMA Cloud revamp — Phase D++ corrective rewrite (2026-08-05)

-- 1. Rename stack_mode to confirmation_mode
--    Existing 'strict'/'loose' values become 'either' via app-level fallback
--    (nse-cron.js normalises any value outside 'mss'/'cisd'/'either' to 'either')
ALTER TABLE nse_indicator_configs RENAME COLUMN stack_mode TO confirmation_mode;

-- 2. Add four new CISD watch columns, plus the two SMA-value columns the
--    fresh-cross detector (freshCrossBull/freshCrossBear) needs to diff
--    against the prior run — nse_sma_state had no persisted SMA1/SMA9
--    values before this revamp.
ALTER TABLE nse_sma_state ADD COLUMN cisd_watch_active INTEGER DEFAULT 0;
ALTER TABLE nse_sma_state ADD COLUMN cisd_watch_direction TEXT;
ALTER TABLE nse_sma_state ADD COLUMN cisd_pullback_start TEXT;
ALTER TABLE nse_sma_state ADD COLUMN cisd_watch_armed_at TEXT;
ALTER TABLE nse_sma_state ADD COLUMN sma1_last REAL;
ALTER TABLE nse_sma_state ADD COLUMN sma9_last REAL;

-- 3. Reset all nse_sma_state rows — old phase machine state is incompatible
DELETE FROM nse_sma_state;
