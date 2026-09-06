# Local updater test (quick commands)

## 1) Build and stage the newer release

Set `apps/screenpipe-app-tauri/src-tauri/Cargo.toml` to a newer semver (example: `2.4.229`), then run:

```bash
bun run updater-local:build
bun run updater-local:stage-last
bun run updater-local:serve
```

Keep the server terminal running.

## 2) Build the older app

In another terminal, set `apps/screenpipe-app-tauri/src-tauri/Cargo.toml` to an older semver (must be lower than step 1), then run:

```bash
bun run updater-local:build
```

## 3) Verify update flow

Launch the old installed app and trigger update check.

Expected: it pulls the staged update from `http://127.0.0.1:8765/`.

## Notes

- Build newer first: building the older app later overwrites `src-tauri/target/release/bundle`.
- Scripts used above are in `apps/screenpipe-app-tauri/package.json`:
  - `updater-local:build`
  - `updater-local:stage-last`
  - `updater-local:serve`
