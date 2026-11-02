<!-- doc-covers: apps/screenpipe-app-tauri/lib/workflows/usage.ts, packages/workflows-ui/src/use-workflow-usage.ts -->
<!-- doc-verified: 2fcbdb6e3 -->

# Local Workflows usage events

The desktop host supplies explicit events to the shared Workflows UI. The
`ph-no-capture ph-mask` boundary remains in place. Cloud Workflows does not use
this adapter. Existing PostHog consent and identity settings still apply.

All events have `schema_version: 1`, `surface: desktop_workflows`, and
`workflow_source: device`. The adapter passes only enumerated properties and
sanitizes the current URL/path/referrer. It never passes workflow titles, IDs,
steps, prompts, screenshots, job IDs, file paths, or error messages. Existing
SDK identity and app-version properties remain available. Web previews emit no
events through this adapter.

| Event | Meaning |
| --- | --- |
| `workflow_opened` | The Workflows tab becomes active and the document is visible. Returning after hiding the document counts as another visit. Rerenders and StrictMode effect replay do not. |
| `workflow_detail_viewed` | A selected workflow is visible, including returning to that detail after leaving the tab. No workflow identifier is sent. |
| `workflow_analysis_requested` | A manual analysis request is submitted through the local UI. Repeated requests can reuse an existing job; this counts requests, not distinct executions. |
| `workflow_analysis_completed` | A requested analysis cycle reaches complete and its result is loaded. Duplicate polls are ignored. |
| `workflow_analysis_failed` | The request rejects or its tracked cycle reports failed. A transient polling error does not count as failure. |
| `workflow_analysis_incomplete` | The tracked cycle reports incomplete. |
| `workflow_output_saved` | An SOP or skill save resolves successfully. `output` is `sop` or `skill`. Repeated edits/saves count again. |
| `workflow_agent_handoff_requested` | The user selects an agent. `runner` is `screenpipe`, `claude`, `codex`, or `cursor`. |
| `workflow_agent_handoff_result` | Handoff reports `prefilled`, `copied`, or `failed`, with the same runner. A prefilled prompt has not necessarily been sent or executed. |

## Retention interpretation

Filter by the surface, source, schema, and a release containing these events.
Count distinct people on distinct days for usage retention, rather than raw
event volume. Define whether return means another visit, analysis, save, or
handoff; keep those cohorts separate. D7 needs a fully elapsed return window.
These events cannot backfill historical workflow usage or establish paid
subscription retention, customer acceptance, or successful external execution.

Analysis correlation is bounded, in-memory, and keyed by the local cycle across
its agent jobs. Historical and scheduled jobs are ignored. Restarting the app
loses pending correlation, so a missing terminal event is unknown, not failure.
No individual workflow retention is available because workflow IDs are omitted.
