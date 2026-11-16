# Fix Windows Pipe process cleanup and Digital Clone popups

## Summary

- Persist a Pipe's disabled state first, request cancellation, and wait until
  its execution releases the process-tree guard before returning.
- Fail closed when Windows Job Object assignment fails, instead of running a
  Pipe/agent or managed Pi installer without descendant cleanup.
- Preserve pending-stop behavior for work disabled before a child PID exists.
- Include a complete, hash-checked Digital Clone store submission proposal with
  hidden Windows launches and accurate Screenpipe Cloud disclosure.

## Historical intent

- `3139299b` (`fix: cancel queued workflows promptly when quitting`) introduced
  pending cancellation for queued work. This change reuses its execution-handle
  notification and stop-before-PID sentinel.
- `a71e821de9` / PR #7622 hid only the built-in sub-agent extension and added
  privacy-limited native popup metadata. It did not cover Digital Clone's
  detached `clone.js maintain` launcher and is not treated as a reproduction or
  proof of this report.
- Pi uses the existing ACP self-Job wrapper, which establishes containment
  before it launches user/agent code. The executor retains its Job guard until
  cancellation has dropped the exact future.

## Before / after evidence

Base: `8e40b9b4644649ffda5cd3783ef979ee3034fa6e`

Configuration: consumer Windows 11, default consumer Tauri configuration, no
enterprise feature. Native wrapper used the repository `debug-dev` profile and
machine-wide build queue.

- Before: `enable_pipe(name, false)` only wrote `enabled: false`; it did not call
  `stop_pipe`. Job assignment errors logged a warning and continued with an
  uncontained process. Digital Clone v7 launches `clone.js maintain` with
  `detached: true` and no `windowsHide`.
- After: focused core tests prove durable disable waiting, pending-stop delivery,
  queued cancellation, unrelated-pipe survival, reload persistence, and
  descendant cleanup after the parent exits. A strict store payload and exact
  source/runtime artifacts are included under
  `docs/pr-evidence/clonewin1116n/digital-clone-store-proposal/`.

## Tests

- `cargo test -p screenpipe-core --features acp disabling_dead_parent_drops_executor_guard_and_preserves_other_pipe -- --nocapture` — passed (1 passed); real manager disable, dead root, live descendant, unrelated running pipe, and disabled reload state.
- `cargo test -p screenpipe-core --features acp windows_job_prevents_orphaned_grandchildren -- --nocapture` — passed (1 passed); unmanaged child remained alive, managed child was gone after Job close.
- `cargo test -p screenpipe-core --features acp pi_launch_error_display_preserves_windows_io_cause -- --nocapture` — passed (1 passed).
- `cargo test -p screenpipe-core --features acp stop_notification_covers_pending_and_waiting_stops -- --nocapture` — passed (1 passed).
- `cargo test -p screenpipe-core --features acp stopped_scheduled_queue_drains_without_launching_or_waiting_for_active_run -- --nocapture` — passed (1 passed).
- `cargo test -p screenpipe-core --features acp --test no_console_flash -- --nocapture` — passed (2 passed).
- `bun run docs/pr-evidence/clonewin1116n/build-store-proposal.ts` — passed; proposal source 65,517 bytes.
- `bun run docs/pr-evidence/clonewin1116n/verify-store-proposal.ts` — passed with Bun 1.3.10; bootstrap/setup/context/direct-maintain/async-launch complete, visible console false.
- `cargo fmt --all -- --check` — passed.
- `cd apps/screenpipe-app-tauri && bun run build:tauri:dev` — blocked before compilation by the checked-in dependency mismatch: Rust `tauri-plugin-updater` 2.11.0 versus JS `@tauri-apps/plugin-updater` 2.10.0. The supported queue acquired and released normally; no fallback build was used.

The fixture is native Windows process proof, not a continuous desktop recording
or authenticated production-app demonstration. Full real-app support-report
collection and packaged app observation remain blocked by the dependency
mismatch above. No customer account or production credential was used.

## Production status

Unmerged, unsubmitted, and unreleased. Pending payload submission and human
review in `/admin/pipes`, a Windows consumer app build, merge, and human Admin
Releases publication. No release/version/publication pointer was changed. No
secrets, environment changes, or data migrations are expected.
