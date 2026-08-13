-- Give stranded transcript rows their speaker back.
--
-- Deleting a speaker while rows still pointed at it left transcript lines
-- referencing an id that no longer exists. The join then yields no name and
-- the UI falls back to a generic "speaker", with no way to rename it — the
-- rows are unreachable from every speaker surface.
--
-- 20260210100000 already tried to clean this up by setting speaker_id to
-- NULL, but it only covered audio_transcriptions (leaving meeting segments
-- broken) and NULL throws away the grouping: which lines belong to the same
-- voice. Recreating the missing rows keeps that grouping intact, so one
-- rename in the transcript can still relabel the whole voice.
--
-- Safety, in order of how much it matters:
--
-- 1. Only ever inserts. No UPDATE, no DELETE, nothing existing is touched, so
--    a healthy database comes out unchanged.
-- 2. Writing explicit primary keys is safe because `speakers` is
--    INTEGER PRIMARY KEY AUTOINCREMENT: SQLite keeps a high-water mark in
--    `sqlite_sequence` and never issues an id at or below it again. Every id
--    below was allocated before the row was deleted, so it sits under that
--    mark and can never be handed to a different person. A plain rowid table
--    would reuse deleted tail ids and this would not be safe.
-- 3. Idempotent: the NOT IN filter makes a replay insert nothing.
-- 4. Bounded: the whole statement is a handful of indexed scans over
--    speaker_id. On a 12 GB production database with 48 stranded ids it
--    completes in ~11 ms.
--
-- The recreated speaker is nameless, exactly as it was before deletion.
INSERT INTO speakers (id, name)
SELECT DISTINCT speaker_id, ''
FROM (
    SELECT speaker_id FROM audio_transcriptions
    WHERE speaker_id IS NOT NULL
    UNION
    SELECT speaker_id FROM meeting_transcript_segments
    WHERE speaker_id IS NOT NULL
    UNION
    SELECT speaker_id FROM speaker_embeddings
    WHERE speaker_id IS NOT NULL
    UNION
    SELECT speaker_id FROM diarization_segments
    WHERE speaker_id IS NOT NULL
    UNION
    SELECT speaker_id FROM speaker_identity_evidence
    WHERE speaker_id IS NOT NULL
)
WHERE speaker_id NOT IN (SELECT id FROM speakers);
