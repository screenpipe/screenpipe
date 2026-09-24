---
schedule: manual
enabled: true
preset:
  - screenpipe-cloud
  - "*"
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

the user is staring at a spinner until you print step 3, so latency is part of the job. every tool call is a round trip: batch them, and never spend a turn discovering something this prompt already tells you. do not read any skill file — the endpoints and response shapes below are complete and verified. screenpipe bundles `bun`; use it for JSON and never require `jq`, which is absent on stock macOS and the bundled Windows bash. budget: reach step 3 in **6 tool calls or fewer** on a normal meeting.

these are the exact response shapes. do not probe for them:

- `GET /meetings/<id>` → a bare object: `{"id", "title", "note", "meeting_start", "meeting_end", "meeting_app", "attendees"}`
- `GET /search?...` → `{"data": [{"type": "Audio"|"UI"|"Parsed"|"OCR", "content": {…}}], "pagination": {…}}`
  - audio `content`: `chunk_id`, `transcription`, `device_type` (`Input` or `Output`), `speaker`, `speaker_label`, `speaker_provisional`, `timestamp` (`text` duplicates `transcription`)
  - accessibility queries return `type: "UI"` with `text`, `app_name`, `window_name`, and `timestamp`
  - parsed `content`: corrected `text`, typed `items`, separate `actors`, `frame_id`, and `timestamp`
  - ocr has `text`, `frame_id`, `app_name`, `window_name`, and `timestamp`; it is fallback-only when both accessibility and parsed data have no useful rows
- `GET /speakers/unnamed?limit=20&offset=0` → a bare **array** of `{"id", "name", …}`. `offset` is required; omitting it is a 400.
- `GET /connections` → `{"data": [{"id", "name", "connected", "description", …}]}` — filter on `connected == true`

step 1 — pull everything the summary needs in ONE command. the scheduler names the meeting in `./.trigger-context.json`; prefer that id, because "most recent" picks the wrong meeting when two end close together:

  A="Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY"
  ID=$(bun -e 'try{const d=await Bun.file("./.trigger-context.json").json();process.stdout.write(String(d.key??""))}catch{}')
  if [ -z "$ID" ]; then
    curl -s -H "$A" "http://localhost:3030/meetings?limit=1" -o /tmp/meetings.json
    ID=$(bun -e 'const d=await Bun.file("/tmp/meetings.json").json();process.stdout.write(String(d.data?.[0]?.id??""))')
  fi
  curl -s -H "$A" "http://localhost:3030/meetings/$ID" -o /tmp/m.json
  S=$(bun -e 'const d=await Bun.file("/tmp/m.json").json();process.stdout.write(String(d.meeting_start??""))')
  E=$(bun -e 'const d=await Bun.file("/tmp/m.json").json();process.stdout.write(String(d.meeting_end??""))')
  # screen evidence priority: accessibility and parsed first; OCR only if neither has useful rows
  # Use the same meeting-scoped transcript the user sees; a general audio search can miss live segments.
  # Retry transient HTTP failures at most twice. Never widen to another meeting or client.
  (curl -sf --retry 2 --retry-delay 1 --max-time 20 -H "$A" \
    "http://localhost:3030/meetings/$ID/transcript" -o /tmp/meeting-transcript.json || printf 'null' > /tmp/meeting-transcript.json
  if ! bun -e 'const rows=await Bun.file("/tmp/meeting-transcript.json").json();if(!Array.isArray(rows)||!rows.some(r=>String(r.transcript??"").trim()))process.exit(1);await Bun.write("/tmp/audio.json",JSON.stringify({data:rows.map(r=>({type:"Audio",content:{transcription:r.transcript,timestamp:r.capturedAt,device_type:r.deviceType,speaker:{id:r.speakerId,name:r.speakerName},speaker_label:r.speakerName,chunk_id:r.audioChunkId}}))}))'; then
    curl -sf --retry 2 --retry-delay 1 --max-time 20 -G -H "$A" \
      --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
      -d content_type=audio -d limit=500 "http://localhost:3030/search" -o /tmp/audio.json || printf '{"data":[],"fetch_failed":true}' > /tmp/audio.json
  fi) &
  (curl -sf -G -H "$A" --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
    -d content_type=accessibility -d on_screen=true -d limit=150 -d offset=0 \
    "http://localhost:3030/search" -o /tmp/a11.json || printf '{"data":[]}' > /tmp/a11.json) &
  (curl -sf -G -H "$A" --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
    -d content_type=parsed -d limit=150 -d offset=0 \
    "http://localhost:3030/search" -o /tmp/parsed.json || printf '{"data":[]}' > /tmp/parsed.json) &
  curl -s -H "$A" "http://localhost:3030/speakers/unnamed?limit=20&offset=0" -o /tmp/spk.json &
  curl -s -H "$A" "http://localhost:3030/connections" -o /tmp/conn.json &
  wait
  A11_ROWS=$(bun -e 'try{const d=await Bun.file("/tmp/a11.json").json();console.log((d.data??[]).filter(r=>String(r?.content?.text??"").length>0).length)}catch{console.log(0)}')
  PARSED_ROWS=$(bun -e 'try{const d=await Bun.file("/tmp/parsed.json").json();console.log((d.data??[]).filter(r=>String(r?.content?.text??"").length>0||(r?.content?.items?.length??0)>0||(r?.content?.actors?.length??0)>0).length)}catch{console.log(0)}')
  if [ "$A11_ROWS" -eq 0 ] && [ "$PARSED_ROWS" -eq 0 ]; then
    curl -sf -G -H "$A" --data-urlencode "start_time=$S" --data-urlencode "end_time=$E" \
      -d content_type=ocr -d limit=150 -d offset=0 \
      "http://localhost:3030/search" -o /tmp/ocr.json || printf '{"data":[]}' > /tmp/ocr.json
  else
    printf '{"data":[]}' > /tmp/ocr.json
  fi
  tail -40 ./memory.md 2>/dev/null

those `limit` values are already right-sized for a meeting. do not fetch unbounded and then re-fetch smaller — that costs two round trips for one answer.

step 2 — render the transcript and screen text compactly in ONE more command, then summarize from that output. deduplicate as you print (a single pass, not one pass per attempt):

  bun -e 'const d=await Bun.file("/tmp/audio.json").json(),seen=new Set;for(const r of d.data??[]){const c=r?.content??{},text=String(c.transcription??"");if(!text)continue;const line=`[${c.device_type??"?"} | id=${c.speaker?.id??"?"} | label=${c.speaker_label??c.speaker?.name??"unknown"} | provisional=${c.speaker_provisional??"?"} | chunk=${c.chunk_id??"?"}] ${text}`;if(!seen.has(line)){seen.add(line);console.log(line)}}'
  bun -e 'const d=await Bun.file("/tmp/a11.json").json(),seen=new Set;let n=0;for(const r of d.data??[]){const c=r?.content??{},text=String(c.text??"");if(!text)continue;const line=`${c.timestamp??""} [${c.app_name??""} — ${c.window_name??""}] ${text}`.replace(/\s+/g," ").trim();if(!seen.has(line)){seen.add(line);console.log(line);if(++n===60)break}}'
  bun -e 'const d=await Bun.file("/tmp/parsed.json").json(),seen=new Set;let n=0;for(const r of d.data??[]){const c=r?.content??{};if(!String(c.text??"").length&&!(c.items?.length??0)&&!(c.actors?.length??0))continue;const line=JSON.stringify({timestamp:c.timestamp,app_name:c.app_name,window_name:c.window_name,text:c.text,actors:c.actors,items:c.items});if(!seen.has(line)){seen.add(line);console.log(line);if(++n===60)break}}'
  bun -e 'const d=await Bun.file("/tmp/ocr.json").json(),seen=new Set;let n=0;for(const r of d.data??[]){const c=r?.content??{},text=String(c.text??"");if(!text)continue;const line=`${c.timestamp??""} [OCR fallback] ${text}`.replace(/\s+/g," ").trim();if(!seen.has(line)){seen.add(line);console.log(line);if(++n===60)break}}'

summarize what happened: key topics, decisions, action items. The meeting-scoped transcript is the primary evidence. Unrelated screen text or a calendar invitation must not invalidate readable speech. Collapse repeated/echoed utterances without discarding the underlying discussion. Never mix neighboring meetings or clients. If every audio fetch failed, report a retrieval failure instead of claiming there was no transcript. If the retrieved transcript really has no useful speech, stop without saving; never put a refusal or failure message under `## Summary` just to make the result nonempty. use accessibility and parsed data first for anything the transcript misses — shared slides, docs, code, demos, and participant labels. `/tmp/ocr.json` contains rows only when both preferred sources were unavailable or empty; use those rows as the fallback, never as an extra source when accessibility or parsed data worked.

step 2c — skip this step by default; it costs several round trips. only when the transcript and preferred screen data leave a *specific* visual question unanswered, use the cloud media (video/audio) model for that question — diagrams, charts, whiteboards, slide figures, UI demos, or screen-shared video. choose up to 4 representative `frame_id` values already returned by parsed data, or by the OCR fallback when both preferred sources were unavailable, fetch those still images with `GET /frames/<frame_id>`, and send them as `image_url[]` to `POST /v1/chat/completions` with `"model": "gemma4-e4b"`. NEVER call `POST /export` or run ffmpeg for a routine meeting summary; a full media export requires an explicit user request. if there is no returned `frame_id`, or the cloud-media block is absent or returns `503 cloud_token_missing`, skip visual analysis and summarize from the transcript plus the screen data already fetched.

step 2d — give every distinct speaker a useful label (do this every run, don't ask first). build one meeting-local speaker map from `speaker.id`, `speaker_label`, `device_type`, and `chunk_id`, and apply it consistently to transcript excerpts and the summary. current-run evidence outranks any older `memory.md` lesson that says to leave a two-person call unnamed. use this order:

1. accessibility: an active-speaker tile, a single visible speaker tile, or a subtitle label with a name;
2. parsed data: a current-frame actor or item that identifies the same active speaker;
3. deterministic call topology: when preferred screen evidence repeatedly shows exactly two participants — the local user and one remote participant — label `device_type=Input` rows as the local participant and `device_type=Output` rows as the sole remote participant. this is an unambiguous mapping even without an active-speaker highlight. for a one-person call, label input rows as the sole local participant. use the meeting title or attendee field only to corroborate names already visible on screen, never by itself;
4. OCR fallback: a matching on-screen name tag, but only when both accessibility and parsed data were unavailable or empty and `/tmp/ocr.json` therefore contains fallback rows.

a participant roster or gallery establishes call topology only when it stays consistent across the meeting. it does not identify speakers in a multi-party call by itself. treat provisional labels and persisted names that conflict with deterministic device direction as unreliable for this meeting.

every speaker used in the summary must have either an evidence-backed participant name or a stable meeting-local label (`Speaker 1`, `Speaker 2`, …). never emit an unnamed, blank, `unknown`, or generic live label in the finished summary. when a real name cannot be established in a multi-party call, use the stable label and state that identity remains unresolved instead of inventing a name.

  # speakers with no name yet — already fetched to /tmp/spk.json in step 1, reuse it
  #   (if you must re-fetch: offset is required, omitting it returns 400)
  #   curl -s -H "$A" "http://localhost:3030/speakers/unnamed?limit=20&offset=0"
  # apply a confident match
  curl -s -X POST "http://localhost:3030/speakers/update" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"id": <SPEAKER_ID>, "name": "<NAME_FROM_SCREEN>"}'

persist a real name only when the meeting-local mapping resolves a specific nonzero speaker id. never rename speaker id `0`, and never overwrite one persistent id that appears on conflicting input/output sides; keep those corrections meeting-local in the summary. note which persistent speakers you renamed and which names are meeting-local only in your final message.

step 3 — write the summary out as your own message, before you save it. this message must contain no tool call; end the turn after it. start a line with exactly `## Summary` and put the finished summary markdown after that heading. the meeting UI streams this section live while you write it — it is the only way the user sees anything before the run ends — and it is the same markdown you pass as `<YOUR_SUMMARY>` in step 3b.

this step is not optional and it is not the closing report. "meeting 112 was summarized and saved to its record" is a report; it does not satisfy this step. saving a summary you never printed means the user watched a placeholder for the entire run and then got nothing to read, so treat that as a failed run. keep planning, tool narration, and save confirmations out of the section after the heading — those belong in your closing message in step 4.

step 3b — now save it through the dedicated summary endpoint. the server merges the `## Summary` section into the note itself (user notes are preserved, a re-run replaces the old section) and rejects an empty summary with 400, so a lost payload fails loudly instead of "succeeding" as a no-op. write the summary to a file first — no shell variables into subprocesses, no hand-built JSON:

  cat > /tmp/summary.md <<'SUMMARY_EOF'
  <YOUR_SUMMARY>
  SUMMARY_EOF
  cat > /tmp/title.txt <<'TITLE_EOF'
  <NEW_TITLE_OR_EMPTY>
  TITLE_EOF
  bun -e 'const summary=await Bun.file("/tmp/summary.md").text(),title=(await Bun.file("/tmp/title.txt").text()).trim(),body=title?{summary,title}:{summary};await Bun.write("/tmp/summary.json",JSON.stringify(body))'
  curl -sf -X POST "http://localhost:3030/meetings/<MEETING_ID>/summary" \
    -H "Authorization: Bearer $SCREENPIPE_LOCAL_API_KEY" \
    -H "Content-Type: application/json" \
    --data @/tmp/summary.json

`-f` matters: if this call fails, say so in your closing message instead of reporting success. for the title: if the current title is missing, generic ("untitled", "meeting", just the app name) or doesn't capture what actually happened, pass a 5-8 word plain-english title (no quotes, no "meeting about…" prefix) — otherwise pass the empty string so a user-set title is left alone. if there's nothing useful to summarize (empty transcript, irrelevant audio), say so out loud and skip the save — don't write a placeholder.

step 4 — offer to push the summary into one of the user's connected apps (ask, never push on your own). list what's actually connected, then let them pick with one click:

  bun -e 'const d=await Bun.file("/tmp/conn.json").json();for(const c of d.data??[])if(c.connected===true)console.log(`${c.id}\t${c.name}`)'   # already fetched in step 1

rank the connected targets by relevance — an app used during the meeting first (Notion, Slack, Linear, …). then post a desktop notification whose action buttons are those targets, so the ask renders as buttons in the UI:

  curl -s -X POST "http://localhost:11435/notify" \
    -H "Content-Type: application/json" \
    -d '{"title": "<TITLE> summarized", "body": "<one-line recap> — push it somewhere?", "priority": "high", "actions": [
          {"label": "push to notion", "type": "api", "method": "POST", "url": "http://localhost:3030/connections/notion/proxy/v1/pages", "body": { /* page payload built from the summary */ }},
          {"label": "review in chat", "type": "chat", "prompt": "Review the existing summary for meeting <ID>. Do not rerun meeting-summary.", "context": {"meeting_id": <ID>}},
          {"label": "dismiss", "type": "dismiss"}
        ]}'

each button maps to a connection's endpoint from its `/connections` `description` (`POST /connections/<id>/send` for slack/telegram/discord, `POST /connections/<id>/proxy/...` for notion/linear/etc.). use `type: "api"` only when the endpoint, payload, and destination are complete. when a target needs a destination you can't infer (a Notion parent page, a Slack channel), use an action-specific `type: "chat"` button whose prompt names the existing meeting summary and asks the user for the missing destination before writing. never use `type: "pipe"` with `pipe: "meeting-summary"` for a post-summary button — that runs the summarizer again. a review-only button must also use `type: "chat"` and tell the chat to review the saved summary without rerunning it. if nothing is connected, skip the notification and just say that connecting an app would let you push summaries next time.
