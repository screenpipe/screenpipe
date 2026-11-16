# Finish Windows descendant cancellation

## Summary

- Builds on already-merged #7961. Its lifecycle mutex, current-enabled recheck,
  stop-before-PID sentinel, queued cancellation, and tests remain unchanged.
- Retains each Windows Pi/installer tree in a kill-on-close Job and fails closed
  if Job assignment fails. Closing the Job is an asynchronous OS termination
  request; this change does not claim that `pipe disable` waits for teardown.
- Routes production Windows Pi launches through the existing ACP guard before
  user/agent code starts. The argv transport preserves a leading literal `--`,
  spaces, quotes, and shell metacharacters.
- Removes the duplicate Digital Clone Store package/proposal. Canonical Store
  source and preparation already merged in monorepo#2409 at `8fa81238`.

## Historical intent

- #5161 intentionally treated nested-Job assignment as best effort because a
  parent Job can forbid breakaway/nesting. That fallback is replaced only for
  these owned background Pi trees: continuing uncontained would make disable
  unable to stop descendants, so assignment failure terminates the child and is
  returned with its native cause.
- #7961 is the source of truth for pipe admission/disable behavior. This PR does
  not duplicate or reverse that work.
- monorepo#2409 is the source of truth for Digital Clone Store content. No
  Store submission or publication is performed here.

## Before / after evidence

Base: `173a28003aed99b6c52fd1fc99b057ab8c0c8b64`

Before, a Windows Pi root could exit while a descendant retained inherited
output or continued working. PID-only cleanup could no longer identify that
owned tree. After, the retained Job handle covers the tree and Job close asks
Windows to terminate its remaining members. The native test holds real process
handles and waits for their signaled state; it also proves an unrelated real
process remains unsignaled. It proves eventual Job cleanup, not synchronous
disable completion.

The normal non-test `screenpipe-app.exe` process-guard entry was exercised with
the exact argv `--`, `two words`, `quoted="value"`, and `&|<>^%PATH%`; the target
received all four values exactly. No command line, window title/content,
credential, or broad process telemetry was added.

Console-popup history remains unreproduced: earlier #7961/#2409 observations
found zero visible windows both before and after. This PR therefore describes
the no-window/guard work as defensive and does not claim an original-red popup
regression.

Post-auth consumer QA used the normal browser-to-app callback for the authorized
internal account. The app authenticated, started its engine on fallback port
3130, reached healthy recording, and persisted `has_payment_method: false`.
Onboarding could not be completed without a billing mutation: the live hosted
page exposed only card fields and `START 7 DAY TRIAL`; the required
`CONTINUE WITH FREE - NO CARD` action was absent. No card, subscription, or
customer state was changed. The focused 12-second post-auth recording is
`C:\screenpipe-worker\results\clonewin1116r2\acceptance.mp4` (H.264,
1024x768, decodable). Because onboarding remained on mandatory checkout, the
real-app scoped Pipe run/support-report acceptance could not be completed.

## Tests

- `cargo test -p screenpipe-core --features acp windows_guard_transport_preserves_separator_quotes_and_metacharacters --no-fail-fast -- --nocapture` - passed.
- `cargo test -p screenpipe-core --features acp windows_job_close_eventually_signals_owned_grandchildren_only -- --nocapture` - passed; real signaled handles and unrelated-process survival.
- `cargo test -p screenpipe-core --features acp disabling_pipe_requests_stop_before_pid_is_available -- --nocapture` - passed (#7961 behavior).
- `cargo test -p screenpipe-core --features acp stopped_scheduled_queue_drains_without_launching_or_waiting_for_active_run -- --nocapture` - passed (#7961 behavior).
- `cargo test -p screenpipe-core --features acp --test no_console_flash -- --nocapture` - passed (2 tests).
- `cargo fmt --all -- --check` - passed.
- `cd apps/screenpipe-app-tauri && bun install --frozen-lockfile` - passed.
- `cd apps/screenpipe-app-tauri && bun run build:tauri:dev` - passed via the supported build queue; `debug-dev` app built in 11m31s.

The prior updater mismatch was VM state, not a source pin defect:
`package.json` has no `@tauri-apps/plugin-updater`, but an extraneous installed
2.10.0 directory remained after frozen install. Quarantining only that generated
directory allowed the normal build to compile Rust updater 2.11.0 successfully.

Canonical monorepo follow-up could not be inspected or opened because the task's
GitHub App installation returns HTTP 404 for `screenpipe/monorepo`. No personal
credential or access workaround was used.

The callback JWT exposed no Clerk `sid`/`session_id` claim. The uploaded
`qa-session-proof.json` therefore records the exact Clerk user ID, token JTI,
timestamps and artifact hashes, but leaves `sessionId` null for root to match
against its pre-login session snapshot before revocation; it does not relabel
the token JTI as a Clerk session ID.

## Production status

Unmerged and unreleased. The normal consumer app build passes; merge and human
Admin Releases publication remain pending. Store approval/publication remains
human-only and uses monorepo#2409. No migration, environment, deployment,
version, release tag, publication pointer, customer account, or billing change
is included.
