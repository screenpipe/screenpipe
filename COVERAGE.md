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

- Mapped specs: 94
- Declared test blocks: 260
- Weighted coverage points: 200.3

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 74 | 228 | 185.2 | 15 | 77 | 91% |
| macos | 90 | 223 | 171.1 | 17 | 79 | 89% |
| linux | 64 | 188 | 155.0 | 14 | 72 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 310
- Active test blocks: 2910
- Ignored/manual test blocks: 133
- Weighted coverage points: 2392.6

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2782 | 128 | 2333.8 | 21 | 11 | 100% |
| macos | 29 | 2833 | 108 | 2343.7 | 22 | 11 | 100% |
| linux | 25 | 2476 | 102 | 2056.2 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
