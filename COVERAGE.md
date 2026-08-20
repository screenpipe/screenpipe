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

- Mapped specs: 119
- Declared test blocks: 345
- Weighted coverage points: 270.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 91 | 299 | 245.0 | 15 | 96 | 92% |
| macos | 115 | 307 | 240.7 | 17 | 102 | 90% |
| linux | 80 | 257 | 214.2 | 14 | 92 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 330
- Active test blocks: 3194
- Ignored/manual test blocks: 137
- Weighted coverage points: 2620.1

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3055 | 132 | 2556.7 | 21 | 11 | 100% |
| macos | 29 | 3113 | 112 | 2569.1 | 22 | 11 | 100% |
| linux | 25 | 2729 | 105 | 2259.9 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
