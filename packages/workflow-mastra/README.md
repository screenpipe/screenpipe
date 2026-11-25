# Local Mastra workflow generation

This is an opt-in development runner for the desktop and standalone recorder.
It runs Discover, Deepen, Review and Maintain with Mastra and a local
OpenAI-compatible model. The existing Screenpipe scheduler owns run status,
cancellation, retries and handoffs. The workspace API owns catalog writes,
evidence verification, revisions and receipts.

From the repository root, install the runner dependencies with Bun. Set these
variables in the environment of your Screenpipe development process.

```sh
(cd packages/workflow-mastra && bun install --frozen-lockfile)

export SCREENPIPE_MASTRA_RUNNER="$PWD/packages/workflow-mastra/runner.ts"
export SCREENPIPE_MASTRA_MODEL="your-local-tool-capable-model"
# Optional. The default is Ollama on loopback.
export SCREENPIPE_MASTRA_MODEL_URL="http://127.0.0.1:11434/v1"
```

Start the app from that shell and use **Update workflows** with **Automatic
updates** enabled. Existing background workflow cycles also use Mastra while
the variables are set. Use a model served on-device. A loopback proxy can
forward requests outside this machine. To switch back, unset `SCREENPIPE_MASTRA_RUNNER` and
restart the app. The opt-in supplies the model for those tasks. Chat and
enterprise-managed tasks continue using their own configured executors.

The local runner uses the per-task recorder token and exposes Screenpipe
evidence reads plus the existing workflow workspace tool. It can investigate
chat activity present in Screenpipe captures. Direct chat-log files, shell
tools, hosted providers and app-bundled installation are outside this runner's
scope.

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
WORKFLOW_EVAL_TIMEOUT_MS=300000 bun scripts/eval-workflow-workspace.ts --mastra
WORKFLOW_EVAL_TIMEOUT_MS=300000 bun scripts/eval-workflow-workspace.ts --mastra --conflict
```
