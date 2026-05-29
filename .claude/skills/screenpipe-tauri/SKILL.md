---
name: screenpipe-tauri
description: Add or change Tauri commands and TypeScript bindings in the screenpipe desktop app. Use when editing #[tauri::command] handlers, lib/utils/tauri.ts, or Rust types exported to the frontend.
---

# Screenpipe Tauri (desktop app)

Path: `apps/screenpipe-app-tauri/`

Command registration is automated via the `tauri-helper` crate. **Do not** edit manual invoke-handler or specta command lists in `main.rs`.

## Adding a command

1. Add **both** markers to the handler function in any `src-tauri/src/**/*.rs` module:
   ```rust
   #[tauri::command]
   #[specta::specta]  // required — without this the command is skipped in tauri.ts
   pub async fn your_command(...) { ... }
   ```
2. From `apps/screenpipe-app-tauri/`:

```bash
bun run bindings:generate   # write lib/utils/tauri.ts
bun run bindings:check      # verify no drift
bun run typecheck           # verify frontend types
```

3. Commit Rust + `lib/utils/tauri.ts` together

## Scripts

| Command | Purpose |
|---------|---------|
| `bun run bindings:check` | Fail if checked-in `lib/utils/tauri.ts` does not match Rust |
| `bun run bindings:generate` | Regenerate `lib/utils/tauri.ts` after command/type changes |
| `bun run typecheck` | Frontend TypeScript check |

## Key files

- `src-tauri/build.rs` — `tauri_helper::generate_command_file` (build-time scan)
- `src-tauri/src/main.rs` — `specta_collect_commands!()` / `tauri_collect_commands!()`
- `src-tauri/src/specta_bindings.rs` — export helpers and drift tests
- `lib/utils/tauri.ts` — generated TypeScript bindings (checked in)

Debug builds also auto-export bindings on startup when content changes.
