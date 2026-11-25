---
name: render-html-report
description: Produce a human-facing visual report — a chart, dashboard, scorecard, or styled summary — that renders as a live page in the screenpipe viewer instead of plain text. Use when the task asks for a visual/graphical output rather than a plain note; do NOT use for plain text or raw data (prefer a markdown note for those).
---

# render an html report

screenpipe's in-app viewer can render a standalone `.html` file as a live page (charts, dashboards, styled reports) — but only when you **opt in** and keep the file **self-contained**. Otherwise it shows as raw source.

## the two rules

1. **Opt in.** The first line of the file must be the marker:

   ```
   <!-- screenpipe:render=human -->
   ```

   (or `<meta name="screenpipe:render" content="human">` inside `<head>`). Without it the file shows as source, not a rendered page.

2. **Self-contained — no network.** It renders in a locked-down sandbox with **zero network access**. So:
   - inline **all** CSS in a `<style>` tag and **all** JS in a `<script>` tag;
   - embed any images as `data:` URIs;
   - **no** external `<script src>` / `<link rel=stylesheet>` / CDN, **no** `fetch`, **no** forms that POST.

   Anything that touches the network is silently blocked — **a CDN-loaded chart library renders blank**. Draw charts with **inline SVG** or plain HTML/CSS bars instead (see the template).

## how the user sees it

Write the file (e.g. `./output/report.html`), then link it with an **absolute** path from your note or notification — e.g. `[open report](/Users/me/.../output/report.html)`. The user clicks it; the viewer offers **"preview rendered"**; it renders inside the sandbox. Only standalone `.html` / `.htm` files render — HTML pasted inside a markdown note does not.

The viewer matches the host light/dark theme; if you care about dark mode, style with `@media (prefers-color-scheme: dark)`.

## template (copy, then fill in with real data)

```html
<!-- screenpipe:render=human -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 24px; font-family: system-ui, -apple-system, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin: 0 0 20px; }
  .cards { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .card { flex: 1; min-width: 120px; background: #f4f4f5; border-radius: 10px; padding: 12px 14px; }
  .card .label { font-size: 12px; color: #666; }
  .card .value { font-size: 24px; font-weight: 600; }
  .bar { fill: #3b82f6; }
  .axis { fill: #999; font-size: 11px; }
</style>
</head>
<body>
  <h1>daily focus report</h1>
  <p class="sub">where your time went today</p>

  <div class="cards">
    <div class="card"><div class="label">tracked</div><div class="value">6.4h</div></div>
    <div class="card"><div class="label">top app</div><div class="value">vs code</div></div>
    <div class="card"><div class="label">meetings</div><div class="value">3</div></div>
  </div>

  <!-- inline SVG chart — no chart library (CDNs are blocked in the sandbox) -->
  <svg viewBox="0 0 400 180" width="100%" role="img" aria-label="hours per app">
    <rect class="bar" x="20"  y="40"  width="50" height="120"></rect>
    <rect class="bar" x="90"  y="80"  width="50" height="80"></rect>
    <rect class="bar" x="160" y="110" width="50" height="50"></rect>
    <rect class="bar" x="230" y="130" width="50" height="30"></rect>
    <text class="axis" x="45"  y="174" text-anchor="middle">code</text>
    <text class="axis" x="115" y="174" text-anchor="middle">chrome</text>
    <text class="axis" x="185" y="174" text-anchor="middle">slack</text>
    <text class="axis" x="255" y="174" text-anchor="middle">mail</text>
  </svg>
</body>
</html>
```

## checklist before you save

- [ ] first line is `<!-- screenpipe:render=human -->`
- [ ] all CSS/JS inline; all images are `data:` URIs
- [ ] no CDN / `<script src>` / `fetch` / forms
- [ ] linked from the note or notification with an **absolute** path
