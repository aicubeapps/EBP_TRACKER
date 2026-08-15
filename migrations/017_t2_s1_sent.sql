-- Migration 017: T2 chain s1_sent flag — needed to compute correct /S1../S4
-- signal-ID suffixes in sweep-cron.js, since whether S1 actually sent (vs.
-- armed silently because the plain EBP alert already covered this user) is
-- decided in ebp-worker.js and has no other durable record.
-- Date: 2026-08-15
ALTER TABLE chain_state ADD COLUMN s1_sent INT DEFAULT 0;
