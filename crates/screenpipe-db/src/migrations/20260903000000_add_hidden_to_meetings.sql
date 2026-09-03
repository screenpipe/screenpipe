ALTER TABLE meetings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_meetings_hidden_start ON meetings(hidden, meeting_start);
