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

- Mapped specs: 88
- Declared test blocks: 248
- Weighted coverage points: 190.7

| Platform | Specs | Declared tests | Weighted points | Layers | Features | Critical score |
| --- | --- | --- | --- | --- | --- | --- |
| windows | 71 | 221 | 178.2 | 15 | 75 | 91% |
| macos | 84 | 211 | 161.5 | 17 | 77 | 89% |
| linux | 61 | 181 | 148.0 | 14 | 70 | 88% |

### Core Engine

- Mapped suites: 30
- Mapped Rust files: 301
- Active test blocks: 2815
- Ignored/manual test blocks: 133
- Weighted coverage points: 2319.4

| Platform | Suites | Active tests | Ignored tests | Weighted points | Layers | Flows | Critical score |
| --- | --- | --- | --- | --- | --- | --- | --- |
| windows | 27 | 2688 | 128 | 2261.1 | 21 | 11 | 100% |
| macos | 27 | 2738 | 108 | 2270.6 | 22 | 11 | 100% |
| linux | 23 | 2382 | 102 | 1983.4 | 20 | 11 | 100% |

## Refresh

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:all
bun run coverage:all:check
```

For core line coverage, install/use `cargo llvm-cov` and feed its JSON
summary into `coverage:core`; the core dashboard documents the exact command.
