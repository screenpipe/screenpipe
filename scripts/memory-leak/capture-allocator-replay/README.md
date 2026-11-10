# Capture allocator retention replay

This macOS probe replays the sizes and allocation/free ordering of allocations
at least 64 KiB from a real capture trace. Sequential anonymous IDs replace
addresses; the fixture contains no pixels, text or timestamps. It includes about
9.15 GB of identified Rust allocation traffic and 279 MB of native/unclassified
traffic. This is a sequential approximation of a concurrent recording, not a
complete process or graphics-memory replay.

Both arms use the original System allocator and free every owned buffer between
rounds. They differ only in the native large-allocation cache policy. The existing
libmalloc relief call remains in both arms. On macOS XZM, the control fails the
150 MiB post-cleanup retention assertion and the fixed arm passes.

Build through the machine's existing native queue and sccache:

```sh
/usr/bin/lockf -k "$HOME/Library/Caches/screenpipe/native-build-queue/build.lock" \
  env RUSTC_WRAPPER="$(command -v sccache)" cargo build --release --manifest-path scripts/memory-leak/capture-allocator-replay/Cargo.toml
MallocLargeCache=1 scripts/memory-leak/capture-allocator-replay/target/release/screenpipe-capture-allocator-replay
MallocLargeCache=0 scripts/memory-leak/capture-allocator-replay/target/release/screenpipe-capture-allocator-replay
```

The cached arm is expected to fail. The exact footprint depends on OS/hardware.
Validate capture correctness separately through fresh durable frames, advancing
audio input and dropped-frame counters. The sck-rs native callback probe verifies
that unused callbacks no longer allocate converted RGBA screenshots.

For native CoreML retention, build the existing `rfdetr_ep_probe` example with
`onnx-coreml` through the native queue, then run:

```sh
bun scripts/memory-leak/check-native-cache.ts <probe-binary> <synthetic-positive-image>
```

Both fresh processes use the same compiled adapter, model, input and thresholds.
The check requires identical positive detections and at least 15% less
post-inference footprint with the cache disabled. This is a hardware/OS-specific
retention reproduction, not a universal model memory limit. Use a public synthetic
input, never captured private content.

The recorder sets `MallocLargeCache=0` before libmalloc initializes. Launch
Services normally supplies the setting for the app. Direct app/CLI launches do a
single PID-preserving exec before Tokio or recording starts. Explicit launcher
settings are respected. The native allocator and model/provider stay unchanged.
