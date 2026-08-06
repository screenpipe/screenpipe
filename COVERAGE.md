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

- Mapped specs: 96
- Declared test blocks: 262
- Weighted coverage points: 202.3

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 76 | 230 | 187.2 | 15 | 78 | 91% |
| macos | 92 | 225 | 173.1 | 17 | 80 | 89% |
| linux | 66 | 190 | 157.0 | 14 | 73 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 311
- Active test blocks: 2918
- Ignored/manual test blocks: 134
- Weighted coverage points: 2398.5

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2790 | 129 | 2339.7 | 21 | 11 | 100% |
| macos | 29 | 2841 | 109 | 2349.6 | 22 | 11 | 100% |
| linux | 25 | 2479 | 102 | 2058.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
