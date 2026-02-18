-- Add accessibility table to FTS indexer progress tracking.
-- The accessibility_ai INSERT trigger was dropped in 20260209000001 but the
-- background FTS indexer was not updated to handle accessibility rows.
-- This initializes the progress so the indexer starts from existing data.

INSERT OR IGNORE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'accessibility', COALESCE(MAX(id), 0) FROM accessibility;
