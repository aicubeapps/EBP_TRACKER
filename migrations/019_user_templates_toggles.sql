-- Migration 019: user_templates toggle columns for T2/T3/T4
-- chain_state got these in migration 016, but user_templates (the source
-- these toggles are read FROM) never did — every T2/T3 chain has been
-- silently defaulting since Phases 6/8 with no way for a user to actually
-- configure otherwise. Adding T4's needed columns at the same time rather
-- than piecemeal.
-- Date: 2026-08-15

ALTER TABLE user_templates ADD COLUMN ote_enabled INT DEFAULT 1;
ALTER TABLE user_templates ADD COLUMN sweep_required INT DEFAULT 0;
ALTER TABLE user_templates ADD COLUMN trigger_type TEXT DEFAULT 'cisd';
ALTER TABLE user_templates ADD COLUMN mss_tf TEXT DEFAULT '1H';
ALTER TABLE user_templates ADD COLUMN bias_mode TEXT DEFAULT 'auto';
ALTER TABLE user_templates ADD COLUMN manual_bias TEXT DEFAULT 'bullish';
