# Video SOP visual evidence

Captured September 30, 2026 from the actual shared WorkflowsApp and SOP editor, with the existing fictional workflow catalog. These are isolated browser component previews with mocked native operations, not installed desktop-app screenshots.

The before image recreates the inspected d695023a3 baseline by leaving the optional video capability absent. After images use the implementation in this commit. Viewports are 1440 × 1000 at 1×, except narrow.png at 820 × 1100. Product fonts and theme styles are loaded.

| Image | State |
| --- | --- |
| before.png | Existing SOP toolbar without video support |
| review.png | Video entry point, reviewed screenshot coverage and speech/chat disclosure |
| script.png | Expanded narration review |
| progress.png | Generation progress and Stop |
| error.png | Provider failure, retry available, old progress cleared |
| cancel.png | Cancelled generation |
| complete.png | Preview, MP4 and caption downloads |
| quota.png | Monthly allowance exhaustion |
| stale.png | A source revision mismatch blocks generation |
| narrow.png | Panel fits within the content area at a narrow width |
| chat.png | Existing bottom-right chat scoped to the video draft |
| chat-edited.png | Wording edit saved without rendering |
| chat-rendered.png | Explicit render completed; chat minimizes to reveal preview |
| missing.png | Missing procedural screenshot blocks rendering until reviewed or explicitly overridden |
| revisions.png | Earlier successful render can be selected and downloaded |

The completion fixture plays a short fictional clip produced by the real native renderer using previously recorded canary speech through a local HTTP fixture. It is not the full research-brief narration. Private live workflow videos are excluded from this repository.

## Test results

- 66 focused UI, plan, storage, chat-tool and adapter tests passed.
- Five native test functions passed, including actual FFmpeg rendering, caption timing, failures, limits and cancellation. Three live/fixture/replay evaluation entry points are opt-in and ignored by the regular suite.
- TypeScript, generated bindings, and the CI-scoped Knip check passed.
- Fifteen visual states were exercised with no browser page errors or horizontal overflow. Playback was started and paused for the completed fixture.
- Eight private real workflow snapshots produced valid SOP/video plans using the configured model. Four videos completed with live hosted speech. The remaining four were blocked by the shared monthly AI allowance, including one partial narration run. Live calls stopped; the limit was not bypassed.
- The four earlier completed outputs were decoded successfully as 1280 × 720 H.264/AAC MP4s; caption end times matched their durations within one millisecond. This checks media integrity and timing, not a human listening score. All four were subsequently rendered again with the current code, replaying exact prior narration locally. The UI chat test uses deterministic host/model responses and a fictional renderer fixture; it does not establish a live language-model editing score.
- The repository coverage command is blocked by the pre-existing missing manifest entry for crates/screenpipe-engine/src/routes/activity_summary_hybrid_tests.rs. Its E2E manifest check passed.

The current native renderer also rebuilt the support walkthrough with higher-resolution recorder screenshots, 1.12× narration pace and inspected screenshot focus. This uses exact cached narration and therefore retains the earlier voice. The OpenAI Marin profile is verified only through synthetic gateway tests, not live provider audio. Six gateway tests passed, including Cloudflare routing, local D1 settlement and fail-closed voice configuration.

The bundled editing skill has deterministic tool-boundary tests, including read-before-edit, inspect-before-focus, text-only model behavior and temporary-project cleanup. Live agent skill selection and editing quality remain unverified.

Installed-app IPC, the native save dialog, and Windows/Linux playback remain release smoke-test gaps. Keep this PR draft until those checks and hosted CI are reviewed.

Reproduce the component preview from apps/screenpipe-app-tauri with `bun run preview:workflow-video OPTIONAL_SYNTHETIC_MP4`; see docs/workflows/video-sops.md for renderer and evaluation commands.
