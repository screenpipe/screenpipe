---
schedule: manual
enabled: true
preset:
  - screenpipe-cloud
trigger:
  events:
    - meeting_ended
template: true
title: Meeting Summary
description: Auto-summarizes the meeting that just ended and saves the summary back onto the meeting record (title + note).
icon: "🤝"
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

a meeting just ended. find it, summarize it, and save the summary back onto its record so the user sees it next time they open the meeting.

keep the wording of this prompt in sync with `buildMeetingSummarizeInstructions` in `apps/screenpipe-app-tauri/lib/utils/meeting-context.ts` (used by the in-app "summarize with AI" button) — the two surfaces should produce the same behavior.

read the screenpipe skill first so you know the meetings + search endpoints.

step 1 — find the meeting that just ended:

  curl -s -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    "http://localhost:3030/meetings?limit=1"

the most recent row is the one that just ended. capture its `id`, `meeting_start`, `meeting_end`, `title`, `note`, `meeting_app`, and `attendees`.

step 2 — search screenpipe for what happened during this meeting and summarize it: key topics, decisions, action items. scope your searches to the meeting's `meeting_start`/`meeting_end` window. prefer `content_type=audio` for transcripts.

step 2b — also query the screen for what was *shown*: `content_type=ocr` over the same window (this returns the frame's on-screen text — accessibility tree + OCR merged, not just OCR) — shared slides, docs, code, demos, and the on-screen name tags video-call apps render for participants. fold anything useful into the summary, and use on-screen names to fill in attendees who never spoke.

step 2c — *if available*, use the cloud media (video/audio) model for what text alone can't capture: the screenpipe-api skill includes a "Cloud media analysis" block (the `gemma4-e4b` multimodal model) only when cloud media analysis is enabled and the user is signed into screenpipe cloud. when it's there, use it for visual-only content the transcript and OCR miss — diagrams, charts, whiteboards, slide figures, UI demos, screen-shared video. export the meeting (`POST /export` with this `meeting_id`) or ffmpeg-sample a few keyframes, then send up to 4 frames per request as `image_url[]` to `POST /v1/chat/completions` with `"model": "gemma4-e4b"` and ask what they show; it can also take `audio_url` directly for hard-to-transcribe spans. this step is optional — if the block isn't in the skill, or the call returns `503 cloud_token_missing` (signed out), just skip it and summarize from transcript + OCR.

step 2d — name the speakers from the screen (do this every run, don't ask first): video-call apps render each participant's name on their tile, and that text is already in the `content_type=ocr` frames from step 2b. for every speaker still unnamed or generic ("speaker 1", "unknown", "") in the transcript, line up when they were talking with the on-screen name tag showing at that moment and rename them:

  # speakers with no name yet
  curl -s -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    "http://localhost:3030/speakers/unnamed?limit=20"
  # apply a confident match
  curl -s -X POST "http://localhost:3030/speakers/update" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"id": <SPEAKER_ID>, "name": "<NAME_FROM_SCREEN>"}'

only rename when the on-screen evidence is unambiguous — never guess from voice alone. note which speakers you renamed (and which you left as-is) in your final message.

step 3 — if your summary is worth saving, append it to the meeting note (and refresh the title in the same call) via:

  curl -s -X PUT "http://localhost:3030/meetings/<MEETING_ID>" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"title": "<NEW_TITLE_OR_OMIT>", "note": "<EXISTING_NOTE>\n\n## Summary\n<YOUR_SUMMARY>"}'

replace `<EXISTING_NOTE>` with the meeting's current `note` field (empty string if none) so you don't overwrite the user's work; just append your summary under a `## Summary` heading. for the title: if the current title is missing, generic ("untitled", "meeting", just the app name) or doesn't capture what actually happened, replace it with a 5-8 word plain-english title (no quotes, no "meeting about…" prefix) — otherwise omit the field so a user-set title is left alone. if there's nothing useful to summarize (empty transcript, irrelevant audio), say so out loud and skip the PUT — don't write a placeholder.

step 4 — offer to push the summary into one of the user's connected apps (ask, never push on your own). list what's actually connected, then let them pick with one click:

  curl -s -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" "http://localhost:3030/connections"   # keep only "connected": true

rank the connected targets by relevance — an app used during the meeting first (Notion, Slack, Linear, …). then post a desktop notification whose action buttons are those targets, so the ask renders as buttons in the UI:

  curl -s -X POST "http://localhost:11435/notify" \
    -H "Content-Type: application/json" \
    -d '{"title": "<TITLE> summarized", "body": "<one-line recap> — push it somewhere?", "actions": [
          {"label": "push to notion", "type": "api", "method": "POST", "url": "http://localhost:3030/connections/notion/proxy/v1/pages", "body": { /* page payload built from the summary */ }},
          {"label": "review in chat", "type": "pipe", "pipe": "meeting-summary", "open_in_chat": true, "context": {"meeting_id": <ID>}},
          {"label": "dismiss", "type": "dismiss"}
        ]}'

each button maps to a connection's endpoint from its `/connections` `description` (`POST /connections/<id>/send` for slack/gmail/telegram/discord, `POST /connections/<id>/proxy/...` for notion/linear/etc.). when a target needs a destination you can't infer (a Notion parent page, a Slack channel), make that button `"review in chat"` so the user confirms specifics before anything leaves the machine. if nothing is connected, skip the notification and just say that connecting an app would let you push summaries next time.
