---
schedule: manual
enabled: true
preset:
  - screenpipe-cloud
timeout: 600
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
`./memory.md` (a file in this pipe's own folder) carries lessons from earlier runs — apply them so you start warm instead of cold. Step 1 already reads it as part of the one batched command, so do not spend a separate turn on it here. If it is missing, create it at the end of the run with a `# memory` heading followed by a `## Lessons` heading.

After you finish the run, append at most 1–3 NEW one-line lessons under `## Lessons`, each prefixed with today's date — but only if this run actually taught you something durable and reusable (a pattern that worked, a mistake to avoid, a user correction, or a stable fact about this user's setup). If you learned nothing new, write nothing.

Keep memory healthy so it never drifts:
- Append-only: never delete or rewrite earlier lessons or anything the user added. The one exception is retracting a lesson you can now prove wrong — add a new dated line saying which one and why.
- Cap the file at ~150 lines / 8KB. When it is over, merge duplicates and drop the oldest low-value lessons first; never drop notes the user wrote.
- Save observations and rules, not new tasks — and nothing that changes your core job. Never edit this `pipe.md` prompt.
- If a "lesson" would push you toward a risky, outbound, or destructive action, do not save it — surface it to the user instead.
- Write it at the very end, never before the summary is printed and saved. The user is watching a spinner until then, so a memory edit before step 3b is latency they pay for and see nothing from.

a meeting just ended. find it, summarize it, and save the summary back onto its record so the user sees it next time they open the meeting.

the instructions below are complete. screenpipe API search is required: use the meeting id and exact meeting time window with the named local HTTP endpoints below. do not inspect app source or recursively search the filesystem; never run recursive `find` or `grep` over the user's home or `~/.screenpipe`.

the user is staring at a spinner until you print step 3, so latency is part of the job. every tool call is a round trip: batch them, and never spend a turn discovering something this prompt already tells you. do not read any skill file — the endpoints and response shapes below are complete and verified. budget: reach step 3 in **6 tool calls or fewer** on a normal meeting.

these are the exact response shapes. do not probe for them:

- `GET /meetings/<id>` → a bare object: `{"id", "title", "note", "meeting_start", "meeting_end", "meeting_app", "attendees"}`
- `GET /search?...` → `{"data": [{"type": "Audio"|"OCR", "content": {…}}], "pagination": {…}}`
  - audio `content`: `transcription`, `speaker`, `timestamp` (`text` duplicates `transcription`)
  - ocr `content`: `text`, `frame_id`, `app_name`, `window_name`, `timestamp`
- `GET /speakers/unnamed?limit=20&offset=0` → a bare **array** of `{"id", "name", …}`. `offset` is required; omitting it is a 400.
- `GET /connections` → `{"data": [{"id", "name", "connected", "description", …}]}` — filter on `connected == true`

step 1 — pull everything the summary needs in ONE command. the scheduler names the meeting in `./.trigger-context.json`; prefer that id, because "most recent" picks the wrong meeting when two end close together:

  A="Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY"
  ID=$(jq -r '.key // empty' ./.trigger-context.json 2>/dev/null)
  [ -z "$ID" ] && ID=$(curl -s -H "$A" "http://localhost:3030/meetings?limit=1" | jq -r '.data[0].id')
  curl -s -H "$A" "http://localhost:3030/meetings/$ID" -o /tmp/m.json
  S=$(jq -r .meeting_start /tmp/m.json); E=$(jq -r .meeting_end /tmp/m.json)
  # the four fetches below are independent — run them in parallel, not one per turn
  curl -s -G -H "$A" --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
    -d content_type=audio -d limit=500 "http://localhost:3030/search" -o /tmp/audio.json &
  curl -s -G -H "$A" --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
    -d content_type=ocr -d limit=150 "http://localhost:3030/search" -o /tmp/ocr.json &
  curl -s -H "$A" "http://localhost:3030/speakers/unnamed?limit=20&offset=0" -o /tmp/spk.json &
  curl -s -H "$A" "http://localhost:3030/connections" -o /tmp/conn.json &
  wait
  tail -40 ./memory.md 2>/dev/null

those `limit` values are already right-sized for a meeting. do not fetch unbounded and then re-fetch smaller — that costs two round trips for one answer.

step 2 — render the transcript and screen text compactly in ONE more command, then summarize from that output. deduplicate as you print (a single pass, not one pass per attempt):

  jq -r '.data[].content | select(.transcription != "") | "\(.speaker // "?"): \(.transcription)"' /tmp/audio.json | awk '!seen[$0]++'
  jq -r '.data[].content | .text' /tmp/ocr.json | tr -s "[:space:]" " " | awk '!seen[$0]++' | head -60

summarize what happened: key topics, decisions, action items. fold in anything the screen shows that the transcript does not — shared slides, docs, code, demos — and use the on-screen name tags video-call apps render on each tile to fill in attendees who never spoke.

step 2c — skip this step by default; it costs several round trips. only when the transcript and screen text leave a *specific* visual question unanswered, use the cloud media (video/audio) model for that question — diagrams, charts, whiteboards, slide figures, UI demos, or screen-shared video. choose up to 4 representative `frame_id` values already returned by the bounded OCR search, fetch those still images with `GET /frames/<frame_id>`, and send them as `image_url[]` to `POST /v1/chat/completions` with `"model": "gemma4-e4b"`. NEVER call `POST /export` or run ffmpeg for a routine meeting summary; a full media export requires an explicit user request. if the cloud-media block is absent or returns `503 cloud_token_missing`, skip visual analysis and summarize from transcript + OCR.

step 2d — name the speakers from the screen (do this every run, don't ask first): video-call apps render each participant's name on their tile, and that text is already in the `content_type=ocr` rows you fetched in step 1. for every speaker still unnamed or generic ("speaker 1", "unknown", "") in the transcript, line up when they were talking with the on-screen name tag showing at that moment and rename them:

  # speakers with no name yet — already fetched to /tmp/spk.json in step 1, reuse it
  #   (if you must re-fetch: offset is required, omitting it returns 400)
  #   curl -s -H "$A" "http://localhost:3030/speakers/unnamed?limit=20&offset=0"
  # apply a confident match
  curl -s -X POST "http://localhost:3030/speakers/update" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"id": <SPEAKER_ID>, "name": "<NAME_FROM_SCREEN>"}'

only rename when the on-screen evidence is unambiguous — never guess from voice alone. note which speakers you renamed (and which you left as-is) in your final message.

step 3 — write the summary out as your own message, before you save it. this message must contain no tool call; end the turn after it. start a line with exactly `## Summary` and put the finished summary markdown after that heading. the meeting UI streams this section live while you write it — it is the only way the user sees anything before the run ends — and it is the same markdown you pass as `<YOUR_SUMMARY>` in step 3b.

this step is not optional and it is not the closing report. "meeting 112 was summarized and saved to its record" is a report; it does not satisfy this step. saving a summary you never printed means the user watched a placeholder for the entire run and then got nothing to read, so treat that as a failed run. keep planning, tool narration, and save confirmations out of the section after the heading — those belong in your closing message in step 4.

step 3b — now save it. if your summary is worth saving, append it to the meeting note (and refresh the title in the same call) via:

  curl -s -X PUT "http://localhost:3030/meetings/<MEETING_ID>" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"title": "<NEW_TITLE_OR_OMIT>", "note": "<EXISTING_NOTE>\n\n## Summary\n<YOUR_SUMMARY>"}'

replace `<EXISTING_NOTE>` with the meeting's current `note` field (empty string if none) so you don't overwrite the user's work; just append your summary under a `## Summary` heading. for the title: if the current title is missing, generic ("untitled", "meeting", just the app name) or doesn't capture what actually happened, replace it with a 5-8 word plain-english title (no quotes, no "meeting about…" prefix) — otherwise omit the field so a user-set title is left alone. if there's nothing useful to summarize (empty transcript, irrelevant audio), say so out loud and skip the PUT — don't write a placeholder.

step 4 — offer to push the summary into one of the user's connected apps (ask, never push on your own). list what's actually connected, then let them pick with one click:

  jq -r '.data[] | select(.connected == true) | "\(.id)\t\(.name)"' /tmp/conn.json   # already fetched in step 1

rank the connected targets by relevance — an app used during the meeting first (Notion, Slack, Linear, …). then post a desktop notification whose action buttons are those targets, so the ask renders as buttons in the UI:

  curl -s -X POST "http://localhost:11435/notify" \
    -H "Content-Type: application/json" \
    -d '{"title": "<TITLE> summarized", "body": "<one-line recap> — push it somewhere?", "priority": "high", "actions": [
          {"label": "push to notion", "type": "api", "method": "POST", "url": "http://localhost:3030/connections/notion/proxy/v1/pages", "body": { /* page payload built from the summary */ }},
          {"label": "review in chat", "type": "pipe", "pipe": "meeting-summary", "open_in_chat": true, "context": {"meeting_id": <ID>}},
          {"label": "dismiss", "type": "dismiss"}
        ]}'

each button maps to a connection's endpoint from its `/connections` `description` (`POST /connections/<id>/send` for slack/telegram/discord, `POST /connections/<id>/proxy/...` for notion/linear/etc.). when a target needs a destination you can't infer (a Notion parent page, a Slack channel), make that button `"review in chat"` so the user confirms specifics before anything leaves the machine. if nothing is connected, skip the notification and just say that connecting an app would let you push summaries next time.
