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

- Mapped specs: 93
- Declared test blocks: 259
- Weighted coverage points: 199.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 74 | 228 | 185.2 | 15 | 77 | 91% |
| macos | 89 | 222 | 170.7 | 17 | 79 | 89% |
| linux | 64 | 188 | 155.0 | 14 | 72 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 310
- Active test blocks: 2905
- Ignored/manual test blocks: 133
- Weighted coverage points: 2388.8

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2777 | 128 | 2330.0 | 21 | 11 | 100% |
| macos | 29 | 2828 | 108 | 2339.9 | 22 | 11 | 100% |
| linux | 25 | 2471 | 102 | 2052.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
