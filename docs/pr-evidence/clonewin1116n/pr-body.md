<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Finish Windows descendant cancellation

## Summary

- Builds on #7961 without changing its serialized admission, enabled-state
  recheck, queued cancellation, or stop-before-PID behavior.
- Retains fail-closed Windows Job containment for every still-running Pi,
  streaming Pi, and managed-installer child.
- Fixes the post-spawn race where Windows rejects outer Job assignment after a
  short-lived child has already exited. ACP builds now preserve that completed
  command's stdout, stderr, and real exit status because the existing ACP guard
  joined its own kill-on-close Job before starting the wrapped command.
- Non-ACP builds have no self-contained guard, so they retain unconditional
  fail-closed behavior. Cleanup errors are reported; the code does not claim a
  child was terminated when the cleanup request or reap failed.

## Review result and historical intent

Starting head: `bf46ba81a3f300c6a6f1b8178558459773363225`.
Reviewed production-code commit: `02a52325`.

The regression was confirmed on real Windows handles before changing the
behavior. A process handle was awaited to `WAIT_OBJECT_0`; the existing
`KillOnDropJob::assign` then returned `Access is denied. (os error 5)`. Before
this fix, all three callers discarded the already-complete result and returned
a containment error.

#5161 intentionally allowed a best-effort nested-Job compatibility fallback.
This PR does not restore that fallback for live children: a live assignment
failure still requests termination, reaps the child, and returns the native
cause. #7961 remains the source of truth for pipe admission and disable.

```text
before: signaled child -> outer Job ERROR_ACCESS_DENIED -> output/status lost
after:  signaled ACP guard -> observe Tokio exit -> preserve output/status
        live child -> assignment failure -> cleanup + reap -> containment error
```

Closing a Job requests OS cleanup asynchronously; neither this change nor pipe
disable claims synchronous descendant teardown.

## Windows evidence

The deterministic native tests use process handles and OS signals, not sleep,
PID lookup, polling limits, or deadlines:

- already-signaled children with exit 0 and exit 23 each produced the expected
  `completed-out` stdout and `completed-err` stderr after real late assignment
  failures (`os error 5`);
- a still-running child received a real Win32 assignment failure, was rejected
  and reaped, while an unrelated blocked process remained unsignaled;
- the existing Job-close test signaled the owned lingering grandchild while an
  unrelated real process survived;
- existing ACP guard argument transport still preserves `--`, spaces, quotes,
  and shell metacharacters.

The execution token was `High Mandatory Level` (`S-1-16-12288`) administrator.
This is native lifecycle evidence, not standard-user, consumer login, live
cloud, customer, or full onboarding evidence.

## Commands and results

- `cargo test -p screenpipe-core --features acp windows_completed_children_preserve_zero_and_nonzero_results -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_live_assignment_failure_fails_closed_without_unrelated_cleanup -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_job_close_eventually_signals_owned_grandchildren_only -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_guard_transport_preserves_separator_quotes_and_metacharacters -- --nocapture` — passed, 1/1.
- `cargo check -p screenpipe-core --no-default-features` — passed; confirms the non-ACP path compiles with completed-child recovery absent.
- `cd apps/screenpipe-app-tauri && bun run test:tauri windows_pipe_containment_failure_survives_rotation_and_support_redaction -- --nocapture` — passed, 1/1 through the supported `debug-dev` queue. This is the actual shared collector with representative Win32 wording, rotation/restart, and email redaction; it is not a live assignment failure or support upload.
- `cd apps/screenpipe-app-tauri && bun install --frozen-lockfile` — passed with Bun 1.3.10. The source-unreferenced generated `node_modules/@tauri-apps/plugin-updater` 2.10.0 directory was recoverably quarantined; no source pin changed.
- `cd apps/screenpipe-app-tauri && bun run build:tauri:dev` — passed through the supported queue; `debug-dev` application built at `C:\spdev\debug-dev\screenpipe-app.exe`.
- `cargo fmt --all -- --check` and `git diff --check` — passed.

A broad exploratory `windows_` test filter ran 10 relevant tests successfully
but was not counted as passing because an unrelated pre-existing assertion
compared a resolved `.CMD` path with `.cmd` case-sensitively.

Prior unaffected package-runtime, support-collector, guard-argv, Job cleanup,
and #7961 cancellation checks remain applicable. Canonical package work is in
[screenpipe/monorepo#2415](https://github.com/screenpipe/monorepo/pull/2415),
head `c5bebf1fc`; no package source is duplicated here. Its final source is
65,527 bytes, SHA-256
`c7489091db98fc610bbd0f2d70b4670b472bfa0a2179cdcfe63497dbf3e031cf`;
the Windows-tested embedded runtime remains
`2bfac42a54d3874318f2c5a05600e31dea78d8d2a3e22bcd08ca4ab6aaed51c2`.
All 12 package/Store tests passed. Its disclosure is: cloud presets send screen
content and local AI chat logs to cloud AI; screenpipe-cloud uses Screenpipe
cloud. Permissions, completion/privacy instructions, and native runtime are
unchanged by that review wording fix.

## Production status

Unmerged and unreleased. Pending core and package merge, a versioned Windows
release build/sign/upload, human Admin Releases publication, and normal Store
submission/human approval. No migration, new variable, secret, flag, dependent
service deployment, or backfill is required. No publication pointer, tag,
release, customer state, billing/auth/account state, or permissions were changed.
