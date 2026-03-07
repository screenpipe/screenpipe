---
name: screenpipe-pipes
description: Manage screenpipe pipes — list, enable, disable, run, install, delete, view logs, and edit config. Use when the user asks about their pipes, automations, scheduled tasks, or wants to create/modify pipes.
---

# Screenpipe Pipe Management

Pipes are markdown-based automations that run on schedule or on-demand. Each pipe lives at `~/.screenpipe/pipes/<name>/pipe.md`.

## Shell: pick the right one for the OS

- **macOS/Linux** → `bash`
- **Windows** → `powershell`

## CLI Commands

Use `bunx screenpipe@latest` to run CLI commands. Users don't install the CLI separately — `bunx` fetches it on-the-fly.

### List all pipes

```bash
bunx screenpipe@latest pipe list
```

Output:
```
NAME                 ENABLED    SCHEDULE     LAST RUN
--------------------------------------------------------------
obsidian-sync        running    */30 * * *   2026-03-06 15:40
meeting-sync         yes        */10 * * *   2026-03-06 15:50
daily-logs           no                      never
```

For full JSON (large output — avoid unless you need specific fields):
```bash
bunx screenpipe@latest pipe list --json
```

### Enable / Disable a pipe

```bash
bunx screenpipe@latest pipe enable <name>
bunx screenpipe@latest pipe disable <name>
```

### Run a pipe once immediately

```bash
bunx screenpipe@latest pipe run <name>
```

Returns stdout/stderr and success status.

### View pipe logs

```bash
bunx screenpipe@latest pipe logs <name>
```

Output:
```
2026-03-06 15:40:00 ✓ (12s)
2026-03-06 15:10:00 ✓ (8s)
2026-03-06 14:40:00 ✗ (3s) — connection refused
```

### Install a pipe

```bash
# From URL (GitHub raw or pipe store)
bunx screenpipe@latest pipe install https://github.com/user/repo/blob/main/pipe.md

# From local path
bunx screenpipe@latest pipe install /path/to/pipe.md
bunx screenpipe@latest pipe install ./my-pipe/
```

### Delete a pipe

```bash
bunx screenpipe@latest pipe delete <name>
```

### View AI model presets

```bash
bunx screenpipe@latest pipe models list
```

## Editing Pipe Config

Each pipe's config is in the YAML frontmatter of `~/.screenpipe/pipes/<name>/pipe.md`:

```yaml
---
schedule: every 30m
enabled: true
preset: Oai
history: true
---
```

### Config fields

| Field | Type | Description |
|-------|------|-------------|
| `schedule` | cron or shorthand | When to run: `*/10 * * * *`, `every 30m`, `every 2h`, `daily 9:00` |
| `enabled` | bool | Whether the pipe runs on schedule |
| `preset` | string | AI preset name (e.g., `Oai`, `Screenpipe`) — matches presets from Settings |
| `history` | bool | Whether to include previous execution output as context |

To update config, edit the frontmatter directly:

```bash
# Read current config
head -20 ~/.screenpipe/pipes/<name>/pipe.md

# Edit with sed (example: change schedule)
sed -i '' 's/^schedule:.*/schedule: every 1h/' ~/.screenpipe/pipes/<name>/pipe.md
```

Or use the API for programmatic config updates:

```bash
curl -X POST http://localhost:3030/pipes/<name>/config \
  -H "Content-Type: application/json" \
  -d '{"config": {"schedule": "every 1h", "enabled": true}}'
```

## Creating a New Pipe

Create a directory with a `pipe.md` file:

```bash
mkdir -p ~/.screenpipe/pipes/my-pipe
cat > ~/.screenpipe/pipes/my-pipe/pipe.md << 'PIPE'
---
schedule: every 1h
enabled: true
preset: Oai
---

Your task description here. The AI will execute this as instructions.

## What to do

1. Query screenpipe search API for recent activity
2. Process the results
3. Output a summary
PIPE
```

Then enable it:
```bash
bunx screenpipe@latest pipe enable my-pipe
```

## Rules

1. **Always use `bunx screenpipe@latest pipe list` (not `--json`)** to check pipe status — the table output is compact and sufficient.
2. **Never dump full pipe JSON** to the conversation — it can be 15MB+ and will exceed model limits.
3. **Edit pipe.md frontmatter** for config changes rather than using the API when possible — it's simpler and the file is the source of truth.
4. **Check logs first** when debugging a pipe: `bunx screenpipe@latest pipe logs <name>`.
5. **Use `bunx screenpipe@latest pipe run <name>`** to test changes immediately instead of waiting for the schedule.
