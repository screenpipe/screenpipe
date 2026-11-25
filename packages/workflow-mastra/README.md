# Mastra workflow generation

This is an opt-in development runner for the desktop and standalone recorder.
It runs Discover, Deepen, Review and Maintain with Mastra using the Workflows AI selection. The existing Screenpipe scheduler owns run status,
cancellation, retries and handoffs. The workspace API owns catalog writes,
evidence verification, revisions and receipts.

From the repository root, install the runner dependencies with Bun. Set these
variables in the environment of your Screenpipe development process.

```sh
(cd packages/workflow-mastra && bun install --frozen-lockfile)

export SCREENPIPE_MASTRA_RUNNER="$PWD/packages/workflow-mastra/runner.ts"
```

Start the app from that shell and select **Update workflows**. Automatic
updates use the same runner and model selection. **Intelligent** routes to
Screenpipe Cloud with model `auto`. Screenpipe Cloud presets use their named
model, and explicitly selected Ollama presets use their loopback endpoint.
Other providers use their existing executor.

Unset `SCREENPIPE_MASTRA_RUNNER` and restart to return these tasks to Pi.
The Mastra runner uses the per-task recorder token for evidence and workspace
tools. It can investigate chat activity present in Screenpipe captures.
Direct chat-log files and shell tools are outside its scope.

## Verify locally

From the repository root, run the deterministic subprocess test. It exercises
Mastra against a scripted model and recorder on separate loopback ports.

```sh
bun test packages/workflow-mastra/runner.test.ts \
  crates/screenpipe-core/assets/extensions/workflow-workspace.test.ts
```

Then run the existing evidence evaluation with your local model. It uses
fictional captures and an isolated catalog.

```sh
cd apps/screenpipe-app-tauri
export SCREENPIPE_MASTRA_MODEL='your-local-tool-capable-model'
WORKFLOW_EVAL_TIMEOUT_MS=300000 bun scripts/eval-workflow-workspace.ts --mastra
WORKFLOW_EVAL_TIMEOUT_MS=300000 bun scripts/eval-workflow-workspace.ts --mastra --conflict
```
