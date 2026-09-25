# Chat link actions: visual evidence

Captured September 25, 2026 from the production MarkdownBlock, ChatWebLink,
LinkPreviewAnchor, context menu, and toast components in a temporary isolated
Next.js preview. The preview loaded the app theme and fonts and used fictional
text with example.com. No customer data is present.

Implementation: 6fb9be894a85c7b598f0212361a97f84e244f71a.
Recreated baseline component: 43c6dd9ba (the implementation's parent).
Desktop: 1200 × 700 at device scale 1. Narrow: 520 × 700.

- before.png: original link at rest.
- after-idle.png: new link at rest; appearance intentionally unchanged.
- link-hover-preview.png: existing hover preview remains available.
- link-mouse-leave.png: preview dismissed after mouse leave.
- link-menu-light.png: right-click menu; preview does not overlap it.
- link-menu-external-hover.png: external-browser action highlighted.
- link-menu-keyboard.png: Shift+F10 opens the menu with keyboard focus.
- link-menu-dark.png: dark theme.
- link-copied.png: copy-success toast using a simulated native result.
- link-navigation-error.png: navigation-error toast using a simulated native result.
- link-copy-error.png: clipboard-error toast using a simulated native result.
- link-menu-no-sidebar.png: consumers without a side browser show external/copy only.
- link-menu-narrow.png: narrow viewport and wrapped link.
- link-menu-reduced-motion.png: keyboard menu with reduced motion at narrow width.

The capture exercised menu open/close, hover dismissal, Shift+F10, Escape,
copy-success, navigation-error and copy-error handling. Native navigation and
clipboard responses were stubbed in the temporary preview; no operating-system
clipboard was changed. These images do not verify native WebKit rendering,
external-browser launch, native clipboard integration, or cross-platform desktop
behavior. The temporary route and fixtures were removed before validation and
are not part of the patch.
