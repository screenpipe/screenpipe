# Onboarding reliability: issue #7196

<!-- doc-covers: none -->
<!-- doc-verified: ff9833571574e2bae42d319e9d4b8d25ab1a5b44 -->

Base: `ff9833571574e2bae42d319e9d4b8d25ab1a5b44`.

## Changes in this checkout

- Register `request-server-restart` independently of permission-dialog route
  exclusions, including onboarding-only sessions. Coalesce concurrent events in
  each mounted hook and dispose asynchronous registrations safely.
- Expose the existing native `retry_screenpipe` policy to that listener. It
  checks current recording intent, quit state, lifecycle ownership and cooldown;
  unlike `spawn_screenpipe`, it never publishes new recording intent. This is
  the central recovery approach from the existing PR #7180.
- Route the generic **Continue without recording** action through the existing
  native stop command. Ignore late health/startup responses while stopping and
  retain the action for retry if stopping fails.
- Keep the final setup form mounted during native completion and propagate
  completion failures back to its existing retry UI. Preserve task selections
  across that failure. This addresses the frontend lifecycle portion of #7025.

```text
Before: onboarding -> restart event -> excluded listener -> no retry
After:  onboarding -> restart event -> native intent-preserving retry

Before: Continue without recording -> advance with capture still intended
After:  Continue without recording -> stop succeeds -> advance

Before: finish setup -> loading unmounts form -> error swallowed
After:  finish setup -> same form retained -> error -> retry
```

## Local checks

From `apps/screenpipe-app-tauri`:

```sh
bun run test:vitest lib/hooks/__tests__/use-permission-monitor.test.tsx components/onboarding/engine-startup.test.tsx components/onboarding/final-setup-step.test.tsx app/onboarding/page.test.tsx
# 138 tests passed across four files, rerun on final source before committing.

bun run test:vitest components/onboarding/engine-startup.test.tsx
# 21 passed after adding the final late-response guards.

bun run typecheck
# Passed on the final source.

bun x eslint lib/hooks/use-permission-monitor.tsx lib/hooks/__tests__/use-permission-monitor.test.tsx components/onboarding/engine-startup.tsx components/onboarding/engine-startup.test.tsx app/onboarding/page.tsx app/onboarding/page.test.tsx
# No errors; existing checkoutReturnStatus hook-dependency warning in page.tsx.
```

The deliberate-skip regression failed before the fix because no native stop was
invoked. The real-final-form regression failed before the lifecycle fix because
the loading screen replaced the selected controls. Both pass afterward.
Native commands and the event bridge are mocked in these frontend tests.

`bun run bindings:generate` and `bun run bindings:check` both stop at the
supported build queue's prerequisite check: machine-wide `sccache` is missing.
The TypeScript command entry was synchronized by hand with the existing
generated wrapper convention; native generation/drift verification is pending.
No native build or Windows runtime acceptance is claimed.

Root checks also passed: `rustfmt --edition 2021 --check
apps/screenpipe-app-tauri/src-tauri/src/recording.rs`, `git diff --check`, and
`bun x --bun @biomejs/biome check --no-errors-on-unmatched` with the seven changed
TypeScript paths (six checked; generated bindings excluded by configuration).

## Contribution handoff

Implementation and the checks above were performed using OpenCode at the
`agent` autonomy level. Human verification has not been reported. Under
`CONTRIBUTING.md`, an outside contributor must personally submit the PR and
comments, explain the changes in their own words, and disclose what they
personally verified. The required before/after behavior recording is still
missing. Keep the proposed PR draft while that evidence and native checks are
pending; the ASCII comparison above is not a substitute for that recording.

## Issue-wide work still pending

- Finish #7180's native Windows recovery/pause check: actual durable capture,
  persistence after restart and authorized enterprise upload. Azure CLI is not
  available in this environment; no disposable Windows VM was dispatched.
- Reconcile the remaining #7025 native completion receipts, window teardown
  ordering, task admission, remote install accounting and structured diagnostic
  changes. This checkout does not incorporate that entire PR.
- Capture initialization currently memoizes a rejected `startCapture` promise.
  A simple automatic retry of that user-start command would overwrite a later
  tray pause. Recovery of this state needs a native capture-completion check
  that preserves current intent; resetting the promise alone is insufficient.
- Current main already ignores cached flag callbacks, drains the potentially
  pre-identify response, and uses an authenticated reload. Missing/disabled
  flags select control. The page suite covers identity, SDK freshness, fallback
  and restored-session paths; these tests do not establish live rollout results.
- Hosted checkout categorization belongs to website PR #1075; no website code
  or production telemetry was modified or verified here.

Issue #7196 should remain open until native acceptance, the other linked fixes,
and post-release recovery outcomes are verified.
