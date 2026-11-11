-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com
-- Focused capture owns its lifecycle separately from ambient recording policy.
CREATE TABLE focused_recordings (
    id TEXT PRIMARY KEY NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('recording','paused','summary','submitted','deleted')),
    created_at INTEGER NOT NULL,
    current_slot INTEGER NOT NULL DEFAULT 1 CHECK(current_slot IN (0,1)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE UNIQUE INDEX focused_recordings_one_draft ON focused_recordings((1))
    WHERE current_slot=1 AND phase IN ('recording','paused','summary');

-- The raw narration is available before transcription. Chunk IDs make retries
-- idempotent; each stream's sequence retains its container byte order.
CREATE TABLE focused_recording_audio (
    id TEXT PRIMARY KEY NOT NULL,
    recording_id TEXT NOT NULL REFERENCES focused_recordings(id) ON DELETE CASCADE,
    stream_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 0),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
    mime TEXT NOT NULL,
    audio BLOB NOT NULL,
    UNIQUE(recording_id,stream_id,sequence)
);

-- A narration preference belongs to the device, not to a disposable workflow.
CREATE TABLE focused_recording_preferences (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    voice_enabled INTEGER NOT NULL CHECK(voice_enabled IN (0,1))
);
