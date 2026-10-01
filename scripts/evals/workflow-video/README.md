# Video editing outcome evals

These evals exercise the desktop video editor's actual prompt, bundled skill and
scoped Pi tools. Fixtures are fictional. Expected results stay in the evaluator;
the agent receives only the request, bounded conversation and staged project.
The host applies returned patches in memory. No user workflow or SOP is changed by this suite. Generation uses a subprocess protocol fixture, not hosted speech or a real MP4.

From `apps/screenpipe-app-tauri`:

```sh
# Deterministic tool contracts and scorer calibration; also discovered by test:bun.
bun test scripts/eval-workflow-video-edit.test.ts

# Actual pinned Pi runtime with scripted local model responses. No hosted calls.
bun run eval:workflow-video-edit --output /absolute/private/runtime-results

# Opt-in real model run through the existing screenpipe/auto account route.
bun run eval:workflow-video-edit --live --output /absolute/private/live-results

# One case, or an earlier frozen implementation for paired comparisons.
bun run eval:workflow-video-edit --live --case freeform-shortening --output /absolute/private/shortening-results
bun run eval:workflow-video-edit --source /absolute/private/baseline-source --output /absolute/private/baseline-results
```

A baseline directory contains `video-tool.ts`, `video-edit-prompt.ts` and
`SKILL.md`. Freeze these before changing the implementation. The runner records
source, prompt, skill, case, grader and harness hashes, the installed Pi version,
and execution budgets. It rejects a Pi version that differs from the product pin.
Each case gets an isolated temporary project and config, with only
`read_video_sop`, `edit_video_sop`, and `render_video_sop` exposed. The temporary account config is
removed afterward. Existing sessions and app data are untouched.

Live mode uses the configured account and `auto` route with 8,192 output tokens,
eight turns and a three-minute deadline per case. It stops the suite on an
account/allowance error, records unrun cases, and never switches providers.
`auto` can route to a changing upstream model, so this is a comparison of the
product route, not a pinned-model benchmark. Each run is one sample per case.
The live flag can consume account allowance; use it only for authorized trials.

Private output contains case trajectories, resulting drafts, source hashes and
original scores. Keep these directories outside Git. To fix a scorer without
replacing original results or spending more model calls, from the repository root:

```sh
bun scripts/evals/workflow-video/regrade.ts /absolute/private/baseline-results /absolute/private/live-results
```

The suite covers exact edits, free-form shortening, preservation of untouched
content, questions and no-change requests, old render instructions, source
instruction injection, unsupported voice changes and missing screenshots.
Contract tests cover image inspection, text-only models, unknown sections,
duplicate patches, word limits and rejected-proposal recovery. Separate scorer
fixtures verify that an unchanged draft, dropped exception, unauthorized render,
missing evidence or invented completion cannot pass as a successful edit.

The free-form shortening check combines structural preservation, length and
required concepts with manual review of the actual sentence. Keyword checks do
not prove semantic equivalence. The completion-claim check is also heuristic;
review replies before interpreting a passing score as truthful product behavior.
Scripted runtime results do not measure model judgment. None of these edit evals
establish narration quality, visual composition, screenshot relevance, native
render completion, the installed desktop UI or real-user satisfaction. Those
need the separate renderer and UI checks described in `docs/workflows/video-sops.md`.

## Recorded evaluation, September 30, 2026

| Evidence | Baseline | Final candidate |
| --- | --- | --- |
| Live editing cases, existing `screenpipe/auto` route | 3/13 passed | 13/13 passed |
| Scripted pinned-Pi runtime | 4/12 passed | 13/13 passed |
| Original tool contracts | 12/17 passed | 17/17 passed |
| Expanded contracts and scorer calibration | Not used as a model score | 38/38 passed |

The original twelve cases were frozen before the first implementation changes.
Free-form shortening was added afterward, then run against the same frozen
baseline and candidate. Both arms were regraded with the corrected scorer.
All original traces and intermediate failures remain in private eval artifacts.
The additional scripted case explains the different runtime denominators.

The baseline added `focus: null` to untouched text scenes, including no-op edits.
The tool also accepted unknown IDs, oversized merged scripts, multiple successful
patches and focus on hidden images before the host rejected or discarded them.
Validation now happens before the tool accepts a proposal, so the model can
correct a rejected edit while the app keeps the saved draft intact.

A live shortening trial exceeded the user's word limit. An explicit
`maxNarrationWords` constraint now checks the proposal; a later live trace shows
rejection followed by a valid correction. An intermediate rerun passed 12/13:
the remaining case appended a neighboring section's sentence to supplied exact
wording. The final guidance distinguishes exact replacement from free-form
shortening, and the last full run passed all thirteen cases. Replies and the
shortened sentence were also manually reviewed. This is one final sample per
case, not a reliability estimate or evidence of later user satisfaction.

One scorer initially rejected a truthful "haven't rendered" statement and a
valid synonym for voice support. Calibration fixtures now cover both, and
regrading retains the original results. The scorer remains conservative and
heuristic; the final-state and tool-boundary checks are its strongest evidence.

## Agent renderer verification, October 1, 2026

The updated scripted Pi suite passes 13/13 cases. Live model trials pass explicit
creation and edit-only requests with an earlier render request in history (2/2).
These use a renderer protocol fixture to evaluate tool routing and awaiting,
not video quality. The separate real tool-to-bundled-CLI smoke produced a 720p
H.264/AAC MP4 with a source screenshot, timed captions and non-silent narration.
Closing stdin on the installed CLI cancelled a run and removed its temporary
output. Browser fixture checks cover tool rows, progress, completed page preview,
repeat generation, stop and compact layout. These checks do not establish
screenshot relevance for every saved workflow or Windows/Linux behavior.
