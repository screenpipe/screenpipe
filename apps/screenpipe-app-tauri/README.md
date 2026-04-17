# screenpipe-app-tauri

Refer to the [official documentation](https://docs.screenpi.pe/getting-started) for general setup and usage.

## Built-in Pi Extensions

When Pi starts for a pipe project, screenpipe installs built-in extensions into:

`<project>/.pi/extensions/`

### `protected-paths.ts` (always installed)

This extension intercepts Pi `write` and `edit` tool calls and blocks paths that contain:

- `.env`
- `.git/`
- `node_modules/`
- `.ssh/`

How it works in practice:

- If an agent tries to edit `./.env` or `.git/config`, the tool call is blocked.
- The user sees a warning in the Pi UI when available.
- Read-only operations are not blocked by this extension.

This reduces accidental edits to secrets, git metadata, local SSH material, and large dependency trees.

### `web-search.ts` (conditional)

This extension is only installed for `screenpipe-cloud` presets.
It is removed for non-cloud presets.
