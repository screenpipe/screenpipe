# Software AEC regression replay

This offline executable feeds the production `SonoraAecProcessor`. It does not open a microphone, speaker, network connection, or transcription model. Use public speech fixtures, never customer recordings in public reports.

Fetch the repository's LFS `test_data/speaker_identification/obama.wav` and `6_speakers.wav`, then from the repository root:

```sh
ffmpeg -i crates/screenpipe-audio/test_data/speaker_identification/obama.wav -t 30 -ar 16000 -ac 1 -f f32le /tmp/aec-speech.f32
ffmpeg -i crates/screenpipe-audio/test_data/speaker_identification/6_speakers.wav -t 30 -ar 16000 -ac 1 -f f32le /tmp/aec-second.f32
cargo run -p screenpipe-audio --example aec_replay -- /tmp/aec-speech.f32 /tmp/aec-second.f32
cargo run -p screenpipe-audio --example aec_replay -- /tmp/aec-second.f32 /tmp/aec-speech.f32
cargo test -p screenpipe-audio --lib aec
cargo test -p screenpipe-audio --lib captured_audio
```

The echo-only microphone is `0.55 * render[t-60ms] + 0.15 * render[t-80ms]`. The score excludes the first five seconds. It measures energy attenuation through the entire configured processor (AEC, noise suppression, AGC), **not pure ERLE or intelligibility**. Tests assert complete microphone sample counts, >20 dB attenuation for aligned and jitter/burst cases, and no unexpected bypass. Missing reference must preserve raw audio; this is deliberately not cancellation. The simultaneous-speech check mixes a second speech fixture and requires identical output with/without 100 ms receive-order jitter, plus a non-silent result.

A reference deliberately mislabeled 500 ms into the future tests sample preservation only. It still has poor cancellation: a synthetic wrong timestamp does not become correct by retaining samples. The capture-channel timestamp tests separately verify that subscriber scheduling no longer introduces that offset.

Observed before/after on macOS arm64, with the same pinned Sonora revision:

| Case | Before | After |
| --- | --- | --- |
| 100 ms mic-first delivery, fixture A / B | -0.53 / -3.23 dB | 79.76 / 54.23 dB |
| 1.5 s aligned bursts, A / B | Lost 137,920 / 160,000 mic samples | All samples returned; 79.76 / 54.23 dB |
| Future reference, both fixtures | Lost 7,840 mic samples | All samples returned; cancellation still poor |
| Missing reference, fixture B | Echo energy increased 10.64 dB | Raw passthrough, 0 dB; tail emitted at shutdown |
| Simultaneous speech with 100 ms jitter | Not covered by old replay | Bit identical to aligned delivery, both fixture orders |

The old three failing unit regressions were reproduced before modifying the processor: 100 ms capture prematurely bypassed; a 24,000-sample paired burst returned 16,000; an 8,000-sample capture preceding a new reference returned 160. They now pass.

Recorder tests cover selecting Meeting Tap, same-name replacement at 48/16/44.1 kHz within a segment, disconnect fallback, resampling duration, and final partial frames. Capture times are producer-delivery estimates on a common monotonic clock, not native hardware presentation timestamps. Physical acoustic paths, nonlinear speakers, long clock drift, Windows/Linux native builds, and macOS VoiceProcessingIO remain separate acceptance checks. This replay does not establish that a particular customer incident is resolved.
