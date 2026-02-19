---
schedule: every 30m
enabled: false
---

Scan recent screen activity and create Apple Reminders for actionable items.

## Task

1. Query screenpipe for recent activity using the time range in the context header
2. Look for actionable items: todos in chat, deadlines in emails, follow-ups from meetings, tasks from project tools
3. For each actionable item, create an Apple Reminder

## Search API

```
GET http://localhost:3030/search?content_type=all&start_time=<ISO8601>&end_time=<ISO8601>&limit=100
```

Full API reference (60+ endpoints): https://docs.screenpi.pe/llms-full.txt

## Creating Reminders (macOS)

```bash
osascript -e 'tell application "Reminders"
    tell list "Screenpipe"
        make new reminder with properties {name:"TITLE", body:"DETAILS", due date:date "DATE"}
    end tell
end tell'
```

If the "Screenpipe" list doesn't exist, create it first:
```bash
osascript -e 'tell application "Reminders" to make new list with properties {name:"Screenpipe"}'
```

## Rules

- Only create reminders for genuinely actionable items
- Don't duplicate — check if a similar reminder already exists
- Include context: where you found the item (app, window, conversation)
- Set due dates when mentioned; otherwise leave without due date
- Keep reminder titles short and actionable (start with a verb)
