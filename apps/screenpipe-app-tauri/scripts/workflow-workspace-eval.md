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

These trials use real model calls and consume account usage. Recording data and persistence are fictional and isolated on a temporary loopback server. They do not modify the user's catalog. The script stops the child after 180 seconds and writes private trajectory/result artifacts to a temporary directory.

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
