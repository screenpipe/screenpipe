# Workflow source screenshot previews

These images show the real shared Workflows UI with fictional research data and fictional source images. No customer recordings or private catalog content are included.

- `before.png`: recreated baseline from f02a3d069 using a workflow with empty screenshot attachments but retained source references.
- `after.png`: same workflow and 1440 × 1100 viewport; an available exact source image loads inline.
- `loading.png`, `missing.png`, `error.png`: bounded loading, unavailable capture, and failed lookup states.
- `compact.png`: the same result at 600 × 1000.

Captured with headless Chrome against the maintained Workflows web app, through a temporary fixture route removed before commit. The after preview exercised the selected frame handoff; API behavior is covered separately by adapter tests and a private read-only recorder lookup. These images do not establish installed native-app validation.
