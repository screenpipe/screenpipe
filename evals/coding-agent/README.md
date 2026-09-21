# Coding-agent regression evals

This is an agent eval suite, not a unit-test suite. Every case contains:

- a sanitized task derived from an escaped product failure;
- the historical broken repository revision;
- an isolated trial workspace with no future git history;
- a hidden deterministic outcome grader materialized only after the agent stops;
- saved prompt, transcript, candidate patch, grader output, runtime fingerprint, and result;
- repeated-trial reporting with success rate, `pass@k`, and `pass^k`.

The current app corpus contains 64 git-mined regressions. See
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
Node missing-module/syntax diagnostics and Vitest/Vite import-resolution, URL-load or imported-module collection failures
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
Fifty end-to-end controls cover baseline/reference timeouts and signals,
missing ESM/CommonJS modules, Node/Bun syntax and Bun import errors, Vitest
collection failures (including alias imports and Vite resolve-import diagnostics), missing PostCSS-plugin startup
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


## GLM response-to-tool conversion

`ai-gateway-glm-tool-call-boundary` exercises actual GLM completion and streaming
providers with synthetic SDK responses. Forty-two outcomes cover known XML/JSON
calls, typed arguments, multiple unique IDs, fragmented streams, ordinary text,
unknown names, malformed arguments, absent tools, existing native calls and
other OpenAI providers. The broken parent fails fifteen conversions and preserves
twenty-seven neighbors; the reference and current selected source pass all
forty-two outcomes (374 assertions).

Run `bun test evals/coding-agent/calibrate-glm-tool-calls.test.js` for fourteen
controls. These reject unused correct providers, completion/streaming bypasses,
unknown-name conversion, duplicate IDs, lost argument types, missing converted
finish reasons and blanket refusal. Equivalent parser naming and additional
valid finish metadata on unconverted completions are accepted. Missing provider
source is a setup error. No installed dependencies are required.

The SDK and telemetry ports are synthetic; GLM/OpenAI provider dispatch and
current shared protocol are real. This does not execute tools or establish live
model behavior, full schema validation, every malformed XML form, prompt-injection
resistance, native permission checks, encrypted transport or agent isolation.
These are corpus and grader checks, not model trials.


## Meeting summary completion and saved-note handoff

`app-meeting-summary-handoff` mounts the real NoteView, summary surface and
Markdown renderer with the real lifecycle, stream reducer and save queue.
Nine DOM/IO outcomes cover retained streamed text, empty/stale saved reads,
read failure and recovery, already-saved initial state, execution identity,
active-run preservation and unmount cleanup. The parent fails five intended
assertions and preserves four outcomes; reference and selected current source
pass all nine. Only the two production component files are applied as oracle.

Run `bun test evals/coding-agent/calibrate-meeting-handoff.test.js` with the
app JavaScript dependencies installed. Calibration distinguishes behavioral
failures from missing-source setup and rejects an unused helper, stale reads,
lost completion rendering, early refresh bookkeeping and blanket refusal.
Equivalent helper naming remains accepted.

API, native, analytics, context, chat and unrelated child UI ports are synthetic.
The host applies real onSaved callbacks to the meeting prop and permits the
existing autosave of that same note; this is not proof of backend persistence,
crash recovery, real generation, native capture or filesystem isolation.
Dependencies are exposed only during grading. No model trial is implied.


## Verified enterprise allowance through gateway metadata

`ai-gateway-enterprise-allowance` joins real authentication, gateway context and
connection construction with synthetic Clerk and website ports. Twenty outcomes
cover enterprise precedence only after complete entitlement proof, ordinary
consumer capacity, rejection boundaries, hashed identity, serialized metadata,
OpenAI/Anthropic credential removal, cache identity and service/anonymous paths.
The parent fails five intended assertions and preserves fifteen; reference and
selected current source pass twenty. Only auth and gateway service are oracle
patches. This standalone Bun suite needs no installed dependencies.

Run `bun test evals/coding-agent/calibrate-enterprise-allowance.test.js` for
parent/reference, equivalent naming, auth-only/gateway-only bypass, weak flag,
early entitlement bypass, blanket Ultra, wrong wire metadata and missing-source
controls. No website product code is included in this public case.

The actual internal plan policy, model classification and account cache execute;
an unrelated newer GLM provider import is replaced by an unused constant.
This verifies connection configuration, not full route dispatch, cryptographic
verification, website membership computation, real gateway spend enforcement,
settlement, SDK requests, model outcomes or filesystem isolation.


## Restricted enterprise onboarding

`app-restricted-enterprise-onboarding` renders the actual React entitlement gate
and real entitlement policy. Ten outcomes cover live sign-in, cached identity
and build-resolution transitions, alongside ordinary/paid/tokenless consumer,
managed-build and explicit no-auth paths. The parent fails two visibility
assertions and preserves eight outcomes; reference and current source pass ten.
Permitted paths also preserve absence of recorder-stop commands.

Run `bun test evals/coding-agent/calibrate-restricted-onboarding.test.js` with
existing frontend dependencies installed. Calibration rejects blanket onboarding
access/refusal, premature build classification, lost paid-personal exceptions,
missing token requirements and ignored restriction flags. Equivalent internal
names pass; missing source remains setup failure. The grader is installed only
after an evaluated trajectory. Settings, managed policy, analytics and native
commands are synthetic. Native auth, recorder durability, persisted enterprise
policy, live downloads and execution isolation are outside this UI evidence.


## Local-only preset preservation

`app-local-preset-preservation` executes the actual settings provider, shared
settings store and write queue against synthetic native storage and account data.
Twelve outcomes cover cold loads, repeated reloads, sign-in/subscription/sign-out
transitions, malformed saved data, invalid mutations, mixed configurations and
preserved explicit edits. The parent fails eight assertions and preserves four
outcomes; the historical reference and selected current code pass twelve.
Only the settings module is applied as the oracle.

Run `bun test evals/coding-agent/calibrate-local-presets.test.js` to check known
correct/broken, unused-helper, cloud-seeding, account-reset, silent-repair and
blanket-refusal controls, equivalent helper naming and missing-source errors.
The standalone grader needs no installed packages. React hooks and native,
account, event and analytics ports are synthetic; mount effects do not execute.
It does not prove rendered deletion controls, live account refresh, native
durability, enforced isolation or model performance. Preset dependency deletion
recovery remains a separate case.

## Overlapping chat settings and preset outcomes

The `app-chat-overlapping-load-isolation` grader retains all thirteen original
hook/store outcomes and adds delayed-settings-read races. The saved reopen
target and emitted preset must belong to the newest chat after an older read
finishes. The old grader passed a variant with those guards removed; the two
new outcomes reject it. The historical parent fails three outcomes and preserves
twelve; the reference and selected current source pass all fifteen.

Run `bun test evals/coding-agent/calibrate-chat-overlap.test.js` with desktop
JavaScript dependencies installed. Calibration covers the parent, reference,
the original false pass, separate settings/preset bypasses, equivalent request
guard naming, missing source and preserved navigation behavior. The fixture
runs the actual React hook and chat store with synthetic disk, settings and
event ports; title generation is stubbed to prevent model/native execution.

This proves the selected delayed-read ordering, not native persistence, failures
or races within the settings writer, the complete rendered chat UI, real model
selection or enforced agent isolation. No model trial is implied.

## MCP live database boundary

`mcp-live-database-boundary` builds the real historical MCP entrypoint and drives
its stdio tools through the SDK against a loopback API. A child-process preload
models CLI failures/results and records selected filesystem/subprocess effects.
Missing credentials and invalid CLI output must never reach the database; five
preserved paths cover environment precedence, the legacy key and three CLI
discovery routes. Repeated calls verify request credentials and visible results.

Run `bun test evals/coding-agent/calibrate-mcp-db-boundary.test.js` with MCP
dependencies installed. Controls reject the historical fallback, an unused fix,
SQLite access without an existence probe, swallowed direct reads, lost CLI
recovery and blanket denial; equivalent helper naming passes. Missing entrypoint
is retained as a build error rather than intended regression evidence.

Only the entrypoint is the historical oracle. This does not grade instruction
wording or prove model compliance, native database locking, OS-wide filesystem
isolation, real CLI/keychain discovery, package publication or other platforms.
The observed IO ports are synthetic, not a universal access sandbox. Product
startup tests with supplied credentials do not exercise the missing-key fallback.

## Image cache fields at the provider boundary

`ai-gateway-image-cache-boundary` executes the real OpenAI provider methods
against a synthetic SDK that snapshots each submitted request. Fourteen outcomes
cover both streaming modes, three supported image input shapes, image-only
history, text cache boundaries, disabled history caching and older models.
The parent has eight intended failures and six preserved passes; the historical
reference and selected current code pass all fourteen. Returned content is also
checked, so suppressing provider calls cannot manufacture a pass.

Run `bun test evals/coding-agent/calibrate-image-cache.test.js`. Calibration
rejects an unused fix, either caller reintroducing image fields, dropped images
and disabled caching, while accepting equivalent internal predicate naming.
Missing source remains an import error. Only the provider source is the oracle.

The SDK and error-reporting ports are synthetic; no model or network calls run.
This does not prove upstream API acceptance, gateway authorization/billing,
audio/file/refusal normalization, model quality or trial isolation.

## Expired certificate recovery

`app-expired-certificate-recovery` exercises the public provider-error message
and presentation interfaces. Eleven outcomes cover the escaped expired-TLS
signature across hosted, remote and local presets, case normalization, raw-error
suppression, unknown-text fallback and preserved authentication, throttling and
safety-refusal guidance. The parent fails five intended outcomes and preserves
six; the historical reference and selected current code pass all eleven.

Run `bun test evals/coding-agent/calibrate-certificate-error.test.js`. Nine
controls reject an unused fix, blanket connection classification, raw copy,
nonretryable recovery and divergent message output, while accepting equivalent
predicate logic and distinguishing missing source from behavior failure.
Only the error module is the oracle. These synthetic function outcomes do not
prove rendered UI, actual retry dispatch, TLS recovery or provider availability.
No network calls, model trials or native builds run.

## Workflow save receipts and readable context

`app-workflow-save-receipt-boundary` drives the registered workflow tool against
a synthetic loopback recorder. Fourteen outcomes cover rejected operations,
capability and abort boundaries, exact literal payloads, compact context indexes,
owned draft selectors, private snapshots readable through the real transport
normalizer, and successful save receipts that survive a failed follow-up read.
The parent fails eleven intended outcomes and preserves three; reference and
selected current source pass all fourteen.

Run `bun test evals/coding-agent/calibrate-workflow-receipt.test.js`. Eleven
controls reject unused fixes, swallowed errors, oversized inline context,
world-readable snapshots, discarded remaining state and repeated writes, while
accepting equivalent internal naming. Missing imports remain setup failures.
Only the extension is the historical oracle; the existing public transport
normalizer runs unchanged. These outcomes do not prove native persistence,
real agent repair choices, model performance or enforced process isolation.

## Continued Pipe recording directories

`app-continued-pipe-recording-directory` exercises the actual directory resolver
and session parser against synthetic native path/command ports. Eighteen outcomes
cover custom roots, later root changes, Windows-style drive paths, spaces, lookup
fallbacks, and generic routing for ordinary, per-execution and unsafe sessions.
The parent fails seven outcomes and preserves eleven; reference/current pass all
eighteen. Nine calibration controls reject unused fixes, stale caches, unsafe
routing and lost fallback, while accepting equivalent variable naming.

Run `bun test evals/coding-agent/calibrate-pipe-directory.test.js`. Missing modules
remain setup errors. Only the directory resolver is the historical oracle.
The synthetic join uses forward slashes; it does not prove Windows-native path
semantics, native command correctness, complete chat continuation, account-state
relocation or durable session persistence. No model, scheduler or native build runs.

## Device identity across settings resets

`app-device-settings-identity` runs actual settings provider/store reset actions
against synthetic storage and native ports. Nine outcomes cover empty frontend
defaults, legacy and stable identities, compatibility initialization of empty
stored identities, full/individual resets, ordinary field reset and later native
identity changes. Parent: eight intended failures and one preserved pass.
Reference/current: nine passes, 42 assertions.

Run `bun test evals/coding-agent/calibrate-device-identity.test.js`. Ten controls
reject unused fixes, random defaults, full/individual identity loss, blanket
reset refusal and constant identities; an equivalent guard passes. Missing
source remains an import error. Existing product tests cover defaults and
legacy/stable identity resets; this adds no-write, ordinary-reset, compatibility
and later-identity checks. React lifecycle is stubbed; reloads are explicit.
This does not prove native identity generation, actual disk durability, record
collision prevention, model performance or enforced trial isolation.

## Storage migration rollout review

Use [the migration rollout review](MIGRATION-ROLLOUT-REVIEW.md) when evaluating
storage-format changes or managed background migrations. The source-inspected
case distinguishes ordinary user opt-in from the native hidden-UI automatic
path introduced in #7023. A historical fix that intentionally enables broader
migration is not automatically a safe product contract for a new eval.

Run `bun test evals/coding-agent/migration-rollout-review.test.js`. Sixteen
review scenarios cover separate migration authority, native cohort/stop controls,
managed policy changes, recording/pause preservation, disk/history/storage
boundaries, retries, recovery, retention and data-compatible rollback. The
28 passing controls calibrate a structured review grader; they are not native
migration tests or model trials. Existing coding manifests and the shared runner
are unchanged. The current native rollout-policy gap is recorded, not repaired.

## Explicit migration retry readiness

`app-migration-startup-retry` executes the real React prompt and UI controls with
synthetic native status and command ports. The parent offers a retry while startup
is busy or blocked: two intended failures and fourteen preserved passes. The
historical fix and current source pass all sixteen outcomes, including explicit
start/retry, process-scoped deferral, ineligible and reopening storage, permitted
original-database recovery, no source deletion and an unresolved start request.
Only the prompt component is applied as the historical oracle.

Run `bun test evals/coding-agent/calibrate-migration-startup-retry.test.js` with the
desktop JavaScript dependencies installed. Eleven controls reject unused fixes,
either missing readiness gate, blanket suppression, automatic native start,
lost deferral and source deletion. Equivalent readiness expressions pass; a
missing component remains a setup error. These are grader calibrations, not
model trials. Button casing and unrelated presentation copy are not scored.

This UI case is separate from the managed-rollout review above. It does not
establish native migration/recovery durability, disk or NAS behavior, recording
continuity, native authorization, deployment reach or enforced trial isolation.
The native rollout-policy finding remains open. No native build or production
operation is performed; runtime links and fixtures appear only at grading time.

## Maintained workflow retrieval

`mcp-maintained-workflow-retrieval` preserves the escaped #7161 failure: listing
maintained workflows succeeded while retrieval rejected their UUID-based IDs.
The actual workflow tool function runs with a synthetic API port. Seventeen
outcomes cover maintained and legacy IDs, automation-detail defaults and explicit
options, list-to-detail continuity, complete JSON, safe query encoding, pagination,
malformed IDs and injection, refusal before requests, provider failures and a
later explicit retry. The parent fails seven intended outcomes and preserves ten;
the workflow-tools-only reference and current source pass all seventeen.

Run `bun test evals/coding-agent/calibrate-workflow-ids.test.js`. Fourteen controls
reject unused fixes, broad ID acceptance, UUID-only compatibility loss, wrong
identity, option/validation bypasses, empty success and blanket refusal; equivalent
private constant naming passes. Missing source remains a setup failure.

No installed packages or dependency links are required. The hidden fixture is
materialized only for grading. These are corpus and grader checks, not model
trials, native catalog persistence, stdio dispatch, authentication or bounded
stalled-response evidence. No real recordings, credentials or provider calls
are used; execution isolation and model improvement remain unproven.
