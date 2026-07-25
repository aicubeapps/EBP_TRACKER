-- Must be the very first statement in the file — PRAGMA foreign_keys is a
-- no-op once a transaction is already open (D1 enforces foreign_keys=ON by
-- default, unlike vanilla sqlite3's off-by-default), and the first DELETE
-- below would otherwise open that transaction before this pragma could apply.
PRAGMA foreign_keys = OFF;

-- Step 1: Clean up orphaned configs from soft-deleted assets
DELETE FROM user_ebp_configs WHERE asset_id IN (
  SELECT id FROM user_assets WHERE active = 0
);
DELETE FROM user_sweep_configs WHERE asset_id IN (
  SELECT id FROM user_assets WHERE active = 0
);
DELETE FROM user_templates WHERE asset_id IN (
  SELECT id FROM user_assets WHERE active = 0
);
DELETE FROM chain_state WHERE asset_id IN (
  SELECT id FROM user_assets WHERE active = 0
);

-- Step 2: Delete soft-deleted assets
DELETE FROM user_assets WHERE active = 0;

-- Step 3: Recreate user_assets without active column.
CREATE TABLE user_assets_new (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  asset_type     TEXT NOT NULL,
  added_at       INTEGER NOT NULL,
  bias_overrides TEXT DEFAULT '{}',
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- No WHERE active=1 needed — active=0 rows were already hard-deleted above.
INSERT INTO user_assets_new (id, user_id, symbol, display_name, asset_type, added_at, bias_overrides)
SELECT id, user_id, symbol, display_name, asset_type, added_at, bias_overrides
FROM user_assets;

DROP TABLE user_assets;
ALTER TABLE user_assets_new RENAME TO user_assets;

-- Step 4: Add expires_at to signals table (EBP 4H/1D/1W signals expire;
-- T3/NSE signals leave this NULL and never get swept by the Step 5 cleanup).
ALTER TABLE signals ADD COLUMN expires_at TEXT;

-- Step 5: Seed EBP signal counters (4H/1D/1W — separate from the T3/NSE
-- counters already seeded in migration 007)
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-4H','A',0);
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-1D','A',0);
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-1W','A',0);
