# Org data unification spec

Status: proposal. Spans two repos: `screenpipe` (desktop/engine, this repo) and
`website-screenpipe` (cloud control plane + runner).

## Why

Two storage stacks, tuned to two different jobs, that should stay separate:

- **Local, per device**: `db.sqlite` (frames/ocr/audio/ui + FTS/vec) + `compact_monitor_*.mp4`
  video, served by the engine at `localhost:3030`. Optimized for one person, rich query,
  retain video.
- **Cloud, per org**: flat JSONL telemetry lake partitioned `device/hour` + rollup/meta index
  + SAF artifacts, in R2/Azure. Optimized for many people, cheap append, derived rollups.

Do **not** merge the engines — sqlite does not federate (30 employees = 30 dbs, not one
queryable org brain). Unify the three layers *above* storage instead:

1. **Artifact shape** — one SAF envelope, local and cloud.
2. **Query interface** — one contract, so a pipe runs unchanged local or cloud.
3. **On-demand frame fetch** — ship only the ~30 frames a SOP cites, not the firehose.

Sequencing: **P3 → P1 → P2** (hot ask first, then the shared envelope, then the big rock).

---

## P1 — Unified artifact shape (SAF everywhere)

### Current state
- Cloud has a real envelope: `Artifact` in
  `website-screenpipe/lib/enterprise/artifacts/types.ts:128` (`saf_version`, `artifact_id`,
  `version`, `kind`, `body`, `evidence: EvidenceRef[]`, `provenance`, `changelog`). Per-kind
  bodies (`SopBody.steps: ArtifactStep[]`) at `:106-122`.
- Local has a *different* shape: `OutputRecord` in
  `screenpipe/crates/screenpipe-db/src/types.rs:305` (`source`, `source_type`, `title`,
  `kind`, `output_path`, `preview`, `metadata`) served by
  `crates/screenpipe-engine/src/routes/outputs.rs`. It is a file registry, not a typed
  artifact. The desktop artifacts view renders these as markdown/plain files.

They don't match, so a device-authored SOP and a cloud-authored SOP can never share a
renderer or a list.

### Proposed change
1. **Shared SAF contract.** Lift the SAF types into one source of truth both repos consume.
   Cheapest: a published `@screenpipe/saf` types package (or vendored `saf.ts` in each repo
   plus a contract test that round-trips a golden envelope). No runtime dep, just types +
   validators.
2. **Local can emit SAF.** Add SAF as an *optional richer layer* over the existing outputs
   registry — do not remove plain files. Migration on `outputs`:
   ```sql
   ALTER TABLE outputs ADD COLUMN saf_kind   TEXT;     -- 'sop' | 'skill' | ... | NULL for plain files
   ALTER TABLE outputs ADD COLUMN artifact_id TEXT;    -- stable id for versioned artifacts
   ALTER TABLE outputs ADD COLUMN version     INTEGER; -- bumps on re-emit
   ```
   When a pipe writes `out/<artifact_id>.saf.json`, `auto_register_pipe_outputs`
   (`outputs.rs:408`) detects `saf_version`, validates, and fills these columns. Plain files
   keep `saf_kind = NULL` and behave exactly as today.
3. **One renderer.** The desktop artifacts view learns to render a SAF body (it already
   renders markdown; port the dashboard's `SopData` renderer from
   `website-screenpipe/app/account/workspace/enterprise-workflows-dashboard.tsx`). One
   component, both sides.
4. **Sync up (no transform).** A registered SAF output can be pushed to the org artifact
   store as-is (same envelope) via the existing artifacts POST
   (`app/api/enterprise/cloud-runner/artifacts/route.ts`). The org dashboard then lists
   device-authored + runner-authored artifacts together. Gate behind centralized-data policy.

### Compat / risk
- Additive migration; old rows and the `/outputs` API are untouched.
- SAF validation must be lenient on unknown `kind` (forward-compat) — the envelope rails are
  already kind-agnostic by design (`types.ts:16`).
- Risk: scope creep into "sync every local output to cloud". Keep sync **opt-in per pipe**,
  not automatic.

### Effort
~2-3 days: migration + detect/validate in `outputs.rs` + port one renderer + a contract test.

---

## P2 — One query interface (portable pipes)

### Current state — three different access patterns
- **Local pipes**: hit `localhost:3030` — `/search?content_type=…`, `/frames/{id}` (JPEG,
  `routes/frames.rs:45` `get_frame_data`), `/memories`, `/pipes`.
- **Cloud runner pipes**: `cat` raw `/org-data/{device}/{yyyy-mm-dd}-{hh}.jsonl` files off the
  VM disk (see the seed prompts in `enterprise-worker/pipes/*/pipe.md`).
- **Cloud HTTP**: a *third* surface already exists at
  `website-screenpipe/app/api/enterprise/v1/*` — `records`, `search`, `rollups`, `devices`,
  `files`, `pipes`. `v1/records` already mirrors local `/search` params (`device_id`, `kind`,
  time window, `limit`; see `v1/records/route.ts:14-19`).

So a pipe author must know *where* it runs. Code is forked between local and cloud.

### Proposed change
1. **Define the screenpipe query contract** (one doc, versioned): the read surface every
   runtime must serve.
   - `GET /search` — `q`, `content_type` (ocr|audio|ui|all), `start_time`/`end_time`,
     `app_name`, `limit`, `offset`.
   - `GET /frames/{id}` — `image/jpeg` (see P3 for the cloud impl).
   - `GET /memories`, `GET /devices`, `GET /rollups` (rollups are cloud-native; locally a
     no-op or single-device synthesis).
   Param names follow the local engine; the cloud `v1` API conforms to the same names (it is
   ~80% there already).
2. **Runner serves the contract over the lake.** Instead of pipes `cat`-ing JSONL, the runner
   runs a tiny local shim (or the engine in a new "lake mode") that answers `/search` and
   `/frames/{id}` over the partitioned lake + rollup index. Pipes read
   `$SCREENPIPE_API` (default `http://localhost:3030`) and stop caring where they are.
3. **Rewrite seed pipes to query, not cat.** `sop-generator` / `workflow-discovery` ask
   `/search` with a time+app filter instead of bulk-reading hours. This *also* fixes the
   "some orgs have GBs, never cat blindly" hazard the prompts currently warn about by hand —
   progressive disclosure becomes structural, not prompt-enforced.

### Compat / risk
- The `v1` API stays; we tighten param parity and add `/frames/{id}`. Existing callers keep
  working.
- Runner shim is new surface area on the VM — keep it loopback-only, no external port.
- Biggest risk is scope: do **not** try to make the cloud serve FTS/vec search day one.
  Phase it: exact + time + app filters first (covers the seed pipes), semantic later.

### Effort
~1-2 weeks. The contract doc + cloud param parity is days; the runner lake-mode shim and
seed-pipe rewrite is the bulk. Highest leverage of the three (write a pipe once, runs both).

---

## P3 — On-demand frame fetch (cheap images) — DO FIRST

### Current state
- Only `kind:"snapshot"` records carry an image to the cloud, shipped ~1 per 5-min sync as a
  288×180 JPEG of "the latest frame at sync time" (desktop `enterprise_sync.rs`
  `fetch_latest_snapshot`). Measured density on a live org: ~0.6 snapshots per batch, random
  moments, unaligned to workflow steps.
- Regular `frame` records carry **no** image cloud-side. `/frames/{id}` (the decode-on-demand
  path) exists only on the device.
- Net: a SOP step cites real `event_id`s but every `frame_id` is `null` and 0 images render,
  even with the (already-correct) `![](snapshot:N)` prompt + dashboard resolver.

### Proposed change — lazy push of cited frames
1. **Stop the random snapshot.** Drop the per-sync "latest frame" thumbnail (it is noise).
2. **Frame-request channel.** When a runner pipe cites frame_ids it wants as images, it writes
   a small manifest to org storage: `frame-requests/{license_id}/{device_id}.json` =
   `{ frame_ids: [12200, 12431, …], requested_at }`. Capped (e.g. ≤200 ids).
3. **Device fulfills on next sync.** The desktop sync reads its own request manifest, and for
   each id: decode the frame from local video (same path `/frames/{id}` already uses), **run
   the on-device PII redaction model**, downscale to readable (e.g. 1280px), upload to
   `frames/{license_id}/{device_id}/{frame_id}.jpg`. Delete the manifest entry.
4. **Resolution at render.** `EvidenceRef` already has `frame_id` (`types.ts:68`). The
   dashboard already resolves `snapshot:N` → data URI (`enterprise-workflows-dashboard.tsx`
   `resolveSnapshotPlaceholders`); generalize it to `frame_id` → signed org-storage URL for
   `frames/{license}/{device}/{id}.jpg`. **No new SAF body field** — the citation *is* the
   image pointer.
5. **Policy gate.** New `sync_streams.frame_images: bool` (default off). Redaction is
   mandatory and non-bypassable when on. This is the compliance story: "screenshot-grounded
   SOPs that never leave a credential on screen."

### Why lazy push (not pull or bulk)
- Pull (runner → device tunnel) breaks on offline laptops.
- Bulk upload of all frames is the wrong target (gigabytes uploaded to use kilobytes; raw
  screen video centralized = compliance liability). Lazy push uploads only what an artifact
  cites: ~30 frames/SOP/day/device → MB/mo, ~$0.01/mo storage at R2.

### Compat / risk
- Additive: new storage prefix, new optional policy key, new manifest channel. Snapshot path
  can stay during migration, then be removed.
- Two-sync latency: a SOP cites frames in run N, images appear after the device's next sync.
  Acceptable for a daily SOP pipe; document it.
- Redaction is load-bearing — never upload an unredacted frame. Reuse the existing redact
  pipeline; add a test that a known-PII frame is blurred before upload.

### Effort
~2-3 days: request manifest read/write, device fetch+redact+upload loop in `enterprise_sync`,
generalize the dashboard resolver, the policy key. Unblocks the images ask end to end.

---

## What we are explicitly NOT doing
- Not putting sqlite or video in the cloud (doesn't federate; compliance liability).
- Not auto-syncing every local output to the org store (opt-in per pipe only).
- Not bulk-uploading frames (lazy, cited-only).
- Not building cloud FTS/vec search in v1 of the query contract (phase it).
