<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Focused-display-only text evidence (2026-11-12)

## Result

The focused-display text boundary passed the local Windows unit/regression
suites and a production-default engine compile. Review found no acceptance
blocker in the resumed four-file implementation. Text ownership is sampled
from uncached actual focused-window geometry before pixels/metadata, before an
AX walk, and after an AX walk. Scheduling remains independent and may retain
its cursor fallback, but it cannot authorize AX, OCR detection/recognition,
OCR-cache reuse, semantic projection, element references, or focused metadata.

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

- `cargo test -p screenpipe-capture --lib --profile debug-dev`
  - PASS: 47 passed, 0 failed, 1 ignored.
- `cargo test -p screenpipe-engine --lib --profile debug-dev event_driven_capture::tests`
  - PASS on retry: 104 passed, 0 failed, 0 ignored, 1666 filtered out.
  - The first attempt stopped before engine compilation when `ort-sys` lost its
    CDN connection while extracting `onnxruntime.lib` (`Peer disconnected`).
    The unchanged exact retry recovered the artifact and passed.
- `cargo test -p screenpipe-engine --lib --profile debug-dev focus_aware_controller::tests`
  - PASS: 15 passed, 0 failed, 0 ignored, 1755 filtered out.
- `cargo check -p screenpipe-engine --lib --profile debug-dev`
  - PASS: default engine features, non-test library target.
- `git diff --check`
  - PASS.

The macOS host capture result remains separately reported as 46/47 before the
fixture correction. Its rerun and host engine tests are pending; this Windows
evidence does not report them as passed.

## Native Windows evidence and limits

The prepared console exposed one actual display: `DISPLAY1`, origin `(0,0)`,
size `1024x768`. A disposable Notepad app window was queried through the same
real Win32 sequence used by the new production API:

```text
GetForegroundWindow -> GetWindowRect -> GetForegroundWindow
sampled hwnd: 131828
stable across query: true
rect: x=52 y=52 width=768 height=519
```

The modern Notepad host reused one foreground window across two launches.
Separate encoded WinForms fixtures did not materialize in this prepared
console, so native focus movement and absent/unknown foreground were not
claimed. With only one enumerated display, cursor-on-another-display behavior
and actual two-display ownership were not tested. Controlled real-engine
`do_capture`/DB execution and a UI demonstration were also unavailable; the DB
proof is the backend capture regression above. No customer sign-in, customer
machine, or operator RDP was used.

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
