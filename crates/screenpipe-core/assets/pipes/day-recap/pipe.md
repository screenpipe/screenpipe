---
schedule: manual
enabled: true
template: true
title: Day Recap
description: "Today's accomplishments, key moments, and unfinished work"
icon: "📋"
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

Analyze my screen and audio recordings from today (last 16 hours). Read the screenpipe skill first. Use limit=10 per search, max 5 searches total. Prefer /raw_sql with COUNT/GROUP BY for app usage. Use the API only — do not write or run code.

Use this exact format:

## Summary
One sentence: what I mainly did today.

## Accomplishments
- Top 3 things I finished, with timestamps (e.g. "2:30 PM"). Name specific apps, files, or projects.

## Key Moments
- Important things I saw, said, or heard — with timestamps.

## Unfinished Work
- What to continue tomorrow — name the app, file, or task.

## Patterns
- Apps I used most and topics that recurred.

Only report what you can verify from the data. End with: "**Next step:** [most important thing to continue]"
