# screenpipe desktop app

Use the source-build instructions in [`CONTRIBUTING.md`](../../CONTRIBUTING.md):

- [Windows NSIS installer](../../CONTRIBUTING.md#windows)
- [macOS app and DMG](../../CONTRIBUTING.md#macos)
- [Linux desktop bundles](../../CONTRIBUTING.md#linux)

Run the Tauri commands from this directory, not the repository root. Product
usage documentation is available at [docs.screenpi.pe](https://docs.screenpi.pe/getting-started).

## fast browser UI development

From this directory, run:

```bash
bun run dev:web
```

Then open <http://127.0.0.1:1420/home>. This starts only Next.js: Tauri IPC,
the settings store, the local engine HTTP API, and the health/meeting WebSockets
are replaced by in-memory browser mocks. Rust and the sidecar are not built or
started, so this is the shortest loop for layout and ordinary React work.

Useful mock states:

```bash
SCREENPIPE_WEB_SCENARIO=empty bun run dev:web
SCREENPIPE_WEB_SCENARIO=backend-error bun run dev:web
```

The default `ready` state also seeds a stateful Live View and canvas document.
Edits such as changing the time range or layout mode are preserved for the
current browser session, so Live View UI work does not need the Rust backend.

To use the real engine while still skipping the Tauri/Rust build, first start
or keep Screenpipe running, then run:

```bash
SCREENPIPE_LOCAL_API_KEY=your-local-key bun run dev:web:live
```

Set `SCREENPIPE_WEB_API_PORT` too if the engine is not on port 3030. The dev
server binds to `127.0.0.1`; the key is embedded in this local development
bundle, so do not use or share a production credential.

Use `bun run dev:tauri` for the full native loop. Browser mode cannot validate
native windows, menus, tray behavior, permissions, updater flows, filesystem
access, or WebKit-only layout/focus behavior. Check those changes in Tauri
before considering them complete.

## dev builds are isolated from your installed app

`bun tauri dev` / `bun run dev:tauri` / `cargo run` do **not** touch the
production install. Every debug build redirects itself at startup
(`src-tauri/src/dev_isolation.rs`):

| | production | dev |
| --- | --- | --- |
| data dir (DB, `store.bin`, secrets, pipes, chats) | `~/.screenpipe` | `~/.screenpipe-dev` |
| local API port | 3030 | 3130 |
| focus / notification port | 11435 | 11535 |
| telemetry | on | off |
| agent MCP configs (`~/.claude`, `~/.codex`, …) | real home | empty fake home |

This is what makes running dev next to the installed app safe. Without it, dev
would hand off to production over the focus port and exit instead of launching,
and its recording supervisor would `kill -9` production's engine to claim
port 3030 — mid-write to a multi-GB SQLite database.

You keep a separate dev profile, so first launch shows onboarding and an empty
timeline. That is expected. To reset, delete `~/.screenpipe-dev`.

Any variable you set yourself still wins, so you can relax one dimension at a
time:

```bash
# real recordings, still on the dev ports and dev settings store
SCREENPIPE_DATA_DIR=~/.screenpipe bun run dev:tauri

# OAuth connections: providers register the callback as localhost:3030 exactly,
# so testing them needs the production port. Quit the installed app first —
# whichever instance starts second kills the other's engine to claim the port.
SCREENPIPE_PORT=3030 bun run dev:tauri
```

To opt out completely and run against the production profile:

```bash
SCREENPIPE_DEV_USE_PROD_DATA=1 bun run dev:tauri
```

Release builds are never redirected, and the E2E harness keeps its own
isolation (`e2e/helpers/app-launcher.ts`) unchanged.
