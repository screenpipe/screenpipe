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
  ownership remains monorepo#2409. An offline follow-up patch against canonical
  commit `1c3492653f1c9ee0bc46af0e9a9b8216cabe11ad` completes the remaining
  Windows package work without adding another core runtime/package fork.

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

Base: `a32b5b251f0b3599d1daf5746e3f2e4f8d978a93`

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

The focused canonical-package rerun exercised the actual embedded v7 and patched
runtimes on Windows 11/Bun 1.3.10 with an empty loopback-only fixture. Both
completed `context`, detached `launch`, and all 11 `maintain` phases. EnumWindows
observation found 2 visible child-window events for v7 and 0 for the patch. The
patch sets the supported `windowsHide: true` option on every Bun maintenance
child as well as the already-hidden detached Node child. This is package/fixture
evidence, not a full-app, live-cloud, customer, or standard-user result.

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
The r2 real-app blocker recording and results remain preserved and were not
overwritten.

Root subsequently revoked the uniquely matched run-created QA session and
deleted its private staging. No login, billing, account, or session mutation was
performed in the package follow-up. The actual guest token was High Mandatory
Level (`S-1-16-12288`) administrator context, so these Windows observations are
explicitly not standard-user proof.

## Tests

- `cargo test -p screenpipe-core --features acp windows_guard_transport_preserves_separator_quotes_and_metacharacters --no-fail-fast -- --nocapture` - passed.
- `cargo test -p screenpipe-core --features acp windows_job_close_eventually_signals_owned_grandchildren_only -- --nocapture` - passed; real signaled handles and unrelated-process survival.
- `cargo test -p screenpipe-core --features acp disabling_pipe_requests_stop_before_pid_is_available -- --nocapture` - passed (#7961 behavior).
- `cargo test -p screenpipe-core --features acp stopped_scheduled_queue_drains_without_launching_or_waiting_for_active_run -- --nocapture` - passed (#7961 behavior).
- `cargo test -p screenpipe-core --features acp --test no_console_flash -- --nocapture` - passed (2 tests).
- `cargo fmt --all -- --check` - passed.
- `cd apps/screenpipe-app-tauri && bun install --frozen-lockfile` - passed.
- `cd apps/screenpipe-app-tauri && bun run build:tauri:dev` - passed on the final synchronized source via the supported build queue; the warm `debug-dev` build completed in 2m26s.
- Canonical package `bun install --frozen-lockfile` - passed with Bun 1.3.10.
- Canonical package `bun run test -- lib/digital-clone-windows-source.test.ts lib/pipe-source-validation.test.ts` - passed (2 files, 12 tests).
- Real `validatePipeSubmission` against the complete generated payload - passed; normalized source 65,528/65,536 bytes, restricted permissions derived from source.
- Offline preparation regeneration - passed and matched the proposed `pipe.md`; edited v7 input and output overwrite protections passed.
- `git -c core.autocrlf=false apply --check --whitespace=error-all digital-clone-canonical.patch` - passed; applying to a fresh extraction reproduced all four LF proposal file hashes.

The prior updater mismatch was VM state, not a source pin defect:
`package.json` has no `@tauri-apps/plugin-updater`, but an extraneous installed
2.10.0 directory remained after frozen install. Quarantining only that generated
directory allowed the normal build to compile Rust updater 2.11.0 successfully.

The immutable canonical archive for commit
`1c3492653f1c9ee0bc46af0e9a9b8216cabe11ad` was retrieved through managed
identity and verified as SHA-256
`22b17994aae3d1c5f5e8a76052b8b208fd531e32c97ba1cff434788c28204caa`.
The complete validated payload, clean-applying patch, package evidence, native
observation receipt, and focused `acceptance.mp4` are privately retained under
`windows-autonomous/clonewin1116r3/`. The package patch discloses that
screenpipe-cloud sends screen content and local AI chat logs to Screenpipe cloud
and that local presets do not upload, while preserving completion/privacy text,
detached behavior, v7 fixture pinning, and offline hash/overwrite protections.

No monorepo PR can be opened because the screenpipe-windows-development GitHub
App installation returns HTTP 404 for `screenpipe/monorepo`; no personal or host
credential was substituted. Exact GitHub UI intervention: a Screenpipe
organization owner must add `screenpipe/monorepo` to that App installation's
selected repositories. This access change is distinct from later Store
submission/human approval and app publication.

The callback JWT exposed no Clerk `sid`/`session_id` claim. The uploaded
`qa-session-proof.json` therefore records the exact Clerk user ID, token JTI,
timestamps and artifact hashes, but leaves `sessionId` null for root to match
against its pre-login session snapshot before revocation; it does not relabel
the token JTI as a Clerk session ID.

## Production status

Draft, unmerged, and unreleased. Core native source revision
`c3aac0a9cbdc63b3567b64bbee8231d9ee018360` remains the passed code revision;
this documentation-only follow-up does not invalidate its targeted tests or
normal consumer native build, and no app rebuild/onboarding retry was performed.
Full-app Pipe/support-report acceptance remains blocked by the hosted
mandatory-card screen. Store approval/publication remains human-only and uses
monorepo#2409. No migration, environment, deployment, version, release tag,
publication pointer, permission, customer account, or billing change is included.
