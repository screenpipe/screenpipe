<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Retrieve focused narration

<!-- doc-covers: none -->

Saved focused narration is available without transcription, including after a restart or while the desktop serves saved history after Quit.
Use the local API authentication configured for the device. Pipe callers cannot read
focused narration. History limits and vault locking still apply. Narration follows the existing audio
exemption from text/image privacy processing.

1. Request `GET /focused-recordings/{recordingId}/audio` with the focused recording UUID.
   The response contains `intervals` and `chunks`. Each chunk has `id`, `streamId`,
   `sequence`, `start`, `end` (Unix milliseconds), and `mime`.
2. Fetch each chunk at `GET /focused-recordings/{recordingId}/audio/{chunkId}`.
   The response body is the original bytes, with the stored `Content-Type`.
3. Group chunks by `streamId` and concatenate their bytes in `sequence` order,
   starting at zero. A fragment may depend on the preceding container header.
   Use the stored MIME type to play or export each complete stream.

Streams appear in capture order. Each pause/resume or microphone restart can create
a separate stream with its own container header. Keep these streams separate; do not
concatenate independent containers. Use chunk timestamps and recording intervals to
retain gaps when placing narration on a timeline. The manifest does not include
bytes, and each byte request reads at most one captured chunk.

Deleted or missing recordings and chunks return 404. A chunk must belong to the
recording in its URL. Read responses use `Cache-Control: no-store` so a later policy
change is checked on each request.
