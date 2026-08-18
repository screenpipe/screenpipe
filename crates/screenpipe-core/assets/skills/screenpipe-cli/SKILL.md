---
name: screenpipe-cli
description: Manage screenpipe pipes (scheduled AI automations) and connections (Telegram, Slack, Discord, etc.) via the CLI. Use when the user asks to create, list, enable, disable, run, or debug pipes, or manage service connections from the command line.
---

# Screenpipe CLI

Run every CLI command exactly like this, from a clean temp directory so `bun x` cannot collide with a project's `node_modules`:

```bash
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} <command>
```

`$SCREENPIPE_CLI` is an already-resolved native binary that screenpipe publishes and refreshes for you. When it is set, a call costs **~0.15s**. The `bun x screenpipe@latest` fallback runs when it is not (a plain terminal, a fresh install, an offline machine) and costs **~4s**, because `@latest` re-resolves the npm registry every single time. Never replace the whole expression with just `bun x screenpipe@latest` — you would give up the fast path for no reason.

**Rules:** every invocation is `cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} …` · keep the `${SCREENPIPE_CLI:-…}` form intact · never drop the `cd` prefix · copy the examples below verbatim rather than shortening them · because the `cd` changes your working directory, **any path you pass must be absolute** (`~/...` or `/...`), never relative (`./my-pipe`).

Works on macOS, Linux, and Windows: the CLI always runs under bash, and `mktemp` is present on all three (on Windows via the bundled git-portable `usr/bin`).

**The CLI is the slow path.** Even at 0.15s it is a process spawn; the local REST API answers the same read in ~0.02s (see the `screenpipe-api` skill). Use the CLI for state changes it uniquely owns — `pipe enable`, `connection set` — and read through the API or MCP tools.

> **Sandboxed shells:** some agents (e.g. Codex) block all shell network access, so `bun x` cannot fetch the package and CLI calls to `localhost:3030` fail instantly. If that happens, use the screenpipe MCP tools instead of the CLI.

## Shell

- **All platforms** → `bash` (on Windows, the bundled git-portable bash is used automatically)

> **Note:** the bash tool truncates output around ~50 KB. Long listings (`connection list`, `pipe list`, etc.) are sorted with connected/enabled rows first, but if you need a specific row, pipe through `grep` or `head` rather than scanning the full output — e.g. `cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection list | grep -E 'browser|connected'`.

---

## Pipe Management

Pipes are markdown-based AI automations that run on schedule. Each pipe lives at `~/.screenpipe/pipes/<name>/pipe.md`.

### Commands

```bash
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe list                    # List all pipes (compact table)
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe enable <name>           # Enable a pipe
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe disable <name>          # Disable a pipe
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe run <name>              # Run once immediately (for testing)
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe logs <name>             # View execution logs
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe install <url-or-abs-path>  # Install from GitHub or an absolute local path
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe delete <name>           # Delete a pipe
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe models list             # View AI model presets
```

### Creating a Pipe

Create `~/.screenpipe/pipes/<name>/pipe.md` with YAML frontmatter + prompt:

```markdown
---
schedule: every 30m
enabled: true
preset: ["Primary", "Fallback"]
---

Your prompt instructions here. The AI agent executes this on schedule.

## What to do

1. Query screenpipe search API for recent activity
2. Process results
3. Output summary / send notification
```

**Schedule syntax**:
- Recurring: `every 30m`, `every 1h`, `every day at 9am`, `every monday at 9am`, or cron `*/30 * * * *`, `0 9 * * *`
- One-off (fires once, then auto-disables): `at <RFC3339 timestamp>` — e.g. `at 2026-04-29T17:00:00-07:00`
- Manual only: `manual` (run via `pipe run` or API trigger)

**One-off scheduled tasks** (use this when the user says "in 2 days", "tomorrow at 5pm", "next Monday", "remind me to check X later", or any other future-time deferred action):

```yaml
---
schedule: at 2026-04-29T17:00:00-07:00
enabled: true
preset: auto
---

Check Gmail for a reply from Mark about the HIPAA evidence pack.
If found, summarize and send a notification. If not, note it.
```

Resolve "in 2 days" / "tomorrow 5pm" / "next Monday" against the user's local timezone (which is in the context header), format as RFC3339 with offset, and put it in the `at <iso>` schedule.

When fired, the pipe auto-disables itself — `enabled: false` is set in the local-overrides file. The pipe.md stays on disk as history. Users see upcoming one-offs in the chat sidebar's "upcoming" section with a countdown ("in 2d 4h"). To cancel before fire time: `pipe disable <name>`. To re-run after firing: `pipe enable <name>` then `pipe run <name>` (or set a new `at <iso>`).

**Config fields**: `schedule`, `enabled` (bool), `preset` (string or array — e.g. `"Oai"` or `["Primary", "Fallback"]`), `history` (bool — include previous output as context)

Screenpipe prepends a context header with time range, timezone, OS, and API URL before each execution. No template variables needed.

After creating:
```bash
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe install ~/.screenpipe/pipes/my-pipe
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe enable my-pipe
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} pipe run my-pipe   # terminal-only; in-app chat uses the workflow below
```

### Testing from in-app chat

The cloud JWT is intentionally absent from Bash. Do not expose or recover it, and do not use standalone `pipe run`. Test through the authenticated desktop runtime:

```bash
api="${SCREENPIPE_LOCAL_API_URL:-http://localhost:3030}"
auth="Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY"
curl -sS -X POST -H "$auth" "$api/pipes/my-pipe/run"
curl -sS -H "$auth" "$api/pipes/my-pipe/logs"
```

`{"success":true}` means the run started, not that it passed. Poll for a new terminal log. Bind only after `success: true`; otherwise report its `stderr` and leave the Live View unchanged.

### Editing Config

Edit frontmatter in `~/.screenpipe/pipes/<name>/pipe.md` directly, or use the API:

```bash
curl -X POST http://localhost:3030/pipes/<name>/config \
  -H "Content-Type: application/json" \
  -d '{"config": {"schedule": "every 1h", "enabled": true}}'
```

### Output & Artifacts

Pipes can produce user-facing output files that appear in the Artifacts library.

**Standard path** — for files inside the pipe directory:
- Declare them in frontmatter under `artifacts:`:
  ```yaml
  artifacts:
    - path: "output/report.md"
      title: "Weekly Report"
      kind: "markdown"
  ```
- Write results to the declared path. After execution, they are auto-registered.

**External path** — for files outside the pipe directory (shared locations, user folders, vaults):
- Use the `register_artifact` tool during execution:
  ```
  register_artifact(file_path="/path/to/deliverable.md", title="Weekly Report")
  ```
- The tool registers an existing file by its absolute path. The file must already exist on disk.
- Only register finished deliverables — not scratch files, caches, or internal state.

### Rules

1. Use `pipe list` (not `--json`) — table output is compact
2. Never dump full pipe JSON — can be 15MB+
3. Check logs first when debugging: `pipe logs <name>`
4. Outside in-app chat, use `pipe run <name>` before waiting for a schedule; in-app chat uses the authenticated runtime above

---

## Connection Management

Manage integrations (Telegram, Slack, Discord, Email, Todoist, Teams) from the CLI.

### Commands

```bash
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection list              # List all connections + status
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection list --json       # JSON output
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection get <id>          # Show status + non-secret settings
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection get <id> --json   # JSON output
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection set <id> key=val  # Save credentials
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection test <id>         # Test a connection
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection remove <id>       # Remove credentials
```

### Examples

```bash
# Set up Telegram
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection set telegram bot_token=123456:ABC-DEF chat_id=5776185278

# Set up Slack webhook
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection set slack webhook_url=https://hooks.slack.com/services/...

# Verify it works
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection test telegram

# Check what's connected
cd "$(mktemp -d)" && ${SCREENPIPE_CLI:-bun x screenpipe@latest} connection list
```

Connection IDs: `telegram`, `slack`, `discord`, `email`, `todoist`, `teams`, `google-calendar`, `openclaw`

Credentials are stored locally and are not printed by `connection get`.

**Per-integration details**: don't guess API shapes from this skill. Run `connection list` for self-describing local endpoints. `connection get <id>` returns only status and non-secret settings.

## Publishing pipes to the store

```bash
screenpipe pipe publish <pipe-name>
```

Reads `~/.screenpipe/pipes/<pipe-name>/pipe.md`, extracts title/description/icon/category from YAML frontmatter, and publishes to the screenpipe pipe store. Requires auth (SCREENPIPE_API_KEY env var or `~/.screenpipe/auth.json`).
