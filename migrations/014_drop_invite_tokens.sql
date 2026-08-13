-- Migration 014: Drop invite_tokens table
-- Invite token feature had zero enforcement: token was display-only
-- in Landing.jsx, never passed to Clerk or validated server-side.
-- Any visitor could register without a token.
-- All routes, components, and schema references removed in the same
-- commit as this migration.
-- Date: 2026-08-14
DROP TABLE IF EXISTS invite_tokens;
