<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Turn discovered workflows into agents

<!-- doc-covers: packages/workflows-ui/src, apps/screenpipe-app-tauri/components/workflows/integrated-workflows.tsx, apps/screenpipe-app-tauri/components/chat/home-card-agent-actions.tsx -->
<!-- doc-verified: 6bb353a863b1d805cc6752fb3f0e1f95a62bec00 -->

**Architecture proposal, October 7, 2026. No runtime implementation.** Background
workflow miners should discover work across recordings and supported local agent
transcripts, then persist an automation proposal on the workflow. The workflow
shows **Turn into agent** when that proposal is ready. A foreground chat or a new
answer is not required.

Home, Context, Library and navigation retain their existing layouts. The compact
Screenpipe / Claude / Codex picker belongs to the selected workflow's existing
actions. Updated visual mockups remain pending; the chat-only mockups below are
superseded and must not be used as implementation acceptance evidence.

## What exists in the inspected source

| Capability | Current implementation | Gap for this feature |
| --- | --- | --- |
| Background workflow mining | Discover, Deepen, Review and Maintain run as scheduled Pipes. Discover requests hourly coverage. Their prompts and allowed APIs research recorder activity, parsed screen history and meetings. | Native transcript coverage is not configured in these agents. Reading a captured Codex window is not reading its native chat history. |
| Workflow writes | `workflow_workspace` exposes context, propose, handoff and publish, with role restrictions, revisions and durable receipts. Review publishes to the catalog. | There is no supported automation-proposal field that drives this picker through the workflow model and UI. |
| Local Claude Code and Codex import | `external-chat-sync.ts` watches `~/.claude/projects` and `~/.codex/sessions`. The desktop chat sidebar starts it. Imports are stored in the Screenpipe chat store. Reconciliation is bounded to seven days and 100 candidates per source. | A UI-mounted importer is not a recorder-independent background mining service or complete historical coverage. |
| Native chat search | `chat-control.ts` provides `search_chats`; core `chat_control.rs` searches Screenpipe, Codex, Claude, Cursor and Gemini CLI chats. | Scheduled Pipe setup does not install this chat-control extension. Search results are bounded previews, not a full evidence-read contract. |
| Background chat leads | The separate skill-learning Pipe can call `/agent/learning/chats`, reusing native discovery for up to five recent, inactive chat results from the last day. | Workflow miners do not allow this route. This lead-only endpoint is insufficient for complete workflow evidence. |
| Hermes | Neither inspected native chat source enum nor the external importer includes Hermes. | A Hermes transcript adapter and fixtures are required. Installing a skill in `.hermes/skills` does not provide chat ingestion. |

Source anchors:

- [Discover prompt and permissions](../crates/screenpipe-core/assets/pipes/workflow-discover/pipe.md)
- [Workflow write tool](../crates/screenpipe-core/assets/extensions/workflow-workspace.ts)
- [Scheduled Pipe tool setup](../crates/screenpipe-core/src/pipes/mod.rs)
- [Native chat search](../crates/screenpipe-core/src/agents/chat_control.rs)
- [External chat synchronization](../apps/screenpipe-app-tauri/lib/chat/external-chat-sync.ts)
- [External chat import bounds](../apps/screenpipe-app-tauri/lib/chat/external-chat-import.ts)
- [Skill-learning chat endpoint](../crates/screenpipe-engine/src/agent_skills.rs)
- [Workflow model](../packages/workflows-ui/src/model.ts)
- [Publication and recorder evidence verification](../crates/screenpipe-engine/src/routes/workflow_catalog.rs)

These are repository findings at the verified commit, not an audit of enabled
agents or successful runs on an installed app. Claude here means supported local
Claude Code transcripts; arbitrary Claude web conversations are not covered by
that reader.

## Proposed background flow

```text
Supported local transcripts + Screenpipe activity
  → shared incremental retrieval with stable source references
  → Discover / Deepen investigate jobs and automation opportunities
  → Review verifies evidence and publishes through workflow_workspace
  → saved workflow includes its automation proposal
  → workflow UI renders Turn into agent
  → user clicks → Screenpipe / Claude / Codex → existing setup / handoff
```

Reuse the native parsers behind a shared, read-only search and evidence-read
surface available to scheduled Pipes. It must work without the chat sidebar
being open. Track source-specific cursors, changed messages, duplicate imported
copies and unavailable sources. Return original message references and coverage
gaps, not only generated summaries. Digital clone and other Pipes can use the
same authorized retrieval surface; digital clone synthesis is optional context,
not the only route to original transcripts.

Extend the existing workflow publication contract rather than adding a separate
UI-only suggestion store. A proposed `agentProposal` field would contain status,
reason, referenced evidence, executable scope, instructions, required inputs,
expected output, unresolved prerequisites and an optional suggested trigger.
The field name and exact schema remain proposed. Preserve workflow identity,
user corrections and dismissal state across subsequent mining runs.

Discover or Deepen can propose the automation while researching the workflow.
Review verifies the cited original messages and publishes a ready proposal when
it can explain a useful task an agent can perform, its inputs and expected
output. A partial workflow can offer automation of only its supported portion.
Missing prerequisites remain explicit. A fixed number of recurrences or a
completed foreground answer is not the button's trigger. The trigger is the
published proposal state. A useful workflow without a ready proposal remains
visible with its normal controls.

Native chat evidence must also be supported by publication validation and
catalog round trips. The current verifier resolves recorder evidence; merely
putting a transcript quotation into a draft is not a complete implementation.
Keep user requests, assistant claims, tool receipts and observed results distinct.

The UI reads the persisted proposal; it does not run mining on render. Selecting
**Turn into agent** opens the provider picker with existing icons. Show a short
reason and the proposed scope in the existing workflow detail. Provider readiness
is resolved by the actual provider adapter. Creation or scheduling continues
through existing controls with the instructions prefilled. An opened provider
is not proof of a created agent or active schedule.

## Implementation acceptance

- A scheduled run discovers a workflow from a supported native transcript that
  was never visible in a recording and while the chat sidebar is closed.
- Review reads original messages and persists the proposal through
  `workflow_workspace`; it survives catalog normalization and an app restart.
- The workflow action appears from the saved ready proposal with no foreground
  chat turn. A pending, dismissed or already-created proposal has the appropriate
  state, without duplicate creation on retries.
- Source cursors and deduplication survive retries. Missing or unsupported
  sources are reported as gaps, not successful empty scans. Hermes is reported
  unsupported until its reader is implemented and verified.
- A second authorized Pipe can retrieve the same source references without
  rescanning all transcripts or depending on a digital-clone summary.
- The picker reuses provider icons and controls. Verify keyboard behavior and
  truthful handoff states; suggestions alone do not activate schedules.
- Preserve existing Home and Context. Capture the implemented workflow states
  before claiming visual or runtime completion. Reuse existing scoped checks;
  this proposal does not add CI jobs.

## Visual status

[Figma working file](https://www.figma.com/design/kQbZmiUwApaPTaKjPXuhzy).
All existing captures use fictional data in a browser preview, not live results.
Home and Context are retained as fidelity references:

![Existing Home reference](pr-assets/workflow-to-agent/01-home-unchanged.png)

![Existing Context reference](pr-assets/workflow-to-agent/05-context-unchanged.png)

The following assets document the superseded chat-only exploration. They do not
represent the proposed background-miner interaction:

- [Existing fictional chat baseline](pr-assets/workflow-to-agent/02-chat-before.png)
- [Superseded chat offer](pr-assets/workflow-to-agent/03-contextual-offer.png)
- [Superseded chat picker](pr-assets/workflow-to-agent/04-choose-runner.png)
