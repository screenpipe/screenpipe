# Continuous transcript recall evaluations

Use disposable databases and synthetic speech to separate post-recognition
retention from acoustic recognition. These tests do not operate a microphone,
change the installed recorder, call paid providers, or establish resolution of a
particular customer's incident.

## Fast regressions

```sh
cargo test -p screenpipe-audio --test continuous_recall_test --test continuous_recall_stress_test -- --nocapture
cargo test -p screenpipe-db --test continuous_audio_recall_test --test audio_duplicate_test --test audio_segment_search_test --test chunk_outcome_test --test meeting_transcript_dedup_test --test speaker_identity_eval -- --nocapture
cargo test -p screenpipe-audio --lib transcription:: -- --nocapture --test-threads=1
```

The stress target includes 20,000 generated cleanup assertions and a minimal
cross-device timing regression. DB tests cover both insertion paths and invalid
or partial intervals. The audio unit subset is sequential because an unchanged
retry-log assertion has failed under parallel execution.

## Large replay and race probes

```sh
SCREENPIPE_RECALL_REPETITIONS=1024 SCREENPIPE_RECALL_STRESS_RECEIPT=/tmp/recall-stress.json cargo test -p screenpipe-audio --test continuous_recall_stress_test seeded_multi_day -- --ignored --nocapture
cargo test -p screenpipe-db --test continuous_audio_recall_test cross_device_interval_eval_sweep -- --ignored --nocapture
cargo test -p screenpipe-db --test continuous_audio_recall_test concurrent_echo_retention_probe -- --ignored --nocapture
cargo test -p screenpipe-db --test continuous_audio_recall_test measure_continuous -- --ignored --nocapture
```

The large replay generates 12,288 cases from 12 scenario families, seed `0x5eed`.
Two engine labels give 24,576 case runs and 49,152 submitted segments. Both labels
use the same handler; this does **not** run two recognition models. Cases include
overlap, adjacent intervals, changed details, repeated speech, multiple devices,
shared files, out-of-order arrival, silence and recognition failures. The oracle
compares full transcript occurrence counts after paginated search. The virtual
timeline spans multiple days; hardware was not recorded for that duration.
Default repetitions are 128 for a smaller manual run. Generated variations are
not independent samples of user accuracy.

The 480-case DB sweep varies capture time, segment intervals, device direction
and insertion method. It checks missing occurrences and surviving echoes. The
race probe synchronizes eight writers in each of 64 groups. It asserts retention
and separately reports extra copies; passing does not mean exactly-once dedup.
This stresses concurrent DB callers. The normal transcript consumer is serial,
so the probe does not establish this concurrency level in a customer recording.

## Acoustic eval

Requires cached Silero and quantized Whisper Large v3 Turbo models. On macOS:

```sh
RECALL_DIR=$(mktemp -d)
say -v Samantha -r 160 'Order twelve amber chairs. Send twenty birch invitations.' -o "$RECALL_DIR/sentence.aiff"
say -v Samantha -r 160 'Amber.' -o "$RECALL_DIR/short.aiff"
afconvert -f WAVE -d LEI16@16000 -c 1 "$RECALL_DIR/sentence.aiff" "$RECALL_DIR/sentence.wav"
afconvert -f WAVE -d LEI16@16000 -c 1 "$RECALL_DIR/short.aiff" "$RECALL_DIR/short.wav"
SCREENPIPE_RECALL_SENTENCE_WAV="$RECALL_DIR/sentence.wav" SCREENPIPE_RECALL_SHORT_WAV="$RECALL_DIR/short.wav" SCREENPIPE_RECALL_ACOUSTIC_RECEIPT="$RECALL_DIR/acoustic.json" cargo test -p screenpipe-audio --test continuous_recall_stress_test acoustic_vad -- --ignored --nocapture
SCREENPIPE_RECALL_SHORT_WAV="$RECALL_DIR/short.wav" SCREENPIPE_RECALL_PADDING_RECEIPT="$RECALL_DIR/padding.json" cargo test -p screenpipe-audio --test continuous_recall_stress_test short_speech_padding -- --ignored --nocapture
```

The 108 conditions vary sentence/single-word/silence, position, gain, seeded
uniform noise and input/output thresholds. They use production `prepare_segments`
with Silero and its no-diarization fallback. Six sentence conditions also run
actual CPU Whisper, then the handler and database. Acoustic assertions validate
recognized-text retention, not perfect ASR. Score recognized words separately
against the spoken reference, explicitly handling `twelve`/`12` and `twenty`/`20`.

The padding probe keeps spoken samples constant and changes surrounding silence.
Two Whisper controls explicitly bypass VAD to separate admission loss from model
recognition. It is a diagnostic, not a claim that short speech is captured.
Receipts retain rejected conditions. Keep WAV/model hashes, tool versions and
commands with results. Do not attach private recordings or account telemetry.

## Limits

Missing offsets retain the legacy capture-time heuristic; invalid/partial offsets
fail open. Valid intervals must overlap. Concurrent checks are not atomic with
insertion, and the scan remains capped at 50 candidates. Same-file exact-text
uniqueness can collapse repetition. VAD can reject sparse speech before cleanup;
no VAD threshold is tuned here. Hardware capture, device switches, diarization,
battery and final-answer completeness remain outside these tests. Large probes
are ignored manual tests using existing infrastructure, with no new CI jobs.
