<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Native AI chat mining

<!-- doc-covers: packages/workflows-ui/src, apps/screenpipe-app-tauri/components/workflows, apps/screenpipe-app-tauri/lib/chat-utils.ts, crates/screenpipe-core/src/workflows, crates/screenpipe-core/src/agents/chat_control, crates/screenpipe-core/assets/extensions/local-chat-history.ts, crates/screenpipe-core/assets/pipes, crates/screenpipe-core/src/pipes/builtin_migrations.rs, crates/screenpipe-engine/src/chat_history.rs -->
<!-- doc-verified: e0574226b -->

Local Workflows agents research native Claude Code, Codex and Hermes messages
alongside screen recordings. The digital clone receives the same research route
when it runs as a Screenpipe Pipe. No digital clone is required for Workflows.

## Shared research tool

`local_chat_history` is installed into normal Pi chat, Pi ACP and scheduled
Pipes. It exposes two read operations through the authenticated recorder:

- `GET /agent/chat-history/search`: source, optional query, offset and limit.
- `GET /agent/chat-history/read`: source, exact chat id, offset and limit.

| Source | Storage | Reader |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Paged original user/assistant messages |
| Codex | `~/.codex/sessions/**/*.jsonl` | Paged original rollout messages |
| Hermes | `$HERMES_HOME/state.db`, default `~/.hermes/state.db` | Read-only SQLite session/message queries |

Claude Desktop's native conversations are not covered by this reader. Its
visible activity may still appear in screen recordings. Choosing Cursor as a
handoff destination does not add a native Cursor history reader.

Search and read return `next_offset`; empty pages may still have more data.
Claude/Codex search is bounded to the 1,000 most recent discoverable files and
5,000 lines / 60,000 characters per searched file. Those limits are reported.
Known transcripts can be read beyond the search-text limit. Original role,
timestamp and stable source address remain attached to each returned message.
Tool payloads are not exposed as conversation prose. Assistant claims remain
claims, not evidence that an external action succeeded.

## Workflow agents

Discover, Deepen, Review and Maintain explicitly search available native sources,
read original messages, track coverage gaps and deduplicate recorded/native
views of the same conversation. They use the existing `workflow_workspace`
publication path. Review still validates the workflow itself; there is no
separate automation eligibility decision or generated automation prompt.

Publication rereads each cited native message through the authenticated API and
checks the exact source address and quoted text. Missing, mismatched or
incomplete messages fail validation. Native-only evidence does not acquire
invented screenshots or recording replay buttons.

Recognized older installed miner templates receive the native research
instructions and two read-only endpoint grants. Customized prompt bodies,
owner deny rules, enabled state and custom schedules remain preserved. An owner
who removes a grant after upgrading does not have it silently restored later.
The existing Workflows controls determine whether these agents run.

## Digital clone

The digital clone is store-installed rather than bundled in this repository.
The shared extension adds research instructions at `before_agent_start` only
when `SCREENPIPE_PIPE_NAME` is `digital-clone`. It preserves the task's existing
prompt, memory workflow, source exclusions and schedule. It instructs the clone
to search permitted native sources, read relevant originals, retain provenance,
and save compact useful context instead of raw chat dumps or secrets.

All scheduled callers use their own scoped Pipe token. An absent capability,
permission denial, missing provider or unread page is a coverage gap. Native
reads remain blocked by incompatible recorder data/privacy filters. This does
not expand the reader preset or bypass a restricted clone configuration. An
unrestricted clone can use its existing scope; a restricted clone needs the
explicit endpoint grants. The feature does not install or enable a clone.

Other Pipes and ordinary chat can use the shared tool, but they do not receive
an unsolicited instruction to mine the user's history.

## Existing workflow handoff

Every workflow offers **Open in agent**, with Codex first, then Claude, Cursor
and Screenpipe. This is the existing generic instruction to read the saved
workflow's current steps and sources and help carry it out. No `canAutomate`
flag or saved `agentPrompt` is required or generated. No recurring loop is
created by opening the menu or choosing a destination.

External destinations use the same deep links and clipboard fallback as the
main cards. Screenpipe opens Chat with an unsent prompt. Home and Context retain
their existing layout. Earlier Turn into agent screenshots and the narrated
v1 recording describe a superseded design.

## Verification and limits

Focused checks exercise the native readers, original-message provenance,
workflow publication, installed-template migration, scoped extension calls,
digital-clone prompt injection, denied access and ordinary workflow handoffs.
Browser captures show real main-app components with fictional data. External
app launches and a live model-driven mining run remain unverified. No installed
app or production agent schedule was changed.
