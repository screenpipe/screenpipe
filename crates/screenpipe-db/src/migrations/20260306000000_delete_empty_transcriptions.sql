-- Delete transcription rows with empty or whitespace-only text.
-- These were created by update_audio_transcription (overlap cleanup)
-- which lacked an empty-text guard. The corresponding audio chunks
-- are kept so reconciliation can re-transcribe them if needed.
DELETE FROM audio_transcriptions WHERE TRIM(transcription) = '' OR transcription IS NULL;
