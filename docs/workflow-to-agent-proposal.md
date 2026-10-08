<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Turn a workflow into an agent

<!-- doc-covers: packages/workflows-ui/src, apps/screenpipe-app-tauri/components/workflows, apps/screenpipe-app-tauri/lib/chat-utils.ts, crates/screenpipe-core/src/workflows, crates/screenpipe-core/src/agents/chat_control, crates/screenpipe-core/assets/extensions/local-chat-history.ts, crates/screenpipe-engine/src/chat_history.rs -->
<!-- doc-verified: f5c5ecc47 -->

Implemented in the local Workflows mode of the main Screenpipe app. Home and
Context retain their existing layout.

```text
Recordings + local_chat_history (Claude Code / Codex / Hermes)
  → Discover / Deepen save research through workflow_workspace
  → Review rereads originals and publishes canAutomate + agentPrompt
  → eligible workflow shows Turn into agent
  → Screenpipe / Claude / Codex receives the prompt and workflow identity
  → user reviews it and chooses a loop or schedule in the existing agent flow
```

## When the action appears

The background agents propose `canAutomate: true` when they can express a useful
repeatable task with explicit inputs and a checkable result. They put that task
in `agentPrompt`. Review makes the publication decision using the existing
workflow evidence. There is no fixed confidence threshold or foreground chat
requirement.

The catalog persists these two fields on the existing workflow. Old workflows
default to false. True requires a nonempty prompt of at most 12,000 characters;
invalid values fail publication. False clears the prompt. The UI also checks
both fields before showing the action. These fields do not enable a schedule.

The button uses a 16px Bot icon and a small chevron. Its menu contains only the
Screenpipe, Claude and Codex icons and names. Screenpipe opens the existing Home
chat with the prompt unsent. Claude and Codex use the existing deep-link handoff
and clipboard fallback. The prompt includes the saved workflow identity and
asks the selected agent to retrieve current steps, request missing inputs and
confirm the loop or schedule before enabling it.

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

Checked the main-app workspace switcher, eligibility, provider icons, Escape
focus restoration and Screenpipe's unsent prompt. Claude/Codex handoffs are
covered with mocked host adapters; installed external apps were not launched.
No installed application was replaced and no production miner run is claimed.

Focused checks:

- Core workflow validation: 46 tests, including native source verification and
  persistence of a prompt longer than the generic 400-character text normalizer.
- Native history: 4 tests, including a match beyond the first search page,
  original Codex messages, Hermes pagination and invalid source addresses.
- Main-app UI/navigation: 33 tests across the integrated screen, dropdown and
  chat utilities.
- Extension capability tests: 3 tests covering scoped auth, pagination,
  missing capability and blocked remote targets.
- Queued native test: shared extension registration in every Pi harness.
- Main-app TypeScript check.

The broader core suite also exposes two unchanged skill-content assertions:
`bundled_read_skills_keep_the_live_database_behind_screenpipe` and
`workflow_maintenance_skill_installs_in_chat_and_restricted_pipes`.

Prompt evaluation covers a repeatable native-chat task, preserving an existing
workflow and a correct non-automatable/no-change case through deterministic
checks and manual review. No matched model replay or production outcome study
has been run. Existing task cadence and enabled states are preserved.
