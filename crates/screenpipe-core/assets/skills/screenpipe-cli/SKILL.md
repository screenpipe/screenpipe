---
name: screenpipe-cli
description: Manage screenpipe pipes (scheduled AI automations) and connections (Telegram, Slack, Discord, etc.) via the CLI. Use when the user asks to create, list, enable, disable, run, or debug pipes, or manage service connections from the command line.
---

# Screenpipe CLI

Use `bun x screenpipe@latest` to run CLI commands. No separate install needed.

**IMPORTANT**: Always run `bun x` commands from a clean temp directory to avoid node_modules conflicts:
```bash
cd "$(mktemp -d)" && bun x screenpipe@latest <command>
```

> **Sandboxed shells:** some agents (e.g. Codex) block all shell network access, so `bun x` cannot fetch the package and CLI calls to `localhost:3030` fail instantly. If that happens, use the screenpipe MCP tools instead of the CLI.

## Shell

- **All platforms** → `bash` (on Windows, the bundled git-portable bash is used automatically)

> **Note:** the bash tool truncates output around ~50 KB. Long listings (`connection list`, `pipe list`, etc.) are sorted with connected/enabled rows first, but if you need a specific row, pipe through `grep` or `head` rather than scanning the full output — e.g. `bun x screenpipe@latest connection list | grep -E 'browser|connected'`.

---

## Pipe Management

Pipes are markdown-based AI automations that run on schedule. Each pipe lives at `~/.screenpipe/pipes/<name>/pipe.md`.

### Commands

```bash
bun x screenpipe@latest pipe list                    # List all pipes (compact table)
bun x screenpipe@latest pipe enable <name>           # Enable a pipe
bun x screenpipe@latest pipe disable <name>          # Disable a pipe
bun x screenpipe@latest pipe run <name>              # Run once immediately (for testing)
bun x screenpipe@latest pipe logs <name>             # View execution logs
bun x screenpipe@latest pipe install <url-or-path>   # Install from GitHub or local path
bun x screenpipe@latest pipe delete <name>           # Delete a pipe
bun x screenpipe@latest pipe models list             # View AI model presets
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
bun x screenpipe@latest pipe install ~/.screenpipe/pipes/my-pipe
bun x screenpipe@latest pipe enable my-pipe
bun x screenpipe@latest pipe run my-pipe   # test immediately
```

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
4. Use `pipe run <name>` to test before waiting for schedule

---

## Connection Management

Manage integrations (Telegram, Slack, Discord, Email, Todoist, Teams) from the CLI.

### Commands

```bash
bun x screenpipe@latest connection list              # List all connections + status
bun x screenpipe@latest connection list --json       # JSON output
bun x screenpipe@latest connection get <id>          # Show saved credentials
bun x screenpipe@latest connection get <id> --json   # JSON output
bun x screenpipe@latest connection set <id> key=val  # Save credentials
bun x screenpipe@latest connection test <id>         # Test a connection
bun x screenpipe@latest connection remove <id>       # Remove credentials
```

### Examples

```bash
# Set up Telegram
bun x screenpipe@latest connection set telegram bot_token=123456:ABC-DEF chat_id=5776185278

# Set up Slack webhook
bun x screenpipe@latest connection set slack webhook_url=https://hooks.slack.com/services/...

# Verify it works
bun x screenpipe@latest connection test telegram

# Check what's connected
bun x screenpipe@latest connection list
```

Connection IDs: `telegram`, `slack`, `discord`, `email`, `todoist`, `teams`, `google-calendar`, `openclaw`

Credentials are stored locally at `~/.screenpipe/connections.json`.

**Per-integration details**: don't guess API shapes from this skill. Run `connection list` or `connection get <id>` — each entry includes a self-describing `description` with credential fields, endpoints, and example bodies. Only fetch the integration you need.

## Publishing pipes to the store

```bash
screenpipe pipe publish <pipe-name>
```

Reads `~/.screenpipe/pipes/<pipe-name>/pipe.md`, extracts title/description/icon/category from YAML frontmatter, and publishes to the screenpipe pipe store. Requires auth (SCREENPIPE_API_KEY env var or `~/.screenpipe/auth.json`).
