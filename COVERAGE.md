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
- Declared test blocks: 344
- Weighted coverage points: 269.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 91 | 298 | 244.0 | 15 | 96 | 92% |
| macos | 115 | 306 | 239.7 | 17 | 102 | 90% |
| linux | 80 | 256 | 213.2 | 14 | 92 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 330
- Active test blocks: 3207
- Ignored/manual test blocks: 137
- Weighted coverage points: 2629.8

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3068 | 132 | 2566.4 | 21 | 11 | 100% |
| macos | 29 | 3126 | 112 | 2578.8 | 22 | 11 | 100% |
| linux | 25 | 2742 | 105 | 2269.6 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
