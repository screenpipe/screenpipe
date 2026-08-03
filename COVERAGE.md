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

- Mapped specs: 91
- Declared test blocks: 255
- Weighted coverage points: 197.7

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 73 | 227 | 184.2 | 15 | 77 | 91% |
| macos | 87 | 218 | 168.5 | 17 | 79 | 89% |
| linux | 63 | 187 | 154.0 | 14 | 72 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 309
- Active test blocks: 2872
- Ignored/manual test blocks: 133
- Weighted coverage points: 2365.3

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2744 | 128 | 2306.6 | 21 | 11 | 100% |
| macos | 29 | 2795 | 108 | 2316.5 | 22 | 11 | 100% |
| linux | 25 | 2438 | 102 | 2029.0 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
