<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->

# Focused-window screenshot setting

The two PNGs are synthetic pixel fixtures, not native application captures.
They were produced by an isolated Rust probe that extracted
`mask_image_to_focused_window` and `apply_screenshot_scope` verbatim from
`crates/screenpipe-engine/src/event_driven_capture.rs`. The default-off result
retains the original image allocation. The enabled result retains the
1920 × 1080 dimensions and original pixels within the focused rectangle,
with opaque black outside it.

The source unit test also checks missing/invalid bounds, partial off-monitor
windows, and screenshots already disabled. Native capture, multi-monitor
behavior, focus races, and a running enterprise policy rollout require
separate platform validation. This setting masks a rectangle from the
already privacy-filtered desktop; allowed overlays inside that rectangle
can remain visible. It is not a tightly cropped or isolated native-window image.

An isolated release-mode helper probe on this Mac, while other cold builds
were running, measured 100 iterations at 1920 × 1080: median 7.455 ms,
p95 263.942 ms. This includes only the masking helper, not native capture,
OCR, JPEG encoding, or database writes, and is not a recorder benchmark.
