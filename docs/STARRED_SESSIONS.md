<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Starred work sessions

<!-- doc-covers: crates/screenpipe-engine/src/routes/starred.rs, crates/screenpipe-engine/src/routes/search.rs, crates/screenpipe-engine/src/routes/activity_summary.rs, packages/screenpipe-mcp/src, crates/screenpipe-db/src/db/starred.rs, crates/screenpipe-engine/src/cli/starred.rs, apps/screenpipe-app-tauri/components/starred-sessions -->
<!-- doc-verified: 5ccec2debee1a9d1e58739b328048a9a5d893be4 -->

A star marks a saved time interval. Capture settings, exclusions, pauses, history access, and retention still apply. The engine stores intervals in SQLite so desktop windows, API clients, CLI commands, and agents see the same boundaries.

## API

- `GET /starred-sessions?start_time=...&end_time=...&limit=10&offset=0` lists overlapping intervals, newest first. The limit is capped at 100. `id=UUID` retrieves one interval.
- `POST /starred-sessions` creates or edits `{id, start, end, hd_requested, revision}`. Use a UUID and RFC3339 timestamps. Revision 0 creates; edits use the last returned revision. Identical retries are idempotent. A stale revision or another active session returns 409.
- `GET /search?starred_only=true&start_time=...&end_time=...&limit=10` retrieves captured starred work directly. Intervals are merged before pagination to avoid duplicates. More than 100 disjoint intervals returns an actionable error to narrow the time range.
- `GET /search?starred_session_id=UUID&limit=10` intersects normal search filters with that session's `[start,end)` interval. Search hits include `starred: boolean`, including after cached searches are invalidated by an edit.

Responses include `has_audio: boolean`, indicating indexed audio chunks beginning in the interval. It does not enable capture or guarantee retained media files. Export includes whatever audio was captured automatically; there is no separate audio checkbox.

Only one session may be active. Intervals start in the past, span at most 24 hours, and end no more than two hours ahead. Timed sessions expire without a frontend timer. Users may edit historical boundaries or end an active interval early. Restricted agent readers cannot retrieve global session metadata; writes require an owner request. Existing history access also applies.

## Desktop and CLI

The timeline lists recent starred intervals and seeks to their start when selected. Session controls offer 5, 15, 30, and 60 minutes, early ending, extension, optional HD, editable start/end times, chat context, and export. The configurable shortcut defaults to Control+Command+B on macOS and Alt+Shift+B on Windows. The macOS overlay also has a timed menu; the webview overlay scales its session panel with the widget setting.

`screenpipe star list --limit 10`, `star start --minutes 15 [--hd]`, `star end`, and `star edit UUID --start TIME --end TIME` use the running engine. They honor the configured local API URL/key and return JSON.

HD uses a separate bounded lease. Ending a star leaves an unrelated meeting/timer lease intact. An explicit HD stop clears both leases. HD capture is ephemeral and does not automatically resume after an engine restart; `hd_requested` records the user's selection, not proof of actual HD frames.

## Agents

The existing MCP `search-content` tool accepts `starred_only=true`; no dedicated starred-session tool is added. `activity-summary` includes at most ten recent `starred_sessions` and `starred_sessions_has_more`, including sessions without captured content. Narrow the review window to inspect more metadata; starred-only search independently covers the whole requested window. Set `include_starred=false` to omit this context. Session metadata is omitted for app/data-restricted summary reads and intervals spanning inaccessible history.

The bundled ACP SQL tool describes the starred interval table and EXISTS predicate; HTTP activity-summary includes the same bounded metadata. Workflow activity classification uses the existing summary response to prioritize evidence. Skills describe direct retrieval and keep interval history out of standing prompts. A star alone does not establish task completion, repeated behavior, or time savings.
