<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Windows screenshot acquisition rate benchmark

Windows-only validation for `capture-fps-20261112-c6c2`, based on
`3682553f15f43c7558d0080cd61e177ddad3b154`. macOS validation and the global
default decision remain pending with the integration owner. The provisional 2
fps value is not a conclusion from this benchmark.

## Behavior and risk

WGC historically kept one GPU capture session alive, retained the most recent
texture, and performed staging/BGRA-to-RGBA work only for an admitted screenshot
request. This change preserves that demand-driven copy path and applies the
Windows `MinUpdateInterval` at session creation and before the next request after
a live preference change. Failure is diagnostic and nonfatal: older/unsupported
systems retain the safe demand-driven path. The update lock is held before request
admission, so a preference change cannot cancel an admitted screenshot. No FPS
ceiling was added; the only lower bound is one native 100 ns tick.

This is a battery-sensitive recording hot path. Converting every compositor
frame would make cost scale with producer FPS and was deliberately avoided.

## Machine and method

- Windows 11 Pro build 26100, 4-vCPU Hyper-V disposable console VM; no RDP
  listener or operator desktop.
- 1024x768 at 100%; Microsoft Hyper-V Video 10.0.26100.1150. No discrete adapter
  is exposed, so these results are VM/compositor evidence, not physical-GPU data.
- Release `wgc_cpu_probe` using the actual WGC source. Requests were held at
  286 ms (~3.5/s), independently of requested producer rate.
- 1, 2, 4, 8, 12, 24, and 30 fps; static and controlled moving fixtures; 30 s
  each; forward and reverse order; no compilation during trials.
- CPU is `% of one core` for process/DWM and `% of the whole 4-vCPU VM` for
  system. Raw process private/working-set, startup, first-frame, and teardown
  samples are retained per trial.
- WGC does not expose a native acquisition timestamp here. Request latency is a
  software proxy and is never labeled native frame age.

## Results

All 28 rate trials reported native interval `Applied`, with zero failed requests.
Values below average forward and reverse runs. `cb/s` is actual WGC callback rate.

| fixture | requested fps | cb/s | process CPU/core % | DWM CPU/core % | system/VM % | request p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| static | 1 / 2 / 4 / 8 / 12 / 24 / 30 | .96 / 1.95 / 3.91 / 7.85 / 10.59 / 15.20 / 15.25 | 1.27 / 1.56 / 1.90 / 2.08 / 2.05 / 2.10 / 2.03 | 14.81 / 13.50 / 14.74 / 16.03 / 16.44 / 17.72 / 20.98 | 2.72 / 6.08 / 7.69 / 9.92 / 10.22 / 9.63 / 10.16 | 4.05 / 3.79 / 3.90 / 3.73 / 3.78 / 3.74 / 3.83 |
| moving | 1 / 2 / 4 / 8 / 12 / 24 / 30 | .96 / 1.93 / 3.86 / 7.62 / 10.31 / 19.86 / 20.74 | 1.51 / 1.95 / 2.21 / 2.00 / 1.98 / 2.18 / 2.13 | 24.11 / 24.11 / 27.11 / 26.64 / 24.69 / 28.57 / 30.14 | 3.52 / 3.58 / 4.44 / 3.55 / 5.88 / 4.14 / 4.21 | 4.05 / 4.09 / 3.97 / 3.97 / 3.98 / 4.03 / 4.01 |

Fixture-only DWM baselines were 12.74% of one core static and 24.37% moving.
At high requested rates the VM compositor capped callbacks near 15/s static and
21/s moving; native application success therefore does not imply the OS delivered
the requested rate. Copies/deliveries remained request-driven, not callback-driven.

The existing session comparison completed 30/30 in both modes: persistent/fresh
requests averaged 505.7 ms (p95 526.4 ms, 1.33% core), while transient sessions
averaged 60.6 ms (14.6 ms init, 39.1 ms first frame, 6.8 ms close, 1.66% core).
This comparison is retained as historical/session context, not a replacement for
the controlled matrix.

## Full app and limitations

The supported E2E build used repository fixtures with explicit
`onboarding,no-audio,cloud-authenticated` seeding; this is fixture authentication,
not authentication acceptance evidence. The real native app/engine stayed at one
PID through live 2→24→4 changes, progressed from `vision_not_started` to healthy,
and wrote frames. The demo video shows the app plus cyan allowed and moving
magenta fixture windows. A separate pause/resume attempt reached `stop_capture`
but exceeded WebDriver's 60 s command timeout; pause recovery is therefore
**not validated** and the failed log is retained rather than hidden. Normal
consumer identity without the fixture was correctly blocked by account access,
so it is not presented as capture proof.

Persist/reload, row-level privacy pixel/filename outcomes, and a collected support
bundle containing a representative unsupported-capability failure were not proven
in this run. The benchmark did prove successful native capability reporting and
zero request failures on this OS, but cannot demonstrate the unsupported-OS path.
Windows HD recording is unsupported and was neither fabricated nor implemented.

## Evidence and commands

- `matrix-raw.json`, `matrix-summary.csv`, and `raw/`: complete per-run values and
  stdout/stderr; `fixture-baseline.json`: fixture-only samples.
- `session-baseline.log`: existing-session comparison.
- `e2e-app-proof.log` and `e2e-app-demo.mp4` are preserved in the private worker
  evidence directory; the video intentionally is not committed because it shows
  the disposable worker desktop.
- `tested-binary-hashes.json`: preserved normal executable/resources before the
  E2E build. Normal exe SHA-256:
  `F88E8907A935B40E0EEDC3A36A6079A82B4A1561F152B6764C99CD4C929AD8DC`.

Exact benchmark invocation: `powershell -File docs/pr-assets/screenshot-frame-rate/windows/run-matrix.ps1`.
Full-app invocation: `powershell -File docs/pr-assets/screenshot-frame-rate/windows/run-e2e-proof.ps1`.
Builds used repository wrappers (`bun run build:tauri:dev`, then
`bun run build:tauri:e2e`). A cold native cache made the first builds unusually
long. `bun install --frozen-lockfile` repaired missing workspace packages. An
untracked stale `node_modules/@tauri-apps/plugin-updater` 2.10 directory conflicted
with pinned Rust 2.11 and was moved recoverably outside the repository before the
supported build; no manifest or lock dependency was changed for it.

Before: persistent WGC callbacks were hardcoded to 60 Hz regardless of the shared
preference. After: the session requests the current preference natively, live
changes are serialized before admission, and screenshot conversion remains
demand-driven.

Final checks:

- `cargo test -p screenpipe-screen wgc_capture::tests --lib`: 9 passed, 3 native
  tests filtered as ignored; the native capture and live 2→24→4 ignored tests were
  also run separately and passed.
- `cargo test -p screenpipe-screen screenshot_privacy::windows --lib`: 5 passed,
  1 ignored; the ignored console privacy-dimension test passed separately.
- `cargo test -p screenpipe-config screenshot_frame_rate`: 2 passed.
- `bun run bindings:generate` and `bun run bindings:check`: passed (the latter 1
  native test passed through the supported build queue).
- `bun x vitest run --config vitest.config.ts components/settings/screenshot-frame-rate-card.test.tsx`:
  1 passed; `bun run typecheck`: passed; full-app E2E: 1 passed.
- An accidentally broad `bun run test -- <file>` invocation ran the whole Vitest
  suite: 630 files/7084 tests passed, 4 files/7 unrelated tests failed (stale
  generated skill content, workflow access, Windows renderer fixture executable,
  and platform-path expectations). The correctly scoped component command above
  passed. No broad-suite failure was hidden or treated as feature evidence.
