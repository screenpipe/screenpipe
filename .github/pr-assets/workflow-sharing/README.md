# Workflow sharing visual evidence

Real React components rendered in a headless Chromium isolated preview with synthetic account/settings data. These are implementation screenshots, not design mockups or installed-app end-to-end evidence.

- Before: recreated from the implementation parent `558ffda349ca3553c9dabf5cc0fbaaa5a92e2357`.
- After: implementation `39ffe5568c28c2828ffd9099f3b3614763d38c31`.
- Components: `WorkflowTasksPrompt`, `WorkflowSharingControls`, and `PrivacySection`, with the repository's actual global CSS/Tailwind styles and UI primitives.
- Native APIs, settings persistence, translation, scheduled-task setup and account endpoints were replaced at the external ports with synthetic fixtures. External network traffic was intercepted; no customer data or production collection was used.
- Desktop viewport: 1100 × 1000 CSS pixels, device scale 1. Narrow dialog: 600 × 760. Dialog comparisons use the same fixed 500 × 920 crop. Settings excerpts preserve the same 786-pixel content width and show the sharing section through the existing cloud-redaction explanation; lower recording-category controls are outside the excerpt. Additional states show the sharing card.
- Light/dark dialog comparisons use the same viewport, data and styles. Dark-mode modal intentionally retains its existing white surface.

## Coverage

Entry dialog: recreated before/after in light and dark; sharing on; separate model-training permission on; details expanded; narrow layout with both actions visible.

Privacy settings: recreated before; sharing off; sharing on with cloud selected and both backend choices disabled; model-training permission on; details expanded; deletion confirmation; completed deletion with Local restored and editable; saving; enable failure; stop-network failure with local opt-out retained; account unavailable; managed deployment; status-load failure; dark mode; recording redaction off while sharing still requires cloud.

Browser assertions verified enabled/disabled and checked states, successful training opt-in, deletion restoring Local, distinct error copy, and recording redaction remaining off. All 23 PNGs were visually inspected. Capture fixtures and server code are outside the repository and are not part of the PR.
