# Example Apps

The repo carries one runnable example per host framework. Each example is kept
small and uses the SDK surface an app would use in production.

| App | Preview | Run | Smoke check |
| --- | --- | --- | --- |
| [Electron](./electron-app) | ![Electron example app](../docs/screenshots/electron-example.png) | `npm --prefix examples/electron-app install && npm --prefix examples/electron-app start` | `npm --prefix examples/electron-app run smoke` |
| [Swift](./swift-app) | ![Swift example app](../docs/screenshots/swift-example.png) | `swift run --package-path examples/swift-app ScreenpipeExample` | `SCREENPIPE_SWIFT_EXAMPLE_SMOKE=1 swift run --package-path examples/swift-app ScreenpipeExample` |
| [Tauri](./tauri-app) | ![Tauri example app](../docs/screenshots/tauri-example.png) | `npm --prefix examples/tauri-app install && npm --prefix examples/tauri-app run dev` | `npm --prefix examples/tauri-app run smoke` |

## Before Running UI Apps

Build the native addon from the repo root:

```bash
bun install
bun run build
```

The headless smoke checks use the checked-out package directly and are safe for
CI. The UI apps may prompt for Screen Recording, Microphone, and Accessibility
permissions depending on the platform and which features you press.

## Full Example Validation

```bash
node --test --test-concurrency=1 __test__/examples_e2e.test.mjs
```

Set `SCREENPIPE_RUN_NATIVE_EXAMPLE_BUILDS=1` to include the optional native
Tauri example compile.
