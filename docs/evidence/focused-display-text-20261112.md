<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Focused-display-only text evidence (2026-11-12)

## Result

The corrected focused-display text boundary passed the required Windows
unit/regression suites, a production-default engine compile, and an opt-in
native acceptance that executes the production
`get_focused_window_monitor_fresh` helper. The corrected implementation was
resumed at `0ffcd74120c668b2c91048f3e3c0207ec867fd65`; the validation test and
this final report are committed immediately after it on
`codex/focused-display-text`.

On Windows, text ownership is sampled from the uncached actual foreground
`HWND` through `MonitorFromWindow(MONITOR_DEFAULTTONULL)`, confirmed against a
fresh `GetForegroundWindow`, and compared directly to `SafeMonitor.id`.
Scheduling remains independent and may retain its cursor fallback, but it
cannot authorize AX, OCR detection/recognition, OCR-cache reuse, semantic
projection, element references, focused metadata, or UI-event frame links.

```text
before: background pixels -> no AX -> gated OCR/cache -> text

after:  fresh foreground owner -> AX/OCR/text
        other/unknown -> permitted screenshot -> durable frame
                                      \-> no text/projections
```

The capture regression covers focused AX, then background capture with a
populated unknown-app OCR cache, fresh/no/no gate, present/absent tree, and
screenshot-disabled mode, followed by restored focus. It asserts the durable
frame columns, elements, snapshot, metadata, hashes, text source, and reference
are empty as applicable without weakening the screenshot durability checks.

## Local commands and results

- `cargo check -p screenpipe-engine --lib --profile debug-dev`
  - PASS, exit 0: production default-feature engine library compiled.
- `cargo test -p screenpipe-capture --lib --profile debug-dev`
  - PASS: 47 passed, 0 failed, 1 ignored.
- `cargo test -p screenpipe-engine --lib --profile debug-dev event_driven_capture::tests`
  - PASS, exit 0: 104 passed, 0 failed, 1 ignored, 1666 filtered out.
- `$env:SCREENPIPE_ISOLATED_VM_TEST='1'; cargo test -p screenpipe-engine --lib
  --profile debug-dev
  isolated_vm_focused_monitor_matches_capture_backend_and_unknown_fails_closed
  -- --ignored --nocapture`
  - PASS, exit 0: 1 passed, 0 failed, 1770 filtered out.
  - `foreground_monitor_id=65537`
  - `capture_monitors=[(65537, 0, 0, 1024, 768)]`
  - `private_inactive_desktop_focused_monitor=None`
- `cargo test -p screenpipe-engine --lib --profile debug-dev focus_aware_controller::tests`
  - Carried from the prior Windows run: 15 passed, 0 failed. Its source and
    inputs are unchanged by the corrected source and validation commit.
- `git diff --check`
  - PASS.

Separate host evidence, not Windows proof: macOS capture passed 47/47,
event-driven capture passed 104/104, focus controller passed 15/15, and the
final frame-linker suite passed 13/13.

## Native Windows evidence and limits

The prepared console exposed one actual display, origin `(0,0)`, size
`1024x768`. The guarded Rust test executed the actual production helper against
the console's real foreground window. Its returned native monitor handle
representation, `65537`, exactly matched the capture backend's `SafeMonitor.id`.
It then attached a test thread to a newly created private inactive desktop;
the production helper returned `None`, the thread switched back, closed only
its test-owned desktop, and the original console query still returned `65537`.
The test is ignored by default and asserts
`SCREENPIPE_ISOLATED_VM_TEST=1`, so ordinary hosts cannot launch or run this
native fixture.

The earlier `GetWindowRect` probe is retained only as historical evidence that
Notepad could own the guest foreground; it is not proof of the corrected
HMONITOR helper. The current native test supersedes that geometry probe.

The file-backed SQLite capture regression proves the remaining boundary. A
focused capture retains text; a background capture retains its permitted JPEG
and frame row while skipping OCR detect/run/cache and AX work and clearing text
columns, metadata, elements, semantic projections, and frame-link attachment;
returning focus restores focused text. The event-driven suite additionally
proves only focused paired results reach `FrameLinker` and background results
clear `last_frame_id`.

Only one physical/runtime display was enumerated. No actual two-display
transition, cursor-on-another-display behavior, hotplug, or DPI-mixed topology
was tested; no simulated geometry or synthetic image is claimed as native
multi-display proof. The private desktop result proves native per-desktop
unknown-focus behavior, not a display transition. No customer sign-in,
customer machine, operator RDP, virtual display driver, or image rebuild was
used.

## Historical intent and scope

- `1a5a778b5b` in #5060 introduced gated background-monitor OCR.
- #6018 and squash `1736578525` in #6009 intentionally removed cross-monitor
  AX attribution while retaining background OCR.
- The new product requirement supersedes only that background OCR expectation.
  Cross-monitor privacy attribution is retained.
- The customer-reported Teams CPU correlation is not evidence of a
  monitor-specific or Teams-process cause; no such claim is made.
- The new native APIs add focused-window geometry queries on capture triggers.
  No CPU or battery benchmark claim is made.

No retry/time/count policy was added, and normal diagnostics remain intact.
Scheduling/change detection, privacy filters, DRM/pause behavior, and
user-owned state were not rewritten.
