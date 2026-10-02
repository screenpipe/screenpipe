-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com
CREATE TABLE starred_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    hd_requested INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    CHECK (end > start)
);
CREATE INDEX idx_starred_sessions_start_end ON starred_sessions(start, end);
