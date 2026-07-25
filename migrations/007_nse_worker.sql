-- NSE candle cache
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

-- signals table (needed for Signal IDs — Phase I retrofits T3/T4, NSE uses from day one)
CREATE TABLE IF NOT EXISTS signals (
  signal_id     TEXT PRIMARY KEY,
  template_type TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  htf_tf        TEXT,
  ltf_tf        TEXT,
  direction     TEXT,
  fired_at      TEXT NOT NULL,
  traded        INTEGER DEFAULT 0
);

-- signal_counters table
CREATE TABLE IF NOT EXISTS signal_counters (
  template  TEXT PRIMARY KEY,
  series    TEXT DEFAULT 'A',
  count     INTEGER DEFAULT 0
);

-- Seed NSE global counter
INSERT OR IGNORE INTO signal_counters (template, series, count)
VALUES ('NSE', 'A', 0);

-- Per-user NSE timeframe access — separate from user_tf_access (forex/crypto
-- only, Phase A decision). Default: all NSE TFs enabled.
ALTER TABLE users ADD COLUMN nse_tf_access TEXT DEFAULT '["M1","M5","M15","M30","1H","D"]';
UPDATE users SET nse_tf_access = '["M1","M5","M15","M30","1H","D"]' WHERE nse_tf_access IS NULL;
