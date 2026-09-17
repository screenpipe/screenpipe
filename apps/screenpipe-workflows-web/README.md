# Screenpipe Workflows web host

This app proves that `@screenpipe/workflows-ui` renders as a normal website without importing Tauri or desktop commands.

- `/` uses the production web adapter. The host website supplies authenticated `POST /api/workflows/runtime` and `POST /api/workflows/analyze` endpoints.
- `/preview` uses fictional data so the complete experience can be reviewed or captured safely.
- `/enterprise-preview` uses fictional organization data and the same confidential-cloud, multi-scope contract as the enterprise website.
- The website API owns authentication and processing. Browser code never receives a Screenpipe API key or direct recorder access.

The Tauri app mounts the same `WorkflowsApp` through its desktop adapter. Product UI changes therefore land once in `packages/workflows-ui` and appear in both hosts.
