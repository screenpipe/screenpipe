# Workflow workspace evaluation

The four agents use the normal Pi harness, Screenpipe API skill and scoped Pipe permissions. `workflow_workspace` handles durable drafts, handoffs and publication receipts. It does not choose recording queries or classify workflows.

## Model trials

From `apps/screenpipe-app-tauri`, with the local Screenpipe Pi runtime and an authenticated AI account installed:

```sh
bun scripts/eval-workflow-workspace.ts --large-context --conflict
bun scripts/eval-workflow-workspace.ts --ai-mediated --conflict
bun scripts/eval-workflow-workspace.ts --feedback-only
bun scripts/eval-workflow-workspace.ts --missing-draft
bun scripts/eval-workflow-workspace.ts --no-change
bun scripts/eval-workflow-workspace.ts --discover
bun scripts/eval-workflow-workspace.ts --repair-delegation
bun scripts/eval-workflow-workspace.ts --research-notes
bun scripts/eval-workflow-workspace.ts --repair-source
bun scripts/eval-workflow-workspace.ts --reported-actions
bun scripts/eval-workflow-workspace.ts --discover --medium-context
WORKFLOW_EVAL_MODEL=glm-5.3-flash-reap50-iq3m bun scripts/eval-workflow-workspace.ts --no-change
```

These trials use real model calls and consume account usage. Recording data and persistence are fictional and isolated on a temporary loopback server. They do not modify the user's catalog. The script defaults to a 180-second total budget and writes private trajectory/result artifacts to a temporary directory. `WORKFLOW_EVAL_TIMEOUT_MS` can set an explicit budget up to 900 seconds; results record the selected budget. Longer runs are reported separately from the default-budget trials.

The withheld outcome checks distinguish directly observed actions from assistant completion claims and menu labels, accept work actually performed inside a chat, preserve source identity, exercise stale-write recovery, and check greetings are not treated as corrections. A successful process exit alone is not a pass. Private trials also check verified confidential transport.

These are sampled agent trials, not exhaustive quality guarantees. The mock persistence server does not substitute for native route/storage tests. A short Private trial passing does not establish reliability for a long real-history scan.

`--reported-actions` reproduces a false accept where the draft admits missing execution evidence in limitations, but still describes connecting systems in its title and procedure. The agent must retain the observed planning and request for a receipt without promoting the assistant's report into external work. Its fixture-specific text checks are conservative and require manual review of the saved payload; they are not a general semantic grader.

`--medium-context` preserves 40 resolved draft decisions, and `--large-context` preserves 160. Both require the actual file-snapshot path to be exposed and all prior decisions to remain intact. Older discovery trials cleared the resolved history before starting, so their large-context label was incorrect. The context tool now creates a snapshot before Private's 8K text boundary, rather than letting intermediate-size JSON be truncated with no complete copy available.

`--discover` checks separate jobs within one chat application. `--repair-delegation` starts with a draft mixing observed review with unobserved tests/merge; the agent must retain useful work while removing unsupported completion. `--research-notes` starts with notes lacking the catalog's description/stages, reproducing a failed native handoff. The latter two run actual handoffs between Review and Deepen within a shared 180-second budget. The negative candidate has valid structure, so field validation alone cannot establish its lack of factual support.

`--repair-source` supplies a draft with a mismatched quotation; the reviewer must read the source and store an actual payload repair. A self-handoff containing only a note cannot acknowledge an edit. The server permits note-only handoffs to other agents for research questions, but rejects self-handoffs that omit or repeat the unchanged payload without advancing workspace state.

Set `WORKFLOW_EVAL_PROMPT_FILE` to a saved baseline prompt for the first role when comparing runs. Keep fixture, tools, model and deadline identical, and record any grader changes separately. Native normalizer tests cover field errors and valid single-day evidence; the mock does not execute that Rust code. Verify the full save path in the signed app before treating a model trial as an end-to-end pass.

## Native validation

Use a signed dev app with the installed templates verified against source. Never rebuild its bundle during an active trial. Keep a private catalog/settings backup and retain failed-run evidence.

1. Start an update through the actual Workflows UI. Verify the intended model and execution IDs.
2. Observe Discover and Maintain running independently, durable draft handoffs to Deepen/Review, and atomic publication receipts.
3. Verify new/updated counts against persisted records and source quotations against original recording records, including actor and outcome semantics. An unchanged count can be correct; it must have an evidence-backed explanation.
4. Check the whole-cycle cursor advances only after completion. Stop/resume and stale writes must preserve catalog entries and human corrections.
5. Inspect generated steps and screenshot references in the native UI, and check capture health. Restore the user's model preference after model-specific tests.

The development trial on September 19 produced a ninth workflow with fourteen source-matching procedure items. A later native Intelligent cycle completed with an independently reviewed no-change result. A long native Private trial timed out during compaction without producing a draft; that remains a failed acceptance case and must not be represented as shipping-ready.

On September 20, native investigation found that Deepen could hand off a research note without replacing its incomplete payload. Review then mistook the normalizer's generic recurrence error for an evidence decision and rejected a real drafting job. The regression trials now include this payload shape, observed knowledge work with an unverified external outcome, and a structurally valid assistant-only completion claim. In a rebuilt Intelligent native UI run, the catalog grew from nine to ten workflows; Review rejected a second candidate that combined unrelated account surfaces. All three saved procedure quotes matched independently fetched original records, and the saved source image rendered in the app. This demonstrates that case, not exhaustive recall across all recorded history.

Two subsequent native cycles brought the catalog to thirteen. Twelve procedure quotations across the first three added workflows matched original records. The third cycle exposed a separate publication defect: Review supplied an edited `publish.payload`, but the endpoint ignored it and saved the older draft. Publication now validates that supplied object and persists it with the receipt atomically. A targeted replay of the actual agent edit against the rebuilt native app updated the existing record without a duplicate; the catalog description and stored draft matched the submitted edit. Replaying the identical request returned the same receipt; replaying a different payload was rejected without changing the catalog. This targeted API replay is distinct from the autonomous discovery trials.

A subsequent native resume exposed repeated mistyped UUIDs during context reads and handoff. Missing-draft errors now list exact currently assigned open IDs without substituting or retrying writes. Tool tests cover this error recovery contract. Preserve this failed trial separately from the completed native publication trials.

`--missing-draft` invalidates the first publication target while retaining its contents under another opaque ID. The agent must use the returned exact candidate, publish only the supported workflow, and finish the whole cycle. This is fault injection against the tool contract, not a claim that production IDs change. Successful save responses now include remaining work and current revisions. A failed follow-up state read must preserve the successful receipt.

The no-change fixture now omits directly observed invoice actions. Its earlier version included those actions while requiring rejection, so repairing the candidate was a valid response that the grader incorrectly rejected. Keep that earlier trial separate from runs of the corrected fixture; do not treat the fixture correction as a measured model improvement.


The September 20 recovery candidate was also tested in the installed, signed native app. Stopping during startup exposed a late PID callback that overwrote a terminal cancelled execution with `running`; the shared Pipe store now refuses that transition. Repeating Stop left both started executions cancelled, the cycle paused, and all recurring task settings unchanged. Resume reused the same cycle and fixed interval. Discover, Maintain, Deepen and Review completed; Review recovered from rejected publication payloads through the normal tool path and finished the cycle. The catalog grew from thirteen to fourteen, with the thirteen prior records unchanged and the completed cursor equal to the requested interval end. All five new procedure quotations matched the original timestamp/app/text records. The new entry explicitly distinguishes the user's requested behavior and assistant-reported plan from an independently verified implementation. After one app restart, the entire catalog and task configurations were identical, the completed result remained visible, and recording health was normal.

The missing-draft trial passed with both `auto` and Private `glm-5.3-flash-reap50-iq3m`, including actual Pi tool-error signaling, publication, rejection of unsupported evidence, and full-cycle completion. The corrected no-change trial passed with `auto`. These are isolated real-model trials; the installed native completion above used Intelligent.

Later native Private runs still timed out at the normal 900-second deadline without saving drafts. Matching the persisted prompt and results to the provider's existing context bounds fixed a measurable discrepancy, but did not establish completion. The failed native run also exposed medium-size workspace JSON being truncated at transport; the snapshot regression now reproduces that independently.

A later signed Intelligent run completed the four-agent cycle and grew the catalog from 14 to 18, preserving all prior records and advancing the cursor to the fixed end. All 25 new procedure quotations matched their original timestamp/app/text records. Manual review nevertheless found some assistant-reported external actions promoted into procedures despite limitations. That result is a persistence pass and a semantic-quality failure, not an end-to-end quality pass. Deepen and Review now explicitly scope titles and individual steps to observed work and put proposed future verification in open questions. The new reported-actions trial and preserved in-chat-work trial passed with manual review; the former's baseline produced no response before its deadline, so it does not measure a causal improvement. The latest native visual check remains blocked by a locked Mac. Do not represent these results as universal reliability or release readiness.

## Timing maintenance regression, September 21

The context index now exposes timing coverage and saved-source dates, and both
index and selected-workflow reads retain the available history boundary. Maintain
can investigate an unmeasured saved workflow outside the current discovery cycle.
It still needs observed start/end transitions; repeated finished conversations
must not become measured work just because their capture timestamps differ.

```sh
# From apps/screenpipe-app-tauri. Keep WORKFLOW_EVAL_NOW identical for comparisons.
bun scripts/eval-workflow-workspace.ts --timing=historical
bun scripts/eval-workflow-workspace.ts --timing=sparse
bun scripts/eval-workflow-workspace.ts --timing=static-chat
bun scripts/eval-workflow-workspace.ts --timing=preserve
WORKFLOW_EVAL_TIMEOUT_MS=360000 WORKFLOW_EVAL_MODEL=glm-5.3-flash-reap50-iq3m bun scripts/eval-workflow-workspace.ts --timing=historical --large-context
```

The historical fixture has two completed receipts three days ago and unrelated
recent activity. Its expected runs last six and eight minutes, separated by a
break. Search respects timestamp/app/query bounds and pagination. Old fixture
searches returned all rows regardless of the requested interval; those runs did
not demonstrate historical retrieval. Fixed-clock fixtures now also keep saved
source references consistent with recorder rows. The scheduler resumes unfinished
Maintenance after review instead of repeatedly dispatching Review. Terminal
handoffs are rejected. Large-context timing cases retain the resolved history.

A successful measured trial writes `native-timing-input.json`, containing model
output and independently authored fictional recorder rows. Verify it through the
real HTTP recorder, workspace validation and atomic catalog store, from repo root:

```sh
WORKFLOW_TIMING_AGENT_INPUT=/path/to/trial/native-timing-input.json \
WORKFLOW_TIMING_CATALOG_OUTPUT=/tmp/workflow-timing-native-catalog.json \
cargo test -p screenpipe-engine --test workflow_timing_e2e --no-default-features --features redact-onnx-cpu
```

Without the input environment variable, the test uses its deterministic fixture.
It checks source-quote rejection without changing disk, exact arithmetic, two
occurrences rather than one interval across a break, no duplicate workflow,
idempotent publication, no-change completion, and disk/API timestamp equivalence
across timezones. The test runs an isolated recorder and never edits the user's DB.

Build and serve `apps/screenpipe-workflows-web/out` locally. Then, from that app:

```sh
WORKFLOW_TIMING_CATALOG_OUTPUT=/tmp/workflow-timing-native-catalog.json \
WORKFLOW_TIMING_PREVIEW_URL=http://127.0.0.1:1437/preview.html \
bun scripts/check-workflow-timing-browser.cjs
```

This headless browser check consumes the actual native-saved catalog. It verifies
`~7m`, two runs, the 6m–8m range, each boundary's source disclosure, a narrow
viewport, and reload persistence. Native Timeline launching is covered by the
UI callback test, not this web fixture.

Verified in this change: Intelligent historical, sparse, static-chat and preserve agent cases;
real backend publication of the historical agent output; deterministic native
regression; browser display/reload of that output. The corrected historical
baseline also passed, so these samples are not a measured causal improvement or
a success-rate claim. Earlier historical attempts exposed an inconsistent fixture
and a scheduler mismatch and are retained as failures. These checks do not prove
that every real saved workflow has enough evidence to be timed, nor that a new
signed desktop release has been installed and tested.

The static-chat case repeats a complete draft/revision conversation at two capture
timestamps an hour apart, without labeling it as inactive. The agent must retain
the workflow while leaving its duration unknown. This mirrors the inspected real
source shape more closely than the receipt-list negative fixture.

Private's first large-context trial exhausted the default 180 seconds after
Maintenance produced the correct two runs, before Review could complete. A
360-second trial exposed a different failure: Maintenance repeatedly omitted
`expected_revision` and mistook the resulting error for concurrent writes. The
tool now validates required revisions locally with an actionable error, without
fetching or substituting a revision for the model. The single-workflow publication
shape is also explicit beside the legacy batch output contract. These changes
preserve conflict detection and do not auto-repair or publish model payloads.

The later native replay of the large-context Intelligent output failed despite
correct timing: a valid procedure cited its stage's fifth source, but the core
normalizer had already reduced stage evidence to four display references. It
reported a dropped procedure item and rejected the whole update. Normalization
now validates against all already-resolved sources, then keeps the compact
supplemental references plus every source cited by a validated procedure. The
recorder source-read bound and quote verification remain unchanged. A regression
includes a valid fifth source, an uncited sixth source and a fabricated quote;
the HTTP test's default fixture also includes the fifth-source case. The core
workflow suite passed all 31 tests after this fix.

Private completed the standard historical fixture with verified confidential
transport. A later 360-second large-context run finished Maintenance but Review
repeated malformed `action: "context\\ndraft_id"` calls until timeout. That is a
failed stress trial. The tool now gives literal JSON call examples with separate
action and selector fields; invalid actions remain rejected, not silently fixed.
Trial metadata records the workspace extension hash alongside prompt/skill hashes.

After the source-preservation fix, the native HTTP test passed with the exact
large-context Intelligent output that previously failed, with the successful
Private historical output, and with the deterministic fifth-source fixture.
Both providers' native-saved catalogs passed the headless browser checks. This
closes the generation → source verification → atomic save → reload → display
chain on isolated data; it is not an installed desktop packaging test.

The explicit-action-example stress rerun still timed out after reaching Review,
which attempted to publish a catalog wrapper. Workspace context now exposes a
dedicated single-workflow contract (`workflowOutputContract` on the recorder API,
returned as `outputContract` by the workspace tool). The legacy batch contract is
preserved for existing clients. Contract parity and backward compatibility are
covered by tool tests, and the HTTP test checks that both API fields are present.

Both large-context providers subsequently completed with the single-workflow
contract: Intelligent (`EVUqU7`) and Private (`sePouA`). Their exact payloads passed
the real native HTTP publication test and browser display/reload checks. Manual
review found that Private's run summaries called elapsed spans “active work”;
the computed numbers were correct, but that wording overclaims what captures
prove. This is a semantic limitation of that trial, despite its mechanical pass.

The embedded-skill installation check caught the added guidance exceeding its
5,000-byte budget. The guide was condensed to 4,889 bytes without removing the
historical-research, source-verification or persistence requirements, and the
installation check passed. Final agent trials use the condensed guide.

The condensed-guide Intelligent historical run (`Gumjab`) passed generation,
real native publication and browser reload. Its summaries describe elapsed spans.
The final static-chat trial (`8yTuwM`) also completed with timing unknown. A new
calibrated fixture assertion flags the earlier “6 minutes of active work” claim
without rejecting “6 minutes elapsed; this does not establish active work time.”
All eight oracle calibration tests pass. Regrading the stored outputs passes
`Gumjab` and `8yTuwM` and flags the earlier Private `sePouA` wording, as intended.

The final condensed-guide Private stress trial (`arT6yp`) completed with verified
confidential transport and the two exact source-supported runs. Offline regrading
with the added active-time assertion passed; manual review found bounded run
summaries with the intervening lunch kept separate. The exact generated payload
also passed native HTTP source validation, publication, retry and disk reload.

Final checks: 31 core workflow tests, 20 workspace-tool tests (85 assertions),
eight timing-oracle tests, four shared UI timing tests, and the embedded-skill
installation/budget check passed. The integrated tests use fictional recording
data with actual Pi/provider calls, then the production recorder save path and
shared browser UI. Agent evaluation uses an isolated workspace endpoint; replay
through the real backend independently verifies that its output is saveable.
This is not a claim of installed desktop release validation or universal model
reliability. Unknown timing remains correct when sources cannot establish runs.
