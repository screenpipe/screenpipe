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

- Mapped specs: 86
- Declared test blocks: 245
- Weighted coverage points: 187.7

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 70 | 219 | 176.2 | 15 | 74 | 90% |
| macos | 82 | 208 | 158.5 | 17 | 76 | 88% |
| linux | 60 | 179 | 146.0 | 13 | 69 | 87% |

### Core Engine

- Mapped suites: 30
- Mapped Rust files: 298
- Active test blocks: 2796
- Ignored/manual test blocks: 133
- Weighted coverage points: 2305.2

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 27 | 2669 | 128 | 2246.9 | 21 | 11 | 100% |
| macos | 27 | 2719 | 108 | 2256.4 | 22 | 11 | 100% |
| linux | 23 | 2363 | 102 | 1969.2 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
