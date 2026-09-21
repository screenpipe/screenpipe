# Screenpipe Workflows web host

This app proves that `@screenpipe/workflows-ui` renders as a normal website without importing Tauri or desktop commands.

- `/` uses the production web adapter. The host website supplies authenticated `POST /api/workflows/runtime` and `POST /api/workflows/analyze` endpoints.
- `/preview` uses fictional data so the complete experience can be reviewed or captured safely.
- `/enterprise-preview` uses fictional organization data and the same confidential-cloud, multi-scope contract as the enterprise website.
- The website API owns authentication and processing. Browser code never receives a Screenpipe API key or direct recorder access.

The Tauri app mounts the same `WorkflowsApp` through its desktop adapter. Product UI changes therefore land once in `packages/workflows-ui` and appear in both hosts.

## Workflow editor check

With Chrome installed, start `bun run dev`, then run `bun run test:editor` in a
second terminal. `WORKFLOWS_PREVIEW_URL` can point to another local preview port;
`WORKFLOW_EDITOR_ARTIFACTS` selects the screenshot directory (defaults to a
folder in the system temporary directory).

The headless test uses fictional data in an isolated browser profile. It checks
inline editing, drag and keyboard reordering of steps and blocks, undo, required
fields, failed-save draft retention, save/reload persistence, concurrent saves,
cancel, unfinished draft recovery after navigation, and narrow-window sizing.
The current host uses the same light palette under both system color preferences.

The desktop adapter saves through the authenticated local catalog endpoint.
Backend tests cover revision conflicts, preservation of captured references,
manual fields surviving AI reconciliation, rejection of agent-authored manual
edits/fabricated evidence, and atomic save failure/reload. Run them from the repo
root with `cargo test -p screenpipe-engine --lib routes::workflow --no-default-features`.
The preview validates the UI with local fixture storage; it is not a native-app
installation test. Manual changes do not retroactively rewrite existing SOPs.

Editing a step or its order makes the ordered step list owner-controlled.
Later AI updates retain it and can refresh untouched descriptive fields. Editing
only a title does not lock the steps. Original captures remain references and
are never rewritten by the editor.
