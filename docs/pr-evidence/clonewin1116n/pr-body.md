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
- Refreshes Tokio's usable child PID after completion observation. A reaped
  child is no longer installed into stop state or passed to `taskkill`; a live
  child still honors an already-pending stop.
- Non-ACP builds have no self-contained guard, so they retain unconditional
  fail-closed behavior. Observation errors no longer bypass cleanup; assignment,
  observation, cleanup-request, and reap failures are all reported factually.

## Review result and historical intent

Starting head: `bf46ba81a3f300c6a6f1b8178558459773363225`.
Native-validated production-code head: `05158a7478d3c43845501bfe2d2066f42aa43046`.
The follow-up adds `#[cfg(windows)]` to the three helper bindings so macOS/Linux
do not compile Windows-only calls. The Windows execution path is unchanged, so
its passed native checks and normal app build remain applicable.

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

The deterministic native tests use process handles and OS signals, not PID
reuse, polling limits, or arbitrary deadlines:

- the narrow helper test uses an honestly unguarded PowerShell fixture: its
  already-signaled exit 0 and exit 23 results retained stdout/stderr after real
  late assignment failures (`os error 5`), and neither replaced a pending-stop
  sentinel nor triggered PID cleanup;
- a live real child installed against the same pending-stop sentinel was
  terminated and reaped;
- a still-running child received a real Win32 assignment failure, was rejected
  and reaped, while an unrelated blocked process remained unsignaled;
- the existing Job-close test signaled the owned lingering grandchild while an
  unrelated real process survived;
- existing ACP guard argument transport still preserves `--`, spaces, quotes,
  and shell metacharacters.

The exact normal build output, `C:\spdev\debug-dev\screenpipe-app.exe`, then ran
the production `--screenpipe-acp-process-guard` entrypoint with completed targets.
It preserved `guard-out-zero`/`guard-err-zero` with exit 0 and
`guard-out-nonzero`/`guard-err-nonzero` with exit 23. This proves the built ACP
guard path; the narrow helper test alone is not presented as that proof.

The execution token was `High Mandatory Level` (`S-1-16-12288`) administrator.
This is native lifecycle evidence, not standard-user, consumer login, live
cloud, customer, or full onboarding evidence.

## Commands and results

- `cargo test -p screenpipe-core --features acp windows_unguarded_helper_preserves_completed_zero_and_nonzero_results -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_live_child_honors_pending_stop_during_pid_install -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_live_assignment_failure_fails_closed_without_unrelated_cleanup -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_job_close_eventually_signals_owned_grandchildren_only -- --nocapture` — passed, 1/1.
- `cargo test -p screenpipe-core --features acp windows_guard_transport_preserves_separator_quotes_and_metacharacters -- --nocapture` — passed, 1/1.
- `cargo check -p screenpipe-core --no-default-features` — passed; confirms the non-ACP path compiles with completed-child recovery absent.
- `cd apps/screenpipe-app-tauri && bun run test:tauri windows_pipe_containment_failure_survives_rotation_and_support_redaction -- --nocapture` — passed, 1/1 through the supported `debug-dev` queue. This is the actual shared collector with representative Win32 wording, rotation/restart, and email redaction; it is not a live assignment failure or support upload.
- `cd apps/screenpipe-app-tauri && bun install --frozen-lockfile` — passed with Bun 1.3.10. The source-unreferenced generated `node_modules/@tauri-apps/plugin-updater` 2.10.0 directory was recoverably quarantined; no source pin changed.
- `cd apps/screenpipe-app-tauri && bun run build:tauri:dev` — passed on final source through the supported queue in 6m20s; `debug-dev` application built at `C:\spdev\debug-dev\screenpipe-app.exe`.
- Exact built-app ACP guard commands for target exits 0 and 23 — passed; stdout,
  stderr, and exit codes propagated exactly.
- `cargo fmt --all -- --check` and `git diff --check` — passed.
- After the platform-guard correction, macOS `cargo check -p screenpipe-core --features acp` — passed (50.85s).
- macOS `cargo clippy -p screenpipe-core --features acp --no-deps` — passed (6.60s; existing warnings).

The built-app guard checks used these PowerShell commands:

```powershell
$env:SCREENPIPE_INTERNAL_ACP_WRAPPED_COMMAND = 'powershell.exe'
& 'C:\spdev\debug-dev\screenpipe-app.exe' --screenpipe-acp-process-guard -- -NoProfile -NonInteractive -Command "[Console]::Out.Write('guard-out-zero'); [Console]::Error.Write('guard-err-zero'); exit 0"
$LASTEXITCODE # 0
& 'C:\spdev\debug-dev\screenpipe-app.exe' --screenpipe-acp-process-guard -- -NoProfile -NonInteractive -Command "[Console]::Out.Write('guard-out-nonzero'); [Console]::Error.Write('guard-err-nonzero'); exit 23"
$LASTEXITCODE # 23
Remove-Item Env:SCREENPIPE_INTERNAL_ACP_WRAPPED_COMMAND
```

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
Its focused 12 tests, build, TypeScript, browser/API, and native automation
passed. Its broader unit job has exactly the same 26 failures as exact main
merge parent `fea7da25177dd8329ac873abd24b67c8a48c4743`; that baseline comparison is
recorded in the package PR. The runtime SHA is unchanged.

## Core CI

CI on `54886916` caught an introduced cross-platform compile failure: only the
assignment binding was gated to Windows, leaving three helper calls enabled on
macOS/Linux. All three helper bindings now have their own `#[cfg(windows)]`.
The local macOS core check and focused Clippy run passed after the correction;
CI is being re-run for the final source.

Earlier exact `bf46ba81` CI passed Vitest/Bun/typecheck and Windows/macOS build,
core, integration, and Clippy checks. Its Windows CLI/workspace failures were
`ort-sys` `dynamic_link.rs:42`, OS error 3, matching the evidenced exact-base
failure. Its Ubuntu job 133618922497 (run 43958392360) failed `screenpipe-redact`
`table_work_slices_adapt_independently` (19 passed, 1 failed); that failure's
baseline was not rerun. Advisory desktop E2E also remained red. These older
results are not presented as a green final CI run.

## Production status

Both PRs are source-only, unmerged, and unreleased. Pending core/package merge,
a versioned Windows release build/sign/upload, human Admin Releases publication,
normal Store update submission, and human `/admin/pipes` approval. Last Store
readback was v7, SHA `3ae629da4bab55336fe2586a1a157011445fe85841d6202c95db02da6db4deb9`.
No migration, new variable, secret, flag, dependent service deployment, or
backfill is required. No publication, customer/account, billing, or recovery
claim was made.
