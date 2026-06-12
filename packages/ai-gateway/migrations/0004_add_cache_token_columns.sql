-- Migration: Add prompt-cache token columns to cost_log
-- Tracks cache reads (discounted input) and cache writes (premium input) per
-- request so we can verify prompt caching actually reduces spend.
-- Run with: wrangler d1 execute screenpipe-usage --remote --file=./migrations/0004_add_cache_token_columns.sql
-- NOTE: logCost falls back to the legacy column set until this is applied,
-- so deploy order doesn't matter — but cache telemetry only lands after it.

ALTER TABLE cost_log ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE cost_log ADD COLUMN cache_creation_tokens INTEGER;
