# Workflow storage and reliability audit

<!-- doc-covers: packages/workflows-ui/src/ apps/screenpipe-app-tauri/lib/workflows/ crates/screenpipe-core/src/workflows/ crates/screenpipe-engine/src/routes/workflow_catalog.rs -->
<!-- doc-verified: e89530e2d -->

Audited against `e89530e2d` on September 29, 2026. Scope: Workflows capture references, catalog persistence and recovery, scheduler status, screenshot rendering, SOP image review/export, and obsolete UI paths. This is a bounded audit of those paths, not a claim that every Workflows edge case is resolved.

## Findings and changes

| Finding | Change | Boundary checked |
| --- | --- | --- |
| Both catalog writers fetched and embedded a separate 640px JPEG. Catalogs and backups duplicated those pixels. | Store frame ID, timestamp and app. Strip legacy pixel fields on backend reads and subsequent saves, including backups and nested revisions. | Core migration test; backend save/read roundtrip; native workflow tests. |
| Large previews displayed the small embedded copy. | Resolve the original recorder frame, with nearest-frame fallback disabled. Verify exact timestamp before fetching an existing frame ID. | Exact identity, reused ID, missing capture, HTTP failures and oversized streaming responses. |
| Screenshot lifecycle could retain offscreen blobs or repeat irrelevant lookups. | Load near the viewport, cancel on leave/unmount, revoke blobs, deduplicate source lookups, and limit concurrent transfers to three. | Multiple independent references, one expired capture, viewport entry/exit and late response cleanup. |
| SOP review/export depended on catalog pixels. | Review uses the same source loader. Only explicit HTML image export embeds selected pixels. Missing selected media fails visibly; text-only and stale-source exports do not fetch. | Review tests and explicit export tests. |
| Read-only details had a second screenshot renderer. | Use the shared evidence component in both detail paths. | Shared evidence and workflow tests. |
| Browser caching removed frame identities and lowered quality scores. | A shared serializer omits pixels while preserving references, user content and quality metadata. | Nested reference serialization test. |
| A corrupt primary could overwrite the valid backup on the next frontend save. | Read and validate the recovery value before rotating the backup. Preserve it if replacement fails. | Corrupt primary, failed rename, queued guide writes and recovery tests. |
| Every idle poll repeated role lookups and loaded a completed catalog again. | Reuse the fetched role status, separate status from result loading, and poll every 30 seconds idle / 3 seconds active. Retry completion retrieval until its result is available. | Scheduled discovery request assertions and completion tests. |
| Old overview, time, evidence, bottleneck and privacy screens remained in the active app module. | Delete unused screens, their state/helpers, the old sign-in poller and 163 unused CSS rules. Existing legacy URLs continue to open Home. | Five legacy-route tests plus Home, detail and Context tests. |

## Storage and performance evidence

The synthetic migration test contains repeated screenshot payloads in a current value and retained drafts. Serialized size falls from 600,612 bytes to 543 bytes while preserving frame identity and unrelated content. This illustrates eliminated image duplication; it is not a production storage measurement.

Catalog commits no longer request or encode screenshots. Image reads use the recorder's existing API and cache. No capture callback, database writer, recorder retention setting or background recording path changes. The loader limits each image response to 16 MiB, including responses without Content-Length, and uses a ten-second deadline. The UI's legacy multi-source search has a thirty-second overall deadline.

## Visual evidence

All images use fictional product notes in the actual shared WorkflowEditor and WorkflowStepEvidence components, with product theme styles. The before image uses the evidence component from base `e89530e2d` and a 640px JPEG, quality 68. The after image resolves a 2400px source. This is an isolated component preview, not an installed desktop recording.

Desktop: 1440 × 1080 CSS pixels at 2× scale. Mobile: 390 × 844 at 2×. States: before, original loaded, loading, unavailable, failed/retry, recovered, and mobile. Temporary routes and capture fixtures are removed from the patch.

## Remaining limits

- Existing on-disk catalogs shrink on their next successful save. This patch does not silently rewrite user files or delete captures during startup.
- Recorder retention can remove an original. Workflows then shows an unavailable message; it does not retain a secret second copy or substitute a nearby frame.
- Existing schema-version-5 compatibility keeps `dataUrl` as an empty string for recorder references. Explicit exports can contain image data.
- The backend retains its 32 MiB catalog limit. Oversized or unreadable legacy files are preserved and reported, not automatically repaired.
- Frontend guide/profile/assistant writes remain serialized within their existing app context. This change does not introduce a new cross-process storage service.
- Native workflow unit tests run through the build queue. Installed-app end-to-end behavior, Windows native behavior, real-data migration and battery/memory profiling are not established by these tests.

## Local validation

- App: `bun run test:vitest lib/workflows components/workflows`: 310 passed.
- App: `bun run typecheck`: passed.
- Shared web preview: `bun run typecheck`: passed with its installed peer dependencies available at the repository root.
- Core: `cargo test -p screenpipe-core workflows:: --lib`: 39 passed.
- Migration: `cargo test -p screenpipe-core --test workflow_media_storage -- --nocapture`: 1 passed.
- Backend: `cargo test -p screenpipe-engine --lib routes::workflow`: 25 passed.
- Native app: `bun run test:tauri workflows_runtime::`: 33 passed through the native build queue.
- Browser: `WORKFLOWS_PREVIEW_URL=http://localhost:1461/preview bun scripts/eval-workflow-storage.cjs`: passed against the maintained fictional preview.
- Coverage dashboards: `bun run coverage:all:check`: passed after regeneration. The pre-existing dashboard drift concerned audio test counts; the regeneration adds no audio behavior changes.
- `git diff --check`: passed.

The production app was not restarted or replaced. Signed-in GitHub browser verification is unavailable in this session because the browser tool reports `unsupported Codex auth method: apikey`. PR image URLs can still be checked through HTTP; that check is distinct from browser rendering.
