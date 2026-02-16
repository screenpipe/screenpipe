-- Deferred FTS indexing: drop synchronous INSERT triggers.
--
-- Previously, every INSERT into frames, ocr_text, audio_transcriptions, and
-- ui_events fired a trigger that synchronously updated the FTS5 index.
-- This added ~0.5-1ms per row to the write transaction, extending lock hold time.
--
-- A background FTS indexer now batch-indexes new rows every 30 seconds.
-- Search results lag by ≤30s, which is invisible for a recording tool.
--
-- DELETE and UPDATE triggers are kept for correctness (these are rare operations).

-- Drop INSERT triggers only
DROP TRIGGER IF EXISTS frames_ai;
DROP TRIGGER IF EXISTS ocr_text_ai;
DROP TRIGGER IF EXISTS audio_transcriptions_ai;
DROP TRIGGER IF EXISTS ui_events_ai;
DROP TRIGGER IF EXISTS accessibility_ai;
DROP TRIGGER IF EXISTS ui_monitoring_ai;
DROP TRIGGER IF EXISTS chunked_text_index_ai;

-- Create progress tracking table for the background FTS indexer
CREATE TABLE IF NOT EXISTS fts_index_progress (
    table_name TEXT PRIMARY KEY,
    last_indexed_rowid INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize with current max rowids so we don't re-index existing data
-- (existing data was already indexed by the old triggers)
INSERT OR IGNORE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'frames', COALESCE(MAX(id), 0) FROM frames;

INSERT OR IGNORE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'ocr_text', COALESCE(MAX(rowid), 0) FROM ocr_text;

INSERT OR IGNORE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'audio_transcriptions', COALESCE(MAX(rowid), 0) FROM audio_transcriptions;

INSERT OR REPLACE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'ui_events', COALESCE(MAX(rowid), 0) FROM ui_events;

INSERT OR IGNORE INTO fts_index_progress (table_name, last_indexed_rowid)
SELECT 'ui_monitoring', COALESCE(MAX(rowid), 0) FROM ui_monitoring;
