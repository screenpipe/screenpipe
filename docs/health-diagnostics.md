# Health dependency and startup diagnostics

<!-- doc-covers: crates/screenpipe-core/src/health_diagnostics.rs, crates/screenpipe-engine/src/routes/health.rs -->
<!-- doc-verified: f02a3d069 -->

`GET /health` adds `dependencies`, `runtime`, `startup`, and
`unhealthy_reasons`. Existing response fields deserialize unchanged and existing
`message` text is preserved. New consumers should use the fault array for
causes and remedies; a newly detected dependency fault can make `status`
`degraded` and `status_code` 503 while the legacy pipeline message stays the same.

Health reads copy observed state. They do not discover or install binaries,
start model downloads, enumerate processes, or read startup records from disk.
The existing one-second health cache applies to these fields too. Snapshot
serialization happens after releasing the observation lock. Startup checkpoint
writers serialize with a separate mutex, and release the observation lock before
filesystem operations, so a slow checkpoint cannot hold up audio lifecycle
updates or health reads. Audio completion history is capped at 4,096 events and
expired entries are removed from the front without rescanning the whole buffer.
Checkpoint writes still run synchronously on the startup caller; they do not run
in audio callbacks.

## Observed state

- `dependencies.ffmpeg`: resolved path and source, one bounded background
  version probe per changed path, installation state and retry deadline,
  separate non-fatal version-probe errors, latest process failure, running HD/audio/extraction operations, rolling
  audio completion/failure counts, compaction activity, and HD timeout count.
- `dependencies.ffprobe`: sibling/PATH discovery when FFmpeg resolves. Missing
  ffprobe is informational; it does not establish a recording failure.
- `dependencies.models`: selected transcription engine, initialization,
  local-model download requests, Whisper download completion/failure, and
  VAD/speaker session initialization outcomes. `downloaded` means weights
  arrived; only a successful engine initialization reports `ready`.
- `runtime.onnxruntime`: actual guarded session outcomes, timeouts, and affected
  features. A model/session initialization error is `init_failed`, not a claim
  that a particular DLL is missing. CPU compatibility mode is independent.
- `startup`: boot phase, completed initialization checks, environment override
  **names only**, and the most recent failed or interrupted start. Timestamps
  in this contract are Unix seconds. The atomic `health-startup.json` checkpoint
  resides in the configured data directory and survives restarts. A previous
  attempt that never reached ready has an `unknown` termination cause; it does
  not invent a signal or exit code. Previous failures do not degrade a healthy
  current session.
- `unhealthy_reasons`: stable snake_case code, subsystem, warning severity,
  detail, remedy, and observed timestamp when available. It covers current
  media/model/runtime faults and the existing vision, audio, writer, and
  configured-but-stopped UI-recorder states. Snapshot timeout has its own code.

Process guards release counters on cancellation. A successful operation clears
only its own pipeline's failure. Media failures without a later observation
age out of current degradation after three minutes; historical error details
remain. Downloading, unknown states, and version-probe timeouts do not by
themselves cause degradation. A successful metadata probe cannot clear an actual
encode failure.
Audio-disabled runs suppress audio model/runtime faults. No capture admission,
encoding, download, or recovery policy is changed by this instrumentation.

## Remaining coverage

This is the first implementation of the broader diagnostics request, not the
complete platform dependency contract:

- MSVC, Swift, crash-helper presence, and exact loaded ONNX path/version/source
  remain `unknown` on applicable platforms. A process killed by the OS loader
  before `main` cannot write a checkpoint; it requires launcher-side reporting.
- Audiopipe's detached Parakeet/Qwen download API has no completion callback
  here. State is refreshed when the engine next initializes; only Whisper's
  download callback currently publishes a definitive download failure.
- Extraction running counts cover timeline frame extraction. Queue depth is
  `null` (unobserved), and export/merge/probe call sites are not yet instrumented.
  A corrupt input file remains a request error, not an installation diagnosis.
- Bootstrap is observed at the existing CLI/desktop boundaries; the HTTP server
  is not moved ahead of database/audio initialization. During a failed boot,
  inspect the checkpoint or logs; the next successful boot exposes its history.
- Runtime settings changes can leave dependency requirement flags conservative
  until the next recording-engine restart. Observed media operations still mark
  FFmpeg as required when used.

The domain allow/block request is already implemented separately in PR #6685;
this change does not backport it or change domain filtering.

## Focused validation

The diagnostics regression suite exercises blocked checkpoint I/O, failed-write
recovery, bounded counters, per-pipeline fault recovery, stale model callbacks,
and the healthy/degraded status matrix. Two opt-in local evals avoid timing gates
on shared CI hosts:

```sh
cargo test -p screenpipe-core health_diagnostics --lib
cargo test -p screenpipe-engine --lib routes::health
cargo test -p screenpipe-audio --lib utils::
cargo test -p screenpipe-core health_diagnostics_lifecycle_latency_eval --lib -- --ignored --nocapture
cargo test -p screenpipe-audio --lib health_diagnostics_audio_encode_eval -- --ignored --nocapture
```

The encoder eval requires FFmpeg, encodes synthetic ten-second PCM in alternating
instrumented/uninstrumented pairs, and checks that decoded audio is identical.
It opens no audio devices and uses no private recordings. These measurements do
not replace platform E2E, microphone/device-switch testing, or speech-quality
evals.
