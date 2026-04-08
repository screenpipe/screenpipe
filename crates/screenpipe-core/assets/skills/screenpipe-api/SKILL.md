---
name: screenpipe-api
description: Query the user's screen recordings, audio, UI elements, and usage analytics via the local Screenpipe REST API at localhost:3030. Use when the user asks about their screen activity, meetings, apps, productivity, media export, retranscription, or connected services.
---

# Screenpipe API

Local REST API at `http://localhost:3030`. Full reference (60+ endpoints): https://docs.screenpi.pe/llms-full.txt

## Context Window Protection

API responses can be large. Always write curl output to a file first (`curl ... -o /tmp/sp_result.json`), check size (`wc -c /tmp/sp_result.json`), and if over 5KB read only the first 50-100 lines. Extract what you need with `jq`. NEVER dump full large responses into context.

---

## 1. Search — `GET /search`

```bash
curl "http://localhost:3030/search?q=QUERY&content_type=all&limit=10&start_time=1h%20ago"
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Keywords. Do NOT use for audio searches — transcriptions are noisy, q filters too aggressively. |
| `content_type` | string | No | `all` (default), `accessibility`, `audio`, `input`, `ocr`, `memory`. Screen text is primarily captured via the OS accessibility tree (`accessibility`); OCR is a fallback for apps without accessibility support (games, remote desktops). Use `all` unless you need a specific modality. |
| `limit` | integer | No | Max 1-20. Default: 10 |
| `offset` | integer | No | Pagination. Default: 0 |
| `start_time` | ISO 8601 or relative | **Yes** | Accepts `2024-01-15T10:00:00Z` or `16h ago`, `2d ago`, `30m ago` |
| `end_time` | ISO 8601 or relative | No | Defaults to now. Accepts `now`, `1h ago` |
| `app_name` | string | No | e.g. "Google Chrome", "Slack", "zoom.us" |
| `window_name` | string | No | Window title substring |
| `speaker_name` | string | No | Filter audio by speaker (case-insensitive partial) |
| `focused` | boolean | No | Only focused windows |
| `max_content_length` | integer | No | Truncate each result's text (middle-truncation) |

### Progressive Disclosure

Don't jump to heavy `/search` calls. Escalate:

| Step | Endpoint | When |
|------|----------|------|
| 0 | `GET /memories?q=...` | **Always query first/in parallel** — highest signal, lowest cost |
| 1 | `GET /activity-summary?start_time=...&end_time=...` | Broad questions ("what was I doing?", "which apps?") |
| 2 | `GET /search?...` | Need specific content |
| 3 | `GET /elements?...` or `GET /frames/{id}/context` | UI structure, buttons, links |
| 4 | `GET /frames/{frame_id}` (PNG) | Visual context needed |

Decision tree:
- "What was I doing?" → Step 1 only
- "Summarize my meeting" → Step 2 with `content_type=audio`, NO q param. Add `content_type=all` for screen context.
- "How long on X?" → Step 1 (`/activity-summary` has `active_minutes`)
- "Which apps today?" → Step 1 (do NOT use frame counts or SQL)
- "What button did I click?" → Step 3 (`/elements` with role=AXButton)
- "Show me what I saw" → Step 2 (find frame_id) → Step 4

### Critical Rules

1. **ALWAYS include `start_time`** — queries without time bounds WILL timeout
2. **Start with 1-2 hour ranges** — expand only if no results
3. **Use `app_name`** when user mentions a specific app
4. **Keep `limit` low** (5-10) initially
5. **"recent"** = 30 min. **"today"** = since midnight. **"yesterday"** = yesterday's range
6. If timeout, narrow the time range

### Response Format

```json
{
  "data": [
    {"type": "OCR", "content": {"frame_id": 12345, "text": "...", "timestamp": "...", "app_name": "Chrome", "window_name": "..."}},
    {"type": "Audio", "content": {"chunk_id": 678, "transcription": "...", "timestamp": "...", "speaker": {"name": "John"}}},
    {"type": "UI", "content": {"id": 999, "text": "Clicked 'Submit'", "timestamp": "...", "app_name": "Safari"}}
  ],
  "pagination": {"limit": 10, "offset": 0, "total": 42}
}
```

> **Note**: The `"OCR"` type label is used for all screen text results, including text captured via the accessibility tree. Most screen text comes from accessibility, not OCR.

---

## 2. Activity Summary — `GET /activity-summary`

```bash
curl "http://localhost:3030/activity-summary?start_time=1h%20ago&end_time=now"
```

Returns app usage with accurate `active_minutes`, first/last seen, recent texts, audio summary. ~200-500 tokens. Best starting point.

---

## 3. Elements — `GET /elements`

Lightweight FTS search across UI elements (~100-500 bytes each vs 5-20KB from `/search`).

```bash
curl "http://localhost:3030/elements?q=Submit&start_time=1h%20ago&limit=10"
```

Parameters: `q`, `frame_id`, `source` (`accessibility`|`ocr`), `role`, `start_time`, `end_time`, `app_name`, `limit`, `offset`.

### Frame Context — `GET /frames/{id}/context`

Returns accessibility text, parsed nodes, and extracted URLs for a frame.

```bash
curl "http://localhost:3030/frames/6789/context"
```

### Common Roles (platform-specific)

Roles are **not normalized** across platforms. Use the correct format for the user's OS:

| Concept | macOS | Windows | Linux |
|---------|-------|---------|-------|
| Button | `AXButton` | `Button` | `Button` |
| Static text | `AXStaticText` | `Text` | `Label` |
| Link | `AXLink` | `Hyperlink` | `Link` |
| Text field | `AXTextField` | `Edit` | `Entry` |
| Text area | `AXTextArea` | `Document` | `Text` |
| Menu item | `AXMenuItem` | `MenuItem` | `MenuItem` |
| Checkbox | `AXCheckBox` | `CheckBox` | `CheckBox` |
| Group | `AXGroup` | `Group` | `Group` |
| Web area | `AXWebArea` | `Pane` | `DocumentWeb` |
| Heading | `AXHeading` | `Header` | `Heading` |
| Tab | `AXTab` | `TabItem` | `Tab` |
| List item | `AXRow` | `ListItem` | `ListItem` |

OCR-only roles (fallback when accessibility unavailable): `line`, `word`, `block`, `paragraph`, `page`

---

## 4. Frames (Screenshots) — `GET /frames/{frame_id}`

```bash
curl -o /tmp/frame.png "http://localhost:3030/frames/12345"
```

Returns raw PNG. **Never fetch more than 2-3 frames per query** (~1000-2000 tokens each).

---

## 5. Media Export — `POST /frames/export`

```bash
curl -X POST http://localhost:3030/frames/export \
  -H "Content-Type: application/json" \
  -d '{"start_time": "5m ago", "end_time": "now", "fps": 1.0}'
```

Fields: `start_time`, `end_time` (or `frame_ids` array), `fps` (default 1.0). Max 10,000 frames.

FPS guidelines: 5min→1.0, 30min→0.5, 1h→0.2, 2h+→0.1

Returns `{"file_path": "...", "frame_count": N, "duration_secs": N}`. Show path as inline code block for playback.

### Audio & ffmpeg

Audio files from search results (`file_path`). Common operations:
```bash
ffmpeg -y -i /path/to/audio.mp4 -q:a 2 ~/.screenpipe/exports/output.mp3          # convert
ffmpeg -y -i input.mp4 -ss 00:01:00 -to 00:05:00 -q:a 2 clip.mp3                 # trim
ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -an fast.mp4                    # speed 2x
ffmpeg -y -i input.mp4 -t 10 -vf "fps=10,scale=640:-1" output.gif                 # GIF
```

Always use `-y`, save to `~/.screenpipe/exports/`.

---

## 6. Retranscribe — `POST /audio/retranscribe`

```bash
curl -X POST http://localhost:3030/audio/retranscribe \
  -H "Content-Type: application/json" \
  -d '{"start": "1h ago", "end": "now"}'
```

Optional: `engine` (`whisper-large-v3-turbo`|`whisper-large-v3`|`deepgram`|`qwen3-asr`), `vocabulary` (array of `{"word": "...", "replacement": "..."}` for bias/replacement), `prompt` (topic context for Whisper).

Keep ranges short (1h max). Show old vs new transcription.

---

## 7. Raw SQL — `POST /raw_sql`

```bash
curl -X POST http://localhost:3030/raw_sql \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT ... LIMIT 100"}'
```

**Rules**: Every SELECT needs LIMIT. Always filter by time. Read-only. Use `datetime('now', '-24 hours')` for time math.

**WARNING**: Do NOT use frame counts for time estimates — frames are event-driven, not fixed-interval. Use `/activity-summary` for screen time.

### Schema

| Table | Key Columns | Time Column |
|-------|-------------|-------------|
| `frames` | `app_name`, `window_name`, `browser_url`, `focused` | `timestamp` |
| `ocr_text` | `text`, `app_name`, `window_name` | join via `frame_id` |
| `elements` | `source`, `role`, `text`, `bounds_*` | join via `frame_id` |
| `audio_transcriptions` | `transcription`, `device`, `speaker_id`, `is_input_device` | `timestamp` |
| `audio_chunks` | `file_path` | `timestamp` |
| `speakers` | `name`, `metadata` | — |
| `ui_events` | `event_type`, `app_name`, `window_title`, `browser_url` | `timestamp` |
| `accessibility` | `app_name`, `window_name`, `text_content`, `browser_url` | `timestamp` |
| `meetings` | `meeting_app`, `title`, `attendees`, `detection_source` | `meeting_start` |
| `memories` | `content`, `source`, `tags`, `importance` | `created_at` |

### Example Queries

```sql
-- Most used apps (last 24h)
SELECT app_name, COUNT(*) as frames FROM frames
WHERE timestamp > datetime('now', '-24 hours') AND app_name IS NOT NULL
GROUP BY app_name ORDER BY frames DESC LIMIT 20

-- Most visited domains
SELECT CASE WHEN INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') > 0
  THEN SUBSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), 1, INSTR(SUBSTR(browser_url, INSTR(browser_url, '://') + 3), '/') - 1)
  ELSE SUBSTR(browser_url, INSTR(browser_url, '://') + 3) END as domain,
COUNT(*) as visits FROM frames
WHERE timestamp > datetime('now', '-24 hours') AND browser_url IS NOT NULL
GROUP BY domain ORDER BY visits DESC LIMIT 20

-- Speaker stats
SELECT COALESCE(NULLIF(s.name, ''), 'Unknown') as speaker, COUNT(*) as segments
FROM audio_transcriptions at LEFT JOIN speakers s ON at.speaker_id = s.id
WHERE at.timestamp > datetime('now', '-24 hours')
GROUP BY at.speaker_id ORDER BY segments DESC LIMIT 20

-- Context switches per hour
SELECT strftime('%H:00', timestamp) as hour, COUNT(*) as switches
FROM ui_events WHERE event_type = 'app_switch' AND timestamp > datetime('now', '-24 hours')
GROUP BY hour ORDER BY hour LIMIT 24
```

Common patterns: `GROUP BY date(timestamp)` (daily), `GROUP BY strftime('%H:00', timestamp)` (hourly), `HAVING frames > 5` (filter noise).

---

## 8. Connections — `GET /connections`

```bash
# List all integrations (Telegram, Slack, Discord, Email, Todoist, Teams)
curl http://localhost:3030/connections

# Get credentials for a connected service
curl http://localhost:3030/connections/telegram
```

Returns credentials to use with service APIs directly:
- **Telegram**: `bot_token` + `chat_id` → `POST https://api.telegram.org/bot{token}/sendMessage`
- **Slack**: `webhook_url` → `POST {webhook_url}` with `{"text": "..."}`
- **Discord**: `webhook_url` → `POST {webhook_url}` with `{"content": "..."}`
- **Todoist**: `api_token` → `POST https://api.todoist.com/api/v1/tasks` with Bearer auth
- **Teams**: `webhook_url` → `POST {webhook_url}` with `{"text": "..."}`
- **Email**: `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`, `from_address`

If not connected, tell user to set up in Settings > Connections.

---

## 9. Meetings — `GET /meetings`

```bash
curl "http://localhost:3030/meetings?start_time=1d%20ago&end_time=now&limit=10&offset=0"
curl "http://localhost:3030/meetings/42"
```

Returns detected meetings (from calendar, app detection, window titles, UI elements, multi-speaker audio).

| Field | Type | Description |
|-------|------|-------------|
| `id` | integer | Meeting ID |
| `meeting_start` | ISO 8601 | Start time |
| `meeting_end` | ISO 8601? | End time (null if ongoing) |
| `meeting_app` | string | App (zoom, teams, meet, etc.) |
| `title` | string? | Meeting title |
| `attendees` | string? | Attendees |
| `detection_source` | string | How detected (`app`, `calendar`, `ui`, etc.) |

Also available via raw SQL: `SELECT * FROM meetings WHERE meeting_start > datetime('now', '-24 hours') LIMIT 20`

---

## 10. Speakers — Management & Reassignment

```bash
# Search speakers by name
curl "http://localhost:3030/speakers/search?name=John"

# Get unnamed speakers (for labeling)
curl "http://localhost:3030/speakers/unnamed?limit=20&offset=0"

# Get speakers similar to a given speaker (by voice embedding)
curl "http://localhost:3030/speakers/similar?speaker_id=29&limit=5"

# Update speaker name/metadata
curl -X POST http://localhost:3030/speakers/update \
  -H "Content-Type: application/json" \
  -d '{"id": 29, "name": "Jordan"}'

# Reassign speaker for an audio chunk (propagates to similar chunks by default)
curl -X POST http://localhost:3030/speakers/reassign \
  -H "Content-Type: application/json" \
  -d '{"audio_chunk_id": 456, "new_speaker_name": "Jordan", "propagate_similar": true}'
# Returns: new_speaker_id, transcriptions_updated, old_assignments (for undo)

# Undo a speaker reassignment
curl -X POST http://localhost:3030/speakers/undo-reassign \
  -H "Content-Type: application/json" \
  -d '{"old_assignments": [{"transcription_id": 1, "old_speaker_id": 29}]}'

# Merge two speakers (keeps one, merges the other into it)
curl -X POST http://localhost:3030/speakers/merge \
  -H "Content-Type: application/json" \
  -d '{"speaker_to_keep_id": 5, "speaker_to_merge_id": 29}'

# Mark speaker as hallucination (false detection)
curl -X POST http://localhost:3030/speakers/hallucination \
  -H "Content-Type: application/json" \
  -d '{"speaker_id": 29}'

# Delete a speaker (also removes associated audio chunk files)
curl -X POST http://localhost:3030/speakers/delete \
  -H "Content-Type: application/json" \
  -d '{"id": 29}'
```

### Speaker Reassignment Workflow

When the user says "that was actually Jordan, not Karishma":
1. Search audio results to find the `chunk_id` for the misidentified audio
2. Call `POST /speakers/reassign` with `audio_chunk_id` and `new_speaker_name`
3. With `propagate_similar: true` (default), it also fixes similar-sounding chunks

---

## 11. Memories — High-Signal Persistent Knowledge

**Memories are the highest-signal data source in screenpipe.** They contain curated facts, user preferences, decisions, and project context — distilled from hours of screen/audio data. Always check memories when answering questions or building context.

### When to Query Memories

**Query memories FIRST (before or alongside `/search`)** when:
- The user asks about preferences, decisions, or past context
- You need background on a project, person, or workflow
- You're generating a summary, recommendation, or action plan
- You're unsure about user preferences or past decisions
- Any task where historical context would improve the output

**Rule: If you're calling `/search`, also call `/memories` in parallel.** Memories provide the "why" behind the raw screen data. Search gives you what happened; memories tell you what matters.

### API

```bash
# Search memories (FTS) — do this often!
curl "http://localhost:3030/memories?q=preference&limit=20"

# List recent memories (high importance first)
curl "http://localhost:3030/memories?min_importance=0.5&limit=20"

# Filter by source or tags
curl "http://localhost:3030/memories?source=user&tags=project&limit=20"

# Create a memory
curl -X POST http://localhost:3030/memories \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "source": "user", "tags": ["preference", "ui"], "importance": 0.7}'

# Update a memory
curl -X PUT http://localhost:3030/memories/1 \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode in all apps", "importance": 0.8}'

# Delete a memory
curl -X DELETE http://localhost:3030/memories/1
```

Parameters for `GET /memories`: `q` (FTS search), `source`, `tags`, `min_importance`, `start_time`, `end_time`, `limit`, `offset`.

Memories also appear in `/search?content_type=memory`.

### Creating Memories

When you learn something important about the user (preferences, decisions, project context), store it as a memory. Use `importance` 0.0-1.0 to rank signal. Only store genuinely useful long-lived facts, not transient observations.

---

## 12. Notifications — `POST http://localhost:11435/notify`

Send a notification to the screenpipe desktop UI. This uses the Tauri sidecar server (port 11435), **not** the main API (port 3030).

The notification body supports **markdown**: `**bold**`, `` `inline code` ``, and `[link text](url)`. Links can be web URLs, file paths, or screenpipe deeplinks.

```bash
# Simple notification
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "3 new voice memos", "body": "found recordings from today"}'

# Markdown body with links
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "Meeting summary", "body": "**Q3 Planning** notes saved\n\nopen [meeting notes](~/Documents/notes/q3.md) or view [recording](screenpipe://timeline)"}'

# Link to a local file (absolute path or ~ path)
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "Export complete", "body": "saved to [report.csv](~/Downloads/report.csv)"}'

# With action buttons
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "Meeting summary", "body": "**Q3 Planning**\n- Budget approved", "actions": [{"id": "view", "label": "view", "type": "deeplink", "url": "screenpipe://timeline"}, {"id": "skip", "label": "skip", "type": "dismiss"}]}'

# Custom auto-dismiss (5 seconds)
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "Saved", "body": "Note saved", "timeout": 5000}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | **Yes** | Notification title |
| `body` | string | **Yes** | Markdown body (`**bold**`, `` `code` ``, `[text](url)`) |
| `type` | string | No | Category (default "pipe") |
| `timeout` | integer | No | Auto-dismiss in ms (default 20000) |
| `autoDismissMs` | integer | No | Alias for timeout |
| `actions` | array | No | Action buttons |

**Supported link types in body markdown:**
- Web URLs: `[docs](https://docs.screenpi.pe)` — opens in browser
- File paths: `[notes](~/notes/file.md)` or `[log](/var/log/app.log)` — opens in default app
- Deeplinks: `[timeline](screenpipe://timeline)` — navigates within screenpipe

Returns `{"success": true, "message": "Notification sent successfully"}`.

---

## 13. Other Endpoints

```bash
curl http://localhost:3030/health              # Health check
curl http://localhost:3030/audio/list           # Audio devices
curl http://localhost:3030/vision/list          # Monitors
```

---

## Deep Links

Reference specific moments with clickable links:

```markdown
[10:30 AM — Chrome](screenpipe://frame/12345)           # screen text results (use frame_id)
[meeting at 3pm](screenpipe://timeline?timestamp=ISO8601) # Audio results (use timestamp)
```

Only use IDs/timestamps from actual search results. Never fabricate.

## Showing Videos

Show `file_path` from search results as inline code for playable video:
```
`/Users/name/.screenpipe/data/monitor_1_2024-01-15_10-30-00.mp4`
```
