-- EBP signal IDs now fire on M15/1H/4H/1D (not just 4H/1D/1W) — seed the
-- two new counters. EBP-1W is left in place (unused going forward, but not
-- deleted to avoid orphaning any historical 1W signal_ids that reference it).
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-M15','A',0);
INSERT OR IGNORE INTO signal_counters (template, series, count) VALUES ('EBP-1H','A',0);
