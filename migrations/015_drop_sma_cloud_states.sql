-- Migration 015: Drop orphaned sma_cloud_states table
-- Never read or written after SMA state migration to forex_sma_state and
-- nse_sma_state.
-- Row count at drop time: 0
-- Date: 2026-08-14
DROP TABLE IF EXISTS sma_cloud_states;
