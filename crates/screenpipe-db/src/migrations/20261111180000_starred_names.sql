-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com
ALTER TABLE starred_sessions ADD COLUMN name TEXT;
-- Stable local links preserve Capture pause gaps without creating a second discovery path.
CREATE TABLE focused_starred_intervals (
    recording_id TEXT NOT NULL REFERENCES focused_recordings(id) ON DELETE CASCADE,
    interval_index INTEGER NOT NULL,
    session_id TEXT NOT NULL UNIQUE REFERENCES starred_sessions(id) ON DELETE CASCADE,
    PRIMARY KEY(recording_id, interval_index)
);
