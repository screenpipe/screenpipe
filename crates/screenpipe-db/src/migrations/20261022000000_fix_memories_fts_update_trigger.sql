-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com

-- Keep memories_fts in sync with memories whatever the content.
--
-- 20260310000000 guarded the UPDATE trigger with `WHEN OLD.content != ''`,
-- so a memory created (or once updated) with empty content was never
-- re-indexed: after `'' -> 'text'` the new text stayed out of search for
-- good. The INSERT/DELETE guards skipped empty rows too, while the UPDATE
-- trigger indexed `'text' -> ''`, so the index and the content table could
-- disagree in both directions.
--
-- Index every row unconditionally (empty content has no tokens, so this
-- costs nothing) and rebuild the index once from the content table to
-- repair rows that fell out of search under the old triggers.

DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;

CREATE TRIGGER memories_ai AFTER INSERT ON memories
BEGIN
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, COALESCE(NEW.content, ''), COALESCE(NEW.tags, ''));
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, COALESCE(OLD.content, ''), COALESCE(OLD.tags, ''));
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories
BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', OLD.id, COALESCE(OLD.content, ''), COALESCE(OLD.tags, ''));
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (NEW.id, COALESCE(NEW.content, ''), COALESCE(NEW.tags, ''));
END;

INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
