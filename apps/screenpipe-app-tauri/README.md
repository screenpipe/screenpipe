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
