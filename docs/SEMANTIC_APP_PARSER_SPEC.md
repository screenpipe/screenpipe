# Semantic App Parser

> **Status**: Experimental end-to-end path, opt-in and off by default
> **Date**: 2026-07-27

## 1. Problem

Screenpipe captures timestamped screenshots, consolidated accessibility/OCR text,
structured elements, and UI events. AI retrieval is already compact, but it is
app-agnostic. A model repeatedly reconstructs relationships such as sender to
message, thread to subject, document to editor, and task to status from generic
text and UI nodes.

App-aware deterministic parsers can produce better context with fewer irrelevant
tokens. They must not increase capture latency, create a second observer, run an
LLM per frame, or persist a duplicate raw tree.

## 2. Source order

Use the strongest available source and retain the weaker sources as evidence:

1. Explicitly enabled native structured source
2. App-specific semantic parser over accessibility
3. Generic accessibility text and element outline
4. OCR fallback
5. A few frame images when pixels materially matter

A parser may return `NotHandled`. Generic accessibility retrieval remains the
fallback, so an app redesign degrades quality instead of losing context.

For a matched app, parser order is:

1. an app or version-specific override, only when needed
2. a shared UI-family parser with declarative app profiles
3. the existing generic accessibility projection outside this crate

`NotHandled` or a parser failure advances to the next candidate. `Empty` stops
the chain because it means the parser recognized a genuinely empty screen.

## 3. Foundation in this change

`screenpipe-semantic` defines:

- stable cross-platform `AppIdentity`
- parser manifests and precompiled app/URL selection
- ordered app-override and shared-family parser candidates
- merged capture requirements across fallback candidates
- fail-open parser execution with failure details for telemetry
- parser-declared accessibility attribute and offscreen requirements
- a compact immutable tree with integer links and interned strings
- a deterministic Rust parser trait
- typed conversation, message, document, task, calendar, and page items
- stable input fingerprints that include parser/schema/app/content versions
- output validation for size, item count, parents, cycles, and source-node links

The database integration adds normalized semantic runs and canonical items,
frame linkage, full-text search, compact retrieval, and retention garbage
collection. When `enableSemanticContext` is true, capture submits a durable
frame and its existing accessibility snapshot to a bounded background worker.
The setting defaults to false, so existing installs start no parser worker and
keep the historical capture path.

## 3.1 Parser coverage model

Screenpipe does not need a custom semantic parser for every installed app.
Every app keeps the current generic accessibility and OCR path. A parser is an
optional quality upgrade for screens where sender, thread, document, task, or
event relationships matter.

Prefer shared family implementations with small declarative profiles:

| Family | Shared extraction | Profile-specific details |
|---|---|---|
| Conversation | channel, sender, message, time, draft | message-list anchor, chrome exclusions, sender marker |
| Mail | subject, participants, body, thread order, draft | thread root, collapsed-message rules, compose labels |
| Editor | file, buffer, terminal, project | workbench marker, editor and terminal containers |
| Task | title, project, status, due date, assignee | board/list anchors and field labels |
| Calendar | event, time range, attendees, location | day/week view structure and event container |
| Page/document | title, author, body, selection | article/editor root and navigation exclusions |
| Terminal | command and output transcript | terminal root and prompt markers |

A family parser manifest can match multiple bundle identifiers, executables,
and URL patterns. Native and web versions may still need separate adapters when
their accessibility trees differ, but they should share extraction and output
code. App-only logic should be limited to selectors, stable labels, and known
quirks rather than duplicating the whole parser.

The family parser selects its profile from `ParseContext.app`, so a profile does
not require another runtime or another tree copy. Register an `App` parser only
when an app needs an algorithmic override that cannot fit the shared family.

Only matching candidates run. The registry caps a tree at four candidates; the
normal case is one family parser, or one app override plus one family parser.
This bounds failure-path CPU even if the registry eventually contains hundreds
of app definitions.

### Built-in catalog and reference family parsers

The built-in catalog covers 49 app targets using public app identities, URL
patterns, and stable accessibility contracts. Implementations remain
Screenpipe-owned parser families and exact app overrides.

| Family | Built-in profiles |
|---|---|
| Conversation | Antigravity, Antigravity IDE, ChatGPT, ChatGPT legacy, ChatGPT web, Claude, Claude macOS, ClickUp, ClickUp web, Codex, Cursor, Discord, Gemini desktop, Gemini web, Messages, Messenger, Microsoft Teams, Slack, WhatsApp, WhatsApp web, Windsurf |
| Mail | Gmail, Mail, Microsoft Outlook, Spark Desktop, Spark Mail Classic, Superhuman |
| Editor | Antigravity IDE, Cursor, VS Code, Windsurf, Xcode |
| Document | Antigravity IDE, Claude macOS, ClickUp, ClickUp web, Microsoft Outlook, Microsoft Word, Microsoft Word web, Notes, Notion, Obsidian, Pages, TextEdit, Xcode |
| Task | Antigravity, Asana, Asana web, ClickUp, ClickUp web, Microsoft To Do, OmniFocus, Todoist, Toggl |
| Calendar | Calendar, Fantastical |
| Terminal | Ghostty, iTerm2, Terminal, Warp, Windows Terminal |

Profiles may belong to more than one family because the same app can expose
different semantic surfaces. The registry still runs at most four matching
candidates for one tree.

`EditorFamilyParser` recognizes macOS AX, Windows UIA, and Linux AT-SPI role
aliases, then emits editor buffers and integrated terminal content as `Document`
items. `FamilyParser` supplies conservative conversation, mail, document, task,
calendar, and terminal implementations. Each implementation requires structural
markers before it emits output. App identity by itself always returns
`NotHandled`.

The current registry has 23 implementations: seven shared family parsers,
exact ChatGPT, Claude, and Obsidian overrides, and 13 native macOS overrides for
Calendar, Discord, Gemini, Mail, Messages, Microsoft To Do, Microsoft Word,
Notes, OmniFocus, Pages, Slack, TextEdit, and WhatsApp. The overrides use exact
AX roles, subroles, stable identifiers, or bounded DOM-class contracts and
safely abstain when their recognition contract is absent.

The parsers abstain on unrecognized surfaces and inaccessible editor buffers.
This preserves generic accessibility instead of emitting an empty or misleading
semantic result. Synthetic, privacy-safe fixtures cover every family, and the
editor fixtures cover all three platforms. They are contract fixtures, not proof
that every supported app version exposes the expected accessibility contract.

### Real-capture replay checkpoint

`CapturedAccessibilityNode` and `adapt_captured_accessibility_tree` can now
replay Screenpipe's existing `accessibility_tree_json` through the compact
arena without committing private capture data. The `replay` example reports
only node and attribute counts, parser selection, output size, heap estimates,
and timings. It never prints semantic content.

A read-only 90-day replay over a bounded, app-stratified sample of 1,668 local
frames on 2026-07-25 confirmed the intended fail-open behavior:

- 441 frames matched a parser identity and 217 were handled, or 49.21% of
  identity matches.
- Handled frames used 94.97% fewer context tokens than their raw tree JSON.
- Compact-tree construction measured 18 microseconds p50 and 203 microseconds
  p95 per frame. The parser chain measured 1 microsecond p50 and 74
  microseconds p95.
- Maximum compact-tree heap was 180,251 bytes and there were zero parser
  failures.
Per-app identities and sample counts from the local replay are intentionally not
committed because they are user-activity metadata. Historical frames still lack
many parser-only structural containers and DOM identifiers that the opt-in
walker now keeps transiently, so fresh opt-in captures remain necessary for
those contracts. Exact overrides fail open to shared families or generic
capture. Raw frames and extracted text remain local and are not test fixtures.

### Pipe-output evaluation checkpoint

A separate side-effect-free suite replays the read and analysis contracts of
four installed pipes: prompt extraction, repeated-workflow discovery, ordered
SOP generation, and activity classification. It compares raw accessibility
JSON, Screenpipe's current element outline, and semantic context against the
same sanitized ground truth. The model scorer requires valid JSON, the requested
top-level output fields, required facts, no forbidden contamination, and correct
observed step order.

The deterministic suite retained all 13 required facts in semantic context and
used 651 complete prompt tokens, versus 1,427 for raw JSON and 885 for the
current outline. That is 54.38% fewer prompt tokens than raw JSON and 26.44%
fewer than the outline. The current outline lost one exact activity fact. Model
inference is opt-in, local, counterbalanced across formats, and reported
separately because small-model output is stochastic. Exact commands and results
live under `crates/screenpipe-semantic/evals/pipes/`.

The first model pass also exposed ambiguity in positional compact fields. The
renderer now emits explicit `title=`, `actor=`, and `body=` labels, and renders
the stored neutral `[user]` marker as `actor=user` without changing persistence.

## 4. Capture integration

The parser registry returns a `SemanticCapturePlan` before an accessibility walk.
The plan combines every matching fallback candidate's `AttributeSet` with
engine-owned `TreeBudget` and `OutputBudget` hard caps. This prevents an app
override from abstaining after capture omitted an attribute needed by its
family fallback. Parser packs may request less data, but they cannot raise the
engine's resource ceilings.

Semantic memory is visible-first: a node explicitly marked off-screen keeps its
role, hierarchy, identifiers, classes, state, and bounds, but its text, value,
and description are not copied into the compact tree. Unknown visibility stays
fail-open. This preserves parser structure without turning scrollback or hidden
overflow into durable memory. Raw accessibility storage and automation
targeting remain separate compatibility surfaces.

The macOS walker retains a bounded set of parser-relevant structural nodes while
it performs the existing walk. Identifier and subrole extend the existing
batched AX request, so semantic capture still performs one primary IPC round
trip per visited node. DOM identifier and class list join that same request only
for browser and Electron apps that can expose them.

`TreeSnapshot` now carries a native bundle identifier or executable alongside
the display name so parser selection does not depend on localized app names.
The current text-oriented node list can also be adapted for offline replay.

The existing text-oriented `TreeSnapshot.nodes` and database element behavior
remain unchanged in this experimental rollout. Parser-only containers live in a
transient `TreeSnapshot.semantic_nodes` sidecar, are merged back into original
walk order only in the semantic worker, and are skipped by serialization. This
preserves the existing raw tree JSON and avoids duplicating structural capture
on disk. Conservative parsers still abstain when an app version does not expose
enough structure.

### Capture-purpose profiles

`semanticContextMode` selects a projection over the same accessibility walk:

| Mode | Capture and processing behavior | Default agent view |
|---|---|---|
| `memory` | Keep parser-requested structure transient and run the semantic worker | compact readable outline |
| `computerUse` (shown as `automation`) | Persist only action controls and bounded landmarks in the existing raw tree; do not start the semantic parser worker | automation targeting view |
| `both` (shown as `memory + automation`) | Persist the action subset and pass the union to the semantic worker without storing a second tree | compact readable outline, with explicit automation requests available |

The master `enableSemanticContext` switch remains off by default. Missing mode
values deserialize as `memory`, preserving the behavior of earlier opt-in
installs. The automation subset keeps interactive controls plus a small set
of navigation and window landmarks, rather than every group, row, or cell.
macOS, Windows, and Linux also retain unnamed actionable controls that the
memory projection would omit. All three platforms reuse the existing bounded
accessibility walk. Windows makes no additional platform query; Linux only
fetches state for an otherwise unnamed action control while the opt-in mode is
active.

The two identifier layers intentionally have different lifetimes:

- `ref=eN` is a response-local target label. An agent must request a fresh
  snapshot before every action and must not reuse a ref from an older response.
- `key=k_*` is a best-effort recognition key derived from an automation-ID
  ancestry when available, otherwise from bounded role/name ancestry.
  `key_quality` is `strong`, `derived`, or `ambiguous`.

Database row IDs are never exposed as live UI handles. A key helps the agent
recognize the same logical control after a refresh, but it does not authorize an
action. The agent must verify revision, key, role, name, state, and bounds in the
latest snapshot. Ambiguous keys require another query or visual fallback.
This change provides targeting context, not a native desktop action executor.
A downstream automation tool must resolve the latest target or coordinates;
Screenpipe does not accept these refs at a write endpoint.

## 5. Scheduling

Do not parse inside `paired_capture`, the frame transaction, or deferred element
insertion.

After `paired_capture` returns a durable `frame_id`, move the snapshot into a
bounded parser actor with a synchronous latest-value replacement. The capture
loop never awaits parser or database capacity.

Current actor policy:

- one pending job for the whole worker, replaced by the latest durable frame
- one worker task and no parser work when the feature is disabled
- no screenshots in jobs
- parser output capped at 64 KB and 256 items
- stale pending work is replaced instead of building a FIFO backlog
- parser or database failures fail open and leave generic capture available

A scripting runtime, if later added, still requires an 8 to 16 MB heap limit
and a 20 ms hard deadline.

The current database writer reuses an identical run after parsing. A future
pre-parse shortcut may use an existing element reference only if parser version,
app identity, and the structural fingerprint are all proven identical.

## 6. Parser runtime

The crate initially exposes a Rust trait. Built-in Rust parsers are the lowest-risk
way to benchmark the contract.

For rapid parser updates across many apps, evaluate one shared sandboxed QuickJS
runtime later. Parser code must receive opaque `NodeId` handles and Rust host
selectors, not a copied JavaScript object tree. Disable filesystem, network,
process, clock, randomness, imports, and host mutation. Parser packs require
signatures, compatibility ranges, last-known-good rollback, and a kill switch.

The parser ABI and stored output must remain independent of the chosen runtime.

## 7. Storage

The normalized migration and transactional write/read adapter are implemented.
Opted-in capture calls the writer only after the source frame is durable and a
parser returns a validated handled projection. Current screenshot,
accessibility, element, and raw-text writes are unchanged, so this PR does not
reduce disk use by itself.

Today a stored accessibility frame can contain `accessibility_text`, a derived
`full_text`, `accessibility_tree_json`, and normalized `elements`. Exact content
dedup can skip an eligible capture, and `elements_ref_frame_id` can share an
anchor frame's normalized elements, but a stored frame can still repeat its text
and tree JSON. Semantic persistence must not add another per-frame JSON copy.

Do not store one parsed JSON blob per frame. Repeated screens would repeat every
message or document. The normalized persistence contract is:

- `semantic_runs`: parser/version/input fingerprint/status/duration
- `frames.semantic_run_id`: nullable frame to run link, reusing identical runs
- `semantic_items`: immutable, canonical, versioned typed records
- `semantic_run_items`: run membership, parent, order, and source node indexes
- external-content `semantic_items_fts`
- `semantic_actors`: durable, user/Pipe-correctable actor identities
- `semantic_actor_aliases`: source-scoped heuristic labels retained across cleanup
- `semantic_item_actors`: mutable identity assignments over immutable observations

Required keys and constraints:

- `semantic_runs.input_fingerprint` is unique. It includes parser ID,
  parser version, schema version, app identity, and source content hash.
- `frames.semantic_run_id` is nullable, so one frame resolves to at most one
  selected semantic projection while any number of identical frames may reuse a
  run.
- Every item has an `entity_fingerprint` and a `version_fingerprint`.
  `semantic_items.version_fingerprint` is unique and immutable.
- Stable and derived items may reuse the same exact canonical version across
  runs. Ephemeral items include the parse-run fingerprint in their entity key,
  so equal message text or position-based keys from different screens never
  merge.
- Only stable identity supports authoritative cross-run entity history. A
  derived entity key is an approximate grouping hint even when exact-value
  reuse is safe.
- Parent, order, parser-local ID, and source-node indexes live only in
  `semantic_run_items`. Moving an item within a screen must not duplicate its
  canonical value.
- A changed title, body, actor, time, status, or metadata value creates a new
  immutable item version while preserving the entity fingerprint.
- The parser's observed `semantic_items.actor` value is never edited. Initial
  identity assignment is an app/host-scoped label heuristic and deliberately
  excludes parser ID, so exact-parser fallback after UI drift does not split an
  actor. Plain display names and directional labels such as `[contact]` are
  additionally conversation-scoped; only exact email/E.164-shaped labels can
  reuse an alias across conversations. A plain label without conversation
  structure is isolated to its item rather than joined app-wide. Renames,
  merges, alias moves, and item-level corrections update only the actor mapping.
- Merging actors moves their aliases as well as existing assignments. Future
  observations therefore inherit the reconciliation instead of recreating the
  discarded provisional actor. Actor aliases intentionally survive source-frame
  retention; they are a small durable identity index, not another frame copy.
- Names are searchable but never implicit join keys. Cross-app identity is
  established only by an explicit merge or a future conservative identifier
  resolver.

`semantic_projection_storage_keys` implements this contract. It domain-separates
run, entity, and version hashes and scopes them by parser and app. The storage
adapter binds 32-byte values as BLOBs, not hex text, and writes the run, canonical
items, run-local membership, and frame link in one immediate transaction.
Callers must use `SemanticTree::structural_fingerprint()` as the input content
hash. The existing capture hash covers flattened text only and is not safe for
semantic run reuse when hierarchy changes.

Do not overload `frames.full_text`, `memories`, or `outputs`. They represent raw
search text, durable user facts, and generated files respectively.

### Raw and parsed retention

Keep both forms only while they serve distinct purposes:

- With the default disabled setting: write no semantic data.
- During the opt-in measured rollout: keep existing raw/generic evidence and
  normalized semantic records so parser recall and fallback can be compared.
- After a successful parse is durable and the retention/redaction gates pass,
  `lean` mode may keep `full_text` plus semantic items while clearing heavy tree,
  geometry, element, and source-node evidence.
- If parsing abstains or fails, preserve the current generic accessibility/OCR
  path. Never delete the only usable representation.

Storage reduction is therefore a later retention outcome, not an automatic
consequence of parsing. The initial synthetic SQLite regression measured 8.2
semantic bytes/frame for 1,000 identical projections and 860.2 bytes/frame for
1,000 changing projections, including indexes and frame links. Before changing
retention defaults, a representative fixed capture trace must still compare
current full, current lean, semantic full, and semantic lean modes after
checkpoint and compaction. It must separately report media bytes, database
bytes, reused parse runs, reused item versions, and parse failures.

Automation mode does not add a semantic table or a per-frame automation blob.
Its bounded action structure is part of the existing
`accessibility_tree_json`/`elements` capture, and the automation view is rendered
on demand. `both` mode stores the same action subset once while normalized
semantic tables deduplicate memory-oriented records independently. UI events
continue to store the user's actual actions and can be joined to either view by
frame and time.

## 8. Retrieval

The database API supports exact-frame and bounded time/app/full-text queries.
`GET /search?content_type=parsed` exposes parsed app data through the existing
search contract, including its authentication, time/app/window filters,
pagination, output formats, field selection, truncation, and redaction. Each
`Parsed` result contains compact corrected `text`, typed `items`, parser
provenance, and mutable actor references kept separately from raw parser labels.
`frame_id` selects one parsed frame and `actor_id` filters by the current
reconciled actor.

Actor reconciliation uses the same local API shape as speaker correction:

- `GET /semantic/actors/search?q=...` searches canonical and observed names.
- `POST /semantic/actors/create` creates an intentionally separate identity.
- `POST /semantic/actors/update` renames a canonical actor.
- `POST /semantic/actors/merge` merges identities and their future aliases.
- `POST /semantic/actors/reassign` corrects one canonical semantic item by ID.
- `POST /semantic/actors/aliases/reassign` moves one observed alias and its
  heuristic history, so a reconciliation affects future captures or can split
  an overly broad merge. Explicit item corrections remain untouched.

These endpoints are sufficient for a local reconciliation Pipe. It can inspect
actors and source-backed JSON, propose or apply merges, then retrieve all context
for the corrected actor without rewriting historical parser evidence.

The MCP `search-content` tool exposes the same path with
`content_type=parsed`; it does not add a second read tool. When no parsed records
exist, agents can use another `content_type` or `activity-summary`, preserving
the original capture behavior.

Element endpoints expose three explicit projections:

- `format=outline` for reading and memory tasks
- `format=automation` (aliases `computer-use` and `computer_use`) for controls,
  allowed actions, state, normalized bounds, response-local refs, and
  best-effort keys
- `format=preferred` to follow the active capture-purpose setting

The MCP `search-elements` and `get-frame-elements` tools accept
`purpose=read|automation` (`computer-use` remains a legacy alias). An explicit
purpose wins. When omitted they request `format=preferred`, so automation-only installations get targeting context
without requiring every agent prompt to know the local preference.

Default output is grouped plain text:

```text
Slack | #release | 10:02-10:08
alice 10:02: notarization is blocking the release
[user] 10:04: I will retry the signing job
source frame: <frame_id>
```

When the feature is enabled, the agent progression becomes activity summary,
semantic app context, generic content search, element search, and pixels only
when needed.

## 9. Privacy and retention

Semantic strings are a new PII surface. Exclusion, incognito, password, DRM, and
pause gates run before enqueue. Synchronous removal applies before insertion.
The async redaction worker must add a semantic watermark and should reuse the
frame redaction map when possible.

Retention behavior:

- `media`: keep semantic records
- `lean`: keep compact semantic text, clear source-node blobs with tree geometry
- `all` and time-range deletion: remove frame references and garbage-collect
  unreferenced runs, observations, and items

No cloud sync until permission, encryption, deletion, and live read-back are
verified separately.

## 10. Acceptance gates

Measure on an older Intel Mac and a representative Windows enterprise laptop:

| Metric | Gate |
|---|---:|
| Parser projection p50 | under 1 ms |
| Parser projection p95 | under 5 ms |
| Hard parser deadline | 20 ms |
| Incremental steady RSS | under 20 MB |
| Average parser CPU over 8-hour trace | under 0.5 percent |
| Capture delay caused by parser | zero awaited time |

Token success is end-to-end tokens and tool calls needed to answer a fixed task
suite, compared with current `full_text` and element-outline retrieval. Raw JSON
compression alone is not a sufficient metric.

The crate now includes a privacy-safe fixed context suite covering all seven
shared parser families. It compares persisted accessibility JSON, the current
text-bearing element outline, and semantic plain text with the exact
`o200k_base` tokenizer. Regression tests require every semantic case to retain
all scored task facts while using a smaller complete prompt than both
baselines. An opt-in Pi runner sends the balanced 24-prompt pack to a local or
configured model with tools, project context, skills, extensions, and sessions
disabled. Model accuracy is reported separately from deterministic fact
retention and is never a network or credential requirement for CI.

The synthetic suite verifies the representation contract, not real-app parser
recall. Fresh-capture evaluation is still required for app contracts that rely
on the new transient structural sidecar because historical trees cannot express
all sender/message, task/status, or event/schedule relationships.

A deterministic automation fixture separately compares the targeting view
with raw accessibility JSON using the exact `o200k_base` tokenizer. It preserves
all 80 interactive controls, names, and action refs while using 3,860 tokens
instead of 7,923, a 51.3% reduction. Tests also cover stable strong keys across
sibling insertion and database-ID changes, ambiguous derived keys, password
redaction, output bounds, and allowed actions.

An exploratory walk against a live macOS accessibility window compared the
closest same-shape samples after the action subset was bounded: 490 retained
nodes and 109,597 JSON bytes in the default walk versus 504 nodes and 112,839
bytes in automation mode. Mean walk time was 111.5 ms versus 118.0 ms. This is
approximately 3.0% more tree bytes and 5.8% more walk time, but it is not a
deterministic benchmark because the live window changed during sampling. The
release gate still requires a fixed trace, an older Intel Mac, Windows hardware,
steady RSS, and an eight-hour CPU run.

The release-mode synthetic pipeline benchmark runs 1,000 adapt, parse, and
render iterations for each family. On the 2026-07-24 development machine,
per-case mean latency was 1.69 to 4.93 microseconds and p95 was 1.79 to 5.04
microseconds. In-memory SQLite persistence measured 72.1 microseconds per reused
run write and 156.4 microseconds per changing write. These are reproducible
microbenchmarks, not the older-hardware or real-disk acceptance test.

## 11. Rollout

1. Ship normalized writes, synchronous PII removal, the latest-wins worker, and
   parsed retrieval through `/search` and its existing MCP tool behind
   `enableSemanticContext`, default false. Complete in this change.
2. Measure the opt-in path on an older Intel Mac and a representative Windows
   enterprise laptop, including steady RSS and an eight-hour CPU trace.
3. Retain parser-requested structural containers selectively in the existing
   platform walk and replay every family against privacy-safe real-tree fixtures.
4. Tighten profiles only from privacy-safe real-tree fixtures when a shared
   parser abstains or emits the wrong structure.
5. Consider a measured `lean` retention policy only after raw fallback and
   deletion correctness are proven.
6. Consider signed remote parser packs only after shipped parsers are stable.
