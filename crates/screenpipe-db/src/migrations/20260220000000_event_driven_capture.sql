-- Event-driven capture: add snapshot and accessibility columns to frames.
-- Backward compatible: all new columns are nullable with defaults.
-- Legacy video-chunk frames keep snapshot_path = NULL.

-- Step 1: Make video_chunk_id nullable for snapshot frames.
-- SQLite doesn't support ALTER COLUMN, so we rebuild the table.
-- This preserves all data and indexes.

CREATE TABLE IF NOT EXISTS frames_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_chunk_id INTEGER DEFAULT NULL,
    offset_index INTEGER NOT NULL DEFAULT 0,
    timestamp TIMESTAMP NOT NULL,
    name TEXT,
    app_name TEXT DEFAULT NULL,
    window_name TEXT DEFAULT NULL,
    focused BOOLEAN DEFAULT NULL,
    browser_url TEXT DEFAULT NULL,
    device_name TEXT NOT NULL DEFAULT '',
    sync_id TEXT,
    machine_id TEXT,
    synced_at DATETIME,
    -- New event-driven capture columns
    snapshot_path TEXT DEFAULT NULL,
    accessibility_text TEXT DEFAULT NULL,
    accessibility_tree_json TEXT DEFAULT NULL,
    content_hash INTEGER DEFAULT NULL,
    simhash INTEGER DEFAULT NULL,
    capture_trigger TEXT DEFAULT NULL,
    text_source TEXT DEFAULT NULL,
    FOREIGN KEY (video_chunk_id) REFERENCES video_chunks(id)
);

INSERT INTO frames_new (
    id, video_chunk_id, offset_index, timestamp, name,
    app_name, window_name, focused, browser_url, device_name,
    sync_id, machine_id, synced_at
)
SELECT
    id, video_chunk_id, offset_index, timestamp, name,
    app_name, window_name, focused, browser_url, device_name,
    sync_id, machine_id, synced_at
FROM frames;

DROP TABLE frames;
ALTER TABLE frames_new RENAME TO frames;

-- Recreate indexes that existed on the old table
CREATE INDEX IF NOT EXISTS idx_frames_timestamp ON frames(timestamp);
CREATE INDEX IF NOT EXISTS idx_frames_video_chunk_id ON frames(video_chunk_id);

-- New index for event-driven frame lookup
CREATE INDEX IF NOT EXISTS idx_frames_timestamp_device
  ON frames(timestamp, device_name);

-- Index for snapshot path lookups
CREATE INDEX IF NOT EXISTS idx_frames_snapshot_path
  ON frames(snapshot_path) WHERE snapshot_path IS NOT NULL;

-- Step 2: Rebuild frames_fts to include accessibility_text column.
-- Must drop and recreate because FTS5 doesn't support ALTER TABLE.
DROP TRIGGER IF EXISTS frames_ai;
DROP TRIGGER IF EXISTS frames_au;
DROP TRIGGER IF EXISTS frames_ad;
DROP TABLE IF EXISTS frames_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
    name,
    browser_url,
    app_name,
    window_name,
    focused,
    accessibility_text,
    id UNINDEXED,
    tokenize='unicode61'
);

-- Recreate triggers with accessibility_text
CREATE TRIGGER IF NOT EXISTS frames_ai AFTER INSERT ON frames BEGIN
    INSERT INTO frames_fts(id, name, browser_url, app_name, window_name, focused, accessibility_text)
    VALUES (
        NEW.id,
        COALESCE(NEW.name, ''),
        COALESCE(NEW.browser_url, ''),
        COALESCE(NEW.app_name, ''),
        COALESCE(NEW.window_name, ''),
        COALESCE(NEW.focused, 0),
        COALESCE(NEW.accessibility_text, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS frames_au AFTER UPDATE ON frames
WHEN (NEW.name IS NOT NULL AND NEW.name != '')
   OR (NEW.browser_url IS NOT NULL AND NEW.browser_url != '')
   OR (NEW.app_name IS NOT NULL AND NEW.app_name != '')
   OR (NEW.window_name IS NOT NULL AND NEW.window_name != '')
   OR (NEW.focused IS NOT NULL)
   OR (NEW.accessibility_text IS NOT NULL AND NEW.accessibility_text != '')
BEGIN
    INSERT OR REPLACE INTO frames_fts(id, name, browser_url, app_name, window_name, focused, accessibility_text)
    VALUES (
        NEW.id,
        COALESCE(NEW.name, ''),
        COALESCE(NEW.browser_url, ''),
        COALESCE(NEW.app_name, ''),
        COALESCE(NEW.window_name, ''),
        COALESCE(NEW.focused, 0),
        COALESCE(NEW.accessibility_text, '')
    );
END;

CREATE TRIGGER IF NOT EXISTS frames_ad AFTER DELETE ON frames
BEGIN
    DELETE FROM frames_fts
    WHERE id = OLD.id;
END;

-- Step 3: Reset FTS progress for frames so the background indexer
-- backfills the new (empty) frames_fts table from all existing rows.
-- Uses INSERT OR IGNORE so already-indexed rows are cheap no-ops.
UPDATE fts_index_progress SET last_indexed_rowid = 0 WHERE table_name = 'frames';
