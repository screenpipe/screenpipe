# Workflow sharing visual evidence

Actual React components in an isolated Chromium preview with synthetic account/settings data and mocked native/backend operations. External network traffic is intercepted. No production collection or customer data is used.

## Sources

- `entry-before-*` and `settings-before-off`: recreated original baseline from `558ffda349ca3553c9dabf5cc0fbaaa5a92e2357`.
- `before-combined`: previous combined-dialog implementation, unchanged visually through `cd6d691730549e5c2c0a3e6bee3c01e44e56e125`.
- Remaining images: refreshed from two-step implementation `4d13358c23e66acab950047e4bffd10b4d180097`, using actual `WorkflowTasksPrompt`, `WorkflowSharingControls`, `PrivacySection`, UI primitives and global styles.

## Capture conditions

Desktop viewport 1100 × 1000 CSS pixels at device scale 1. Dialog crops retain 24 pixels of surrounding overlay, with the same content width and scale. Historical baseline images were cropped with the same padding; their content is unchanged. Narrow dialog viewport 600 × 760. Settings excerpts preserve the same 786-pixel content width and show sharing through the existing cloud-redaction explanation; lower recording-category controls are outside the excerpt. Additional settings states show the sharing card.

The modal intentionally retains its white surface in both themes, with a light native color scheme for checkbox readability. Settings respect the app theme. All 30 PNGs were inspected. Temporary preview code and synthetic ports are outside the repository.

## Coverage

Two-step entry: daily updates first; either explicit daily-update choice leads to optional sharing. Training starts unchecked and applies only to Screenpipe's own models. Captures include both themes, expanded details, training selected, narrow layout, pending saves and recoverable failures. Browser assertions also verified successful sharing closes the dialog.

Privacy settings: before/after, sharing off/on, cloud backend locked, first-party training, expanded details, deletion confirmation/completion with Local restored, saving, enable/stop/status failures, unavailable/managed accounts, dark mode, and recording redaction staying off while sharing still requires cloud.

Focused tests additionally verify no implicit consent, remembered per-account dismissal, signed-out/already-sharing cases, repeat submission prevention, and failed saves preserving the prompt. Native redaction and deployed backend behavior are outside this visual preview.
