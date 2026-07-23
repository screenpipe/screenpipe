# E2E Tests

Cross-platform E2E for Screenpipe using [tauri-plugin-webdriver](https://crates.io/crates/tauri-plugin-webdriver). macOS, Windows, Linux.

## Run

From `apps/screenpipe-app-tauri`:

**1. Build**

```bash
bun tauri build --no-sign --debug --verbose --no-bundle -- --features e2e
```

- `--no-sign` — skip code signing (dev)
- `--debug` — debug build, faster than release
- `--verbose` — show build output
- `--no-bundle` — binary only, no installer
- `-- --features e2e` — enable WebDriver plugin

**2. Run tests**

```bash
bun run test:e2e
```

**Run the macOS audio fallback spec**

```bash
bun run test:e2e:audio-fallback:macos
```

This uses `SCREENPIPE_E2E_SEED=onboarding,no-recording,cloud-audio-fallback`
to keep vision capture off while leaving the audio settings visible with
Screenpipe Cloud saved and no logged-in user. It asserts the Recording fallback
alert and the persisted `/notifications` entry.

**Run the macOS HD recording pipeline spec**

```bash
bun run test:e2e:hd:macos
```

Opt-in spec for the high-fps "HD recording" pipeline. Uses
`SCREENPIPE_E2E_SEED=onboarding` (vision ON) so it needs a host with **Screen
Recording granted and a real display**. It drives `POST /capture/hd/start`,
then asserts (1) the controller flips active, (2) a non-empty `hd_*.mp4` chunk
is written to disk, and (3) OCR rows keep landing via `/search` *during* the HD
window — i.e. high-fps capture and normal indexing run concurrently (#3699 /
#3707). Self-skips under the default `no-recording` seed or when the HD
controller is unavailable, so it never fails the default CI lane.

**Or combined (build + test):**

```bash
./e2e/run.sh
```

Uses `.e2e/` as isolated data dir; real data is never touched.
The E2E launcher also moves the app-local focus/notification server to
`SCREENPIPE_FOCUS_PORT` (default `11436`) so tests can exercise `/notify` and
`/notifications` without colliding with a developer's production app on 11435.

## Running locally on Windows

### Prerequisites

- **Bun** ≥ 1.3.10 — `winget install oven-sh.bun` or from [bun.sh](https://bun.sh)
- **Rust** stable (x86_64-pc-windows-msvc) — `rustup target add x86_64-pc-windows-msvc`
- **MSVC build tools** — Visual Studio 2022 Build Tools with C++ workload
- **ONNX Runtime** — the pre_build script downloads this automatically during `bun tauri build`
- No Scream audio driver needed for local runs (only required in CI for audio capture tests)

### Step-by-step (PowerShell)

```powershell
# 1. Install frontend dependencies (from repo root or apps/screenpipe-app-tauri)
cd apps/screenpipe-app-tauri
bun install

# 2. Build the debug binary with the WebDriver plugin enabled
bun tauri build --no-sign --debug --no-bundle -- --features e2e

# 3. Run all e2e specs
bun run test:e2e

# 4. Run with video recording (saves to e2e/videos/)
$env:RECORD_VIDEO="1"; bun run test:e2e

# 5. Run the Windows core recording spec (recording-enabled app + API checks,
#    with OCR/Timeline assertions when the runner exposes usable frames; no-audio
#    keeps hosted runners out of Whisper startup while vision capture stays on)
$env:SCREENPIPE_E2E_SEED="onboarding,no-audio"; bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/windows-core-recording.spec.ts

# 6. Run the Windows event-trigger capture checks (keystroke/clipboard/window-focus
#    triggers on; raw key and clipboard rows stay disabled and focus rows get linked)
$env:SCREENPIPE_E2E_SEED="onboarding,no-audio,event-trigger-capture"; bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/windows-core-recording.spec.ts

# 7. Run the same trigger lane with raw key DB rows opted in; verifies key rows
#    get linked frame_id too.
$env:SCREENPIPE_E2E_SEED="onboarding,no-audio,event-trigger-capture,keyboard-db-capture"; bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/windows-core-recording.spec.ts
```

### Run a single spec

```powershell
# Run only the settings-sections spec
bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/settings-sections.spec.ts

# Run only the pipes spec
bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/pipes.spec.ts

# Run only home window navigation
bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/home-window.spec.ts
```

### Artifacts

| Path | Contents |
|---|---|
| `e2e/screenshots/` | PNG screenshots taken during tests |
| `e2e/videos/` | Desktop recording (only when `RECORD_VIDEO=1`) |
| `e2e/results/` | Runtime JSON emitted by the WDIO coverage reporter |
| `.e2e/` | Isolated screenpipe data dir used during tests (deleted on each run) |
| `e2e/COVERAGE.md` | Generated platform/layer/feature coverage dashboard |
| `e2e/COVERAGE.runtime.md` | Runtime dashboard with actual pass/fail/skip counts |

## Coverage dashboard

The E2E coverage dashboard is behavioral coverage, not line or branch
coverage. It answers "which user/product risks are exercised on which
platforms and layers?" using `e2e/coverage-map.json`.

From `apps/screenpipe-app-tauri`:

```bash
bun run e2e:coverage
```

This validates that every `e2e/specs/*.spec.ts` file is mapped and writes
the static baseline report to `e2e/COVERAGE.md`. The report summarizes:

- platform coverage for Windows, macOS, and Linux
- layer coverage such as real UI E2E, local API, capture/OCR, audio/device,
  OS integration, settings, storage/privacy, chat, pipes, and performance
- critical feature gaps, including weak coverage where specs are conditional
  or smoke-only
- a per-spec inventory with declared test counts, confidence, UX type, and
  notes

Declared test counts are static source counts. Parameterized specs can execute
more runtime cases in WDIO than the source count shows.

To verify that the checked-in report is current:

```bash
bun run e2e:coverage:check
```

Every WDIO run also writes JSON files to `e2e/results/`. To merge those actual
runtime pass/fail/skip counts into the coverage dashboard:

```bash
bun run e2e:coverage:runtime
```

This writes `e2e/COVERAGE.runtime.md`. CI uploads the runtime report and raw
JSON result files for each E2E platform job. Use the runtime report when judging
whether a mapped feature really passed on a given run; use the static report to
review taxonomy drift and unmapped specs.

For repo-wide behavioral coverage, including the Rust core engine crates:

```bash
bun run coverage:all
bun run coverage:all:check
```

This refreshes/checks `e2e/COVERAGE.md`, `../../docs/coverage/CORE.md`, and the
top-level `../../COVERAGE.md` summary. Core line/branch coverage is tracked
separately via `cargo llvm-cov`; see `../../docs/coverage/README.md`.

### Troubleshooting on Windows

**Binary not found**
```
Error: Screenpipe debug binary not found at …\src-tauri\target\debug\screenpipe-app.exe
```
Run the build step first. Debug builds land in `src-tauri/target/debug/`.

**Port 4445 already in use**
The test runner (`wdio.conf.ts` `onPrepare`) calls `netstat -ano | findstr :4445` and kills the owner via `taskkill`. If it persists, manually run:
```powershell
netstat -ano | findstr :4445
taskkill /PID <PID> /F
```

**App crashes immediately / blank window**
Check `apps/screenpipe-app-tauri/.e2e/` for log files after a run. The app launcher pipes stdout/stderr with an `[app]` prefix to the test runner console.

**WebDriver server timeout**
The launcher waits up to 30 s for `http://127.0.0.1:4445/status`. If the build was done without `--features e2e`, the WebDriver server never starts. Rebuild with the feature flag.

## Video recording

macOS / Linux:

```bash
RECORD_VIDEO=1 bun run test:e2e
```

Windows PowerShell:

```powershell
$env:RECORD_VIDEO="1"; bun run test:e2e
```

Windows cmd:

```cmd
set RECORD_VIDEO=1 && bun run test:e2e
```

Saves to `e2e/videos/`.

## Test specs

| Spec | What it tests |
|---|---|
| `home-window.spec.ts` | Opens Home window; clicks through Home, Pipes, Timeline, Help, Settings nav items |
| `timeline.spec.ts` | Navigates to Timeline; seeds a capture event; verifies at least one frame renders |
| `windows-core-recording.spec.ts` | Windows opt-in. Enables real vision recording and requires API auth, health/load, audio/device, vision, and search endpoints to stay responsive. In CI it uses `SCREENPIPE_E2E_SEED=onboarding,no-audio` so hosted runners exercise OCR without booting Whisper. When the runner exposes usable desktop frames, it also shows a foreground marker window and verifies OCR indexing/query search plus Timeline frame metadata, visible scrubber clicks, and arrow-key frame stepping; hosted runners without frames self-skip those capture-dependent assertions. |
| `windows-system-integration.spec.ts` | Windows-only. Verifies isolated data dir, native DLL/WebView2 runtime, display/DPI topology, localhost-only API binding, process health, Defender visibility, audio service/device health, concurrent local API load, focus churn, rapid Home-window routing, Home close/reopen backend survival, and absence of Windows crash-report events during the suite |
| `windows-user-journey.spec.ts` | Windows-only. Drives Home search button -> floating Search input -> Timeline -> Home, opens Recording settings to reveal Windows audio troubleshooting controls, starts/stops a manual Meeting note through the visible UI, opens the Shortcuts editor and cancels an open-search hotkey capture, toggles the Display shortcut-reminder overlay, clicks its visible Search, Chat, Timeline, and Hide controls, opens notification history from the bell, manages notification preferences, dismisses a notification from the visible bell UI, previews the Storage retention safety confirmation without applying destructive cleanup, and verifies the Privacy API-auth restart warning without restarting |
| `hd-recording-pipeline.spec.ts` | macOS opt-in. Starts an HD timer session via `/capture/hd/start`; asserts the controller goes active, a non-empty `hd_*.mp4` chunk is written, and OCR keeps indexing during HD (high-fps + indexing decouple, #3699/#3707) |
| `settings-sections.spec.ts` | Navigates General → Recording → AI → Speakers settings; verifies content and no crash |
| `audio-fallback.spec.ts` | macOS opt-in spec for the Screenpipe Cloud → local Whisper fallback alert and `/notify` history |
| `window-lifecycle.spec.ts` | Exercises `show_window` / `close_window` routing for Home, Search, and completed onboarding |
| `permission-recovery.spec.ts` | macOS recovery window smoke for missing TCC permissions, route wiring, dedupe, and clean close |
| `owned-browser.spec.ts` | Verifies the embedded agent browser queues navigation and hides safely |
| `pipes.spec.ts` | Opens Pipes section; verifies pipe store mounts without crash; navigates back to Home |
| `pipes-mcp-connections.spec.ts` | Seeds a custom MCP server, installs a local pipe, selects the MCP server from the pipe connection picker, and verifies `mcp:<id>` persists in the pipe config |
| `parallel-chat.spec.ts` | Drives chat-load-conversation + fake `pi_event` envelopes from the webview to walk Louis's repro: chat A → chat B → back to A. Asserts A's messages are still in the DOM (catches the "switch wipes A" regression) and that backgrounded streaming does NOT reorder sidebar rows. |
| `chat-settings-background-stream.spec.ts` | Starts a long synthetic chat stream, navigates into the standalone `/settings` route mid-stream (unmounting the home page), then returns. Asserts the running chat remains live in Recents and, after clicking it, the full response — early tokens (snapshotted on unmount) plus the final token (streamed in the background) — is present. Catches the "opening Settings stops the current chat" regression. |
