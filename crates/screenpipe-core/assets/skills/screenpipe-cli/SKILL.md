---
name: screenpipe-cli
description: Manage screenpipe pipes (scheduled AI automations) and connections (Telegram, Slack, Discord, etc.) via the CLI. Use when the user asks to create, list, enable, disable, run, or debug pipes, or manage service connections from the command line.
---

# Screenpipe CLI

Use `bunx screenpipe@latest` to run CLI commands (or `npx screenpipe@latest`). No separate install needed.

## Shell

- **macOS/Linux** → `bash`
- **Windows** → `powershell`

---

## Pipe Management

Pipes are markdown-based AI automations that run on schedule. Each pipe lives at `~/.screenpipe/pipes/<name>/pipe.md`.

### Commands

```bash
bunx screenpipe@latest pipe list                    # List all pipes (compact table)
bunx screenpipe@latest pipe enable <name>           # Enable a pipe
bunx screenpipe@latest pipe disable <name>          # Disable a pipe
bunx screenpipe@latest pipe run <name>              # Run once immediately (for testing)
bunx screenpipe@latest pipe logs <name>             # View execution logs
bunx screenpipe@latest pipe install <url-or-path>   # Install from GitHub or local path
bunx screenpipe@latest pipe delete <name>           # Delete a pipe
bunx screenpipe@latest pipe models list             # View AI model presets
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

**Schedule syntax**: `every 30m`, `every 1h`, `every day at 9am`, `every monday at 9am`, or cron: `*/30 * * * *`, `0 9 * * *`

**Config fields**: `schedule`, `enabled` (bool), `preset` (string or array — e.g. `"Oai"` or `["Primary", "Fallback"]`), `history` (bool — include previous output as context)

Screenpipe prepends a context header with time range, timezone, OS, and API URL before each execution. No template variables needed.

After creating:
```bash
bunx screenpipe@latest pipe install ~/.screenpipe/pipes/my-pipe
bunx screenpipe@latest pipe enable my-pipe
bunx screenpipe@latest pipe run my-pipe   # test immediately
```

### Editing Config

Edit frontmatter in `~/.screenpipe/pipes/<name>/pipe.md` directly, or use the API:

```bash
curl -X POST http://localhost:3030/pipes/<name>/config \
  -H "Content-Type: application/json" \
  -d '{"config": {"schedule": "every 1h", "enabled": true}}'
```

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
bunx screenpipe@latest connection list              # List all connections + status
bunx screenpipe@latest connection list --json       # JSON output
bunx screenpipe@latest connection get <id>          # Show saved credentials
bunx screenpipe@latest connection get <id> --json   # JSON output
bunx screenpipe@latest connection set <id> key=val  # Save credentials
bunx screenpipe@latest connection test <id>         # Test a connection
bunx screenpipe@latest connection remove <id>       # Remove credentials
```

### Examples

```bash
# Set up Telegram
bunx screenpipe@latest connection set telegram bot_token=123456:ABC-DEF chat_id=5776185278

# Set up Slack webhook
bunx screenpipe@latest connection set slack webhook_url=https://hooks.slack.com/services/...

# Verify it works
bunx screenpipe@latest connection test telegram

# Check what's connected
bunx screenpipe@latest connection list
```

Connection IDs: `telegram`, `slack`, `discord`, `email`, `todoist`, `teams`, `google-calendar`, `apple-intelligence`, `openclaw`

Credentials are stored locally at `~/.screenpipe/connections.json`.

## Publishing pipes to the store

```bash
screenpipe pipe publish <pipe-name>
```

Reads `~/.screenpipe/pipes/<pipe-name>/pipe.md`, extracts title/description/icon/category from YAML frontmatter, and publishes to the screenpipe pipe store. Requires auth (SCREENPIPE_API_KEY env var or `~/.screenpipe/auth.json`).
