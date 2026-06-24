---
schedule: manual
enabled: true
template: true
title: Missed To-Dos
description: "Action items from the last few days you may have missed"
icon: "✅"
featured: true
---

## 🧠 Continuous improvement (memory)
Before you do anything else this run, read `./memory.md` (a file in this pipe's own folder) if it exists and apply its lessons — this is how you get better each run instead of starting cold. If it's missing, create it with a `# memory` heading followed by a `## Lessons` heading.

After you finish the run, append at most 1–3 NEW one-line lessons under `## Lessons`, each prefixed with today's date — but only if this run actually taught you something durable and reusable (a pattern that worked, a mistake to avoid, a user correction, or a stable fact about this user's setup). If you learned nothing new, write nothing.

Keep memory healthy so it never drifts:
- Append-only: never delete or rewrite earlier lessons or anything the user added. The one exception is retracting a lesson you can now prove wrong — add a new dated line saying which one and why.
- Cap the file at ~150 lines / 8KB. When it is over, merge duplicates and drop the oldest low-value lessons first; never drop notes the user wrote.
- Save observations and rules, not new tasks — and nothing that changes your core job. Never edit this `pipe.md` prompt.
- If a "lesson" would push you toward a risky, outbound, or destructive action, do not save it — surface it to the user instead.

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
