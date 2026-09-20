# Workflow workspace evaluation

The four agents use the normal Pi harness, Screenpipe API skill and scoped Pipe permissions. `workflow_workspace` handles durable drafts, handoffs and publication receipts. It does not choose recording queries or classify workflows.

## Model trials

From `apps/screenpipe-app-tauri`, with the local Screenpipe Pi runtime and an authenticated AI account installed:

```sh
bun scripts/eval-workflow-workspace.ts --large-context --conflict
bun scripts/eval-workflow-workspace.ts --ai-mediated --conflict
bun scripts/eval-workflow-workspace.ts --feedback-only
bun scripts/eval-workflow-workspace.ts --discover
bun scripts/eval-workflow-workspace.ts --repair-delegation
bun scripts/eval-workflow-workspace.ts --research-notes
bun scripts/eval-workflow-workspace.ts --repair-source
WORKFLOW_EVAL_MODEL=glm-5 bun scripts/eval-workflow-workspace.ts --no-change
```

These trials use real model calls and consume account usage. Recording data and persistence are fictional and isolated on a temporary loopback server. They do not modify the user's catalog. The script stops the child after 180 seconds and writes private trajectory/result artifacts to a temporary directory.

The withheld outcome checks distinguish directly observed actions from assistant completion claims and menu labels, accept work actually performed inside a chat, preserve source identity, exercise stale-write recovery, and check greetings are not treated as corrections. A successful process exit alone is not a pass. Private trials also check verified confidential transport.

These are sampled agent trials, not exhaustive quality guarantees. The mock persistence server does not substitute for native route/storage tests. A short Private trial passing does not establish reliability for a long real-history scan.

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
