---
name: screenpipe-follow-up-reminders
description: Detect sales commitments and follow-up tasks. "Any follow-ups from today?" "What did I promise to send?" "CRM reminders from my calls"
tools: Bash
---

# Screenpipe Follow-up Reminders

Detect commitment language in screen and audio activity, extract actionable follow-up tasks for sales teams.

## Database Location## Query Patterns
```bash
# Scan OCR text for commitment markers in the last 30 minutes
sqlite3 -header -column ~/.screenpipe/db.sqlite "
  SELECT
    strftime('%H:%M', f.timestamp) as time,
    o.app_name,
    o.window_name,
    substr(o.text, 1, 300) as content
  FROM ocr_text o
  JOIN frames f ON o.frame_id = f.id
  WHERE f.timestamp >= datetime('now', '-30 minutes')
    AND (
      o.text LIKE '%follow up%'
      OR o.text LIKE '%follow-up%'
      OR o.text LIKE '%I will%'
      OR o.text LIKE '%I''ll send%'
      OR o.text LIKE '%I''ll call%'
      OR o.text LIKE '%I''ll check%'
      OR o.text LIKE '%get back to you%'
      OR o.text LIKE '%by EOD%'
      OR o.text LIKE '%by end of day%'
      OR o.text LIKE '%by Thursday%'
      OR o.text LIKE '%by Friday%'
      OR o.text LIKE '%send the proposal%'
      OR o.text LIKE '%send the invoice%'
      OR o.text LIKE '%schedule a call%'
      OR o.text LIKE '%let''s catch up%'
      OR o.text LIKE '%circle back%'
    )
  ORDER BY f.timestamp DESC
  LIMIT 20;
"

# Scan audio transcriptions for verbal commitments
sqlite3 -header -column ~/.screenpipe/db.sqlite "
  SELECT
    strftime('%H:%M', start_time) as time,
    substr(transcription, 1, 300) as spoken_content,
    speaker
  FROM audio_transcriptions
  WHERE start_time >= datetime('now', '-30 minutes')
    AND (
      transcription LIKE '%I will%'
      OR transcription LIKE '%I''ll%'
      OR transcription LIKE '%follow up%'
      OR transcription LIKE '%send you%'
      OR transcription LIKE '%get back%'
      OR transcription LIKE '%by tomorrow%'
      OR transcription LIKE '%next week%'
      OR transcription LIKE '%schedule%'
      OR transcription LIKE '%proposal%'
      OR transcription LIKE '%invoice%'
    )
  ORDER BY start_time DESC
  LIMIT 20;
"

# Sales app activity in the last hour (WhatsApp, HubSpot, Gmail, LinkedIn)
sqlite3 -header -column ~/.screenpipe/db.sqlite "
  SELECT
    strftime('%H:%M', f.timestamp) as time,
    o.app_name,
    o.window_name,
    substr(o.text, 1, 300) as content
  FROM ocr_text o
  JOIN frames f ON o.frame_id = f.id
  WHERE f.timestamp >= datetime('now', '-60 minutes')
    AND (
      o.app_name LIKE '%WhatsApp%'
      OR o.app_name LIKE '%Chrome%'
      OR o.app_name LIKE '%Safari%'
      OR o.app_name LIKE '%Mail%'
      OR o.window_name LIKE '%HubSpot%'
      OR o.window_name LIKE '%Pipedrive%'
      OR o.window_name LIKE '%LinkedIn%'
      OR o.window_name LIKE '%Gmail%'
    )
  ORDER BY f.timestamp DESC
  LIMIT 30;
"
```

## Your Task

When the user asks about follow-ups, reminders, or CRM tasks:

1. Run the commitment marker query on OCR text
2. Run the audio transcription query for verbal commitments
3. Run the sales app activity query for context
4. For each commitment found, extract:
   - **Person**: Who the commitment was made to
   - **Action Item**: What was promised
   - **Due Date**: When (if mentioned, otherwise flag as "unspecified")
   - **Source**: Which app/channel it came from
5. Summarize into actionable follow-up tasks

## Output Format
```markdown
## Follow-up Reminders — [Date] [Time]

### Action Items Detected

| # | Person | Action Item | Due Date | Source |
|---|--------|-------------|----------|--------|
| 1 | Sarah (HubSpot) | Send Q2 proposal | EOD today | WhatsApp |
| 2 | James | Schedule onboarding call | Thursday | Gmail |
| 3 | Unknown | Check invoice status | Unspecified | Audio |

### Commitment Snippets
- [09:42] WhatsApp: "I'll send the proposal over by end of day"
- [10:15] Audio: "Let's catch up on Thursday to go through the numbers"

### No Reminders Found
(shown only if no commitments detected in the lookback window)

### Suggested Next Steps
- Add items to CRM (HubSpot / Pipedrive)
- Set calendar reminders for time-bound commitments
```

## Notes for Sales Teams

- Default lookback window is 30 minutes; ask the user if they want to extend (e.g. "last 2 hours", "today")
- If no commitments found in 30 minutes, automatically extend to 2 hours before reporting clean
- Verbal commitments (audio) are weighted equally to written ones (OCR)
- Flag any commitment without a due date as high priority for immediate CRM entry
