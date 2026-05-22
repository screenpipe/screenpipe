# @screenpipe/sdk

Commercial screen recording SDK for Electron, Swift, Tauri, and Node apps.

The SDK exposes the capture primitives from the native
[screenpipe](https://screenpi.pe) stack: record an MP4, grab JPEG preview
snapshots, read a mic level for preflight UI, and inspect the focused app.

## SDK Surfaces

| Surface | Source | Example |
| --- | --- | --- |
| Node | [index.js](./index.js), [index.d.ts](./index.d.ts) | [examples/record-10s.mjs](./examples/record-10s.mjs) |
| Electron | [electron](./electron), [session](./session) | [examples/electron-app](./examples/electron-app) |
| Swift | [Package.swift](./Package.swift), [Sources/Screenpipe](./Sources/Screenpipe) | [examples/swift-app](./examples/swift-app) |
| Tauri | [tauri](./tauri) | [examples/tauri-app](./examples/tauri-app) |

Detailed embed notes live in [docs/integration.md](./docs/integration.md).

## Example Apps

| Electron | Swift | Tauri |
| --- | --- | --- |
| ![Electron example app](docs/screenshots/electron-example.png) | ![Swift example app](docs/screenshots/swift-example.png) | ![Tauri example app](docs/screenshots/tauri-example.png) |
| [examples/electron-app](./examples/electron-app) | [examples/swift-app](./examples/swift-app) | [examples/tauri-app](./examples/tauri-app) |

See [examples/README.md](./examples/README.md) for run commands and smoke
checks for all three apps.

## Install

```bash
npm install @screenpipe/sdk
# or
bun add @screenpipe/sdk
```

This package is source-available under the Screenpipe Enterprise License. It is
not covered by the root repository MIT license. See [LICENSE.md](./LICENSE.md).

## Node Quick Start

```ts
import { Recorder, requestPermissions } from "@screenpipe/sdk";

const permissions = await requestPermissions();
if (!permissions.screen) {
  throw new Error("Screen Recording permission is required");
}

const recorder = new Recorder({
  output: "/tmp/session.mp4",
  // Optional privacy filters — recording pauses (hard cut in the MP4)
  // while a matching window/URL is focused.
  ignoredWindows: ["1password", "private"],
  ignoredUrls: ["wellsfargo.com", "chase"],
});
await recorder.start();

// ... user does stuff ...

await recorder.stop();
```

## Core API

### `new Recorder(options)`

- `options.output` (string, required): path where the MP4 is written.
- `options.monitorId` (number, optional): display id; defaults to the primary display.
- `options.microphone` (boolean, optional): accepted for forward compatibility.
- `options.systemAudio` (boolean, optional): accepted for forward compatibility.
- `options.ignoredWindows` (string[], optional): substring patterns matched
  case-insensitively against the focused app name and window title. While a
  matching window is in focus, the recorder skips writing frames — the MP4
  contains a hard cut over the filtered period. Mirrors the engine's
  `--ignored-windows` CLI flag.
- `options.includedWindows` (string[], optional): substring whitelist. If
  non-empty, frames are written ONLY while the focused app name or window
  title matches at least one pattern. Mirrors `--included-windows`.
- `options.ignoredUrls` (string[], optional): URL patterns to skip
  (case-insensitive, domain-aware match — `chase` matches `chase.com` and
  `online.chase.com` but not `purchase.com`). When the focused browser is on
  a matching URL, the recorder skips writing frames. Mirrors `--ignored-urls`.

Filtering uses the macOS Accessibility API; without that permission the
filter fails open (records everything). Without any filter list set, the
recorder stays on the zero-overhead fast path — no a11y polling is done.

### Methods

| Method | Purpose |
| --- | --- |
| `start()` | Start screen capture and write frames into the MP4. |
| `stop()` | Stop capture, flush the MP4 trailer, and close the file. Safe to call more than once. |
| `snapshot()` | Capture the recorder's monitor as a JPEG preview. |
| `framesWritten()` | Return frames written since `start()`. |
| `audioLevel()` | Return a smoothed microphone RMS level in `[0, 1]` for preflight UI. |
| `focusedApp()` | Return best-effort focused-window metadata; requires Accessibility permission on macOS. |
| `filterStatus()` | Return `{ paused, reason }` for the window/URL filter. Poll, or subscribe via the session wrapper's `paused`/`resumed` events. |
| `setFilters(patch)` | Replace the active filter lists at runtime — `{ ignoredWindows?, includedWindows?, ignoredUrls? }`. Takes effect within ≤ 1 s. |
| `requestPermissions()` | Trigger or check supported OS permissions. |

### Filter events (session wrapper)

`createScreenpipeSession` emits `paused` and `resumed` events whenever the
filter verdict flips. Payload: `{ paused: boolean, reason: string | null }`
where `reason` is one of `"ignored_window"`, `"included_window_mismatch"`,
`"ignored_url"`, `"incognito"`, `"excluded_app"`.

```ts
session.on("paused", ({ reason }) => {
  showBanner(`recording paused — ${reason}`);
});
session.on("resumed", () => {
  hideBanner();
});

// Runtime toggle (e.g. user flips "Pause on banking" in your settings UI):
await session.setFilters({ ignoredUrls: ["chase", "wellsfargo.com"] });
```

Audio is not muxed into the MP4 in v0.1.0.

## Development

```bash
bun install
bun run build:debug
node --test --test-concurrency=1 "__test__/**/*.test.mjs"
swift test
```

Example app smoke checks:

```bash
npm --prefix examples/electron-app run smoke
npm --prefix examples/tauri-app run smoke
SCREENPIPE_SWIFT_EXAMPLE_SMOKE=1 swift run --package-path examples/swift-app ScreenpipeExample
```

Run the optional native Tauri example compile with:

```bash
SCREENPIPE_RUN_NATIVE_EXAMPLE_BUILDS=1 node --test --test-concurrency=1 __test__/examples_e2e.test.mjs
```

Before publishing:

```bash
cargo test --lib
bun run build
bun run prepublishOnly
npm pack --dry-run
```

Publish generated platform packages first, then publish the root
`@screenpipe/sdk` package.

## Platforms

| OS | Architecture | Status |
| --- | --- | --- |
| macOS | Apple Silicon | Supported |
| macOS | Intel | Supported |
| Windows | x64 | Builds in CI; runtime validation required before public launch |
| Windows | ARM64 | Builds in CI; runtime validation required before public launch |
| Linux | - | Not supported in v0.1.0 |
