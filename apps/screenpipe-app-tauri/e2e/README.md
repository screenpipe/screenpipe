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

**Or combined (build + test):**

```bash
./e2e/run.sh
```

Uses `.e2e/` as isolated data dir; real data is never touched.

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
| `.e2e/` | Isolated screenpipe data dir used during tests (deleted on each run) |

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
| `settings-sections.spec.ts` | Navigates General → Recording → AI → Speakers settings; verifies content and no crash |
| `pipes.spec.ts` | Opens Pipes section; verifies pipe store mounts without crash; navigates back to Home |
