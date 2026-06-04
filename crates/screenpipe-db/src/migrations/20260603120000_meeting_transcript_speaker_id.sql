-- Add a global speaker_id to live meeting transcript segments so the Meeting view
-- can show the same embedding-matched, cross-meeting speaker identity that the
-- timeline/search already get via audio_transcriptions.speaker_id. Populated
-- post-hoc by DatabaseManager::backfill_meeting_segment_speakers (no FK, matching
-- audio_transcriptions.speaker_id which is also unconstrained; orphans are cleaned
-- up the same way). NULL until resolved → callers fall back to the free-text
-- speaker_name from Deepgram diarization.
ALTER TABLE meeting_transcript_segments ADD COLUMN speaker_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_meeting_transcript_segments_speaker
    ON meeting_transcript_segments(speaker_id);
