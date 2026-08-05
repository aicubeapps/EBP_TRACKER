-- Migration 013: Convert alert_history.fired_at from INTEGER (ms epoch) to TEXT (ISO 8601)
-- Reason: signals.fired_at is already TEXT ISO. Unifying both eliminates a type-mismatch
-- landmine where any future cross-table query would silently produce wrong results.
-- All isDuplicateAlert() call sites and alert_history INSERT sites in ebp-worker.js,
-- sweep-cron.js, nse-cron.js were updated to use ISO strings BEFORE this migration runs
-- (see the deploy sequence in the commit this migration ships with) — running the code
-- deploy first and the migration second is deliberate: SQLite's storage-class comparison
-- rules (NULL < INTEGER/REAL < TEXT < BLOB) mean a TEXT column value always compares
-- greater than a bound INTEGER parameter regardless of its actual content, so migrating
-- the column before the workers stop sending integer cutoffs would make every dedup
-- check spuriously report "duplicate" and silently suppress all new alerts platform-wide
-- until every worker redeploys. Deploying the code first avoids that failure mode.

-- SQLite does not support ALTER COLUMN. Rename → recreate → copy → drop.
ALTER TABLE alert_history RENAME TO alert_history_old;

CREATE TABLE alert_history (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  timeframe   TEXT NOT NULL,
  direction   TEXT NOT NULL,
  trend_bias  TEXT NOT NULL,
  candle_time INTEGER NOT NULL,
  fired_at    TEXT NOT NULL,
  alert_type  TEXT DEFAULT 'ebp',
  details     TEXT DEFAULT '{}'
);

-- typeof(fired_at) is checked per-row (SQLite's manifest typing tracks each
-- value's actual storage class independently of the column's declared
-- affinity) rather than assuming every row is still a raw integer at
-- migration time — some rows may already be ISO text if any worker was
-- redeployed with the new code before this migration ran. Converting an
-- already-ISO row via fired_at/1000 would silently corrupt it to
-- 1970-01-01 (dividing non-numeric text yields 0 in SQLite), so only
-- genuinely-integer rows get the epoch conversion.
--
-- Uses strftime with an explicit '%Y-%m-%dT%H:%M:%fZ' format, NOT
-- datetime(), which produces SQLite's own 'YYYY-MM-DD HH:MM:SS' format
-- (space separator, no 'Z', no milliseconds) — a different string shape
-- than JS's toISOString() output that the application code writes and
-- compares against. Mixing the two formats in the same column would make
-- lexicographic comparisons wrong at the character where 'T' vs ' '
-- diverges, for any pair of rows sharing the same calendar date. (This
-- was caught by testing the migration's actual output, not assumed.)
INSERT INTO alert_history
  (id, user_id, symbol, timeframe, direction, trend_bias, candle_time,
   fired_at, alert_type, details)
SELECT
  id, user_id, symbol, timeframe, direction, trend_bias, candle_time,
  CASE
    WHEN typeof(fired_at) = 'integer' THEN strftime('%Y-%m-%dT%H:%M:%fZ', fired_at / 1000, 'unixepoch')
    ELSE fired_at
  END,
  alert_type, details
FROM alert_history_old;

DROP TABLE alert_history_old;
