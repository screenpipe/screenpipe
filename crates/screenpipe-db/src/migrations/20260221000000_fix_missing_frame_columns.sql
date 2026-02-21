-- Fix for missing event-driven capture columns on frames table.
-- An earlier version of migration 20260220000000 may have been applied
-- without accessibility_tree_json, content_hash, and simhash columns.
-- The actual column fix runs in Rust (ensure_event_driven_columns)
-- because SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS.
SELECT 1;
