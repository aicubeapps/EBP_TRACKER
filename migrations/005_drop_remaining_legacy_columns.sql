-- Drops the last 3 legacy user_assets columns, now safe after GET /user/assets
-- (worker/src/ebp-worker.js) and GET /sweep/dashboard (sweep-worker/src/index.js)
-- were migrated to read from user_ebp_configs / user_sweep_configs instead.
--
-- Do not run until both routes have been deployed and verified live.

ALTER TABLE user_assets DROP COLUMN timeframes;
ALTER TABLE user_assets DROP COLUMN sweep_enabled;
ALTER TABLE user_assets DROP COLUMN sweep_timeframes;
