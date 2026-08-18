# Batch Audio Transcription (Idle Processing)

<!-- doc-covers: crates/screenpipe-audio -->
<!-- doc-verified: a2681111e -->
> **Historical.** Last verified against a2681111e (2026-02-14). `crates/screenpipe-audio` has moved a long way
> since; read this for original intent only. Names, signatures, and thresholds are
> probably wrong. The code wins. Run `bun scripts/check-doc-freshness.ts` for current drift.

## Problem

Whisper inference on Metal (GPU) competes with video call apps (Zoom, Meet, Teams, FaceTime) for GPU resources. Users report lag during calls and have to quit screenpipe — defeating the purpose of recording everything.

**Root cause:** Real-time transcription runs Whisper Large v3 Turbo (1.6GB model) on Metal every ~21-30 seconds, consuming 27-29% CPU and significant GPU bandwidth. Video call apps also need Metal for encoding/decoding.

## Solution

Defer audio transcription to idle periods. Audio is still captured and saved to disk in real-time (no data loss), but Whisper inference only runs when the system isn't under load. This is acceptable because screenpipe is a search-your-history tool — users don't need live captions, they need transcriptions available before they search.

## User Experience

### Default behavior (no change for most users)
- Real-time transcription continues as today
- Users who don't use video calls see zero difference

### When system is under load
1. Audio recording continues uninterrupted — .mp4 files are saved to disk as usual
2. Transcription pauses automatically
3. Tray icon shows a subtle indicator (e.g., "● recording (transcription paused)")
4. Health endpoint reports pending transcription count

### When system becomes idle
1. Transcription resumes automatically, processing the backlog
2. Backlog processes oldest-first (chronological order)
3. Tray indicator returns to normal when caught up
4. Search results for the backlog period become available progressively

### User controls (Settings → Recording)
- **Transcription mode**: "Real-time" (default) | "Smart (pause during high load)" | "Manual batch"
- **CPU threshold**: slider, default 70% — above this, transcription pauses
- **Backlog indicator**: visible in health/tray when pending > 0

### Search during backlog
- Searches return results for all content where transcription is complete
- Audio segments pending transcription appear as "pending transcription" in results (file exists, text not yet available)
- Once transcribed, they appear normally — no user action needed

## Technical Spec

### Architecture

The current pipeline:
```
Capture → .mp4 to disk → Whisper inference → DB insert
                          (real-time, blocking)
```

New pipeline:
```
Capture → .mp4 to disk → [idle?] → YES → Whisper inference → DB insert
                              → NO  → queue segment metadata for later
```

Audio files are **already saved to disk before transcription**. The change is: instead of immediately running Whisper, we check system load first and potentially defer.

### Timestamp fix (critical)

**Current bug:** `audio_transcriptions.timestamp` uses `Utc::now()` at DB insertion time, not audio capture time. Today this is ~3-7 seconds off (transcription latency). With batch mode, it could be minutes or hours off.

**Fix:** Pass the original capture timestamp through the pipeline and use it for the DB insert. The `AudioInput` struct already carries timing info from the capture loop — thread it through to `insert_audio_transcription()`.

### Idle detection

Define "idle" as ALL of:
- System CPU usage < threshold (default 70%) for 30+ seconds
- No known video call app in foreground (Zoom, zoom.us, Google Meet, Microsoft Teams, FaceTime, Discord, Slack huddle, Webex)

Check interval: every 10 seconds.

Video call app detection: check running processes or frontmost app name. On macOS, use `NSWorkspace.shared.frontmostApplication`. On Windows, check foreground window process name.

### Pending segments tracking

Option A (simple): Keep segments in the existing crossbeam channel. The channel is bounded at 1000 segments. At 30s per segment, that's ~8.3 hours of audio. If the channel fills, fall back to real-time transcription (don't drop audio).

Option B (durable): New DB table for pending segments with file path and capture timestamp. Survives app restarts. Adds complexity but handles edge cases (crash recovery, multi-day backlogs).

**Recommendation:** Start with Option A. 1000 segments / 8.3 hours is sufficient for any reasonable meeting day. Add Option B later if users hit limits.

### Backlog processing

When idle detected:
1. Resume draining the recording channel
2. Process segments chronologically (oldest first)
3. Re-check idle status between segments — if load spikes, pause again
4. Continue until channel is empty

GPU batching optimization (future): process multiple segments per Whisper model load to reduce init/teardown overhead.

### Health endpoint changes

Add to `/health` response:
```json
{
  "audio_pipeline": {
    ... existing fields ...
    "transcription_mode": "realtime" | "batched",
    "pending_segments": 42,
    "oldest_pending_age_secs": 1800,
    "batch_paused_reason": "cpu_high" | "video_call_detected" | null
  }
}
```

### Tray menu changes

When pending > 0:
```
● recording (12 segments pending transcription)
```

When caught up:
```
● recording
```

### Settings store keys

```
transcriptionMode: "realtime" | "smart" | "manual"  (default: "realtime")
batchCpuThreshold: number (0-100, default: 70)
```

## Constraints

1. **Zero data loss** — Audio files must always be saved to disk regardless of transcription state. Never drop audio.
2. **Capture timestamp accuracy** — Transcription results must carry the original capture timestamp, not the processing timestamp. This is a bug fix independent of batch mode.
3. **No quality degradation** — Same model, same parameters, same segmentation. Only timing changes.
4. **Graceful degradation** — If idle detection fails or channel fills, fall back to real-time transcription. Never silently stop transcribing.
5. **Backward compatible** — Default mode is "realtime" (current behavior). Batch mode is opt-in.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Back-to-back meetings all day (8h) | Channel holds up to ~8.3h of segments. If exceeded, spill to real-time processing (accept GPU load) rather than drop. |
| User searches during backlog | Returns all completed transcriptions. Pending segments shown as "pending". |
| App crash with pending segments | With Option A (channel), pending segments are lost (but .mp4 files exist on disk — future: rescan). With Option B (DB), pending segments survive. |
| Laptop sleep during backlog | On wake, idle detector resumes. If CPU is low, batch processing continues. |
| User switches from "smart" to "realtime" mid-backlog | Immediately resume real-time processing. Drain any pending backlog first. |
| User disables audio recording | Stop capturing. Pending backlog still processes to completion. |
| Multiple audio devices | Each device's segments enter the same channel. Processing is device-agnostic. |
| Deepgram engine (not Whisper) | Batch mode still applies — Deepgram API calls are deferred too. Reduces API call frequency during meetings. |

## Metrics & Observability

Add to `AudioPipelineMetrics`:
- `segments_deferred: AtomicU64` — segments sent to batch queue instead of real-time
- `segments_batch_processed: AtomicU64` — segments processed from batch queue
- `batch_pause_events: AtomicU64` — number of times batch mode activated
- `batch_resume_events: AtomicU64` — number of times batch processing resumed

PostHog events:
- `batch_transcription_activated` — with reason (cpu_high, video_call)
- `batch_transcription_resumed` — with pending_count, idle_duration
- `batch_backlog_cleared` — with total_segments, total_duration

## Implementation Phases

### Phase 1: Timestamp fix + pause flag (1-2 days)
- Fix `audio_transcriptions.timestamp` to use capture time
- Add `transcription_paused` AtomicBool to AudioManager
- Add idle detection (CPU threshold only, no app detection yet)
- Add `pending_segments` to health endpoint
- Add setting: `transcriptionMode`

### Phase 2: Video call detection + UX (1-2 days)
- Detect video call apps (Zoom, Meet, Teams, etc.)
- Tray menu indicator for pending segments
- Settings UI for transcription mode and CPU threshold

### Phase 3: Robustness (future)
- DB-backed pending queue (crash recovery)
- GPU batching (process multiple segments per model load)
- Disk cleanup for old audio files
- "Rescan" feature: re-transcribe .mp4 files that were never processed

## Non-Goals

- Live captioning / real-time subtitle display (different feature)
- Model switching based on load (e.g., auto-downgrade to Whisper Tiny)
- Per-device transcription scheduling
- Cloud offloading of transcription during load
