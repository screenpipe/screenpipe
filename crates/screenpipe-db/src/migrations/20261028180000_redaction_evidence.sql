-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com

CREATE TABLE redaction_evidence (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    method TEXT NOT NULL,
    evidence TEXT NOT NULL,
    policy TEXT,
    UNIQUE(kind,record_id,field,method)
);

CREATE TABLE redaction_records (
    kind TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    PRIMARY KEY(kind,record_id)
);
