# Coverage

This directory holds repo-level coverage dashboards that sit next to the
Tauri/WebDriver E2E coverage map.

The dashboards are behavioral coverage maps, not raw line or branch coverage.
They answer which product risks are represented by tests, which platforms those
tests claim, and whether ignored/manual tests are inflating confidence.

From `apps/screenpipe-app-tauri`:

```bash
bun run coverage:core
bun run coverage:all
```

To verify checked-in reports are current:

```bash
bun run coverage:core:check
bun run coverage:all:check
```

## Files

- `core-engine-map.json`: declarative map of core Rust test suites to flows.
- `CORE.md`: generated core Rust flow coverage report.
- `../COVERAGE.md`: generated top-level summary combining E2E and core reports.
- `scripts/generate-core-engine-coverage-report.ts`: validates the core map,
  counts Rust test blocks, and writes `CORE.md`.
- `scripts/generate-unified-coverage-report.ts`: writes the top-level summary.

## Core Line Coverage

Use `cargo llvm-cov` when you need line or branch coverage:

```bash
cargo llvm-cov --workspace --summary-only --output-format json > coverage/core-llvm-cov-summary.json
cd apps/screenpipe-app-tauri
bun run coverage:core -- --llvm-cov-summary ../../coverage/core-llvm-cov-summary.json
```

The generated core report will include the supplied line/function/branch/region
totals without mixing them into the behavioral flow score.
