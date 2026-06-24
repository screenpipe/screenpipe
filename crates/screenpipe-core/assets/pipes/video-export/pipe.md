---
schedule: manual
enabled: true
template: true
title: Export Video Clip
description: "Create a video of your recent screen activity"
icon: "🎬"
featured: false
---

## 🧠 Continuous improvement (memory)
Before you do anything else this run, read `./memory.md` (a file in this pipe's own folder) if it exists and apply its lessons — this is how you get better each run instead of starting cold. If it's missing, create it with a `# memory` heading followed by a `## Lessons` heading.

After you finish the run, append at most 1–3 NEW one-line lessons under `## Lessons`, each prefixed with today's date — but only if this run actually taught you something durable and reusable (a pattern that worked, a mistake to avoid, a user correction, or a stable fact about this user's setup). If you learned nothing new, write nothing.

Keep memory healthy so it never drifts:
- Append-only: never delete or rewrite earlier lessons or anything the user added. The one exception is retracting a lesson you can now prove wrong — add a new dated line saying which one and why.
- Cap the file at ~150 lines / 8KB. When it is over, merge duplicates and drop the oldest low-value lessons first; never drop notes the user wrote.
- Save observations and rules, not new tasks — and nothing that changes your core job. Never edit this `pipe.md` prompt.
- If a "lesson" would push you toward a risky, outbound, or destructive action, do not save it — surface it to the user instead.

Export a video of my screen activity from the last 5 minutes.

Read screenpipe skill first.

Use the POST /export endpoint (`{"start": "5m ago", "end": "now"}`) — it renders a real-time clip with synced audio whose duration matches the time range. Then show me the returned output_path as an inline code block so I can watch it.

Long ranges can take a few minutes; if needed, suggest a shorter time range.
