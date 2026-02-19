---
name: screenpipe-pipe-creator
description: Create, install, and manage screenpipe pipes — scheduled AI agents that run automatically on a cron schedule. Use when the user asks to create a pipe, schedule a prompt, automate a task, set up recurring summaries, or turn a chat into a pipe.
---

# Screenpipe Pipe Creator

Create scheduled AI agents ("pipes") that run automatically on your local machine.

## What is a pipe?

A pipe is a scheduled AI agent defined as a single markdown file: `~/.screenpipe/pipes/{name}/pipe.md`

Every N minutes, screenpipe runs a coding agent (like pi or claude-code) with the pipe's prompt. The agent can query your screen data, write files, call external APIs, send notifications, etc.

## pipe.md format

The file starts with YAML frontmatter, then the prompt body:

```
---
schedule: every 30m
enabled: true
---

Your prompt instructions here...
```

### Schedule syntax

Use natural language in the `schedule` field:
- `every 30m` — every 30 minutes
- `every 1h` — every hour
- `every day at 9am` — daily at 9 AM
- `every day at 6pm` — daily at 6 PM
- `every monday at 9am` — weekly on Monday at 9 AM

Or use cron syntax:
- `0 9 * * *` — every day at 9 AM
- `0 */2 * * *` — every 2 hours
- `*/30 * * * *` — every 30 minutes

## Context header

Before execution, screenpipe prepends a context header to the prompt with:
- Time range (start/end timestamps based on the schedule interval)
- Current date
- User's timezone
- Screenpipe API base URL (`http://localhost:3030`)
- Output directory

The AI agent uses this context to query the right time range. No template variables needed in the prompt.

## Screenpipe search API

The agent queries screen data via the local REST API:

```bash
curl "http://localhost:3030/search?limit=20&content_type=all&start_time=<ISO8601>&end_time=<ISO8601>"
```

### Query parameters
- `q`: text search query (optional)
- `content_type`: `"all"` | `"ocr"` | `"audio"` | `"input"` | `"accessibility"`
- `limit`: max results (default 20)
- `offset`: pagination offset
- `start_time` / `end_time`: ISO 8601 timestamps (ALWAYS include start_time)
- `app_name`: filter by app (e.g. "chrome", "cursor")
- `window_name`: filter by window title
- `browser_url`: filter by URL (e.g. "github.com")
- `min_length` / `max_length`: filter by text length
- `speaker_ids`: filter audio by speaker IDs

### Raw SQL for aggregation
```bash
curl -X POST http://localhost:3030/raw_sql -H "Content-Type: application/json" \
  -d '{"query": "SELECT app_name, COUNT(*) as count FROM frames WHERE timestamp > datetime(\"now\", \"-24 hours\") GROUP BY app_name ORDER BY count DESC"}'
```

## After creating the file

IMPORTANT: Always use `bunx screenpipe@latest` (not `bunx screenpipe` or `screenpipe`) to ensure the latest CLI version:

```bash
# Install the pipe
bunx screenpipe@latest pipe install ~/.screenpipe/pipes/my-pipe

# Enable it
bunx screenpipe@latest pipe enable my-pipe

# Test it immediately (run once without waiting for schedule)
bunx screenpipe@latest pipe run my-pipe
```

## Important formatting rules

- The pipe.md file MUST start with `---` on the very first line (YAML front-matter). No blank lines or comments before it.
- Keep prompts clear and specific about what data to query and what to do with results.
- For daily summaries, query the last 24h. For hourly tasks, query the last 1h.
- Common output actions: desktop notifications, writing to files, calling webhooks.

## Example pipes

### Daily standup summary
```
---
schedule: every day at 9am
enabled: true
---

Search my screen and audio recordings from the last 24 hours. Summarize what I worked on, group by project/app, and highlight any meetings or important conversations. Send the summary as a desktop notification.
```

### Hourly focus tracker
```
---
schedule: every 1h
enabled: true
---

Search my screen recordings from the last hour. Calculate how much time I spent in each app. If I spent more than 20 minutes on social media or news sites, send a desktop notification reminding me to stay focused.
```
