# Workflow review notification states

Fictional fixture data in the main desktop app's browser-mock surface. These are proposed-build state captures, not screenshots of a running packaged macOS app. The notification image uses the existing webview fallback panel; native SwiftUI presentation remains to be checked in a packaged build.

Captured with `apps/screenpipe-workflows-web/scripts/eval-workflow-notifications.ts`, at 1440×1000 for desktop, 390×844 for the narrow viewport, and 340 CSS pixels for the notification panel. The script verifies quiet readiness, a batch, exact workflow routing, duplicate delivery, unavailable workflows, narrow layout, and cold-start URL recovery. Animations are completed for capture.

The default catalog layout is unchanged. No pre-change screenshot was captured; the PR uses an ASCII comparison for the prior routing behavior and this gallery for the proposed states.
