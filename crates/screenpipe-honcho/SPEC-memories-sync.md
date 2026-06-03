# Spec: Honcho as a memories-table sync destination

> Supersedes the activity-summary approach in `SPEC.md`. This spec reworks the
> Honcho integration to ride the existing external-memory-sync pipeline
> (PR #3524) instead of running its own hardwired background service.

## Goal

Make Honcho a destination on screenpipe's existing curated-memory sync, alongside
Claude Code and Codex CLI. Only the importance-filtered `memories` table leaves the
device — never raw OCR frames or audio transcripts.

This replaces the current branch's design (CLI flags + `#[cfg(feature = "honcho")]`
compile gate + a standalone `tokio::spawn` background service running an
activity-summary synthesizer). That design predates the `external_memory_sync`
pattern (#3524, 2026-05-22), which is now the blessed way to push curated memory to
an external destination.

### Why this route

- **Less code.** Reuses the orchestrator, the DB query, the importance filter, the
  enabled-check, and the connection UI surface that #3524 already built.
- **Less sensitive data.** The `memories` table is curated, importance-floored,
  durable facts — not raw screen/audio. Directly addresses the maintainer's "uncertain
  users want their data in the cloud" concern: even hosted Honcho only ever receives
  the same digest screenpipe already exports to Claude Code / Codex.
- **Consistent.** A screenpipe operator who understands the Claude Code / Codex sync
  understands this one — same scheduler, same connection card, same enable/disable.
- **Reliable, not a pipe.** Stays native Rust on a fixed tick. Deterministic delivery,
  no Deno/LLM-interpreted markdown.

## Non-goals (this spec)

- Activity-summary synthesis (app/window/URL/transcript extraction). Dropped — that's
  Option B and a separate, more invasive PR.
- A privacy/redaction filter over raw activity. Not needed: only curated memories ship.
- Honcho dialectic/query surface inside screenpipe. Querying Honcho stays the
  external agent's job.

---

## Architecture

Mirror the three-layer split of `external_memory_sync`:

| Layer | File-destinations (existing) | Honcho (new) |
|---|---|---|
| **Destination definition** (connection card, creds, enable/disable, `test()`) | `screenpipe-connect/src/connections/{claude_code,codex}.rs` | `screenpipe-connect/src/connections/honcho.rs` (new) |
| **Orchestrator** (engine: load memories on a tick, check enabled, dispatch) | `screenpipe-engine/src/external_memory_sync.rs` | same file — add a Honcho branch in `run_once` |
| **Sink** (pure-ish delivery) | `screenpipe-core::memories::external_sync` (`write_atomic`) | `screenpipe-honcho::client` (HTTP POST) |

### Why Honcho is *not* a `Destination`

`external_sync::Destination` is file-oriented (`filename`, `sidecar_filename`,
`target_path() -> PathBuf`). Honcho's sink is a network API with append semantics, so
forcing it into `Destination` would mean bolting a "is this a file or a URL?" branch
onto a type whose whole job is file paths. Instead, Honcho slots into the orchestrator
as a **sibling sink**: `run_once` already loads the memory snapshot once and fans out;
add one more fan-out call, `sync_honcho(&entries, secret_store, dir)`, next to the two
`sync_destination` calls. The shared `entries` snapshot guarantees Honcho sees the same
rows Claude Code / Codex saw that tick.

---

## Delivery semantics — the one real difference from file destinations

File destinations **rewrite the whole file** every tick: idempotent, stateless, the
second identical run is `Unchanged`. Honcho's API **appends messages** to a session, so
re-posting all memories every 5 minutes would duplicate forever.

Honcho therefore delivers **incrementally** off a high-water cursor:

1. Maintain a cursor = the max `updated_at` of memories successfully posted so far.
2. Each tick: from the loaded snapshot, select rows with `updated_at > cursor` (and
   `importance >= IMPORTANCE_FLOOR`, already applied by the loader).
3. Post the selected rows as messages, then advance the cursor to the new max
   `updated_at` **only on success** (a failed POST leaves the cursor put → retried next
   tick → at-least-once delivery).
4. **First tick after connect** (cursor unset): post the full current backlog so Honcho
   has history, then set the cursor. (Backlog is bounded by `MAX_ENTRIES_PER_DIGEST` /
   the loader's `FETCH_LIMIT`.)

### Cursor persistence

Persist the cursor so an engine restart doesn't re-send the backlog:

- **With SecretStore:** store under key `honcho:sync-cursor` via `set_json` after each
  successful post; read at startup. (~5 lines.)
- **Without SecretStore (CLI-only):** in-memory cursor, seeded to "send full backlog on
  first tick." Re-sends backlog on restart, which is low-harm (Honcho's deriver dedupes
  semantically; memory volume is low) but should be `log()`-ged so it isn't silent.

> Impl note to verify: confirm `DatabaseManager::list_memories` can filter/return
> `updated_at` for the cursor compare. If it can't filter by `updated_at` directly,
> fetch importance-floored rows (as `load_memory_entries` already does) and filter by
> `updated_at > cursor` in Rust before posting. `MemoryEntry.updated_at` is already
> RFC3339 UTC, so string compare is ordering-correct.

---

## Honcho data model — **Model 1 (locked)**

Memory facts are authored **as the user peer's own messages**. Honcho models the user
from a first-person-ish stream of durable facts about them.

- **Peer:** one peer, id = the connection's `peer_name` field (default
  `"user-default"`), created idempotently via `create_peer` with `observe_me: true`.
- **Session:** a single stable session, id `"screenpipe-memories"`. These are durable
  facts, not time-series activity, so the daily-rolling-session logic from the current
  branch is **dropped** — no midnight rotation.
- **Message:** one message per `MemoryEntry` (leaning) or one batched `add_messages`
  call per tick carrying all new entries. `peer_id` = the user peer. Content =
  `MemoryEntry.content`. (Optional `[source]`/tags prefix — see Open decisions.)

Reuse `screenpipe-honcho::client` (`create_peer`, `create_session`, `add_messages`)
roughly as-is; just call it from the orchestrator instead of the deleted service loop.

### Model 2 (documented, not implemented) — screenpipe as an observer peer

The alternative is to author messages as a **`screenpipe` observer peer** that observes
a separate user peer, so Honcho attributes "screenpipe observed X about this user"
rather than treating the facts as the user's own statements. We don't build this, but
because `peer_name` is **configurable**, a user can experiment with it without code
changes:

1. Set the connection's `peer_name` to e.g. `"screenpipe"` — now the synced facts are
   authored by a `screenpipe` peer.
2. In Honcho (app.honcho.dev or the local API), add themselves as a separate user peer
   to the `screenpipe-memories` session and set the observe directionality so the
   user peer observes the `screenpipe` peer.

This must be **documented** so users know the lever exists and what trade-off it
represents (self-statement modeling vs. third-party-observation modeling, e.g. for
provenance/trust weighting). Put it in `crates/screenpipe-honcho/README.md` (new) and
reference it briefly in the connection `description`. Add a short code comment at the
`create_peer` call pointing to the README so the configurability isn't a hidden detail.

---

## The connection: `screenpipe-connect/src/connections/honcho.rs`

Model on `claude_code.rs` (manual-field integration, not OAuth).

```rust
static DEF: IntegrationDef = IntegrationDef {
    id: "honcho",
    name: "Honcho",
    icon: "honcho",                 // needs an icon asset in the app
    category: Category::Productivity,
    description: "Continuously sync screenpipe's curated memory facts into a Honcho \
        workspace so other AI agents can query a modeled understanding of your \
        activity. Works with self-hosted (local) or hosted Honcho — set api_url. \
        Only importance-filtered memories are sent; never raw screen or audio.",
    fields: &[
        // api_url — default to LOCAL self-host; hosted is an explicit opt-in.
        FieldDef { key: "api_url",   label: "Honcho API URL", secret: false,
                   placeholder: "http://localhost:8000", help_url: "https://docs.honcho.dev" },
        FieldDef { key: "api_key",   label: "API key (hosted only)", secret: true,
                   placeholder: "", help_url: "https://docs.honcho.dev" },
        FieldDef { key: "workspace", label: "Workspace", secret: false,
                   placeholder: "screenpipe", help_url: "" },
        FieldDef { key: "peer_name", label: "Peer name", secret: false,
                   placeholder: "user-default", help_url: "" },
    ],
};
```

- `resolve_config(creds) -> HonchoClientConfig` helper (mirrors
  `claude_code::resolve_home_path`), reused by the orchestrator. Applies defaults
  (api_url → `http://localhost:8000`, workspace → `screenpipe`, peer_name →
  `user-default`).
- `test()` — minimal **inline** reqwest call (idempotent `POST {api_url}/v3/workspaces/{workspace}/peers`
  with the peer id) so `screenpipe-connect` does **not** depend on `screenpipe-honcho`.
  Returns `"connected to <workspace> (<api_url>)"`.
- Register `Box::new(honcho::Honcho)` in `all_integrations()`.

### Data-residency default

`api_url` defaults to localhost. Hosted Honcho requires the user to explicitly change
it (and supply `api_key`). The description states only curated memories are sent. This
is the concrete answer to the maintainer's cloud concern, pending his "cloud at all vs
cloud by default" reply — if he wants cloud-at-all gated, we additionally hide the card
until configured (see Open decisions).

---

## Orchestrator changes: `screenpipe-engine/src/external_memory_sync.rs`

1. Add a `sync_honcho(entries: &[MemoryEntry], secret_store, screenpipe_dir, cursor)`
   function alongside `sync_destination`. It:
   - `load_connection(ss, dir, "honcho")` → if `enabled == false` / absent → return
     `SyncOutcome::Skipped`.
   - `resolve_config(creds)`; build `HonchoClient`.
   - Ensure peer + `"screenpipe-memories"` session (idempotent).
   - Select `entries` with `updated_at > cursor`; if none → `Skipped { reason: "no new memories" }`.
   - `add_messages(...)`; on success advance + persist cursor; return
     `SyncOutcome::Wrote { entries: n }` (path field n/a — see below).
2. Call it from `run_once`, reusing the already-loaded `entries`:
   ```rust
   let mut results = vec![
       sync_destination(&Destination::CLAUDE_CODE, &entries, ss, dir, resolve_claude_code_path).await,
       sync_destination(&Destination::CODEX, &entries, ss, dir, resolve_codex_path).await,
   ];
   results.push(sync_honcho(&entries, ss, dir, &cursor).await);
   results
   ```
3. `ExternalSyncResult` / `SyncOutcome`: Honcho has no file `path`. Either add a
   `SyncOutcome::Pushed { entries, endpoint }` variant, or reuse `Wrote` with the
   endpoint URL in place of the path. Prefer a small new variant for honesty in the
   status UI. Metrics (`syncs_wrote/skipped/failed`) need no change.
4. Cursor lives in the scheduler struct (or is read/written inside `sync_honcho` via
   SecretStore). Keep it out of `MetricsInner`.

`screenpipe-engine` already depends on `screenpipe-connect` and takes `db` +
`secret_store` in `ExternalMemorySyncScheduler::start` — so no new wiring in
`server_core.rs`. Add `screenpipe-honcho` as a dependency of `screenpipe-engine` (see
crate slimming below).

---

## Slim down `screenpipe-honcho`

The crate becomes a thin Honcho REST client. Keep it a separate crate so the connection
`test()` *could* reuse it later and so the engine isn't bloated with Honcho specifics.

**Keep:** `client.rs` (`HonchoClient`, `create_peer`, `create_session`,
`add_messages`, config struct). Simplify `add_messages`/session usage to the single
stable session.

**Delete:**
- `synthesizer.rs` (activity-summary extraction, the substring "privacy" filter,
  `RawEvent`/`FocusSpan`, format-density logic) — entire file.
- `service.rs` (`HonchoService`, `run()` loop, `poll_activity_summary` + the 5 SQL
  queries, daily session rotation, `last_sync_time`).
- `lib.rs` re-exports of the deleted modules.

**Cargo.toml:** drop `screenpipe-db` dep (no more direct SQL); keep `reqwest`, `serde`,
`tokio`, `chrono`, `anyhow`.

> Per repo convention: don't `git rm` and lose the activity-summary work outright — it's
> the basis for a future Option B. Leave the old `SPEC.md` in place; the deleted code
> stays recoverable from the `feat/honcho-backend-service` history.

---

## Remove the hardwiring

In `screenpipe-engine`:
- **`Cargo.toml`:** remove the `honcho = ["dep:screenpipe-honcho"]` feature; make
  `screenpipe-honcho` a normal (or optional-but-default) dependency.
- **`cli/mod.rs`:** delete `enable_honcho`, `honcho_api_url`, `honcho_api_key`,
  `honcho_workspace`, `honcho_peer_name`, `honcho_sync_interval_mins` args.
- **`bin/screenpipe-engine.rs`:** delete the `#[cfg(feature = "honcho")]` block that
  spawns `HonchoService`, and the "honcho memory" line in the startup banner.

Config now lives entirely in the connection (SecretStore / `connections.json`), editable
at runtime from the connections UI or `screenpipe connection set honcho key=value`. No
rebuild, no relaunch, no feature flag.

---

## Sync interval

The memories sync runs on `external_memory_sync`'s `SCAN_INTERVAL` (5 min). Honcho
shares it — there is no separate honcho interval (the old `sync_interval_mins` flag is
gone). If a Honcho-specific cadence is ever needed, add it as a connection field later;
out of scope here.

---

## File-by-file change list

| File | Change |
|---|---|
| `screenpipe-connect/src/connections/honcho.rs` | **new** — `Honcho` integration + `resolve_config` + inline `test()` |
| `screenpipe-connect/src/connections/mod.rs` | register `honcho::Honcho` in `all_integrations()`; `pub mod honcho;` |
| `screenpipe-engine/src/external_memory_sync.rs` | add `sync_honcho`, call from `run_once`, cursor handling, `SyncOutcome::Pushed` |
| `screenpipe-engine/Cargo.toml` | drop `honcho` feature; `screenpipe-honcho` as normal dep |
| `screenpipe-engine/src/cli/mod.rs` | delete 6 honcho CLI args |
| `screenpipe-engine/src/bin/screenpipe-engine.rs` | delete spawn block + banner line |
| `screenpipe-honcho/src/synthesizer.rs` | **delete** |
| `screenpipe-honcho/src/service.rs` | **delete** |
| `screenpipe-honcho/src/lib.rs` | trim to `pub mod client;` |
| `screenpipe-honcho/src/client.rs` | keep; simplify to single stable session |
| `screenpipe-honcho/Cargo.toml` | drop `screenpipe-db` dep |
| `screenpipe-honcho/README.md` | **new** — crate overview + **Model 1 vs Model 2** peer-modeling note (incl. the configurable-`peer_name` workaround for trying Model 2) |
| app: connection icon asset | add a `honcho` icon |

---

## Testing

- **Unit (core/connect):** `resolve_config` defaults (blank → localhost, etc.);
  cursor select logic (`updated_at > cursor` filters correctly; first-tick backlog).
- **Orchestrator:** `sync_honcho` returns `Skipped` when connection disabled/absent
  (mirror the existing `sync_destination_skips_when_disabled` tests); returns
  `Skipped { "no new memories" }` when cursor is current; advances cursor only on a
  successful post (mock the client).
- **Client:** existing client tests; add one for the single-session path.
- **Manual:** run a local Honcho (`http://localhost:8000`), connect via the UI,
  confirm memories appear as messages in the `screenpipe-memories` session, confirm a
  restart doesn't re-post the backlog (cursor persisted), confirm disabling the
  connection stops posting within one tick.
- `cargo test`, `bun run bindings:check` (no new Tauri commands expected, but verify no
  drift), CI.

---

## Open decisions (need maintainer input)

1. **Cloud at all vs cloud by default.** Default is localhost; if he wants hosted gated
   harder, additionally hide the card until configured (the `list()` surface would need
   a "hidden unless configured" flag — minor).
2. **Message granularity / formatting.** One message per memory vs one batched message
   per tick; whether to prefix content with `[source]` or tags. Honcho ingests either;
   leaning one-message-per-entry for cleaner per-fact modeling.
3. **`SyncOutcome::Pushed` variant** vs reusing `Wrote`. Leaning new variant.
4. **Keep `screenpipe-honcho` as a crate** vs inlining the ~150-line client into
   `external_memory_sync`. Leaning keep-crate for separation.
```
