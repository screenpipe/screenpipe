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

- Mapped specs: 101
- Declared test blocks: 286
- Weighted coverage points: 220.3

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 79 | 248 | 199.8 | 15 | 88 | 91% |
| macos | 97 | 249 | 191.1 | 17 | 90 | 90% |
| linux | 69 | 208 | 169.6 | 14 | 83 | 88% |

### Core Engine

- Mapped suites: 32
- Mapped Rust files: 313
- Active test blocks: 2949
- Ignored/manual test blocks: 134
- Weighted coverage points: 2423.5

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 29 | 2818 | 129 | 2363.5 | 21 | 11 | 100% |
| macos | 29 | 2872 | 109 | 2374.6 | 22 | 11 | 100% |
| linux | 25 | 2507 | 102 | 2082.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
