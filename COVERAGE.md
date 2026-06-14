# Screenpipe Coverage

Screenpipe tracks coverage at two complementary layers:

- Tauri/WebDriver E2E coverage: real product UX and local API behavior by platform.
- Core engine coverage: Rust behavioral flow coverage across capture, audio, DB, accessibility, and engine crates.

These dashboards are behavioral maps, not a replacement for line or branch coverage.
Use them to see which product risks are represented, then layer runtime job
results and `cargo llvm-cov` data on top when judging release confidence.

## Dashboards

- E2E dashboard: [apps/screenpipe-app-tauri/e2e/COVERAGE.md](apps/screenpipe-app-tauri/e2e/COVERAGE.md)
- Core engine dashboard: [coverage/CORE.md](coverage/CORE.md)

## Current Snapshot

### Tauri E2E

- Mapped specs: 49
- Declared test blocks: 173
- Weighted coverage points: 133.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 42 | 162 | 130.4 | 15 | 50 | 89% |
| macos | 45 | 137 | 105.9 | 15 | 50 | 89% |
| linux | 35 | 125 | 102.3 | 13 | 46 | 86% |

### Core Engine

- Mapped suites: 24
- Mapped Rust files: 209
- Active test blocks: 1837
- Ignored/manual test blocks: 110
- Weighted coverage points: 1526.9

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 21 | 1736 | 107 | 1479.5 | 21 | 11 | 100% |
| macos | 21 | 1787 | 87 | 1495.7 | 22 | 11 | 100% |
| linux | 19 | 1720 | 84 | 1465.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
