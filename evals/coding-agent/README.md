# Coding-agent regression evals

This is an agent eval suite, not a unit-test suite. Every case contains:

- a sanitized task derived from an escaped product failure;
- the historical broken repository revision;
- an isolated trial workspace with no future git history;
- a hidden deterministic outcome grader materialized only after the agent stops;
- saved prompt, transcript, candidate patch, grader output, runtime fingerprint, and result;
- repeated-trial reporting with success rate, `pass@k`, and `pass^k`.

The current app corpus contains 51 git-mined regressions. See
[DESIGN.md](./DESIGN.md) for the Anthropic guidance, source contract, and
history-mining workflow. The companion website manifest uses this same harness.

`app-onboarding-fresh-assignment-login` selects thirteen historical React outcome
tests for disabled/absent experiment flags, final-identity assignment, pinned
routes, fresh-login completion across login-screen unmounts, hydration/resume
exclusion and preserved treatment/control eligibility. The actual page and, for
the login-transition cases, real login gate run against synthetic settings,
managed-policy, analytics and native-command ports. Other slides are test doubles.
The parent fails two intended outcomes and preserves eleven; the reference and
the matching thirteen tests in current product source pass. Unselected product
tests are explicitly skipped, not counted as verified outcomes.

Run `bun test evals/coding-agent/calibrate-onboarding-assignment.test.js` with the
desktop's JavaScript test dependencies installed. Controls reject an unused
correct page, stale callback acceptance, duplicate or lost completion, hydration
miscounting, blanket control assignment and false error telemetry, while accepting
equivalent state naming and distinguishing missing-source setup errors. Only the
page and login gate are applied by the historical oracle. Dependencies are linked
only when grading begins; this does not establish execution isolation. No live
login, PostHog delivery, checkout, recorder or native build is exercised, and no
model trial is implied. Newer workflow/auth-restore behavior remains outside the
historical case.

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
Known command-unavailable exits (126/127), Rust compiler failures before test execution,
Bun unhandled test-load errors, and
Node missing-module/syntax diagnostics and Vitest URL-load or imported-module collection failures
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
Forty-three end-to-end controls cover baseline/reference timeouts and signals,
missing ESM/CommonJS modules, Node/Bun syntax and Bun import errors, Vitest
collection failures (including alias imports), missing PostCSS-plugin startup
failures, Rust/Cargo compilation failures and assertions quoting compiler output,
quoted diagnostics followed by real assertions, unavailable or non-executable
commands, genuine failures, assertions quoting diagnostic words or complete diagnostic blocks,
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

## Privacy category ownership caller coverage

`app-privacy-category-rule-ownership` executes the historical PrivacySection,
ContentFiltersCard and category-switch modules, then inspects writes at the
settings IO boundary across repeated interactions with fresh component state.
Fifteen outcomes cover manual domain/app exclusions, owned-filter cleanup,
other-category and include-rule preservation, repeated disable and legacy state.
The original helper-only fixture accepted an incomplete patch whose UI still
deleted the user's domain; the replacement rejects that bypass.

Run `bun test evals/coding-agent/calibrate-privacy-ownership.test.js` for eleven
controls: parent/reference, helper-only patch, missing persistence/reload/card
forwarding, equivalent callback/component and ownership-field renaming, no-op,
removed categories and missing-source setup failure. These are deterministic
grader controls, not agent trials.

The complete source modules are compiled with Bun and executed with synthetic
React hooks/host elements, identity sanitization and settings IO. Unrelated
native, telemetry, discovery and visual ports are substituted; native/provider
actions fail closed. This is not React reconciliation, DOM/browser interaction,
real settings-store serialization, validation, native capture or current-head
integration. The adapter retains the existing category-switch UI contract;
module relocation or a different UI/IO abstraction can require recalibration.
No dependency link or model call is needed for historical verification.

Vite can reject a missing PostCSS plugin before reporting any test-count summary.
The runner recognizes the bounded combination of a Vitest startup banner,
unhandled rejection, PostCSS load failure, missing-plugin diagnostic and config
path as `vitest_postcss_setup_error`. Executed-test summaries, assertion headers
and successful exits retain their previous results. This does not classify all
PostCSS/compiler errors or prove whether the candidate caused a setup failure.
The 27 synthetic CLI controls include both baseline/reference startup failure,
quoted diagnostics with and without a Vitest test summary, and successful output.

The ai-gateway-billing-capacity-compatibility case exercises actual gateway auth
with synthetic Clerk and website ports and the real entitlement cache. It covers
canonical Max/Ultra capacity, older access labels, malformed or contradictory
plan truth, identity binding and cache admission. It does not test live billing,
cryptographic verification, provider settlement or cross-service deployment.
Run `bun test evals/coding-agent/calibrate-billing-capacity.test.js` to check
correct, broken, equivalent and bypass implementations of the grader contract.

## Execution provenance

Each graded trial records SHA-256 hashes of the exact fixture bytes materialized
into the workspace, their destinations and executable flags, resolved Git source
commits where applicable, and the grader command hash and timeout. It also records
the startup bytes of `run.mjs` and `grader-outcome.mjs`, independently of the repo
being evaluated. These records are retained in verification results too.

`evaluation_fingerprint` identifies the case definition, resolved base, hidden
grader and harness inputs. The report combines selected case fingerprints with
the manifest and runtime fingerprints. It remains stable across output-directory
changes and equivalent runner relocation; changed grader or harness bytes change
it. `dataset_fingerprint` continues to mean the manifest bytes alone. If setup
prevents collecting a trial's grader provenance, the report marks
`provenance_complete: false` and leaves its evaluation fingerprint null.

Run `bun test evals/coding-agent/fingerprints.test.ts` for actual caller controls
covering changed local/Git grader inputs, moved refs, imported classifier and
runner changes, repeated runs, relocation, selection and setup failure. These
use synthetic repositories without model calls.

This is input provenance, not a complete reproducibility or isolation guarantee.
Dependency directories, compilers, external services, ambient environment and
sandbox enforcement are not attested by these hashes. Do not use a matching
fingerprint alone to claim matched agent trials or unchanged product behavior.


## Running MCP enterprise credentials

`mcp-team-credential-reload` builds and starts the real historical MCP server,
connects a real SDK stdio client, and observes synthetic loopback HTTP requests
while changing a temporary enterprise settings file. Seven scenarios cover token
replacement, matching gateway rotation, first-time configuration, clear/delete/
malformed recovery, override precedence, expired-token guidance without secret
exposure, and preservation of local tool listings. Telemetry is disabled and
local API credentials are synthetic. Only the two production source changes
are applied by the oracle; builds are created inside each grading workspace.

Run `bun test evals/coding-agent/calibrate-mcp-team-reload.test.js` with the MCP
package dependencies installed. Eight controls retain the parent/reference
contrast, reject an unused-helper fix, cached settings, stale gateway pairing
and blanket denial, accept equivalent naming, and distinguish a missing-source
build failure. These are deterministic corpus/grader tests, not model trials.

The fixture tests sequential saved-file changes and real local process/protocol
behavior. It does not verify concurrent file writes, native desktop persistence,
external enterprise gateways, token cryptography or the harness's filesystem
isolation. Dependencies are exposed only during grading, after the trajectory.


Vitest can register tests and then skip them because a `beforeAll` Bun build
failed. A bounded missing-input compiler diagnostic, failed suite and skipped
summary with no test failures is now `vitest_bun_build_setup_error`; passing
neighboring tests do not turn the build failure into regression evidence.
Assertions quoting compiler diagnostics and successful commands retain their
outcomes. The runner controls cover both baseline/reference build-hook failure,
neighboring passes, quoted assertion diagnostics and error exclusion from scores.
An actual Bun compiler/Vitest setup failure previously certified a false valid
contrast; it now becomes an error and invalid verification. This is bounded
recognition, not general compiler attribution or proof of execution isolation.


The `grok-installer-explicit-consent` case executes the real JavaScript installer
entry point against synthetic encrypted files, the actual decryption routine,
a mocked OS credential command and an in-memory gateway. Fifteen outcomes reject
passive/unsupported actions before file discovery and preserve explicit connect,
idempotent retry, disconnect, unrelated workflows, absent-app handling and safe
errors. Only the installer file from the historical fix is applied as oracle.

Run `bun test evals/coding-agent/calibrate-grok-consent.test.js` for calibrated
parent/reference, equivalent implementation, late refusal, status bypass,
blanket denial, skipped installation/removal and missing-source controls.
This standalone adapter requires macOS; it does not call Keychain or a provider.
It does not verify the native credential-free status cache, browser-cookie
consent, Windows DPAPI, UI interaction or enforced agent isolation.


`app-private-reasoning-budget` executes the actual Private GLM request adapter
and protocol normalizer with a synthetic verified-client port. Twenty-two
outcomes cover effort translation, bounded reasoning, reserved answer/tool
output, output-limit precedence, body-override refusal and preserved auth, cache
rotation, request destination, cancellation and verification-failure boundaries.
Only the transport file from the historical fix is applied as the oracle.

Run `bun test evals/coding-agent/calibrate-private-reasoning.test.js` for
parent/reference, equivalent local naming, missing output reserve, blanket
budget changes, verification/auth-cache bypass, no-op and missing-source
controls. No dependencies, actual encryption, attestation, model calls, native
app or provider access are exercised; this is request construction, not proof
of sampler enforcement, response quality or agent isolation.

## Preset deletion through settings persistence

`app-preset-deletion-save-recovery` calls the real settings provider update,
settings write queue, dependency reassignment and conversation persistence.
Thirteen outcomes exercise task/chat write failure and retry, partial progress,
hidden destinations, newer selections after discovery, preserved content and
unrelated references, queued updates, and final settings-save failure. The
historical parent has nine behavioral failures and four preserved passes.

Run `bun test evals/coding-agent/calibrate-preset-save.test.js` for the hidden
grader controls. The standalone suite uses synthetic native filesystem/store,
HTTP, event and UI state ports; React binding is simulated without running mount
effects. It does not prove rendered UI rollback, native filesystem durability,
cross-process races, or recovery after the final store save fails. No installed
packages or native build is needed. Source setup errors cannot establish the
regression. Actual model trials and enforced trial isolation remain separate.

The `ai-gateway-glm-bounded-tool-history` case observes outgoing SDK requests
from the real GLM and OpenAI provider methods, including streaming. It checks
Pi-triggered bounds, retained evidence and tool pairing while preserving small
results, ordinary clients, user/assistant prose, caller inputs and other providers.
The parent fails twelve intended outcomes and preserves fourteen; the historical
fix and current gateway/protocol implementation pass all twenty-six.

Run `bun test evals/coding-agent/calibrate-glm-tool-history.test.js` for bypass,
streaming, boundary, identity-loss and preserved-client controls. A different
valid head/tail allocation is accepted. The SDK transport and telemetry are
synthetic; there is no live inference, token-budget sufficiency, encrypted
transport, gateway authentication, native persistence, model or isolation claim.
