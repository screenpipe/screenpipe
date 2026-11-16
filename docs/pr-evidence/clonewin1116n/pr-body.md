# Fix Windows Pipe process cleanup and Digital Clone popups

## Summary

- Persist a Pipe's disabled state first, request cancellation, and wait until
  its execution releases the process-tree guard before returning.
- Fail closed when Windows Job Object assignment fails, instead of running a
  Pipe/agent or managed Pi installer without descendant cleanup.
- Preserve pending-stop behavior for work disabled before a child PID exists.
- Record the exact separate Digital Clone v7 store/runtime patch required for
  its detached Bun launcher and accurate Screenpipe Cloud disclosure.

## Historical intent

- `3139299b` (`fix: cancel queued workflows promptly when quitting`) introduced
  pending cancellation for queued work. This change reuses its execution-handle
  notification and stop-before-PID sentinel.
- `a71e821de9` / PR #7622 hid only the built-in sub-agent extension and added
  privacy-limited native popup metadata. It did not cover Digital Clone's
  detached `clone.js maintain` launcher and is not treated as a reproduction or
  proof of this report.
- Existing `no_window` command builders and Windows kill-on-close Job Objects
  remain the process primitives; no second process-cleanup implementation was
  added.

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
  and descendant cleanup after the parent exits. The production-backed store
  follow-up is specified in `docs/pr-evidence/clonewin1116n/store-patch.md` and
  remains unapplied.

## Tests

- `cargo test -p screenpipe-core disabling_pipe_waits_for_pending_execution_cleanup -- --nocapture` — passed (1 passed).
- `cargo test -p screenpipe-core windows_job_prevents_orphaned_grandchildren -- --nocapture` — passed (1 passed); unmanaged child remained alive, managed child was gone after Job close.
- `cargo test -p screenpipe-core stop_notification_covers_pending_and_waiting_stops -- --nocapture` — passed (1 passed).
- `cargo test -p screenpipe-core --test no_console_flash -- --nocapture` — passed (2 passed).
- `cargo fmt --all -- --check` — passed.
- `git diff --check` — passed (Git emitted only LF/CRLF working-copy notices).
- `cd apps/screenpipe-app-tauri && bun run test:tauri clonewin_process_cleanup -- --nocapture` — native queue and `pre_build.js` succeeded; compilation was manually stopped before test execution after the cold cache exceeded the task window. Not claimed as passed.

Real-app visible-window acceptance was not completed. The exact Digital Clone
v7 after-case cannot pass until its separate store runtime patch is built and
published; no production store mutation was authorized.

## Production status

Unmerged and unreleased. Pending a Windows consumer app build, human Admin
Releases publication, and a separately reviewed Digital Clone Pipe-store v8
update. No release/version/publication pointer was changed. No secrets or data
migrations are expected.
