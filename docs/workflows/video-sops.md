<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->
# Desktop video SOPs

Open a workflow, choose **Create SOP**, then **Video SOP**. Review the narration and choose whether to include reviewed screenshots before creating the video. Download the MP4 and WebVTT captions before leaving the SOP. Editing the SOP does not change an existing preview; create a new video to include the edits.

The editable SOP supplies the initial script. Use the bottom-right chat to revise narration and titles, reorder or omit sections, adjust narration pace, or focus a screenshot through the existing bottom-right chat. The agent reads the saved video project and bundled video editing skill on demand. An image-capable model can inspect one attached screenshot at a time, and the tool requires inspection before accepting a focus change. Normal wording edits save the script; an explicit request to create a video invokes the renderer. Text-only models can edit wording and pacing, but cannot set a new focus; the app does not switch the selected model or privacy mode. The written SOP remains separate.

Video drafts retain their source fingerprint. After the SOP changes, reset the video script before rendering again. Every included procedural step needs a reviewed screenshot by default. The render tool reports unavailable source captures before generating speech. Existing screenshots are reused; this feature does not create missing captures. The last three previews remain selectable while the SOP is open. Download copies to keep them.

The scoped project supports narrated screenshot walkthroughs, including pace (0.85–1.25) and focus (up to 1.6×, limited by source resolution). It does not provide arbitrary video code, footage generation, music, voice selection or a general shell. The scoped tools are `read_video_sop`, `edit_video_sop`, and `render_video_sop`. The renderer tool launches the bundled app in `--render-workflow-video` mode, awaits its exit and verifies the MP4 and captions. Progress arrives as ordinary tool events; the page displays the returned artifact. Script edits remain separate from generation. Rendering does not execute the underlying workflow.

## Boundaries

- The shared Workflows UI owns the review and progress panel. Its optional platform capability keeps native imports out of web consumers.
- The desktop adapter resolves reviewed frame references through the recorder's original-frame API, with neighboring-frame fallback disabled. Missing referenced images stop the request before speech charges. Rendering stays local. In a visual chat edit, the agent can send the requested screenshot to the selected AI provider.
- The agent CLI inherits the existing account token and `/v1/tts` gateway, including Business entitlement and the shared AI allowance. Only narration is sent to the speech endpoint. There is no new provider key, account, scheduled task or capture pipeline.
- The engine renders a local 720p H.264/AAC MP4 with the bundled FFmpeg. Each caption is timed from its own decoded speech segment. Audio is encoded once to avoid gaps between AAC segments. The final file is decoded before returning success.
- A filesystem lock permits one agent render per workspace at a time. Each provider call has a 70-second timeout, each video operation 180 seconds, and the agent CLI cancels its job after 10 minutes. Plans are limited to 50 sections, 18,000 characters, 100 speech segments and 20 minutes of output. Encoding uses two threads. Image and output sizes are bounded.
- Stop and navigation cancellation abort pending speech and kill the active renderer. Provider failures are not automatically retried. Account allowance exhaustion has a separate message from transient throttling.
- Temporary source images, speech and video segments are removed after the job. Previews are removed when leaving the SOP or when a fourth render replaces the oldest preview. A failed replacement preserves the earlier preview. Abandoned previews are pruned after a day, with a bounded cache. Turn-scoped image projects are bounded to 32 MB and removed after editing; a bounded cleanup removes owned day-old crash leftovers. Nothing is added to the workflow catalog or recorder database.
- PostHog records starts, completion, cancellation, failure and explicit downloads, with section/image counts or format only. It receives no workflow identity, script, screenshot, file path or upstream error body.

## Narration profile and rollout

Desktop SOP requests send `profile: "sop"` to `/v1/tts`. The gateway uses the enterprise OpenAI defaults: `gpt-4o-mini-tts`, `marin`, and the same conversational reading instructions, through Cloudflare BYOK and the existing cost ledger. This matches the enterprise OpenAI configuration in source; it does not verify which profile a particular enterprise deployment currently uses.

Deploy the gateway change before shipping the desktop change. Configure `SOP_TTS_USD_PER_CHARACTER` to a verified conservative cost rate, with the existing `TTS_ENABLED` and OpenAI BYOK setup. An absent rate fails closed with 503, rather than silently changing voices. Legacy callers without `profile` retain their ElevenLabs configuration. Desktop also verifies the returned narration-profile header, so an older gateway cannot silently produce a different voice. Gateway tests use Miniflare and real local D1 with synthetic provider responses; they do not establish provider acceptance or listening quality. This PR does not deploy the gateway.

## Verification

From `apps/screenpipe-app-tauri`:

```sh
bun x vitest run lib/workflows/video-chat.test.tsx lib/workflows/guide-video-edit.test.ts lib/workflows/guide-storage.test.ts lib/workflows/guide-video.test.tsx lib/workflows/guide-video-adapter.test.ts lib/workflows/guide.test.tsx lib/workflows/guides-adapter.test.ts lib/workflows/video-project.test.ts
bun run test:tauri workflow_video -- --nocapture
bun run bindings:check
bun x tsc --noEmit
bun run coverage:all:check
```

The native tests exercise the real bundled renderer, invalid screenshots, caption timing, cancellation, account allowance errors and provider failures without paid calls. The opt-in `workflow_video_live_eval` test takes `SCREENPIPE_VIDEO_EVAL_MANIFEST` (an array of `{directory, scenes}` with local image paths) and `SCREENPIPE_VIDEO_AUTH_FILE`. It uses real speech and must only run with explicit live-evaluation authorization. Keep input and output outside the repository. `workflow_video_recorded_speech_eval` instead accepts `SCREENPIPE_VIDEO_SPEECH_FIXTURE` and uses a local HTTP fixture; it does not prove live narration quality. `workflow_video_replay_eval` accepts `SCREENPIPE_VIDEO_REPLAY_MANIFEST`, an array of `{text, audioPath}` pairs containing previously generated narration, and routes exact text matches to a local fixture server. This reruns the actual renderer without new hosted speech calls.

`bun run eval:workflow-video PRIVATE_WORKFLOWS_JSON PRIVATE_OUTPUT_DIR` evaluates up to twelve real workflow snapshots through the configured SOP model and validates each video plan. Tools are disabled for this evaluation. It does not save or execute user workflows.

For visual review, run `bun run preview:workflow-video OPTIONAL_SYNTHETIC_MP4`. Open the first workflow and its SOP. The `state` query accepts `before`, `review`, `progress`, `error`, `quota`, `cancel`, `stale`, `missing`, and `revisions`. This renders the actual shared product components with fictional data and mocked host operations. Native IPC, the macOS save dialog, and Windows/Linux playback still need release-platform smoke testing; browser previews do not establish that coverage.

### Video edit outcome evals

`bun test scripts/eval-workflow-video-edit.test.ts` checks the edit-tool contracts and calibrated outcome grader. `bun run eval:workflow-video-edit --output PRIVATE_DIRECTORY` runs the actual pinned Pi CLI with scripted local model responses. Add `--live` for an explicitly authorized run through the existing account's `auto` route. It never saves a user workflow or invokes speech/rendering. See [the eval guide](../../scripts/evals/workflow-video/README.md) for frozen baseline comparisons, budgets, traces and coverage limits.

Edits preserve untouched fields, validate the resulting whole script before acceptance, and permit correction of rejected proposals. Only one successful patch is accepted per turn. When a user specifies a narration word limit, the agent supplies `maxNarrationWords`; the tool checks it before accepting, and the limit is not persisted as video content.
