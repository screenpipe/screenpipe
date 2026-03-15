# E2E Cross-Platform (tauri-plugin-webdriver)

E2E tests for Screenpipe using the **cross-platform** [tauri-plugin-webdriver](https://crates.io/crates/tauri-plugin-webdriver) from crates.io. Works on **macOS, Windows, and Linux** with native WebView automation.

## 1. Plugin in the app (already done)

The app uses the **released** crate behind the **`e2e`** Cargo feature (Cargo does not support `cfg(debug_assertions)` for dependency selection):

- **Cargo.toml:** `tauri-plugin-webdriver = { version = "0.2", optional = true }` and `e2e = ["tauri-plugin-webdriver"]`
- **main.rs:** `#[cfg(feature = "e2e")]` → `.plugin(tauri_plugin_webdriver::init())`

The WebDriver server listens on **port 4445** (or `TAURI_WEBDRIVER_PORT` if set).

## 2. Build the app (debug, with e2e feature)

From **app root** (`apps/screenpipe-app-tauri`). You must pass **`--features e2e`** so the webdriver plugin is included:

```bash
bun tauri build --no-sign --debug --verbose --no-bundle -- --features e2e
```

Binary: `src-tauri/target/debug/screenpipe-app` (or `screenpipe-app.exe` on Windows).

## 3. Run E2E tests

From **app root**:

```bash
bun run test:e2e
```

(Uses the app’s single package.json; no separate install in `e2e`.)

- **onPrepare** starts the Screenpipe debug binary; the launcher waits for `http://127.0.0.1:4445/status`.
- Tests run against that WebDriver server.
- **onComplete** stops the app.

E2E runs use a **fresh data directory per run** so they never touch your real data. The launcher:

- Clears **`.e2e/`** (in the app root) and sets `SCREENPIPE_DATA_DIR` to it so each run is isolated.
- Sets `SCREENPIPE_E2E_SEED=onboarding` — Rust marks onboarding complete at startup.

## 4. One-shot: build and test

From **app root**:

```bash
./e2e/run.sh
```

Or manually:

```bash
bun tauri build --no-sign --debug --verbose --no-bundle -- --features e2e
bun run test:e2e
```

## 5. Video recording

When `RECORD_VIDEO=1`, videos are recorded for each spec file (saved to `e2e/videos/`):

```bash
RECORD_VIDEO=1 bun run test:e2e
```

## 6. Utilities

- **`waitForAppReady()`** (`e2e/helpers/test-utils.ts`) — Waits for URL to load, then pauses for stores to settle.
- **`saveScreenshot(name)`** (`e2e/helpers/screenshot-utils.ts`) — Use in any spec to capture screenshots. Output: `e2e/screenshots/<name>.png`.

## 7. Custom port

To use another port (e.g. 9515):

- Set `TAURI_WEBDRIVER_PORT=9515` when starting the app.
- In `e2e/helpers/app-launcher.ts`, set `WEBDRIVER_PORT = 9515` and use the same port in `wdio.conf.ts`.

## Reference

- **Crate:** [tauri-plugin-webdriver](https://crates.io/crates/tauri-plugin-webdriver) v0.2
- **Backends:** macOS (WKWebView), Windows (WebView2), Linux (WebKitGTK)
- No separate `tauri-wd` process; the plugin embeds the WebDriver server in the app.
