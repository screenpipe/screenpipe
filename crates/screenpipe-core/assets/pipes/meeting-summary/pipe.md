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

step 3 — if your summary is worth saving, append it to the meeting note (and refresh the title in the same call) via:

  curl -s -X PUT "http://localhost:3030/meetings/<MEETING_ID>" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"title": "<NEW_TITLE_OR_OMIT>", "note": "<EXISTING_NOTE>\n\n## Summary\n<YOUR_SUMMARY>"}'

replace `<EXISTING_NOTE>` with the meeting's current `note` field (empty string if none) so you don't overwrite the user's work; just append your summary under a `## Summary` heading. for the title: if the current title is missing, generic ("untitled", "meeting", just the app name) or doesn't capture what actually happened, replace it with a 5-8 word plain-english title (no quotes, no "meeting about…" prefix) — otherwise omit the field so a user-set title is left alone. if there's nothing useful to summarize (empty transcript, irrelevant audio), say so out loud and skip the PUT — don't write a placeholder.
