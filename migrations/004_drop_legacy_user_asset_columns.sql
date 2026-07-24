-- Drops legacy per-asset config columns superseded by user_ebp_configs /
-- user_sweep_configs. Only columns with zero remaining code references
-- (frontend + both Workers) are included — see investigation notes in
-- the accompanying deploy report before running.
--
-- NOT dropped, despite being in the original candidate list, because they
-- are still read live:
--   timeframes        — worker/src/ebp-worker.js  GET /user/assets  (EBP status per TF)
--   sweep_enabled      — sweep-worker/src/index.js GET /sweep/dashboard
--   sweep_timeframes   — sweep-worker/src/index.js GET /sweep/dashboard

ALTER TABLE user_assets DROP COLUMN ebp_alert_mode;
ALTER TABLE user_assets DROP COLUMN sweep_alert_mode;
ALTER TABLE user_assets DROP COLUMN combined_enabled;
ALTER TABLE user_assets DROP COLUMN combined_pairs;
ALTER TABLE user_assets DROP COLUMN combined_window_mins;
