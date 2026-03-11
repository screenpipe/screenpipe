-- Memory system: persistent facts, preferences, decisions, and insights
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    source_context TEXT,
    tags TEXT DEFAULT '[]',
    importance REAL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);

-- FTS5 for full-text search (external content mode)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    tags,
    content='memories',
    content_rowid='id',
    tokenize='unicode61'
);

-- Sync triggers
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
WHEN NEW.content IS NOT NULL AND NEW.content != ''
BEGIN
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, NEW.content, COALESCE(NEW.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
WHEN OLD.content IS NOT NULL AND OLD.content != ''
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, OLD.content, COALESCE(OLD.tags, ''));
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
WHEN OLD.content IS NOT NULL AND OLD.content != ''
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, OLD.content, COALESCE(OLD.tags, ''));
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, COALESCE(NEW.content, ''), COALESCE(NEW.tags, ''));
END;
