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

- Mapped specs: 100
- Declared test blocks: 284
- Weighted coverage points: 218.9

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 78 | 246 | 198.4 | 15 | 86 | 91% |
| macos | 96 | 247 | 189.7 | 17 | 88 | 90% |
| linux | 68 | 206 | 168.2 | 14 | 81 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 313
- Active test blocks: 2939
- Ignored/manual test blocks: 134
- Weighted coverage points: 2415.0

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2808 | 129 | 2355.0 | 21 | 11 | 100% |
| macos | 29 | 2862 | 109 | 2366.1 | 22 | 11 | 100% |
| linux | 25 | 2497 | 102 | 2073.9 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
