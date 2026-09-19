# Coding-agent regression evals

This is an agent eval suite, not a unit-test suite. Every case contains:

- a sanitized task derived from an escaped product failure;
- the historical broken repository revision;
- an isolated trial workspace with no future git history;
- a hidden deterministic outcome grader materialized only after the agent stops;
- saved prompt, transcript, candidate patch, grader output, runtime fingerprint, and result;
- repeated-trial reporting with success rate, `pass@k`, and `pass^k`.

The current app corpus contains 44 git-mined regressions. See
[DESIGN.md](./DESIGN.md) for the Anthropic guidance, source contract, and
history-mining workflow. The companion website manifest uses this same harness.

The MCP config symlink case grades Settings-side IO with synthetic files and
real links on a symlink-capable host. Its platform path-resolution port is
substituted; passing it does not establish native bridge or desktop acceptance.

The regression inventory has an explicit owner and advisory/blocking policy.
New cases may declare trigger paths for later change-aware selection. Validation
prints the dataset fingerprint, and scored reports retain both dataset and
runtime fingerprints for exact-run comparison.

The product tests referenced by the manifest are graders. Passing them directly is not the eval; the evaluated object is an agent trajectory and resulting patch from the historical broken state.

## Validate the corpus

```bash
node evals/coding-agent/run.mjs --validate
node evals/coding-agent/run.mjs --verify
```

`--verify` proves each historical base fails its hidden grader and its known fix passes. A case is invalid if either side of that contrast is missing.

## Run agent trials

```bash
node evals/coding-agent/run.mjs \
  --case app-chat-concurrent-save \
  --trials 3 \
  --agent-command 'codex exec --ephemeral --approve-for-me --json -C {workspace} - < {prompt_file}'
```

The agent receives only the task and archived broken tree. It does not receive the oracle commit, grader definition, or future repository history.

Results are written under `evals/coding-agent/results/` unless `--results-dir` is supplied. Use `--keep` only for debugging a failed trial.

Agent-process, grader-process and harness failures are reported as `error` and excluded from
the success denominator. They are never silently converted into model failures.
Grader timeouts and terminating signals cannot establish a failing baseline:
`--verify` requires a behavioral `fail` followed by an oracle `pass`.
Known command-unavailable exits (126/127), Bun unhandled test-load errors, and
Node missing-module/syntax diagnostics and Vitest URL-load collection failures
with zero tests are also reported as `error`, with a
`grader_error_kind` in the result. A missing import followed by an oracle pass
therefore cannot certify a regression. Plain failed assertions and successful
commands containing diagnostic words retain their previous outcomes.

This is bounded diagnostic recognition, not universal error attribution. Unknown
setup/compiler failures, including other test frameworks, may still be ordinary
nonzero exits. Inspect logs before promoting a case; preserve command exit codes
in wrappers. An error is not proof that infrastructure, rather than a candidate
change, caused it. Report error counts and inspect candidate-caused errors before
comparing model success rates. No isolation or model-quality claim follows.

Run the synthetic runner controls with `bun test ./evals/coding-agent/run.test.ts`.
Nineteen end-to-end controls cover baseline/reference timeouts and signals,
missing ESM/CommonJS modules, Node/Bun syntax and Bun import errors, Vitest
collection failures and quoted diagnostics followed by real assertions, unavailable
or non-executable commands, genuine failures, assertions quoting diagnostic words or complete diagnostic blocks,
already-passing baselines and exclusion of known setup/process errors from scores.
The controls use temporary local Git fixtures and invoke no model or provider.

The same runner can score another checkout and manifest with `--repo` and
`--manifest`; the website corpus uses this so both repositories share exactly
one harness implementation.

## Modes

- `agent`: run the configured coding agent and grade its patch.
- `baseline`: make no change and grade the broken revision.
- `oracle`: apply the historical fix and grade it.
- `regrade`: apply a saved `candidate.patch` and run the current grader without another model call.
- `--verify`: require baseline failure plus oracle success.

Do not turn capability scores into a release gate after one run. Establish matched-environment repeated baselines first. Regression cases intended to block should target reliable `pass^k`, not a lucky `pass@k`.

The app-provider-outage-vs-limit case uses standalone Bun tests without installed package dependencies. `BUN_BIN` may select an explicit Bun binary. It checks provider presentation semantics, not live model availability.

The app-entitlement-plan-consistency case uses a fixed clock and standalone Bun tests to verify historical account normalization and downstream plan policy. Its URL configuration port is synthetic; it does not test gate rendering, billing connectivity, telemetry or recording.

The ai-gateway-verified-identity case invokes the historical `validateAuth`
boundary with synthetic Clerk verification and website/database response ports.
It rejects public account identifiers as credentials, malformed verifier subjects
and unsuccessful legacy responses while preserving legitimate authenticated and
anonymous behavior. Only `auth.ts` from the fixing commit is applied as the
oracle; the same commit's route and native-settings changes are outside this
case. No JWT cryptography, live account, billing, or full gateway route behavior
is exercised.

Calibrate the identity grader with:

```bash
bun test evals/coding-agent/calibrate-gateway-identity.test.js
```

The five controls require the historical contrast, accept equivalent helper
renaming, reject an identifier-trusting fast path, and reject blanket anonymous
fallback. These are grader controls, not model trials. The July 10 historical
case does not require machine-service-token support introduced afterward.

## Bounded history discovery

`mine-history.mjs` scans all reachable history by default, including merged
branches and merge commits. Page with `--limit` and `--skip`; continue using the
returned `resolved_ref` SHA and `next_skip` to keep page boundaries stable.
An explicit `--since` narrows the scan. Merge candidates expose each parent diff
and require resolution review before choosing a broken baseline. The miner is
still a subject/test-path heuristic, so its output is discovery evidence, not
complete source review or verified regressions. See [DESIGN.md](./DESIGN.md).

`bun test evals/coding-agent/mine-history.test.ts` runs four synthetic controls
covering old and merged fixes, per-parent merge paths, complete bounded paging,
root/non-fix exclusions, explicit date filtering and invalid inputs.
