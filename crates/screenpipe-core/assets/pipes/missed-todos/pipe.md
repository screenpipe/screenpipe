---
schedule: manual
enabled: true
template: true
title: Missed To-Dos
description: "Action items from the last few days you may have missed"
icon: "✅"
featured: true
---

Find action items and to-dos from the last 3 days that I may have missed. Read the screenpipe skill first. Use limit=10 per search, max 5 searches over the last 3 days. Query the API only — do not write or run code.

Look across messages, email, meetings, docs, and issue trackers (e.g. Slack, Gmail, Notion, Linear, GitHub) for commitments and tasks — phrases like "I'll", "can you", "TODO", "follow up", "by Friday", action items, and unchecked checkboxes.

Use this exact format:

## Likely Missed
- [ ] Task — where it came from (app + person/thread) and when. Only items that still look unresolved.

## Waiting on Me
- [ ] Things someone asked me to do that I haven't acted on yet.

## Quick Wins
- [ ] Small tasks (<5 min) I can clear right now.

Rank by urgency. Only include items you can actually see in the data — never invent tasks. If you find none, say so plainly. End with: "**Do first:** [the single most important item]"
