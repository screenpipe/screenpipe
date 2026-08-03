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

- Mapped specs: 89
- Declared test blocks: 251
- Weighted coverage points: 193.7

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 72 | 224 | 181.2 | 15 | 77 | 91% |
| macos | 85 | 214 | 164.5 | 17 | 79 | 89% |
| linux | 62 | 184 | 151.0 | 14 | 72 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 308
- Active test blocks: 2858
- Ignored/manual test blocks: 133
- Weighted coverage points: 2354.9

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2730 | 128 | 2296.2 | 21 | 11 | 100% |
| macos | 29 | 2781 | 108 | 2306.1 | 22 | 11 | 100% |
| linux | 25 | 2424 | 102 | 2018.5 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
