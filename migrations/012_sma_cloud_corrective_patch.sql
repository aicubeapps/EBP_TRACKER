-- SMA Cloud corrective patch — bias_mode/htf_timeframe per-config, plus
-- forward scaffolding for Session 2 (forex SMA Cloud working-hours gate).
ALTER TABLE nse_indicator_configs ADD COLUMN bias_mode TEXT DEFAULT 'ttrades';
ALTER TABLE nse_indicator_configs ADD COLUMN htf_timeframe TEXT DEFAULT '1H';

CREATE TABLE IF NOT EXISTS user_indicator_settings (
  user_id         TEXT PRIMARY KEY,
  sma_forex_hours TEXT DEFAULT 'session',
  updated_at      INTEGER NOT NULL
);
