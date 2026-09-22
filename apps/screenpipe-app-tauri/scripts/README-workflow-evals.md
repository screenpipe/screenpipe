# Workflow agent evaluations

These opt-in scripts use the installed Pi harness and signed-in Screenpipe AI
account. They spend tokens. They use the repository prompts and shared skill with
the production permission, MCP and context-guard extensions. No custom workflow
tools are installed.

From `apps/screenpipe-app-tauri`:

```sh
bun scripts/eval-workflow-pipeline.ts --large-context
bun scripts/eval-workflow-pipeline.ts --review-context
bun scripts/eval-workflow-discovery.ts
bun test scripts/eval-workflow-quality.test.ts
```

The receipt fixture covers pagination, busy reads, separate occurrences, personal
exclusion and oversized handoffs. The review fixture distinguishes a user's
customer-feedback activity from a customer's screen-shared SOP and rejects
invented durations for unfinished calls. Discovery checks source failures,
rejected writes, workflow identity and notification decisions.

## Real activity, isolated writes

Use an explicit historical interval and a new empty **private directory outside
the repository**. The local eval API forwards only allowlisted GETs to the local
recorder. Stage/catalog writes stay in memory; notifications are simulated.
The agent still chooses its own queries. The proxy is eval infrastructure and is
never installed or used by the product.

```sh
WORKFLOW_EVAL_START='2026-01-01T09:00:00-08:00' \
WORKFLOW_EVAL_END='2026-01-01T10:00:00-08:00' \
WORKFLOW_EVAL_REPORT_DIR='/absolute/private/new-report-directory' \
bun scripts/eval-workflow-pipeline.ts --real

bun scripts/eval-workflow-quality.ts /absolute/private/new-report-directory
```

Authentication uses `SCREENPIPE_LOCAL_API_KEY` or the existing `screenpipe auth
token` command. The real credential stays in the proxy; the agent gets an eval
credential. `SCREENPIPE_LOCAL_API_URL` selects the local recorder. An optional
`WORKFLOW_EVAL_MODEL` allows a controlled model comparison; it does not change
product defaults. The script defaults to `auto`; it does not resolve the desktop's
encrypted preset settings. Set the model explicitly to compare a particular preset.
`WORKFLOW_EVAL_CONTEXT` optionally seeds the isolated catalog
and profile from a private JSON snapshot of `/workflows/context`, for testing
updates to an existing library. Real runs use each Pipe's configured timeout;
fictional stages are limited to 180 seconds. Each temporary workspace
is removed afterward. Reports retain prompts, agent traces, source responses and
outputs even on failure. Keep them private; never attach raw real reports to a PR.

The real-data fixture rejects activity coverage outside successful overview
reads and rejects new catalog citations that do not match its retrieved source
responses. Unchanged prior-catalog steps are retained without claiming they were
reverified. These checks are narrower than the full production persistence API;
the test does not replace server integration tests.
A reported save only proves the agent reached the simulated persistence seam;
it does not prove the installed app persisted or rendered the result.

## Quality gate

The audit requires usable steps and matches every procedure/timing citation to
retrieved source text, app and timestamp. CSV evidence auditing uses Python 3's
standard CSV parser. A matching quote is necessary but not sufficient: it may
still be a request, an assistant suggestion, someone else's screen share or an
unrelated sidebar. A semantic review is required before declaring output useful.

Review each generated workflow for:

- A specific trigger and reusable procedure, rather than an app/category recap.
- Steps supported by the source's meaning, with requested vs completed work clear.
- Correct actor attribution, distinct jobs and meaningful variants.
- No fabricated recurrence, elapsed duration, completion, bottleneck or savings.
- Useful details for a future skill/SOP without leaking unrelated personal data.

Keep baseline failures, rerun after a concrete change, and test a separate interval
before claiming generalization. Report empty or failed runs, not just successful
samples. A synthetic pass alone does not establish real-data output quality.
