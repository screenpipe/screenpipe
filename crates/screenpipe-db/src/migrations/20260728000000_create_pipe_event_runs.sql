-- Idempotency for event-triggered pipe runs (#5481).
--
-- `meeting_ended` is not once-per-meeting: the 120s rejoin window reopens the
-- same meetings row, so ending a rejoined call emits the same meeting_id twice.
-- The scheduler's in-memory guard is keyed on pipe slug and resets every tick,
-- so two ends landing in different ticks each started a run.
--
-- One row per (pipe, event, key) the scheduler has claimed. Claims are inserted
-- with INSERT OR IGNORE, so the primary key is what makes the claim atomic.
CREATE TABLE IF NOT EXISTS pipe_event_runs (
    pipe_name  TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_key  TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (pipe_name, event_name, event_key)
);

-- Supports pruning by age.
CREATE INDEX IF NOT EXISTS idx_pipe_event_runs_claimed_at ON pipe_event_runs(claimed_at);

-- Which event instance produced a run, so duplicates are diagnosable after the
-- fact. trigger_type only says "event"; these say which one.
ALTER TABLE pipe_executions ADD COLUMN trigger_event TEXT;
ALTER TABLE pipe_executions ADD COLUMN trigger_key TEXT;
