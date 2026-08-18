# Fast native development builds

<!-- doc-covers: none -->

There are exactly three normal native-development commands. Run them from
`apps/screenpipe-app-tauri`:

```bash
# Live frontend + native app loop.
bun run dev:tauri

# One-shot native test binary, without packaging an installer or app bundle.
bun run build:tauri:dev

# E2E-capable one-shot test binary.
bun run build:tauri:e2e
```

All package scripts pass the named profile as Cargo runner arguments:
`-- --profile debug-dev`. The space-separated form matters. It makes Tauri
2.11.2 select `src-tauri/target/debug-dev`; `--debug` instead selects Cargo's
built-in `dev` profile.

Do not add `cargo clean`, a shared `CARGO_TARGET_DIR`, incremental/profile
environment overrides, or one-off compiler-cache settings. The checked-in
`debug-dev` profile is the single source of truth: no first-party debuginfo,
high parallel codegen, and no per-worktree incremental state.

## System-wide build queue and cache

The three commands above and the signed build script all use one per-user build
slot on macOS. A second worktree waits instead of starting another cold native
compile on the same CPU. Queue output names the current build, PID, worktree,
and wait time; inspect it directly with:

```bash
bun run build:tauri:status
```

The coordinator keeps each worktree's own `src-tauri/target` directory so
concurrent checkouts cannot corrupt one another. It separately configures a
dedicated local sccache server with every live Screenpipe worktree as a base
directory. Eligible dependency objects can therefore be reused across
worktrees without sharing target directories or relying on network
credentials. The worktree list is refreshed before every queued native build.

`bun run dev:tauri` queues only its initial Cargo warm-up. It releases the build
slot before starting the long-running Tauri dev process, so an open app does not
block every later build. Subsequent hot-reload compiles belong to that live dev
session and are not queued.

For React/layout-only work, `bun run dev:web` is still faster because it avoids
Rust entirely.

## macOS permissions

Signing is separate from the normal build loop. Only create a signed `.app`
when the test specifically needs a stable macOS TCC identity across rebuilds:

```bash
apps/screenpipe-app-tauri/scripts/build_macos.sh
```

That script enters the same system build queue, uses the same `debug-dev`
profile, builds only the macOS app bundle, and signs it with its configured
development identity. Set
`APPLE_SIGNING_IDENTITY` to use a different stable certificate. Normal
development builds should not copy its packaging/signing steps; otherwise use
the development commands above.
