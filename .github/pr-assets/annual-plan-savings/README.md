# Annual billing banner evidence

Actual Screenpipe frontend rendered in its browser-mock app shell with fictional account, billing, chat, and meeting fixtures. No customer data or live billing changes.

- Product source: `34bd92a90`.
- Before: recreated from base `91e37b48e` using the same account fixture, viewport, theme, and app route.
- Desktop: 1440 × 960. Compact: 760 × 820, sidebar collapsed with the app shortcut.
- Production fonts and theme styles loaded. Reduced motion enabled.
- Native HTTP and browser-opening boundaries were mocked. No native build or real Stripe change was performed.
- Temporary account seed, browser transport adapter, and capture configuration were removed before committing.

| Screenshot | State |
| --- | --- |
| before.png | Baseline, no annual offer |
| after.png | Monthly subscriber, light mode |
| dark.png | Monthly subscriber, dark mode |
| compact.png | Compact window with collapsed navigation |
| keyboard-focus.png | Keyboard focus on Switch to annual |
| opening.png | Browser opening, action disabled |
| error.png | Browser launch failed, retry available |
| opened.png | Browser opened, explicit confirmation still required |
| dismissed.png | Keep monthly, persisted across reload |
| already-annual.png | Annual subscriber, offer hidden |
| meetings.png | Placement in the Meetings section |

Browser assertions passed for the same-plan annual review URL, opening/error/retry states, persisted dismissal, hidden annual offer, and compact banner bounds. Final images were inspected at full size.
