# Integration Notes

This page keeps framework-specific embed details out of the root README while
leaving the important paths easy to find.

## Support Telemetry Context

The SDK itself does not send first-party Screenpipe telemetry. If your app
launches the Screenpipe CLI or engine and you want Screenpipe support to
recognize the deployment in Sentry/PostHog, set opaque support IDs before
starting Screenpipe:

```bash
export SCREENPIPE_SUPPORT_ID="spcust_acme_123"
export SCREENPIPE_CUSTOMER_ID="acme"
export SCREENPIPE_DEPLOYMENT_ID="prod-laptop-fleet-01"
export SCREENPIPE_EMBEDDER="acme-agent"
export SCREENPIPE_EMBEDDER_VERSION="2026.6.4"
```

Use IDs instead of emails. See
[`docs/telemetry-support-context.md`](../../../docs/telemetry-support-context.md)
for the full env contract and aliases.

## Electron

Native modules should stay in Electron's main process. The SDK ships
main/preload helpers so app code does not need to design recorder state,
permission, snapshot, reveal, or IPC channel handling from scratch.

Main process:

```js
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { registerScreenpipeIpc } = require("@screenpipe/sdk/electron");

app.whenReady().then(() => {
  const screenpipe = registerScreenpipeIpc({
    ipcMain,
    app,
    shell,
    sessionOptions: {
      outputDir: () => app.getPath("videos"),
      filenamePrefix: "my-app-recording",
    },
  });

  app.on("before-quit", () => {
    screenpipe.session.dispose().catch(() => {});
  });

  new BrowserWindow({
    webPreferences: {
      preload: require("node:path").join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
});
```

Preload:

```js
const { exposeScreenpipeApi } = require("@screenpipe/sdk/electron/preload");

exposeScreenpipeApi({ name: "screenpipe" });
```

Renderer:

```js
await window.screenpipe.permissions();
await window.screenpipe.start();
const live = await window.screenpipe.snapshot();
await window.screenpipe.stop();
```

`snapshot()` returns `{ jpeg, recording, output, frames, bytes, audioLevel,
focusedApp, errors }` so renderer code can build live preview, meters, status,
save, and reveal flows without touching native modules.

## Swift

The repo is a Swift package named `Screenpipe`. It exposes an async
`ScreenpipeClient` with the same session lifecycle as Electron.

Important files:

- [Package.swift](../Package.swift)
- [Sources/Screenpipe/ScreenpipeClient.swift](../Sources/Screenpipe/ScreenpipeClient.swift)
- [Sources/Screenpipe/NodeJSONLineTransport.swift](../Sources/Screenpipe/NodeJSONLineTransport.swift)
- [Sources/Screenpipe/ScreenpipeModels.swift](../Sources/Screenpipe/ScreenpipeModels.swift)
- [Tests/ScreenpipeTests](../Tests/ScreenpipeTests)
- [Swift example app](../examples/swift-app/Sources/ScreenpipeExample/ScreenpipeExampleApp.swift)

```swift
import Screenpipe

let client = try ScreenpipeClient(
  configuration: .localPackage(
    sdkRoot: URL(fileURLWithPath: "/path/to/screenpipe/ee/sdk"),
    commandTimeout: 30
  )
)

let permissions = try await client.permissions(timeoutMs: 7_500)
let outputDirectory = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask).first
let started = try await client.start(
  ScreenpipeStartOptions(
    outputDirectoryURL: outputDirectory ?? FileManager.default.temporaryDirectory,
    filenamePrefix: "my-app-recording"
  )
)
let preview = try await client.snapshot()
let jpegData = try preview.decodeJpegData()
let outputURL = started.outputURL
let stopped = try await client.stop()
try await client.reveal(fileAt: stopped.outputURL)
```

The Swift SDK uses a bundled Node JSON-lines bridge over the published
`@screenpipe/sdk` native addon. For local development, pass `sdkRoot` to this
checkout or set `SCREENPIPE_SDK_ROOT`. `nodeExecutable` may be an absolute path
or a command available on `PATH`, such as `node`.

For tests and previews, `ScreenpipeClient(transport:)` accepts any
`ScreenpipeTransport` implementation. Swift request option structs are
`Codable`, so apps can persist or test them without hand-mapping bridge keys.

## Tauri

Tauri v2 apps can use the frontend helper and Rust plugin together.

Frontend:

```js
import { createScreenpipeTauriClient } from "@screenpipe/sdk/tauri";

const screenpipe = createScreenpipeTauriClient();
await screenpipe.permissions({ timeoutMs: 7500 });
await screenpipe.start({ filenamePrefix: "my-tauri-app" });
const snapshot = await screenpipe.snapshot();
await screenpipe.stop();
```

Rust:

```rust
use screenpipe_tauri::{init, ScreenpipeConfig};

tauri::Builder::default()
    .plugin(init(
        ScreenpipeConfig::new("node_modules/@screenpipe/sdk/bridges/node-json-session.mjs")
            .sdk_root("node_modules/@screenpipe/sdk")
    ))
    .run(tauri::generate_context!())?;
```

## Native Stack

The SDK wraps the same primitives used by the main ScreenPipe project:

- `screenpipe_screen::SafeMonitor::capture_image` for screen frames.
- `screenpipe_core::video::{start_ffmpeg_process, write_frame_to_ffmpeg, finish_ffmpeg_process}` for MP4 encoding.
- `screenpipe_a11y::tree` for focused-window metadata.

The SDK lives in `ee/sdk` and uses local path dependencies for the Screenpipe
core crates, so SDK changes can be reviewed with the public monorepo code they
wrap.
