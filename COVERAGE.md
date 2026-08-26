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

- Mapped specs: 127
- Declared test blocks: 371
- Weighted coverage points: 293.7

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 97 | 316 | 260.0 | 15 | 106 | 92% |
| macos | 123 | 333 | 263.5 | 17 | 115 | 90% |
| linux | 86 | 274 | 229.4 | 14 | 103 | 89% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 336
- Active test blocks: 3265
- Ignored/manual test blocks: 137
- Weighted coverage points: 2673.4

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 3126 | 132 | 2610.0 | 21 | 11 | 100% |
| macos | 29 | 3184 | 112 | 2622.4 | 22 | 11 | 100% |
| linux | 25 | 2798 | 105 | 2311.3 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
