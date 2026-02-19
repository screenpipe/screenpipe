---
schedule: every 1h
enabled: false
---

Sync screenpipe activity to an Obsidian vault as a daily markdown log.

## Task

1. Read the existing daily note file first (if it exists) — merge into it
2. Query the screenpipe search API for the time range in 30-minute chunks
3. Use `min_length=50` to skip noisy/short OCR fragments
4. Synthesize activities, extract action items, write the note

## Search API

```
GET http://localhost:3030/search?content_type=ocr&start_time=<ISO8601>&end_time=<ISO8601>&limit=200&min_length=50
```

Content types: `ocr` (screen text), `audio` (speech), `input` (clicks/keystrokes/clipboard/app switches), `accessibility` (UI tree), `all`.

Extra params: `q` (keyword), `app_name`, `speaker_name`, `offset` (pagination).

Full API reference (60+ endpoints): https://docs.screenpi.pe/llms-full.txt

Query each modality separately per chunk for richer results:
1. `content_type=ocr&min_length=50` — what was on screen
2. `content_type=audio` — what was said
3. `content_type=input` — what was typed, clicked, copied
4. `content_type=accessibility` — UI elements (buttons, labels, menus)

## Output Format

```markdown
# Activity Log - <date>

## Timeline

| Time | Activity | Apps | Tags |
|------|----------|------|------|
| 10:00-10:30 | Reviewed PR #123 for auth module | GitHub, VSCode | #coding #review |
| 10:30-11:00 | Call with team about roadmap | Zoom, Notion | #meeting #planning |

## Action Items

- [ ] Follow up with [[Alice]] on API design — from 10:30 meeting
- [ ] Review deployment checklist before Friday

## Key Moments

- [10:32 AM](screenpipe://timeline?timestamp=2025-02-01T10:32:00Z) — [[Bob]] mentioned Q2 deadline
- [11:15 AM](screenpipe://timeline?timestamp=2025-02-01T11:15:00Z) — decided to use PostgreSQL

## Summary

Brief 2-3 sentence summary of the day so far.
```

## Deep Links

- Timeline: `[10:30 AM](screenpipe://timeline?timestamp=2025-02-01T10:30:00Z)`
- Frame: `[screenshot](screenpipe://frame/<frame_id>)` using frame_id from results

## Rules

- Link people with [[Name]] and concepts with [[concept]] (Obsidian wiki-links)
- Extract TODOs: tasks, follow-ups, URLs to visit, deadlines mentioned
- Keep summaries concise, group related activities
- Add semantic tags (#coding, #meeting, etc.)
- Skip idle periods or duplicates
- Use the user's local timezone for all displayed times
- Query in chunks to avoid context overflow

## Accumulation (for hourly syncs)

- Read existing note first — merge, don't overwrite
- Deduplicate time ranges already in the timeline
- Keep existing TODOs, add new ones
- Rewrite Summary to cover the full day so far

## Privacy

- Never dump raw OCR — synthesize into activity descriptions
- Redact passwords, API keys, tokens, credentials
- Skip banking/financial/medical content — note as "private activity"
- Summarize conversations, don't paste full transcripts
