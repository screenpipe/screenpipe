---
name: screenpipe-search
description: Full-text search your screen history. "Find when I saw error 404" "Search for meeting notes"
tools: Bash
---

# Screenpipe Search

Full-text search across all screen recordings using SQLite FTS5.

## Database Location

```
~/.screenpipe/db.sqlite
```

## Query Patterns

```bash
# Full-text search (FTS5)
sqlite3 ~/.screenpipe/db.sqlite "
  SELECT f.timestamp, o.app_name, o.window_name, snippet(ocr_text_fts, 1, '>>>', '<<<', '...', 30) as match
  FROM ocr_text_fts
  JOIN ocr_text o ON o.rowid = ocr_text_fts.rowid
  JOIN frames f ON o.frame_id = f.id
  WHERE ocr_text_fts MATCH 'error'
  ORDER BY f.timestamp DESC
  LIMIT 20;
"

# Search with multiple terms
sqlite3 ~/.screenpipe/db.sqlite "
  SELECT f.timestamp, o.app_name, substr(o.text, 1, 300)
  FROM ocr_text o
  JOIN frames f ON o.frame_id = f.id
  WHERE o.text LIKE '%API%' AND o.text LIKE '%key%'
  ORDER BY f.timestamp DESC
  LIMIT 20;
"

# Search in specific app
sqlite3 ~/.screenpipe/db.sqlite "
  SELECT f.timestamp, o.window_name, substr(o.text, 1, 200)
  FROM ocr_text o
  JOIN frames f ON o.frame_id = f.id
  WHERE o.app_name = 'Slack' AND o.text LIKE '%deadline%'
  ORDER BY f.timestamp DESC
  LIMIT 20;
"

# Count occurrences by day
sqlite3 ~/.screenpipe/db.sqlite "
  SELECT date(f.timestamp) as day, COUNT(*) as mentions
  FROM ocr_text o
  JOIN frames f ON o.frame_id = f.id
  WHERE o.text LIKE '%screenpipe%'
  GROUP BY day
  ORDER BY day DESC
  LIMIT 10;
"
```

## Your Task

When the user wants to search their screen history:

1. Extract search terms from their query
2. Use FTS5 for fast full-text search, or LIKE for simple patterns
3. Return relevant matches with timestamps and context
4. Summarize findings (when, where, how often)

## Examples

User: "Find when I saw that error message about authentication"
→ Search for "authentication" + "error", return timestamps and apps

User: "Search for anything about the Q4 budget"
→ Search for "Q4" + "budget", show matches with context

User: "How many times did I look at Twitter today?"
→ Count frames where app_name contains Twitter for today
