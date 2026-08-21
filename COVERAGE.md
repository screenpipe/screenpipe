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

- Mapped specs: 120
- Declared test blocks: 350
- Weighted coverage points: 275.0

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 91 | 300 | 245.4 | 15 | 97 | 92% |
| macos | 116 | 312 | 244.8 | 17 | 104 | 90% |
| linux | 80 | 259 | 215.3 | 14 | 94 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 330
- Active test blocks: 3211
- Ignored/manual test blocks: 137
- Weighted coverage points: 2633.8

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3072 | 132 | 2570.4 | 21 | 11 | 100% |
| macos | 29 | 3130 | 112 | 2582.8 | 22 | 11 | 100% |
| linux | 25 | 2746 | 105 | 2273.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
