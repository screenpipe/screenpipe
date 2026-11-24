-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com

CREATE TABLE frame_redaction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    ready_sequence INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    text_fields TEXT,
    image_regions INTEGER,
    CHECK ((text_fields IS NULL) != (image_regions IS NULL))
);
CREATE UNIQUE INDEX frame_redaction_history_receipt
    ON frame_redaction_history (ready_sequence);
CREATE INDEX frame_redaction_history_frame
    ON frame_redaction_history (frame_id);
