# Screenpipe Coverage

Screenpipe tracks coverage at two complementary layers:

- Tauri/WebDriver E2E coverage: real product UX and local API behavior by platform.
- Core engine coverage: Rust behavioral flow coverage across capture, audio, DB, accessibility, and engine crates.

These dashboards are behavioral maps, not a replacement for line or branch coverage.
Use them to see which product risks are represented, then layer runtime job
results and `cargo llvm-cov` data on top when judging release confidence.

## Dashboards

- E2E dashboard: [apps/screenpipe-app-tauri/e2e/COVERAGE.md](apps/screenpipe-app-tauri/e2e/COVERAGE.md)
- Core engine dashboard: [docs/coverage/CORE.md](docs/coverage/CORE.md)

## Current Snapshot

### Tauri E2E

- Mapped specs: 105
- Declared test blocks: 305
- Weighted coverage points: 237.5

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 82 | 266 | 216.6 | 15 | 89 | 91% |
| macos | 101 | 268 | 208.3 | 17 | 91 | 90% |
| linux | 71 | 223 | 185.2 | 14 | 84 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 319
- Active test blocks: 3035
- Ignored/manual test blocks: 137
- Weighted coverage points: 2495.1

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2904 | 132 | 2435.1 | 21 | 11 | 100% |
| macos | 29 | 2958 | 112 | 2446.2 | 22 | 11 | 100% |
| linux | 25 | 2591 | 105 | 2152.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
