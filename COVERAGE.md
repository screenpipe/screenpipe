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

- Mapped specs: 108
- Declared test blocks: 310
- Weighted coverage points: 242.5

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 84 | 270 | 220.6 | 15 | 90 | 92% |
| macos | 104 | 273 | 213.3 | 17 | 92 | 90% |
| linux | 73 | 227 | 189.2 | 14 | 85 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 320
- Active test blocks: 3056
- Ignored/manual test blocks: 137
- Weighted coverage points: 2515.2

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2925 | 132 | 2455.2 | 21 | 11 | 100% |
| macos | 29 | 2979 | 112 | 2466.3 | 22 | 11 | 100% |
| linux | 25 | 2612 | 105 | 2172.7 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
