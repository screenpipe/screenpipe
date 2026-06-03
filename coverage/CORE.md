# Core Engine Coverage Map

This is a behavioral coverage dashboard for Screenpipe's core Rust crates.
It is not line or branch coverage. A mapped suite contributes coverage to
each declared platform and layer based on non-ignored Rust test blocks,
confidence, and criticality.

- Manifest: `coverage/core-engine-map.json`
- Tracked crates: screenpipe-engine, screenpipe-db, screenpipe-audio, screenpipe-screen, screenpipe-a11y
- Mapped suites: 24
- Mapped Rust files: 191
- Active test blocks: 1641
- Ignored/manual test blocks: 108
- Declared test blocks: 1749
- Weighted coverage points: 1366.8

Confidence weights: strong=1.0, partial=0.7, conditional=0.4, smoke=0.3.
Criticality weights: high=1.0, medium=0.7, low=0.4.
Ignored tests are counted but do not contribute weighted points until they
are explicitly enabled in a runtime lane.

## Platform Summary

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 21 | 1544 | 105 | 1321.0 | 21 | 11 | 100% |
| macos | 21 | 1596 | 85 | 1339.1 | 22 | 11 | 100% |
| linux | 19 | 1533 | 82 | 1310.4 | 20 | 11 | 100% |

## Crate Summary

| Crate | Suites | Integration files | Source unit files | Active tests | Ignored tests | Weighted points | Flows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| screenpipe-engine | 6 | 14 | 49 | 659 | 40 | 489.9 | 10 |
| screenpipe-db | 4 | 27 | 5 | 289 | 4 | 280.3 | 9 |
| screenpipe-audio | 5 | 23 | 28 | 282 | 35 | 245.2 | 5 |
| screenpipe-screen | 5 | 9 | 9 | 168 | 4 | 167.4 | 4 |
| screenpipe-a11y | 4 | 2 | 25 | 243 | 25 | 184.0 | 3 |

## Line Coverage

No `cargo llvm-cov` summary was supplied. Behavioral flow coverage above answers
which product risks are represented by tests; line/branch coverage should be
measured separately with `cargo llvm-cov` when the Rust toolchain is available.

Suggested command from the repo root:

```bash
cargo llvm-cov --workspace --summary-only --output-format json > coverage/core-llvm-cov-summary.json
```

Then regenerate with:

```bash
cd apps/screenpipe-app-tauri
bun run coverage:core -- --llvm-cov-summary ../../coverage/core-llvm-cov-summary.json
```

## Layer Matrix

| Layer | windows | macos | linux |
| --- | --- | --- | --- |
| accessibility | 4 suites / 251 active / 24 ignored / 234.5 pts | 4 suites / 295 active / 5 ignored / 244.3 pts | 4 suites / 243 active / 2 ignored / 225.1 pts |
| audio | 6 suites / 365 active / 36 ignored / 328.2 pts | 6 suites / 365 active / 36 ignored / 328.2 pts | 6 suites / 365 active / 36 ignored / 328.2 pts |
| audio-device | 1 suites / 76 active / 4 ignored / 76.0 pts | 1 suites / 76 active / 4 ignored / 76.0 pts | 1 suites / 76 active / 4 ignored / 76.0 pts |
| configuration | 2 suites / 114 active / 3 ignored / 105.3 pts | 2 suites / 114 active / 3 ignored / 105.3 pts | 2 suites / 114 active / 3 ignored / 105.3 pts |
| database | 3 suites / 210 active / 4 ignored / 201.3 pts | 3 suites / 210 active / 4 ignored / 201.3 pts | 3 suites / 210 active / 4 ignored / 201.3 pts |
| db-search | 2 suites / 80 active / 5 ignored / 80.0 pts | 2 suites / 80 active / 5 ignored / 80.0 pts | 2 suites / 80 active / 5 ignored / 80.0 pts |
| engine-lifecycle | 2 suites / 99 active / 1 ignored / 97.6 pts | 2 suites / 99 active / 1 ignored / 97.6 pts | 1 suites / 97 active / 1 ignored / 97.0 pts |
| local-api | 2 suites / 104 active / 7 ignored / 73.1 pts | 2 suites / 104 active / 7 ignored / 73.1 pts | 2 suites / 104 active / 7 ignored / 73.1 pts |
| meeting | 4 suites / 622 active / 11 ignored / 493.3 pts | 4 suites / 622 active / 11 ignored / 493.3 pts | 4 suites / 622 active / 11 ignored / 493.3 pts |
| ocr | 4 suites / 81 active / 3 ignored / 80.4 pts | 4 suites / 89 active / 2 ignored / 88.7 pts | 3 suites / 80 active / 2 ignored / 79.7 pts |
| os-integration | 1 suites / 2 active / 0 ignored / 0.6 pts | 1 suites / 2 active / 0 ignored / 0.6 pts | - |
| performance | 10 suites / 875 active / 54 ignored / 798.7 pts | 11 suites / 945 active / 57 ignored / 826.7 pts | 10 suites / 875 active / 54 ignored / 798.7 pts |
| pipes | 1 suites / 326 active / 6 ignored / 228.2 pts | 1 suites / 326 active / 6 ignored / 228.2 pts | 1 suites / 326 active / 6 ignored / 228.2 pts |
| privacy | 5 suites / 654 active / 39 ignored / 540.2 pts | 5 suites / 698 active / 20 ignored / 550.0 pts | 5 suites / 646 active / 17 ignored / 530.9 pts |
| real-app | - | 1 suites / 70 active / 3 ignored / 28.0 pts | - |
| speaker | 2 suites / 193 active / 3 ignored / 193.0 pts | 2 suites / 193 active / 3 ignored / 193.0 pts | 2 suites / 193 active / 3 ignored / 193.0 pts |
| storage | 2 suites / 240 active / 27 ignored / 201.0 pts | 2 suites / 240 active / 27 ignored / 201.0 pts | 2 suites / 240 active / 27 ignored / 201.0 pts |
| sync | 1 suites / 326 active / 6 ignored / 228.2 pts | 1 suites / 326 active / 6 ignored / 228.2 pts | 1 suites / 326 active / 6 ignored / 228.2 pts |
| timeline | 4 suites / 500 active / 30 ignored / 430.1 pts | 4 suites / 500 active / 30 ignored / 430.1 pts | 4 suites / 500 active / 30 ignored / 430.1 pts |
| transcription | 5 suites / 309 active / 33 ignored / 241.3 pts | 5 suites / 309 active / 33 ignored / 241.3 pts | 5 suites / 309 active / 33 ignored / 241.3 pts |
| ui-events | 4 suites / 498 active / 30 ignored / 383.7 pts | 3 suites / 472 active / 8 ignored / 365.5 pts | 3 suites / 472 active / 8 ignored / 365.5 pts |
| vision-capture | 4 suites / 289 active / 28 ignored / 249.4 pts | 4 suites / 297 active / 27 ignored / 257.7 pts | 3 suites / 288 active / 27 ignored / 248.7 pts |

## Critical Flow Matrix

| Flow | Required layers | windows | macos | linux |
| --- | --- | --- | --- | --- |
| Settings to engine recording config | configuration | covered (strong; engine-config-lifecycle, db-accessibility-ui-events) | covered (strong; engine-config-lifecycle, db-accessibility-ui-events) | covered (strong; engine-config-lifecycle, db-accessibility-ui-events) |
| Engine health, sleep, and lifecycle | engine-lifecycle | covered (strong; engine-config-lifecycle, engine-focus-os) | covered (strong; engine-config-lifecycle, engine-focus-os) | covered (strong; engine-config-lifecycle) |
| Capture, OCR, and frame persistence | vision-capture, ocr | covered (partial; screen-capture-ocr-contract, screen-windows-ocr) | covered (strong; screen-macos-ocr, screen-capture-ocr-contract) | covered (partial; screen-capture-ocr-contract) |
| Timeline frame and stream delivery | timeline | covered (strong; screen-capture-windowing, db-timeline-frames) | covered (strong; screen-capture-windowing, db-timeline-frames) | covered (strong; screen-capture-windowing, db-timeline-frames) |
| Local API search and indexing | local-api, db-search | covered (strong; engine-local-api-search-integration) | covered (strong; engine-local-api-search-integration) | covered (strong; engine-local-api-search-integration) |
| Audio record, transcribe, and reconcile | audio, transcription | covered (strong; audio-meetings-speakers-dedup, audio-transcription-pipeline) | covered (strong; audio-meetings-speakers-dedup, audio-transcription-pipeline) | covered (strong; audio-meetings-speakers-dedup, audio-transcription-pipeline) |
| Audio device and stream health | audio-device | covered (strong; audio-device-stream-health) | covered (strong; audio-device-stream-health) | covered (strong; audio-device-stream-health) |
| Meeting detection and live transcript merge | meeting | covered (strong; engine-meeting-privacy-sync, audio-meetings-speakers-dedup) | covered (strong; engine-meeting-privacy-sync, audio-meetings-speakers-dedup) | covered (strong; engine-meeting-privacy-sync, audio-meetings-speakers-dedup) |
| Privacy filters, DRM guards, and redaction | privacy | covered (strong; engine-meeting-privacy-sync, screen-capture-windowing) | covered (strong; engine-meeting-privacy-sync, screen-capture-windowing) | covered (strong; engine-meeting-privacy-sync, screen-capture-windowing) |
| Accessibility tree and UI event capture | accessibility, ui-events | covered (strong; a11y-core-tree-cross-platform, a11y-windows-tree) | covered (strong; a11y-core-tree-cross-platform, db-accessibility-ui-events) | covered (strong; a11y-core-tree-cross-platform, db-accessibility-ui-events) |
| Performance, backpressure, and liveness | performance | covered (strong; screen-capture-windowing, a11y-core-tree-cross-platform) | covered (strong; screen-capture-windowing, a11y-core-tree-cross-platform) | covered (strong; screen-capture-windowing, a11y-core-tree-cross-platform) |

## Critical Gaps

- windows: no critical gaps in the current manifest.
- macos: no critical gaps in the current manifest.
- linux: no critical gaps in the current manifest.

## Execution Integrity

- Every discovered integration test file in tracked crates is mapped to a suite.
- Every discovered source unit test file in tracked crates is mapped to a suite.
- Both integration and source unit test files are enforced by `--check`.
- Suites with only ignored/manual tests: screen-custom-ocr. They do not contribute weighted points until explicitly run.
- Static counts do not prove a test executed on a given CI runner. Platform `cfg` gates, ignored tests, missing devices, and skipped runtime paths still need job results or llvm-cov data.

## Suite Inventory

| Suite | Crate | Platforms | Layers | Flows | Criticality | Confidence | Kind | Files | Active | Ignored | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a11y-core-tree-cross-platform | screenpipe-a11y | windows, macos, linux | accessibility, ui-events, privacy, performance | accessibility-ui-events, privacy-and-redaction, performance-liveness | high | strong | unit | 11 | 129 | 0 | Cross-platform accessibility config, tree normalization, cache, privacy title matching, events, budget, and activity feed units. |
| a11y-linux-tree | screenpipe-a11y | linux | accessibility, privacy | accessibility-ui-events, privacy-and-redaction | medium | partial | unit | 4 | 18 | 0 | Linux-specific accessibility/incognito normalization tests. |
| a11y-macos-tree | screenpipe-a11y | macos | accessibility, privacy, real-app, performance | accessibility-ui-events, privacy-and-redaction, performance-liveness | high | conditional | mixed | 6 | 70 | 3 | macOS AX unit coverage plus real TextEdit/Finder/Obsidian probes. Obsidian tests are ignored by default because they require a local app install and AX permission. |
| a11y-windows-tree | screenpipe-a11y | windows | accessibility, privacy, ui-events | accessibility-ui-events, privacy-and-redaction | high | partial | unit | 6 | 26 | 22 | Windows UIA/accessibility parsing and privacy matching; some UIA tests are ignored where they require a live desktop. |
| audio-device-stream-health | screenpipe-audio | windows, macos, linux | audio-device, audio, performance | audio-device-health, audio-record-transcribe, performance-liveness | high | strong | mixed | 12 | 76 | 4 | Device monitor, stream buffering, source lag, Bluetooth gap/hallucination regressions, and process-tap/unit coverage. |
| audio-meetings-speakers-dedup | screenpipe-audio | windows, macos, linux | audio, meeting, speaker, transcription | audio-record-transcribe, meeting-live-notes, performance-liveness | high | strong | mixed | 17 | 110 | 2 | Meeting streaming config/controller logic, speaker embedding state, cross-device dedupe simulations, and overlap cleanup coverage. |
| audio-models-filtering | screenpipe-audio | windows, macos, linux | audio, transcription, privacy | audio-record-transcribe, privacy-and-redaction | medium | partial | mixed | 5 | 16 | 10 | Model-download/TLS guards, ONNX startup smoke, and music-versus-speech filtering. |
| audio-pipeline-benchmarks | screenpipe-audio | windows, macos, linux | audio, transcription, performance | audio-record-transcribe, meeting-live-notes, performance-liveness | medium | partial | benchmark | 8 | 22 | 12 | Benchmark-backed regression probes for VAD, smart mode, meeting audio, quality, cross-device, and end-to-end pipeline timing. |
| audio-transcription-pipeline | screenpipe-audio | windows, macos, linux | audio, transcription, performance | audio-record-transcribe, meeting-live-notes, performance-liveness | high | partial | mixed | 9 | 58 | 7 | Batch deferral, cleanup, language detection, result normalization, and real recording/transcription tests. Hardware/model-heavy tests are ignored by default. |
| db-accessibility-ui-events | screenpipe-db | windows, macos, linux | database, configuration, accessibility, ui-events, performance | settings-to-engine-config, accessibility-ui-events, performance-liveness | medium | partial | integration | 5 | 17 | 2 | Elements bulk insert, on-screen filtering, UI event batching, DB tier config, and ignored heavy-read real-DB probes. |
| db-audio-meetings-speakers | screenpipe-db | windows, macos, linux | database, audio, meeting, speaker | audio-record-transcribe, audio-device-health, meeting-live-notes | high | strong | integration | 11 | 83 | 1 | Audio transcript dedupe, live meeting mirroring, open meeting invariants, liveness, and speaker reassignment coverage. |
| db-search-indexing | screenpipe-db | windows, macos, linux | db-search, ocr, accessibility, performance | local-api-search, capture-ocr-pipeline, accessibility-ui-events, performance-liveness | high | strong | mixed | 8 | 79 | 0 | FTS, tokenizer, OCR snapshot search, query planning, ordering, accessibility search, and contention coverage. |
| db-timeline-frames | screenpipe-db | windows, macos, linux | database, timeline, storage, performance | timeline-streaming, performance-liveness | high | strong | mixed | 8 | 110 | 1 | Frame/audio joins, timeline query shape, suggestions frames, write queue, DB primitives, and timeline performance. |
| engine-api-routes | screenpipe-engine | windows, macos, linux | local-api, timeline, meeting, transcription | local-api-search, timeline-streaming, meeting-live-notes, audio-record-transcribe | high | partial | mixed | 12 | 103 | 2 | Route/unit coverage for search, health, streaming, meetings, time/timezone, and transcription. Legacy endpoint/websocket tests require local data and remain ignored. |
| engine-capture-timeline | screenpipe-engine | windows, macos, linux | vision-capture, timeline, storage, performance | capture-ocr-pipeline, timeline-streaming, performance-liveness | high | partial | mixed | 18 | 130 | 26 | Covers capture trigger logic, frame/audio linking, hot cache, timeline refresh regressions, fragmented MP4 extraction, and HD-mode control. Several real-data tests are intentionally ignored by default. |
| engine-config-lifecycle | screenpipe-engine | windows, macos, linux | configuration, engine-lifecycle, performance | settings-to-engine-config, engine-health-lifecycle, performance-liveness | high | strong | mixed | 9 | 97 | 1 | Fast logic coverage for the config bridge, tray health debounce, sleep/power policies, and queue backpressure. |
| engine-focus-os | screenpipe-engine | windows, macos | engine-lifecycle, os-integration | engine-health-lifecycle, performance-liveness | medium | conditional | unit | 2 | 2 | 0 | Platform focus-tracker parsing/helpers. These files are cfg-gated and only execute on their target OS. |
| engine-local-api-search-integration | screenpipe-engine | windows, macos, linux | local-api, db-search | local-api-search | high | strong | integration | 1 | 1 | 5 | Active /search route test builds an audio-disabled router, seeds captured-screen-shaped OCR data into an in-memory DB, and asserts the HTTP response and pagination. |
| engine-meeting-privacy-sync | screenpipe-engine | windows, macos, linux | meeting, privacy, ui-events, pipes, sync | meeting-live-notes, privacy-and-redaction, accessibility-ui-events, performance-liveness | medium | strong | unit | 21 | 326 | 6 | Unit-heavy coverage for meeting heuristics, privacy filter policy, UI recorder safety, pipes, sync helpers, and CLI parsing. |
| screen-capture-ocr-contract | screenpipe-screen | windows, macos, linux | vision-capture, ocr | capture-ocr-pipeline | high | partial | unit | 1 | 1 | 0 | Cross-platform cached-OCR unit coverage for RawCaptureResult to CaptureResult metadata, browser URL, focus state, and window-to-screen OCR coordinate transformation. |
| screen-capture-windowing | screenpipe-screen | windows, macos, linux | vision-capture, timeline, performance, privacy | capture-ocr-pipeline, timeline-streaming, privacy-and-redaction, performance-liveness | high | strong | mixed | 13 | 157 | 1 | Window filtering, empty-window regressions, retry policy, URL timing, monitor cache, OCR cache, snapshots, and image comparison. |
| screen-custom-ocr | screenpipe-screen | windows, macos, linux | ocr | capture-ocr-pipeline | medium | conditional | manual | 1 | 0 | 2 | Custom OCR tests are ignored by default and only contribute when explicitly run. |
| screen-macos-ocr | screenpipe-screen | macos | ocr, vision-capture | capture-ocr-pipeline | high | strong | mixed | 2 | 9 | 0 | Apple Vision OCR source/unit coverage and fixture OCR assertions. |
| screen-windows-ocr | screenpipe-screen | windows | ocr, vision-capture | capture-ocr-pipeline | high | partial | integration | 1 | 1 | 1 | Windows OCR fixture coverage plus an ignored continuous-capture probe that requires a live desktop. |

## File Inventory

| Suite | Crate | File | Scope | Active | Ignored | Declared |
| --- | --- | --- | --- | --- | --- | --- |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/activity_feed.rs | source | 7 | 0 | 7 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/budget.rs | source | 9 | 0 | 9 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/config.rs | source | 8 | 0 | 8 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/events.rs | source | 4 | 0 | 4 |
| a11y-linux-tree | screenpipe-a11y | src/incognito/linux.rs | source | 2 | 0 | 2 |
| a11y-macos-tree | screenpipe-a11y | src/incognito/macos.rs | source | 7 | 0 | 7 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/incognito/mod.rs | source | 7 | 0 | 7 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/incognito/titles.rs | source | 27 | 0 | 27 |
| a11y-windows-tree | screenpipe-a11y | src/incognito/windows.rs | source | 2 | 0 | 2 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/lib.rs | source | 2 | 0 | 2 |
| a11y-linux-tree | screenpipe-a11y | src/platform/linux.rs | source | 4 | 0 | 4 |
| a11y-macos-tree | screenpipe-a11y | src/platform/macos.rs | source | 10 | 0 | 10 |
| a11y-windows-tree | screenpipe-a11y | src/platform/windows_uia_tests.rs | source | 0 | 12 | 12 |
| a11y-windows-tree | screenpipe-a11y | src/platform/windows_uia.rs | source | 4 | 10 | 14 |
| a11y-windows-tree | screenpipe-a11y | src/platform/windows.rs | source | 10 | 0 | 10 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/tree/cache.rs | source | 6 | 0 | 6 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/tree/electron_docs.rs | source | 17 | 0 | 17 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/tree/enhanced_mode_cache.rs | source | 13 | 0 | 13 |
| a11y-linux-tree | screenpipe-a11y | src/tree/linux_lines.rs | source | 3 | 0 | 3 |
| a11y-linux-tree | screenpipe-a11y | src/tree/linux.rs | source | 9 | 0 | 9 |
| a11y-macos-tree | screenpipe-a11y | src/tree/macos_lines.rs | source | 12 | 0 | 12 |
| a11y-macos-tree | screenpipe-a11y | src/tree/macos.rs | source | 33 | 0 | 33 |
| a11y-core-tree-cross-platform | screenpipe-a11y | src/tree/mod.rs | source | 29 | 0 | 29 |
| a11y-windows-tree | screenpipe-a11y | src/tree/windows_lines.rs | source | 2 | 0 | 2 |
| a11y-windows-tree | screenpipe-a11y | src/tree/windows.rs | source | 8 | 0 | 8 |
| a11y-macos-tree | screenpipe-a11y | tests/e2e_obsidian.rs | integration | 0 | 3 | 3 |
| a11y-macos-tree | screenpipe-a11y | tests/e2e_tree_walker.rs | integration | 8 | 0 | 8 |
| audio-device-stream-health | screenpipe-audio | src/audio_manager/device_monitor.rs | source | 23 | 0 | 23 |
| audio-device-stream-health | screenpipe-audio | src/audio_manager/manager.rs | source | 7 | 0 | 7 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/audio_manager/reconciliation.rs | source | 10 | 0 | 10 |
| audio-device-stream-health | screenpipe-audio | src/core/device_detection.rs | source | 7 | 0 | 7 |
| audio-device-stream-health | screenpipe-audio | src/core/device.rs | source | 4 | 0 | 4 |
| audio-device-stream-health | screenpipe-audio | src/core/e2e_ghost_word_silent_room.rs | source | 0 | 2 | 2 |
| audio-transcription-pipeline | screenpipe-audio | src/core/engine.rs | source | 9 | 0 | 9 |
| audio-device-stream-health | screenpipe-audio | src/core/process_tap.rs | source | 10 | 0 | 10 |
| audio-transcription-pipeline | screenpipe-audio | src/core/run_record_and_transcribe.rs | source | 7 | 0 | 7 |
| audio-device-stream-health | screenpipe-audio | src/core/source_buffer.rs | source | 6 | 0 | 6 |
| audio-device-stream-health | screenpipe-audio | src/core/stream.rs | source | 8 | 0 | 8 |
| audio-device-stream-health | screenpipe-audio | src/idle_detector.rs | source | 4 | 0 | 4 |
| audio-device-stream-health | screenpipe-audio | src/lib.rs | source | 3 | 0 | 3 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/meeting_detector.rs | source | 2 | 0 | 2 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/meeting_streaming/config.rs | source | 9 | 0 | 9 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/meeting_streaming/controller.rs | source | 11 | 0 | 11 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/meeting_streaming/deepgram_live.rs | source | 4 | 0 | 4 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/meeting_streaming/selected_engine.rs | source | 2 | 0 | 2 |
| audio-models-filtering | screenpipe-audio | src/models/download.rs | source | 4 | 3 | 7 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/speaker/embedding_manager.rs | source | 8 | 0 | 8 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/speaker/mod.rs | source | 11 | 1 | 12 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/speaker/models.rs | source | 3 | 0 | 3 |
| audio-meetings-speakers-dedup | screenpipe-audio | src/speaker/segment.rs | source | 1 | 0 | 1 |
| audio-transcription-pipeline | screenpipe-audio | src/transcription/deepgram/batch.rs | source | 5 | 0 | 5 |
| audio-transcription-pipeline | screenpipe-audio | src/transcription/openai_compatible/batch.rs | source | 3 | 0 | 3 |
| audio-transcription-pipeline | screenpipe-audio | src/transcription/transcription_result.rs | source | 8 | 0 | 8 |
| audio-transcription-pipeline | screenpipe-audio | src/transcription/whisper/detect_language.rs | source | 4 | 0 | 4 |
| audio-models-filtering | screenpipe-audio | src/utils/audio/music_detection.rs | source | 6 | 0 | 6 |
| audio-transcription-pipeline | screenpipe-audio | tests/accuracy_test.rs | integration | 0 | 1 | 1 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/audio_fixtures.rs | integration | 6 | 0 | 6 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/cross_device_benchmark.rs | integration | 1 | 1 | 2 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/ground_truth.rs | integration | 2 | 0 | 2 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/meeting_benchmark.rs | integration | 3 | 1 | 4 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/pipeline_benchmark.rs | integration | 1 | 2 | 3 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/quality_regression.rs | integration | 3 | 4 | 7 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/smart_mode_benchmark.rs | integration | 4 | 1 | 5 |
| audio-pipeline-benchmarks | screenpipe-audio | tests/audio_pipeline_benchmark/vad_benchmark.rs | integration | 2 | 3 | 5 |
| audio-transcription-pipeline | screenpipe-audio | tests/batch_deferral_test.rs | integration | 21 | 0 | 21 |
| audio-device-stream-health | screenpipe-audio | tests/bluetooth_gap_hallucination_test.rs | integration | 1 | 2 | 3 |
| audio-device-stream-health | screenpipe-audio | tests/channel_lag_test.rs | integration | 3 | 0 | 3 |
| audio-transcription-pipeline | screenpipe-audio | tests/core_tests.rs | integration | 1 | 6 | 7 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/dedup_benchmark/fixtures.rs | integration | 3 | 0 | 3 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/dedup_benchmark/integration.rs | integration | 12 | 0 | 12 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/dedup_benchmark/metrics.rs | integration | 3 | 0 | 3 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/dedup_benchmark/scenarios.rs | integration | 10 | 0 | 10 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/dedup_benchmark/simulation.rs | integration | 3 | 0 | 3 |
| audio-models-filtering | screenpipe-audio | tests/hf_tls_test.rs | integration | 0 | 2 | 2 |
| audio-models-filtering | screenpipe-audio | tests/music_detection_real.rs | integration | 6 | 0 | 6 |
| audio-models-filtering | screenpipe-audio | tests/onnx_model_test.rs | integration | 0 | 5 | 5 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/overlap_dedup_test.rs | integration | 16 | 0 | 16 |
| audio-meetings-speakers-dedup | screenpipe-audio | tests/speaker_identification.rs | integration | 2 | 1 | 3 |
| db-timeline-frames | screenpipe-db | src/db.rs | source | 31 | 0 | 31 |
| db-search-indexing | screenpipe-db | src/text_normalizer.rs | source | 17 | 0 | 17 |
| db-search-indexing | screenpipe-db | src/text_similarity.rs | source | 18 | 0 | 18 |
| db-timeline-frames | screenpipe-db | src/types.rs | source | 3 | 0 | 3 |
| db-timeline-frames | screenpipe-db | src/write_queue.rs | source | 16 | 0 | 16 |
| db-audio-meetings-speakers | screenpipe-db | tests/audio_duplicate_test.rs | integration | 12 | 0 | 12 |
| db-audio-meetings-speakers | screenpipe-db | tests/chunk_outcome_test.rs | integration | 14 | 0 | 14 |
| db-accessibility-ui-events | screenpipe-db | tests/db_config_test.rs | integration | 5 | 0 | 5 |
| db-timeline-frames | screenpipe-db | tests/db.rs | integration | 34 | 0 | 34 |
| db-timeline-frames | screenpipe-db | tests/frame_offset_sync_test.rs | integration | 6 | 0 | 6 |
| db-search-indexing | screenpipe-db | tests/fts_contention_test.rs | integration | 4 | 0 | 4 |
| db-search-indexing | screenpipe-db | tests/fts_dots_test.rs | integration | 13 | 0 | 13 |
| db-accessibility-ui-events | screenpipe-db | tests/heavy_read_test.rs | integration | 0 | 2 | 2 |
| db-search-indexing | screenpipe-db | tests/keyword_search_accessibility_test.rs | integration | 5 | 0 | 5 |
| db-search-indexing | screenpipe-db | tests/keyword_search_order_test.rs | integration | 3 | 0 | 3 |
| db-timeline-frames | screenpipe-db | tests/live_coverage_marker_test.rs | integration | 6 | 0 | 6 |
| db-audio-meetings-speakers | screenpipe-db | tests/meeting_context_test.rs | integration | 1 | 0 | 1 |
| db-audio-meetings-speakers | screenpipe-db | tests/meeting_end_reason_test.rs | integration | 9 | 0 | 9 |
| db-audio-meetings-speakers | screenpipe-db | tests/meeting_transcript_dedup_test.rs | integration | 1 | 0 | 1 |
| db-accessibility-ui-events | screenpipe-db | tests/ocr_elements_bulk_test.rs | integration | 4 | 0 | 4 |
| db-accessibility-ui-events | screenpipe-db | tests/on_screen_filter_test.rs | integration | 5 | 0 | 5 |
| db-audio-meetings-speakers | screenpipe-db | tests/output_audio_liveness_test.rs | integration | 8 | 0 | 8 |
| db-search-indexing | screenpipe-db | tests/query_plan_test.rs | integration | 15 | 0 | 15 |
| db-search-indexing | screenpipe-db | tests/search_ocr_snapshot_test.rs | integration | 4 | 0 | 4 |
| db-audio-meetings-speakers | screenpipe-db | tests/single_open_meeting_invariant_test.rs | integration | 3 | 0 | 3 |
| db-audio-meetings-speakers | screenpipe-db | tests/speaker_benchmark.rs | integration | 0 | 1 | 1 |
| db-audio-meetings-speakers | screenpipe-db | tests/speaker_reassignment_test.rs | integration | 13 | 0 | 13 |
| db-timeline-frames | screenpipe-db | tests/suggestions_frames_table_test.rs | integration | 3 | 0 | 3 |
| db-audio-meetings-speakers | screenpipe-db | tests/timeline_live_meeting_test.rs | integration | 8 | 0 | 8 |
| db-timeline-frames | screenpipe-db | tests/timeline_performance_test.rs | integration | 11 | 1 | 12 |
| db-accessibility-ui-events | screenpipe-db | tests/ui_events_batch_test.rs | integration | 3 | 0 | 3 |
| db-audio-meetings-speakers | screenpipe-db | tests/untranscribed_chunks_test.rs | integration | 14 | 0 | 14 |
| engine-meeting-privacy-sync | screenpipe-engine | src/calendar_speaker_id.rs | source | 41 | 0 | 41 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/install.rs | source | 4 | 0 | 4 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/mod.rs | source | 15 | 0 | 15 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/presets.rs | source | 9 | 0 | 9 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/search.rs | source | 7 | 0 | 7 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/store_file.rs | source | 12 | 0 | 12 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cli/team.rs | source | 10 | 0 | 10 |
| engine-meeting-privacy-sync | screenpipe-engine | src/cloud_search.rs | source | 3 | 0 | 3 |
| engine-meeting-privacy-sync | screenpipe-engine | src/connections_api.rs | source | 39 | 0 | 39 |
| engine-meeting-privacy-sync | screenpipe-engine | src/drm_detector.rs | source | 19 | 2 | 21 |
| engine-capture-timeline | screenpipe-engine | src/event_driven_capture.rs | source | 28 | 0 | 28 |
| engine-meeting-privacy-sync | screenpipe-engine | src/external_memory_sync.rs | source | 7 | 0 | 7 |
| engine-capture-timeline | screenpipe-engine | src/focus_aware_controller.rs | source | 12 | 0 | 12 |
| engine-focus-os | screenpipe-engine | src/focus_tracker/darwin.rs | source | 1 | 0 | 1 |
| engine-focus-os | screenpipe-engine | src/focus_tracker/windows.rs | source | 1 | 0 | 1 |
| engine-capture-timeline | screenpipe-engine | src/frame_linker_actor.rs | source | 2 | 0 | 2 |
| engine-capture-timeline | screenpipe-engine | src/frame_linker.rs | source | 10 | 0 | 10 |
| engine-capture-timeline | screenpipe-engine | src/hd_recorder.rs | source | 1 | 0 | 1 |
| engine-capture-timeline | screenpipe-engine | src/high_fps_controller.rs | source | 25 | 0 | 25 |
| engine-capture-timeline | screenpipe-engine | src/hot_frame_cache.rs | source | 4 | 0 | 4 |
| engine-config-lifecycle | screenpipe-engine | src/logging.rs | source | 18 | 0 | 18 |
| engine-meeting-privacy-sync | screenpipe-engine | src/mcp_servers_api.rs | source | 12 | 0 | 12 |
| engine-meeting-privacy-sync | screenpipe-engine | src/meeting_detector.rs | source | 80 | 3 | 83 |
| engine-meeting-privacy-sync | screenpipe-engine | src/meeting_export.rs | source | 7 | 1 | 8 |
| engine-meeting-privacy-sync | screenpipe-engine | src/meeting_telemetry.rs | source | 4 | 0 | 4 |
| engine-meeting-privacy-sync | screenpipe-engine | src/pipe_store.rs | source | 21 | 0 | 21 |
| engine-config-lifecycle | screenpipe-engine | src/power/manager.rs | source | 2 | 0 | 2 |
| engine-config-lifecycle | screenpipe-engine | src/power/monitor.rs | source | 3 | 0 | 3 |
| engine-config-lifecycle | screenpipe-engine | src/power/profile.rs | source | 24 | 0 | 24 |
| engine-meeting-privacy-sync | screenpipe-engine | src/privacy_filter.rs | source | 3 | 0 | 3 |
| engine-config-lifecycle | screenpipe-engine | src/recording_config.rs | source | 10 | 0 | 10 |
| engine-api-routes | screenpipe-engine | src/routes/activity_summary.rs | source | 51 | 0 | 51 |
| engine-api-routes | screenpipe-engine | src/routes/health.rs | source | 4 | 0 | 4 |
| engine-api-routes | screenpipe-engine | src/routes/meetings.rs | source | 3 | 0 | 3 |
| engine-api-routes | screenpipe-engine | src/routes/memories.rs | source | 4 | 0 | 4 |
| engine-api-routes | screenpipe-engine | src/routes/retranscribe.rs | source | 3 | 0 | 3 |
| engine-api-routes | screenpipe-engine | src/routes/search.rs | source | 7 | 0 | 7 |
| engine-api-routes | screenpipe-engine | src/routes/streaming.rs | source | 5 | 0 | 5 |
| engine-api-routes | screenpipe-engine | src/routes/time.rs | source | 8 | 0 | 8 |
| engine-api-routes | screenpipe-engine | src/routes/timezone.rs | source | 8 | 0 | 8 |
| engine-config-lifecycle | screenpipe-engine | src/schedule_monitor.rs | source | 6 | 0 | 6 |
| engine-config-lifecycle | screenpipe-engine | src/sleep_monitor.rs | source | 8 | 1 | 9 |
| engine-capture-timeline | screenpipe-engine | src/snapshot_compaction.rs | source | 13 | 0 | 13 |
| engine-meeting-privacy-sync | screenpipe-engine | src/sync_api.rs | source | 6 | 0 | 6 |
| engine-meeting-privacy-sync | screenpipe-engine | src/sync_provider.rs | source | 1 | 0 | 1 |
| engine-meeting-privacy-sync | screenpipe-engine | src/ui_recorder.rs | source | 24 | 0 | 24 |
| engine-capture-timeline | screenpipe-engine | src/video_utils.rs | source | 6 | 0 | 6 |
| engine-capture-timeline | screenpipe-engine | src/vision_manager/manager.rs | source | 5 | 0 | 5 |
| engine-meeting-privacy-sync | screenpipe-engine | src/workflow_classifier.rs | source | 2 | 0 | 2 |
| engine-capture-timeline | screenpipe-engine | tests/audio_vision_integration_test.rs | integration | 0 | 1 | 1 |
| engine-config-lifecycle | screenpipe-engine | tests/consumer_sleep_test.rs | integration | 5 | 0 | 5 |
| engine-local-api-search-integration | screenpipe-engine | tests/endpoint_test.rs | integration | 1 | 5 | 6 |
| engine-capture-timeline | screenpipe-engine | tests/first_frames_test.rs | integration | 0 | 4 | 4 |
| engine-capture-timeline | screenpipe-engine | tests/frame_extraction_test.rs | integration | 1 | 5 | 6 |
| engine-capture-timeline | screenpipe-engine | tests/frame_linker_actor_integration.rs | integration | 7 | 0 | 7 |
| engine-config-lifecycle | screenpipe-engine | tests/health_debounce_test.rs | integration | 21 | 0 | 21 |
| engine-capture-timeline | screenpipe-engine | tests/stream_frames_test.rs | integration | 0 | 5 | 5 |
| engine-api-routes | screenpipe-engine | tests/tags_test.rs | integration | 5 | 0 | 5 |
| engine-capture-timeline | screenpipe-engine | tests/timeline_refresh_bug_test.rs | integration | 16 | 0 | 16 |
| engine-api-routes | screenpipe-engine | tests/transcribe_test.rs | integration | 5 | 1 | 6 |
| engine-capture-timeline | screenpipe-engine | tests/video_cache_test.rs | integration | 0 | 8 | 8 |
| engine-capture-timeline | screenpipe-engine | tests/video_utils_test.rs | integration | 0 | 3 | 3 |
| engine-api-routes | screenpipe-engine | tests/websockets_test.rs | integration | 0 | 1 | 1 |
| screen-macos-ocr | screenpipe-screen | src/apple.rs | source | 7 | 0 | 7 |
| screen-capture-windowing | screenpipe-screen | src/browser_utils/mod.rs | source | 13 | 0 | 13 |
| screen-capture-windowing | screenpipe-screen | src/capture_screenshot_by_window.rs | source | 60 | 0 | 60 |
| screen-capture-ocr-contract | screenpipe-screen | src/core.rs | source | 1 | 0 | 1 |
| screen-capture-windowing | screenpipe-screen | src/frame_comparison.rs | source | 13 | 0 | 13 |
| screen-capture-windowing | screenpipe-screen | src/monitor.rs | source | 6 | 1 | 7 |
| screen-capture-windowing | screenpipe-screen | src/ocr_cache.rs | source | 10 | 0 | 10 |
| screen-capture-windowing | screenpipe-screen | src/snapshot_writer.rs | source | 4 | 0 | 4 |
| screen-capture-windowing | screenpipe-screen | src/utils.rs | source | 5 | 0 | 5 |
| screen-macos-ocr | screenpipe-screen | tests/apple_vision_test.rs | integration | 2 | 0 | 2 |
| screen-capture-windowing | screenpipe-screen | tests/capture_error_test.rs | integration | 4 | 0 | 4 |
| screen-capture-windowing | screenpipe-screen | tests/capture_retry_test.rs | integration | 16 | 0 | 16 |
| screen-custom-ocr | screenpipe-screen | tests/custom_ocr_test.rs | integration | 0 | 2 | 2 |
| screen-capture-windowing | screenpipe-screen | tests/empty_window_name_test.rs | integration | 9 | 0 | 9 |
| screen-capture-windowing | screenpipe-screen | tests/frame_window_mismatch_test.rs | integration | 3 | 0 | 3 |
| screen-capture-windowing | screenpipe-screen | tests/monitor_cache_test.rs | integration | 7 | 0 | 7 |
| screen-capture-windowing | screenpipe-screen | tests/url_timing_test.rs | integration | 7 | 0 | 7 |
| screen-windows-ocr | screenpipe-screen | tests/windows_vision_test.rs | integration | 1 | 1 | 2 |
