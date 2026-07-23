# Screenpipe Swift Example

![Swift example app](../../docs/screenshots/swift-example.png)

Back to the [examples index](../README.md).

This is a minimal macOS SwiftUI app that uses the Swift `ScreenpipeClient`.

The Swift SDK itself lives in the repo root:

- `Package.swift`
- `Sources/Screenpipe/ScreenpipeClient.swift`
- `Sources/Screenpipe/NodeJSONLineTransport.swift`
- `Sources/Screenpipe/ScreenpipeModels.swift`
- `Tests/ScreenpipeTests`

```bash
cd ../..
bun install
bun run build:debug
cd examples/swift-app
swift run ScreenpipeExample
```

For local development, the example uses `SCREENPIPE_SDK_ROOT` when it is set,
then falls back to this checkout. When embedding in another app, pass
`ScreenpipeClient.Configuration.localPackage(sdkRoot:)` a URL for the npm
package checkout or for a packaged copy of `@screenpipe/sdk`.

The app writes recordings to the user's Movies folder, uses the bundled Node
JSON-lines bridge, and calls `decodeJpegData()` so malformed snapshot payloads
show as errors instead of empty previews. On macOS, use the Permissions button
first so the OS can grant Screen Recording and Microphone access before capture.
