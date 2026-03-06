---
name: screenpipe-search
description: Search the user's screen recordings, audio transcriptions, and UI interactions via the local Screenpipe API at localhost:3030. Use when the user asks about their screen activity, meetings, apps they used, what they saw/heard, or anything about their computer usage history.
---

# Screenpipe Search

Search the user's locally-recorded screen and audio data. Screenpipe continuously captures screen text (OCR), audio transcriptions, and UI events (clicks, keystrokes, app switches).

The API runs at `http://localhost:3030`.

Full API reference (60+ endpoints): https://docs.screenpi.pe/llms-full.txt

## Shell: pick the right one for the OS

- **macOS/Linux** → `bash`, `curl`, `date -u -v-1H +%Y-%m-%dT%H:%M:%SZ`
- **Windows** → `powershell`, `curl.exe` (not the alias), `(Get-Date).ToUniversalTime().AddHours(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")`

All examples below use bash. On Windows, adapt: use `powershell`, replace `curl` with `curl.exe`, replace `$(date …)` with the PowerShell equivalent, replace `/tmp/` with `$env:TEMP\`, replace `~` with `$env:USERPROFILE`.

## Search API

```bash
curl "http://localhost:3030/search?q=QUERY&content_type=all&limit=10&start_time=ISO8601&end_time=ISO8601"
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Search keywords. Be specific. Do NOT use for audio/meeting searches — transcriptions are noisy, q filters too aggressively. |
| `content_type` | string | No | `all` (default), `ocr`, `audio` (use for meetings/calls), `input`, `accessibility` |
| `limit` | integer | No | Max results 1-20. Default: 10 |
| `offset` | integer | No | Pagination offset. Default: 0 |
| `start_time` | ISO 8601 or relative | **Yes** | Start of time range. ALWAYS include this. Accepts ISO 8601 (`2024-01-15T10:00:00Z`) or relative (`16h ago`, `2d ago`, `30m ago`). |
| `end_time` | ISO 8601 or relative | No | End of time range. Defaults to now. Accepts ISO 8601 or relative (`now`, `1h ago`). |
| `app_name` | string | No | Filter by app (e.g. "Google Chrome", "Slack", "zoom.us", "Code") |
| `window_name` | string | No | Filter by window title substring |
| `speaker_name` | string | No | Filter audio by speaker name (case-insensitive partial match) |
| `focused` | boolean | No | Only return results from focused windows |
| `max_content_length` | integer | No | Truncate each result's text/transcription to this many characters (middle-truncation). Useful for limiting token usage. |

### Content Types

- `ocr` — Screen text captured via OCR
- `audio` — Audio transcriptions (meetings, voice)
- `input` — UI events: clicks, keystrokes, clipboard, app switches
- `accessibility` — Accessibility tree text
- `all` — OCR + Audio + Accessibility (default)

### Progressive Disclosure Strategy

Don't jump straight to heavy `/search` calls. Escalate through these steps, stopping as soon as you have enough info:

| Step | Endpoint | Tokens | When to use |
|------|----------|--------|-------------|
| 1. **Activity Summary** | `GET /activity-summary?start_time=...&end_time=...` | ~200 | Start here for broad questions ("what was I doing?", "summarize my day") |
| 2. **Narrow with /search** | `GET /search?...` | ~500-1000 | When you need specific content from step 1's context |
| 3. **Drill into elements** | `GET /elements?...` or `GET /frames/{id}/context` | ~200 each | For structural detail (buttons, links, UI layout) |
| 4. **Screenshots** | `GET /frames/{frame_id}` | ~1500 each | Only when text isn't enough (charts, images, visual layout) |

#### Decision tree

- "What was I doing?" → Step 1 only
- "What did I work on in Chrome?" → Step 1 (identify Chrome usage) → Step 2 (search Chrome content)
- "Summarize my meeting/call" → Step 2 directly with `content_type=audio`, NO q param
- "How long did I spend on X?" → Step 1 (`/activity-summary` has accurate `active_minutes`)
- "Which apps did I use today?" → Step 1 (`/activity-summary` — do NOT use frame counts or SQL)
- "What button did I click?" → Step 1 (context) → Step 3 (elements with role=AXButton)
- "Show me what I was looking at" → Step 1 → Step 2 (find frame_id) → Step 4 (fetch screenshot)
- "What URLs did I visit?" → Step 1 (identify browser) → Step 3 (`/frames/{id}/context` for URLs)

#### Common mistakes to avoid
- Do NOT use raw frame counts or SQL `COUNT(*)` on frames table to estimate time spent — it's wildly inaccurate. Use `/activity-summary` which calculates actual active session time.
- Do NOT use the `q` param when searching audio/meetings — transcriptions have noise/typos that cause q to miss relevant content. Search by time range and content_type=audio, then scan results.
- Do NOT ask the user for clarification when their intent is clear. "Summarize my meeting" → search audio immediately. "What apps today?" → call activity-summary immediately.

### CRITICAL RULES

1. **ALWAYS include `start_time`** — the database has hundreds of thousands of entries. Queries without time bounds WILL timeout.
2. **Start with short time ranges** — default to last 1-2 hours. Only expand if no results found.
3. **Use `app_name` filter** whenever the user mentions a specific app.
4. **Keep `limit` low** (5-10) initially. Only increase if the user needs more.
5. **"recent"** = last 30 minutes. **"today"** = since midnight. **"yesterday"** = yesterday's date range.
6. If a search times out, retry with a narrower time range (e.g. 30 mins instead of 2 hours).
7. **Prefer lightweight endpoints first** — use `/activity-summary` before `/search`, and `/elements` before fetching full frames.
8. **Protect your context window.** API responses can be large. Always write curl output to a file first (`curl ... -o /tmp/sp_result.json`), then check its size (`wc -c /tmp/sp_result.json`). If over 5KB, read only the first 50-100 lines to understand the structure, then extract what you need with `jq` or targeted reads. NEVER dump a full large API response into your context.

### Example Searches

```bash
# What happened in the last hour (relative time)
curl "http://localhost:3030/search?content_type=all&limit=10&start_time=1h%20ago&end_time=now"

# Slack messages today
curl "http://localhost:3030/search?app_name=Slack&content_type=ocr&limit=10&start_time=$(date -u +%Y-%m-%dT00:00:00Z)"

# Audio transcriptions from meetings (relative time)
curl "http://localhost:3030/search?content_type=audio&limit=5&start_time=4h%20ago"

# What a specific person said
curl "http://localhost:3030/search?content_type=audio&speaker_name=John&limit=10&start_time=24h%20ago"

# Browser activity
curl "http://localhost:3030/search?app_name=Google%20Chrome&content_type=ocr&limit=10&start_time=2h%20ago"
```

> **Tip:** The API supports relative time strings like `16h ago`, `2d ago`, `30m ago`, `1w ago`, and `now` for `start_time` and `end_time`. No need to compute ISO timestamps with shell commands.

### Response Format

```json
{
  "data": [
    {
      "type": "OCR",
      "content": {
        "frame_id": 12345,
        "text": "screen text captured...",
        "timestamp": "2024-01-15T10:30:00Z",
        "file_path": "/path/to/video.mp4",
        "offset_index": 42,
        "app_name": "Google Chrome",
        "window_name": "GitHub - screenpipe",
        "tags": [],
        "frame": null
      }
    },
    {
      "type": "Audio",
      "content": {
        "chunk_id": 678,
        "transcription": "what they said...",
        "timestamp": "2024-01-15T10:31:00Z",
        "file_path": "/path/to/audio.mp4",
        "offset_index": 5,
        "tags": [],
        "speaker": {
          "id": 1,
          "name": "John",
          "metadata": ""
        }
      }
    },
    {
      "type": "UI",
      "content": {
        "id": 999,
        "text": "Clicked button 'Submit'",
        "timestamp": "2024-01-15T10:32:00Z",
        "app_name": "Safari",
        "window_name": "Forms",
        "initial_traversal_at": null
      }
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 42
  }
}
```

## Fetching Frames (Screenshots)

You can fetch actual screenshot frames from search results. Each OCR result has a `frame_id`.

```bash
curl -o /tmp/frame.png "http://localhost:3030/frames/{frame_id}"
```

This returns the raw PNG image. Use the `read` tool to view it (pi supports images).

### When to fetch frames
- When the user asks "show me what I was looking at" or "what was on screen"
- When you need visual context to answer a question (e.g. UI layout, charts, design)
- When OCR text is ambiguous and you need to see the actual screen

### CRITICAL: Token budget for frames
- Each frame is ~1000-2000 tokens when sent to the LLM
- **NEVER fetch more than 2-3 frames per query** — it's expensive and slow
- Prefer using OCR text from search results first. Only fetch frames when text isn't enough.
- If the user asks about many moments, summarize from OCR text and only fetch 1-2 key frames.

### Example workflow
```bash
# 1. Search for relevant content
curl "http://localhost:3030/search?q=dashboard&app_name=Chrome&content_type=ocr&limit=5&start_time=2024-01-15T10:00:00Z"

# 2. Pick the most relevant frame_id from results
# 3. Fetch that specific frame
curl -o /tmp/frame_12345.png "http://localhost:3030/frames/12345"

# 4. Read/view the image
```

## Other Useful Endpoints

### Activity Summary (lightweight overview)
```bash
curl "http://localhost:3030/activity-summary?start_time=1h%20ago&end_time=now"
```
Returns app usage (with active session minutes, first/last seen times), recent texts, and audio summary in ~200-500 tokens. Great starting point before deeper searches.

### Elements Search (structured UI data)
```bash
curl "http://localhost:3030/elements?q=Submit&role=AXButton&start_time=1h%20ago&limit=10"
```
Returns individual UI elements (~100-500 bytes each) — much lighter than `/search` for targeted lookups.

### Frame Context (accessibility text + URLs)
```bash
curl "http://localhost:3030/frames/12345/context"
```
Returns parsed accessibility tree, full text, and extracted URLs for a specific frame.

### Health Check
```bash
curl http://localhost:3030/health
```

### List Audio Devices
```bash
curl http://localhost:3030/audio/list
```

### List Monitors
```bash
curl http://localhost:3030/vision/list
```

### Raw SQL (advanced)
```bash
curl -X POST http://localhost:3030/raw_sql -H "Content-Type: application/json" -d '{"query": "SELECT COUNT(*) FROM ocr_text"}'
```

### Speakers
```bash
# Search speakers
curl "http://localhost:3030/speakers/search?name=John"

# List unnamed speakers
curl http://localhost:3030/speakers/unnamed
```

## Showing Videos

When referencing video files from search results, show the `file_path` to the user in an inline code block so it renders as a playable video:

```
`/Users/name/.screenpipe/data/monitor_1_2024-01-15_10-30-00.mp4`
```

Do NOT use markdown links or multi-line code blocks for videos.

## Deep Links (Clickable References)

When referencing specific moments from search results, create clickable deep links so the user can jump to that exact moment on their timeline.

**ALWAYS prefer frame-based links** — frame IDs are exact database keys from search results and never break:

```markdown
[10:30 AM — VS Code](screenpipe://frame/12345)
```

For audio results (which have no frame_id), fall back to timestamp links:

```markdown
[meeting at 3pm](screenpipe://timeline?timestamp=2024-01-15T15:00:00Z)
```

### Rules

1. **Use `screenpipe://frame/{frame_id}`** for OCR results — copy the `frame_id` integer directly from the search result's `content.frame_id` field. Do NOT invent frame IDs.
2. **Use `screenpipe://timeline?timestamp=ISO8601`** for audio results — copy the exact `timestamp` string from the search result.
3. **NEVER fabricate IDs or timestamps** — only use values that appear in actual search results.
4. **Make the link text human-readable** — include the time and app name, e.g. `[2:15 PM — Slack](screenpipe://frame/56789)`.
5. Include deep links in your responses whenever you reference specific moments. This lets the user verify your claims by clicking through to the actual recording.

### Example

After searching and getting results with `frame_id: 12345` at `timestamp: "2024-01-15T10:30:00Z"` in Chrome:

```markdown
You were browsing GitHub at [10:30 AM — Chrome](screenpipe://frame/12345) when you reviewed PR #234.
```

## Tips

- The user's data is 100% local. You are querying their local machine.
- Timestamps in results are UTC. Convert to the user's local timezone when displaying.
- If asked "what did I work on today?", search with broad terms and short time ranges, then summarize by app/activity.
- If asked about meetings, use `content_type=audio`.
- If asked about a specific app, always use the `app_name` filter.
- Combine multiple searches to build a complete picture (e.g., screen + audio for a meeting).
- **For aggregation over large datasets**, use raw SQL instead of paginating through search results. The `/search` endpoint returns paginated results (default limit 20), so summarizing thousands of events requires raw SQL. Examples:

```bash
# Count accessibility events by app (last 24h)
curl -X POST http://localhost:3030/raw_sql -H "Content-Type: application/json" \
  -d '{"query": "SELECT app_name, COUNT(*) as count FROM accessibility WHERE timestamp > datetime(\"now\", \"-24 hours\") GROUP BY app_name ORDER BY count DESC"}'

# Count input events by type and app (last 24h)
curl -X POST http://localhost:3030/raw_sql -H "Content-Type: application/json" \
  -d '{"query": "SELECT app_name, event_type, COUNT(*) as count FROM ui_events WHERE timestamp > datetime(\"now\", \"-24 hours\") GROUP BY app_name, event_type ORDER BY count DESC"}'

# App usage summary from OCR frames (last 24h)
curl -X POST http://localhost:3030/raw_sql -H "Content-Type: application/json" \
  -d '{"query": "SELECT app_name, COUNT(*) as frames FROM frames WHERE timestamp > datetime(\"now\", \"-24 hours\") GROUP BY app_name ORDER BY frames DESC"}'
```
