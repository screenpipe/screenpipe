# Trial allowance recovery evidence

Actual UpgradeQuotaBanner component in an isolated browser preview with synthetic quota responses. The surrounding chat text and composer are fixture context, not a full native-app screenshot. Product globals.css, Tailwind configuration, and bundled Inter font were loaded. Viewport: 1280 × 720.

- before.png: baseline component recreated from 6102ff07e, trial rejection with a null reset timestamp plus a separately polled daily reset and generic Business Max action.
- after.png: trial rejection, explicit no-daily-reset explanation, Manage trial action.
- after-dark.png: same trial rejection in dark mode.
- paid-business.png: paid daily allowance rejection retains its real reset and Business Max action.

The Manage trial click was checked in the isolated preview and resolves to https://screenpipe.com/account/billing without a target plan. External navigation was stubbed, so no billing operation occurred.

These images verify presentation, not a production allowance reset, payment, deployment, or the customer's installed app.
