---
name: screenpipe-search
description: Search the user's screen recordings, audio transcriptions, and UI interactions via the local Screenpipe API at localhost:3030. Use when the user asks about their screen activity, meetings, apps they used, what they saw/heard, or anything about their computer usage history.
---

# Screenpipe Search

Search the user's locally-recorded screen and audio data. Screenpipe continuously captures screen text (OCR), audio transcriptions, and UI events (clicks, keystrokes, app switches).

The API runs at `http://localhost:3030`.

## Search API

```bash
curl "http://localhost:3030/search?q=QUERY&content_type=all&limit=10&start_time=ISO8601&end_time=ISO8601"
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `q` | string | No | Search keywords. Be specific. |
| `content_type` | string | No | `all` (default), `ocr`, `audio`, `input`, `accessibility` |
| `limit` | integer | No | Max results 1-20. Default: 10 |
| `offset` | integer | No | Pagination offset. Default: 0 |
| `start_time` | ISO 8601 | **Yes** | Start of time range. ALWAYS include this. |
| `end_time` | ISO 8601 | No | End of time range. Defaults to now. |
| `app_name` | string | No | Filter by app (e.g. "Google Chrome", "Slack", "zoom.us", "Code") |
| `window_name` | string | No | Filter by window title substring |
| `speaker_name` | string | No | Filter audio by speaker name (case-insensitive partial match) |
| `focused` | boolean | No | Only return results from focused windows |

### Content Types

- `ocr` — Screen text captured via OCR
- `audio` — Audio transcriptions (meetings, voice)
- `input` — UI events: clicks, keystrokes, clipboard, app switches
- `accessibility` — Accessibility tree text
- `all` — OCR + Audio + Accessibility (default)

### CRITICAL RULES

1. **ALWAYS include `start_time`** — the database has hundreds of thousands of entries. Queries without time bounds WILL timeout.
2. **Start with short time ranges** — default to last 1-2 hours. Only expand if no results found.
3. **Use `app_name` filter** whenever the user mentions a specific app.
4. **Keep `limit` low** (5-10) initially. Only increase if the user needs more.
5. **"recent"** = last 30 minutes. **"today"** = since midnight. **"yesterday"** = yesterday's date range.
6. If a search times out, retry with a narrower time range (e.g. 30 mins instead of 2 hours).

### Example Searches

```bash
# What happened in the last hour
curl "http://localhost:3030/search?content_type=all&limit=10&start_time=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)"

# Slack messages today
curl "http://localhost:3030/search?app_name=Slack&content_type=ocr&limit=10&start_time=$(date -u +%Y-%m-%dT00:00:00Z)"

# Audio transcriptions from meetings
curl "http://localhost:3030/search?content_type=audio&limit=5&start_time=$(date -u -v-4H +%Y-%m-%dT%H:%M:%SZ)"

# What a specific person said
curl "http://localhost:3030/search?content_type=audio&speaker_name=John&limit=10&start_time=$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ)"

# Browser activity
curl "http://localhost:3030/search?app_name=Google%20Chrome&content_type=ocr&limit=10&start_time=$(date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)"
```

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
# Get a specific frame as an image
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
