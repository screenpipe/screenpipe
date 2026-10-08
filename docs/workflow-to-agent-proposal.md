<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Turn a workflow into an agent

<!-- doc-covers: packages/workflows-ui/src, apps/screenpipe-app-tauri/components/workflows, apps/screenpipe-app-tauri/lib/chat-utils.ts, crates/screenpipe-core/src/workflows, crates/screenpipe-core/src/agents/chat_control, crates/screenpipe-core/assets/extensions/local-chat-history.ts, crates/screenpipe-engine/src/chat_history.rs -->
<!-- doc-verified: ec487aff8 -->

Implemented in the local Workflows mode of the main Screenpipe app. Home and
Context retain their existing layout.

```text
Recordings + local_chat_history (Claude Code / Codex / Hermes)
  → Discover / Deepen save research through workflow_workspace
  → Review rereads originals and publishes canAutomate + agentPrompt
  → eligible workflow shows Turn into agent
  → Codex / Claude / Screenpipe receives the prompt and workflow identity
  → user reviews it and chooses a loop or schedule in the existing agent flow
```

## When the action appears

The background agents offer automation only when original evidence supports a
working execution path for a useful repeatable task: its executor/environment,
required tools, access scopes, available inputs and checkable result. A request
inside Codex or an assistant completion claim does not prove credentials or
successful execution. Success in Codex is evidence for that environment, not
for Claude or Screenpipe. Read access does not establish write permission.

Review checks the latest relevant evidence for unresolved authentication errors,
missing connectors, revoked permissions and required manual login/OTP. Required
access that is unknown or blocked keeps `canAutomate` false; the workflow stays
saved with its specific limitation. A later access failure invalidates an older
success. A supported draft-only job may qualify within that exact scope.

The saved `agentPrompt` names the evidenced executor, access requirements,
working-path source references, inputs, output and checks, without secrets.
Every handoff instructs the chosen agent to recheck current access using
non-destructive checks in its own environment before proposing or enabling a
loop. Missing or unverifiable access must stop setup. These are instructions to
the review and execution agents, not a deterministic credential test or a
production guarantee; no live credential trial is performed by the miner.

The catalog persists these two fields on the existing workflow. Old workflows
default to false. True requires a nonempty prompt of at most 12,000 characters;
invalid values fail publication. False clears the prompt. The UI also checks
both fields before showing the action. These fields do not enable a schedule.

The button uses a 16px Bot icon and a small chevron. Its menu contains only the
Codex, Claude and Screenpipe icons and names, in that order. Screenpipe opens the existing Home
chat with the prompt unsent. Claude and Codex use the existing deep-link handoff
and clipboard fallback. The prompt includes the saved workflow identity and
asks the selected agent to retrieve current steps, request missing inputs and
confirm the loop or schedule before enabling it.

## Which agents run this

Workflows installs four bundled, initially disabled background tasks through
`ensureWorkflowTask`: Discover, Deepen, Review and Maintain. The user's existing
Workflows processing controls enable or run them using Screenpipe's Pi harness,
selected model/provider and existing access/allowance checks. Discover and
Deepen investigate jobs, Review publishes supported workflows, and Maintain
revisits existing workflows and corrections. They do not require a digital clone.

The digital clone is a separate optional task. Like another Pipe, it can reuse
the shared history tool only with the required endpoint grants; this feature
does not silently install or enable it. The Codex/Claude menu choice selects the
agent that will help execute the workflow, not the background mining agent.

Recognized installed miner templates receive the updated instructions and two
read-only history grants. User-written prompt bodies, existing deny rules,
custom schedules and enabled state are preserved.

## Native chat research

`local_chat_history` is installed into normal Pi chat, Pi ACP and scheduled
Pipes. It exposes two read operations through the authenticated recorder:

- `GET /agent/chat-history/search`: source, optional query, offset and limit.
- `GET /agent/chat-history/read`: source, exact chat id, offset and limit.

The four workflow miners explicitly permit both endpoints and are instructed
to use the tool alongside recordings. Other Pipes can use the same tool with
these endpoint grants. The default reader preset is not broadened. Native
history is rejected for Pipes with recorder data filters or privacy filtering,
since those filters cannot safely be applied to native transcript metadata.

| Source | Storage | Reader |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Existing summary parser plus paged original user/assistant messages |
| Codex | `~/.codex/sessions/**/*.jsonl` | Existing rollout parser plus paged original response messages |
| Hermes | `$HERMES_HOME/state.db`, default `~/.hermes/state.db` | Read-only SQLite session/message queries |

The tool works without the chat sidebar. It does not start an external agent,
send a message or create another background indexing job. Search and read pages
return `next_offset`; an empty page can still have more data. Claude/Codex
search is bounded to the 1,000 most recent discoverable files and the first
5,000 lines / 60,000 characters of each searched transcript. Those limits are
reported. Reading a known transcript pages its original records beyond the
search-text limit. Missing providers and unread pages remain coverage gaps.

Each returned message has its role, original timestamp, app and a source address
such as `chat:codex:session-id:52`. Publication rereads that exact message through
the same authenticated API. It rejects missing, mismatched or incomplete
messages. Procedure quotes must match the original text and native source
address. Native messages do not acquire invented recording frames or replay
buttons. Assistant claims alone do not establish an external action succeeded.

## Verification

The screenshots in `docs/pr-assets/workflow-to-agent/06-*.jpg` through
`12-*.jpg` show the real main-app components with fictional browser-mock data.
The before capture uses the prior toolbar implementation at `6cb816c`; the after
captures use implementation `1d11a1845`, at the same 1280 × 720 viewport.
`13-codex-first-menu.jpg` supersedes the earlier menu capture with Codex first.

Checked the main-app workspace switcher, eligibility, provider icons, Escape
focus restoration and Screenpipe's unsent prompt. Claude/Codex handoffs are
covered with mocked host adapters; installed external apps were not launched.
No installed application was replaced and no production miner run is claimed.

Focused checks:

- Core workflow validation: 46 tests, including native source verification and
  persistence of a prompt longer than the generic 400-character text normalizer.
- Native history: 4 tests, including a match beyond the first search page,
  original Codex messages, Hermes pagination and invalid source addresses.
- Main-app UI/navigation and workflow setup: 72 tests across the integrated
  screen, dropdown, chat utilities and scheduled-discovery controls.
- Built-in prompt migrations: 30 tests, including history grants, preservation
  of custom instructions/configuration and owner permission removal.
- Extension capability tests: 3 tests covering scoped auth, pagination,
  missing capability and blocked remote targets.
- Queued native test: shared extension registration in every Pi harness.
- Main-app TypeScript check.

The broader core suite also exposes two unchanged skill-content assertions:
`bundled_read_skills_keep_the_live_database_behind_screenpipe` and
`workflow_maintenance_skill_installs_in_chat_and_restricted_pipes`.

Readiness evaluation manually covers verified Codex execution, a chat-only
request, expired access, a runner change, interactive OTP and a supported
draft-only scope. UI tests check Codex-first order and delivery of the access
preflight instructions to all three runners; migration tests check existing
templates receive the instructions and endpoint grants without losing user
configuration. No matched model replay or production outcome study
has been run. Existing task cadence and enabled states are preserved.
