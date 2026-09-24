# Health dependency and startup diagnostics

<!-- doc-covers: crates/screenpipe-core/src/health_diagnostics.rs, crates/screenpipe-engine/src/routes/health.rs -->
<!-- doc-verified: 84c6ccc84 -->

`GET /health` adds `dependencies`, `runtime`, `startup`, and
`unhealthy_reasons`. Existing response fields deserialize unchanged and existing
`message` text is preserved. New consumers should use the fault array for
causes and remedies; a newly detected dependency fault can make `status`
`degraded` and `status_code` 503 while the legacy pipeline message stays the same.

Health reads copy observed state. They do not discover or install binaries,
start model downloads, enumerate processes, or read startup records from disk.
The existing one-second health cache applies to these fields too.

## Observed state

- `dependencies.ffmpeg`: resolved path and source, one bounded background
  version probe per changed path, installation state and retry deadline,
  latest process failure, running HD/audio/extraction operations, rolling
  audio completion/failure counts, compaction activity, and HD timeout count.
- `dependencies.ffprobe`: sibling/PATH discovery when FFmpeg resolves.
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
remain. Downloading and unknown states do not by themselves cause degradation.
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
