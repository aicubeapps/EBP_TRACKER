-- Migration 018: Retire old T3 template entirely
-- chain_state.template_type is uppercase ('T3'); user_templates.template
-- is lowercase ('t3') — confirmed via live code (sweep-cron.js's own
-- `template='t3'` query) and PRAGMA table_info, not assumed.
-- Date: 2026-08-15

-- Remove all active old T3 chains from chain_state
DELETE FROM chain_state WHERE template_type = 'T3';

-- Remove all old T3 template configs from user_templates
DELETE FROM user_templates WHERE template = 't3';

-- Remove T3 signal counter row (no-op if it was never seeded via a file —
-- see audit: no migration/schema file seeds a T3 row, but a live row is
-- assumed to exist out-of-band per prior code comments)
DELETE FROM signal_counters WHERE template = 'T3';
