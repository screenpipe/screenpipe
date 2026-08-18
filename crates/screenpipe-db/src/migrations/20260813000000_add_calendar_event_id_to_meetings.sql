-- A calendar event describes exactly one meeting.
--
-- Without an identity column the detector re-matched a still-running event to
-- every meeting that started inside its window, stamping the same title and
-- the same attendee list onto unrelated calls. The partial unique index makes
-- that impossible at the storage layer, so every write path — detector,
-- reopen-enrichment, and the client PUT — converges on the same invariant.
ALTER TABLE meetings ADD COLUMN calendar_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_calendar_event_id
    ON meetings (calendar_event_id)
    WHERE calendar_event_id IS NOT NULL AND calendar_event_id != '';
