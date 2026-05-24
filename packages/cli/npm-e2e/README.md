# npm e2e

End-to-end tests for the screenpipe npm package surface. Runs any CLI command via a local Verdaccio registry — no real publish needed.

## Manual dev flow

### 1) Build the native binary

```bash
cd packages/cli
bun run build
```

Prints the binary path, e.g. `target/aarch64-apple-darwin/release/screenpipe`.

### 2) Stage npm packages

```bash
bun run stage
```

Auto-detects the binary from `target/<host-target>/release/screenpipe`. Pass `--binary <path>` to override. Copies wrapper + platform packages into `.work/stage`, injects the real binary, writes placeholder payloads for other platforms, validates the result.

### 3) Serve the local registry

```bash
bun run serve
```

Starts Verdaccio, publishes staged packages, prints the registry URL and the exact command to run. Keep this terminal open.

### 4) Run any command yourself

```bash
bun run screenpipe <command> [flags]
```

Example (CI-safe, no screen/audio permissions needed):

```bash
bun run screenpipe record \
  --disable-audio \
  --disable-vision \
  --disable-telemetry \
  --disable-meeting-detector
```

## Full e2e (CI)

```bash
bun run build
bun run test
```

`test` auto-stages — no need to run `stage` separately. `stage` is only needed for the manual `serve` flow.

## Logs

All logs under `npm-e2e/.work/logs`:

- `verdaccio.log`
- `npm-publish.log`
- `npx-record.log`

