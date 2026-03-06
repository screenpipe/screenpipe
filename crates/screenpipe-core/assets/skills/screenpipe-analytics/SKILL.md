---
name: screenpipe-analytics
description: Analyze the user's computer usage patterns using raw SQL queries on their local Screenpipe database. Use when the user asks about their most used apps, websites, screen time, productivity, meeting time, typing habits, context switching, or any aggregate statistics about their activity.
---

# Screenpipe Analytics

Run raw SQL queries against the user's local Screenpipe database to answer questions about their computer usage patterns, productivity, and habits.

The API runs at `http://localhost:3030`.

## Shell: pick the right one for the OS

- **macOS/Linux** → `bash`, `curl`
- **Windows** → `powershell`, `curl.exe` (not the alias)

All examples below use bash. On Windows, adapt: use `powershell`, replace `curl` with `curl.exe`.

## Raw SQL API

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT ... LIMIT 100"}'
```

Returns a JSON array of row objects.

## CRITICAL RULES

1. **Every SELECT must have a LIMIT** — the API rejects queries without one. Use `LIMIT 100` or less.
2. **Always filter by time** — use `WHERE timestamp > datetime('now', '-24 hours')` or similar. The database can have millions of rows.
3. **Read-only** — only SELECT queries are allowed. No INSERT, UPDATE, DELETE, DROP, etc.
4. **Use datetime() for time math** — SQLite syntax: `datetime('now', '-1 hours')`, `datetime('now', '-7 days')`, `date('now')`.
5. **Default to last 24 hours** unless the user asks for a different range.
6. **"today"** = `date(timestamp) = date('now')`. **"yesterday"** = `date(timestamp) = date('now', '-1 day')`. **"this week"** = `timestamp > datetime('now', '-7 days')`.
7. **Protect your context window.** SQL results can be large. Always write curl output to a file first (`curl ... -o /tmp/sp_result.json`), then check its size (`wc -c /tmp/sp_result.json`). If over 5KB, read only the first 50-100 lines to understand the structure, then extract what you need with `jq` or targeted reads. NEVER dump a full large API response into your context.

## Database Schema

### frames — Screen captures (1 row per screenshot, ~0.5 fps)

```sql
CREATE TABLE frames (
    id INTEGER PRIMARY KEY,
    video_chunk_id INTEGER,
    offset_index INTEGER,
    timestamp TIMESTAMP NOT NULL,
    app_name TEXT,           -- e.g. "Google Chrome", "VS Code", "Slack"
    window_name TEXT,        -- window title
    focused BOOLEAN,
    browser_url TEXT,        -- URL if browser window
    device_name TEXT         -- monitor name
);
```

**Key facts:**
- Frames are event-driven (accessibility captures fire on content change), NOT fixed-interval. Frame count does NOT reliably translate to screen time.
- **WARNING: Do NOT use SQL to answer "how long" / "time spent" / "which apps did I use most" questions.** Use the `/activity-summary` REST endpoint instead — it calculates accurate active session time. SQL frame counts can be off by 10x.
- If you must use SQL for time estimation, use gap analysis (measure time between consecutive frames), NOT `COUNT(*) * 2 / 60`.
- `app_name` is the focused application
- `browser_url` is populated for browser windows
- `window_name` contains document/tab titles

### audio_transcriptions — Speech-to-text segments

```sql
CREATE TABLE audio_transcriptions (
    id INTEGER PRIMARY KEY,
    audio_chunk_id INTEGER,
    timestamp TIMESTAMP NOT NULL,
    transcription TEXT NOT NULL,
    device TEXT,                -- device name (e.g. "MacBook Pro Microphone")
    is_input_device BOOLEAN,   -- true = microphone, false = system audio
    speaker_id INTEGER,
    transcription_engine TEXT
);
```

### audio_chunks — Audio recording files (~30s each)

```sql
CREATE TABLE audio_chunks (
    id INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    timestamp TIMESTAMP
);
```

### speakers — Known speakers

```sql
CREATE TABLE speakers (
    id INTEGER PRIMARY KEY,
    name TEXT,
    metadata JSON
);
```

### ui_events — User interactions (clicks, keystrokes, app switches)

```sql
CREATE TABLE ui_events (
    id INTEGER PRIMARY KEY,
    timestamp DATETIME NOT NULL,
    event_type TEXT NOT NULL,    -- 'click', 'key', 'scroll', 'app_switch', 'window_focus', 'text'
    app_name TEXT,
    window_title TEXT,
    browser_url TEXT,
    element_role TEXT,           -- accessibility role of clicked element
    element_name TEXT,           -- accessibility name of clicked element
    text_content TEXT,
    text_length INTEGER
);
```

### accessibility — Accessibility tree snapshots

```sql
CREATE TABLE accessibility (
    id INTEGER PRIMARY KEY,
    timestamp DATETIME NOT NULL,
    app_name TEXT NOT NULL,
    window_name TEXT NOT NULL,
    text_content TEXT NOT NULL,
    browser_url TEXT
);
```

### ocr_text — OCR extracted text per frame

```sql
CREATE TABLE ocr_text (
    frame_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    app_name TEXT,
    window_name TEXT,
    focused BOOLEAN
);
```

### elements — Structured UI elements (accessibility nodes + OCR blocks)

```sql
CREATE TABLE elements (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL,     -- FK to frames.id
    source TEXT NOT NULL,           -- 'accessibility' or 'ocr'
    role TEXT NOT NULL,             -- e.g. 'AXButton', 'AXStaticText', 'AXLink', 'line'
    text TEXT,                      -- element text content
    parent_id INTEGER,             -- parent element id (for hierarchy)
    depth INTEGER NOT NULL DEFAULT 0,
    bounds_left REAL,
    bounds_top REAL,
    bounds_width REAL,
    bounds_height REAL,
    confidence REAL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
-- FTS index: elements_fts (text)
```

**Key facts:**
- Each frame can have hundreds of elements (one per UI node)
- `source='accessibility'` has proper hierarchy (parent_id, depth) and roles
- `source='ocr'` has flat text blocks with bounding boxes
- FTS index enables fast full-text search via the `/elements` API endpoint
- Join with `frames` via `frame_id` to get timestamps, app names, etc.

## Ready-to-Use Queries

### Most used apps (by screen time)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT app_name, COUNT(*) as frames, ROUND(COUNT(*) * 2.0 / 60, 1) as minutes FROM frames WHERE timestamp > datetime('"'"'now'"'"', '"'"'-24 hours'"'"') AND app_name IS NOT NULL AND app_name != '"'"''"'"' GROUP BY app_name ORDER BY frames DESC LIMIT 20"}'
```

Simpler with heredoc:

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT app_name, COUNT(*) as frames, ROUND(COUNT(*) * 2.0 / 60, 1) as minutes FROM frames WHERE timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL AND app_name != '' GROUP BY app_name ORDER BY frames DESC LIMIT 20"}
PAYLOAD
```

### Most visited websites

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT CASE WHEN INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') > 0 THEN SUBSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), 1, INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') - 1) ELSE SUBSTR(browser_url, INSTR(browser_url, '://') + 3) END as domain, COUNT(*) as visits FROM frames WHERE timestamp > datetime('now', '-24 hours') AND browser_url IS NOT NULL AND browser_url != '' GROUP BY domain ORDER BY visits DESC LIMIT 20"}
PAYLOAD
```

### Daily screen time (last 7 days)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT date(timestamp) as day, COUNT(*) as frames, ROUND(COUNT(*) * 2.0 / 3600, 1) as hours, COUNT(DISTINCT app_name) as unique_apps FROM frames WHERE timestamp > datetime('now', '-7 days') AND app_name IS NOT NULL GROUP BY day ORDER BY day DESC LIMIT 10"}
PAYLOAD
```

### Hourly app usage breakdown

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT strftime('%H:00', timestamp) as hour, app_name, COUNT(*) as frames FROM frames WHERE timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL AND app_name != '' GROUP BY hour, app_name HAVING frames > 5 ORDER BY hour DESC, frames DESC LIMIT 50"}
PAYLOAD
```

### Most viewed windows/documents

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT window_name, app_name, COUNT(*) as frames, ROUND(COUNT(*) * 2.0 / 60, 1) as minutes FROM frames WHERE timestamp > datetime('now', '-24 hours') AND window_name IS NOT NULL AND window_name != '' GROUP BY window_name, app_name ORDER BY frames DESC LIMIT 20"}
PAYLOAD
```

### Speaker stats (who talked the most)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT COALESCE(NULLIF(s.name, ''), 'Unknown') as speaker, COUNT(*) as segments, SUM(LENGTH(at.transcription)) as total_chars FROM audio_transcriptions at LEFT JOIN speakers s ON at.speaker_id = s.id WHERE at.timestamp > datetime('now', '-24 hours') GROUP BY at.speaker_id ORDER BY segments DESC LIMIT 20"}
PAYLOAD
```

### Context switching frequency (app switches per hour)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT strftime('%H:00', timestamp) as hour, COUNT(*) as switches FROM ui_events WHERE event_type = 'app_switch' AND timestamp > datetime('now', '-24 hours') GROUP BY hour ORDER BY hour LIMIT 24"}
PAYLOAD
```

### Click interactions by app

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT app_name, COUNT(*) as clicks FROM ui_events WHERE event_type = 'click' AND timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL GROUP BY app_name ORDER BY clicks DESC LIMIT 20"}
PAYLOAD
```

### Most seen UI elements by app

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT f.app_name, e.role, COUNT(*) as count FROM elements e JOIN frames f ON f.id = e.frame_id WHERE f.timestamp > datetime('now', '-24 hours') AND e.source = 'accessibility' AND e.text IS NOT NULL GROUP BY f.app_name, e.role ORDER BY count DESC LIMIT 30"}
PAYLOAD
```

### Typing volume by app

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT app_name, COUNT(*) as keystrokes FROM ui_events WHERE event_type = 'key' AND timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL GROUP BY app_name ORDER BY keystrokes DESC LIMIT 15"}
PAYLOAD
```

### Daily audio recording stats (meeting time estimate)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT date(timestamp) as day, COUNT(DISTINCT id) as chunks, ROUND(COUNT(DISTINCT id) * 30.0 / 3600, 1) as approx_hours FROM audio_chunks WHERE timestamp > datetime('now', '-7 days') GROUP BY day ORDER BY day DESC LIMIT 10"}
PAYLOAD
```

### Browser time by domain

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT CASE WHEN INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') > 0 THEN SUBSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), 1, INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') - 1) ELSE SUBSTR(browser_url, INSTR(browser_url, '://') + 3) END as domain, ROUND(COUNT(*) * 2.0 / 60, 1) as minutes FROM frames WHERE timestamp > datetime('now', '-24 hours') AND browser_url IS NOT NULL AND browser_url != '' GROUP BY domain ORDER BY minutes DESC LIMIT 20"}
PAYLOAD
```

### Productivity breakdown (coding vs browsing vs communication)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT CASE WHEN app_name IN ('VS Code', 'Code', 'Cursor', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Xcode', 'Android Studio', 'Neovim', 'Vim', 'Emacs', 'Sublime Text', 'Atom', 'WezTerm', 'iTerm2', 'Terminal', 'Alacritty', 'Warp', 'kitty', 'Ghostty', 'Hyper') THEN 'Coding & Terminal' WHEN app_name IN ('Google Chrome', 'Arc', 'Safari', 'Firefox', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Opera') THEN 'Browser' WHEN app_name IN ('Slack', 'Discord', 'Microsoft Teams', 'Telegram', 'Messages', 'WhatsApp', 'Signal', 'Zoom', 'zoom.us', 'Google Meet') THEN 'Communication' WHEN app_name IN ('Notion', 'Obsidian', 'Bear', 'Notes', 'Evernote', 'Roam Research', 'Logseq') THEN 'Notes & Docs' WHEN app_name IN ('Figma', 'Sketch', 'Adobe Photoshop', 'Adobe Illustrator', 'Canva') THEN 'Design' ELSE 'Other' END as category, COUNT(*) as frames, ROUND(COUNT(*) * 2.0 / 60, 1) as minutes FROM frames WHERE timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL AND app_name != '' GROUP BY category ORDER BY frames DESC LIMIT 10"}
PAYLOAD
```

### Active hours heatmap (when are you at the computer)

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  --data-binary @- <<'PAYLOAD'
{"query": "SELECT strftime('%w', timestamp) as weekday, strftime('%H', timestamp) as hour, COUNT(*) as frames FROM frames WHERE timestamp > datetime('now', '-7 days') AND app_name IS NOT NULL GROUP BY weekday, hour ORDER BY weekday, hour LIMIT 200"}
PAYLOAD
```

Weekday values: 0=Sunday, 1=Monday, ..., 6=Saturday.

## Building Custom Queries

### Available tables and their purposes

| Table | Purpose | Time column | Key columns |
|-------|---------|-------------|-------------|
| `frames` | Screen captures (~0.5 fps) | `timestamp` | `app_name`, `window_name`, `browser_url`, `focused` |
| `ocr_text` | OCR text per frame | Join via `frame_id` | `text`, `app_name`, `window_name` |
| `elements` | Structured UI elements | Join via `frame_id` → `frames.timestamp` | `source`, `role`, `text`, `bounds_*` |
| `audio_transcriptions` | Speech segments | `timestamp` | `transcription`, `device`, `speaker_id`, `is_input_device` |
| `audio_chunks` | Audio files (~30s) | `timestamp` | `file_path` |
| `speakers` | Speaker identities | — | `name`, `metadata` |
| `ui_events` | User interactions | `timestamp` | `event_type`, `app_name`, `window_title`, `browser_url` |
| `accessibility` | Accessibility tree text | `timestamp` | `app_name`, `window_name`, `text_content`, `browser_url` |

### Common patterns

```sql
-- Time filtering
WHERE timestamp > datetime('now', '-24 hours')
WHERE timestamp > datetime('now', '-7 days')
WHERE date(timestamp) = date('now')
WHERE timestamp BETWEEN '2024-01-15T00:00:00Z' AND '2024-01-15T23:59:59Z'

-- Group by time
GROUP BY date(timestamp)              -- daily
GROUP BY strftime('%H:00', timestamp) -- hourly
GROUP BY strftime('%w', timestamp)    -- by weekday

-- Frame count (NOT accurate screen time — use /activity-summary for that)
COUNT(*) as frame_count  -- number of captured frames (event-driven, not fixed rate)

-- Domain extraction from browser_url
CASE WHEN INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') > 0
  THEN SUBSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), 1, INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') - 1)
  ELSE SUBSTR(browser_url, INSTR(browser_url, '://') + 3)
END as domain
```

### Joining tables

```sql
-- Audio with speaker names
SELECT at.*, s.name as speaker_name
FROM audio_transcriptions at
LEFT JOIN speakers s ON at.speaker_id = s.id

-- OCR text with frame metadata
SELECT f.timestamp, f.app_name, o.text
FROM frames f
JOIN ocr_text o ON o.frame_id = f.id

-- UI events with frame context
SELECT u.event_type, u.app_name, u.element_name, f.window_name
FROM ui_events u
LEFT JOIN frames f ON u.frame_id = f.id
```

## Tips

- **Screen time from frame counts is unreliable** — frames are event-driven, not fixed-interval. Use the `/activity-summary` endpoint for accurate time estimates.
- **Combine multiple queries** to build a full picture — e.g., app usage + website usage + typing stats.
- **Use HAVING** to filter out noise — `HAVING frames > 5` removes apps you glanced at briefly.
- **Window titles reveal context** — for coding, they contain file names and project names. For browsers, they contain page titles.
- **speaker_id can be NULL** — not all audio gets speaker detection. Use `LEFT JOIN` and `COALESCE`.
- **ui_events event_type values**: `click`, `key`, `scroll`, `app_switch`, `window_focus`, `text`, `clipboard`.
- When presenting results, **format numbers** (round decimals, add units like "minutes" or "hours") and **sort by most interesting** metric.
- For productivity reports, combine screen time + typing + click data for a comprehensive view.
