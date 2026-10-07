# Coding-agent regression evals

The unmarked HTML file-preview case executes ViewerFileContent with the actual
Markdown, code-renderer, iframe and sandbox helper sources. It checks full and
snippet previews, parsed content/CSP metadata, source toggling, path transitions,
Unicode names/content and preserved text/Markdown. Fourteen calibration controls
include unused-correct code, empty/comment-only output, unsafe origin, fake CSP,
lost toggling/Markdown, equivalent implementations and missing-source setup errors.
Dependencies and hidden fixtures are installed only when grading begins. Synthetic
native/media/translation ports and JSDOM do not prove browser network/IPC enforcement,
Brain-view integration, execution isolation or model improvement.

This is an agent eval suite, not a unit-test suite. Every case contains:

- a sanitized task derived from an escaped product failure;
- the historical broken repository revision;
- an isolated trial workspace with no future git history;
- a hidden deterministic outcome grader materialized only after the agent stops;
- saved prompt, transcript, candidate patch, grader output, runtime fingerprint, and result;
- repeated-trial reporting with success rate, `pass@k`, and `pass^k`.

`app-search-focus-lifecycle` runs the actual search page, focus hook and DOM
listener hook with synthetic native events and a small search-view shell. Ten
outcomes cover hidden prewarm, hide/show cycles, focus recovery, query resets,
navigation, close and unmount. The parent fails three hidden-focus outcomes and
preserves seven; the historical page fix and current source pass ten. Run
`bun test evals/coding-agent/calibrate-search-focus.test.js` for twelve controls,
including a mounted-but-inactive equivalent, unused correct code, blanket
inactivity, ignored hide events and lost query/focus/handoff behavior. Missing
source is a setup failure. Fixtures and runtime links appear only at grading.
This does not execute the full search modal, native window events, macOS focus,
real IPC, execution isolation or model trials. Current cache prewarm is checked
separately and is allowed while the view is hidden.

`app-mixed-note-paste` mounts the actual React and TipTap meeting-note editor
with synthetic image conversion and inert menus/localization. Five outcomes cover
mixed text/image paste, ordinary text, image-only files and HTML, and a delayed
image after a keyed meeting switch. The parent loses mixed-paste text; four nearby
outcomes pass. The historical fix and current source pass all five. Run
`bun test evals/coding-agent/calibrate-note-paste.test.js` for calibration,
including unused correct code, equivalent paragraph construction, lost text or
images, blanket paste refusal and missing-source classification. Fixtures and
dependency links appear only when grading begins. This does not execute native
clipboard delivery, image encoding, disk autosave, agent isolation or model trials.

`app-compressed-pending-sqlx-upgrades` runs real temporary SQLite and compressed
stores through normal database startup. Six outcomes cover pending feature
migrations, rollback and retry, retained recordings and starred sessions, resident
revision/privacy hooks, and ordinary SQLite behavior. The historical parent fails
four upgrade outcomes and preserves two; the reference and current source pass
six. Run `bun test evals/coding-agent/calibrate-compressed-sqlx-upgrade.test.js`
for eight controls, including equivalent source, unused correct code, skipped
migrations, lost sessions, omitted privacy hooks and missing-source classification.
Fixtures appear only at grading; cold historical arms use the unchanged
180-second limit without build-cache links. This does not verify production-size
histories, process-kill recovery, managed migration authority, live recording,
deployed storage, execution isolation or model performance.

`app-cloud-auth-host-boundary` installs the actual fetch interceptor with
synthetic HTTP, session and UI ports. Eleven outcomes cover local and unrelated
401 responses, misleading hosts, genuine website expiry, successful requests,
signed-out calls and network-error propagation. Request and response identities
are preserved. The parent fails six outcomes and preserves five; the historical
fix and current source pass all eleven. Run
`bun test evals/coding-agent/calibrate-auth-host.test.js` for calibration.
The hidden fixture appears only at grading and uses no dependency links.
This does not establish native recording continuity, real authentication,
account-switch race safety, browser integration, isolation or model performance.

The current app corpus contains 133 git-mined regressions. See
[DESIGN.md](./DESIGN.md) for the Anthropic guidance, source contract, and
history-mining workflow. The companion website manifest uses this same harness.

`ai-gateway-auth-log-privacy` runs the actual authentication entry points with
synthetic Clerk and account-service replies. Eight checks reject credentials,
account identifiers, emails and upstream error details in console output;
four nearby outcomes preserve verified and legacy access and anonymous fallback.
The broken parent fails eight checks and preserves four. The auth-only historical
fix and current source pass all twelve. Run
`bun test evals/coding-agent/calibrate-auth-log-privacy.test.js` for eleven
controls, including equivalent diagnostics, silence, unused correct source,
raw-value logging, blanket access/denial and missing-source classification.
Fixtures are installed only when grading begins. This does not test real JWT
cryptography, the HTTP router, external log sinks, native model policy, execution
isolation or model capability. Public-identifier authentication from the historical
source is superseded and is not required by this case.


`app-permission-recovery-audio-policy` renders permission recovery, onboarding
and the status banner with synthetic settings and native command ports. Fourteen
outcomes cover audio-off policy, loading, policy changes during delayed completion,
unmount and ordinary audio-on requests. The parent fails eight outcomes and
preserves six; the historical fix and current source pass fourteen. Run
`bun test evals/coding-agent/calibrate-audio-policy.test.js` for ten controls,
including an equivalent policy implementation, unused correct interfaces and
blanket microphone requirements or suppression. Explicit DOM cleanup keeps tests
independent. Fixtures and dependency links appear only at grading. Native pause
and recording behavior, OS permission enforcement, execution isolation and model
improvement are outside this evidence. Recognized Vitest collection failures stay
infrastructure errors when neighboring suites pass or skip. Executed test failures
and assertion headers retain their behavior classification. The shared runner's
`bun test evals/coding-agent/run.test.ts` controls cover both verification arms
and exclusion from scored trials. Unknown diagnostics still need log inspection;
a nonzero process exit alone does not establish a behavior regression.

`app-model-catalog-session-freshness` runs the actual model-catalog hook with
synthetic settings and HTTP ports. Ten outcomes cover hydration, token changes,
late responses and bodies, loading ownership, failure recovery and preserved
anonymous access and metadata. The parent fails five outcomes and preserves five;
the reference and current hook pass ten. Run
`bun test evals/coding-agent/calibrate-model-catalog.test.js` for eleven controls,
including equivalent guards, unused correct code, stale state, empty catalogs,
lost metadata and missing-source classification. The current check also runs the
actual gateway URL adapter with synthetic native ports. Fixtures and dependency
links appear only at grading. This does not establish native credential security,
live entitlement delivery, execution isolation or model improvement.

`app-shared-running-pipes-lifecycle` mounts the actual React hook and Zustand
store with synthetic HTTP/event ports and timers. Ten outcomes cover overlapping
consumers, final unmount, remount, delayed fetch and event-bus completion, pipe
events, filtering and poll recovery. The parent fails six lifecycle outcomes and
preserves four; the reference and current source pass ten. Run
`bun test evals/coding-agent/calibrate-running-pipes.test.js` for calibration.
The fixture and runtime links appear only at grading. This does not establish
native event delivery, real-server behavior, memory usage, execution isolation or
model improvement.

`app-capture-cadence-durable-before-restart` drives the actual recording-settings
change/apply callbacks, local write queue and apply bar with synthetic hook state,
settings storage and native ports. Four outcomes cover a delayed save, a later
accepted edit, failed-save recovery and Auto cadence. The parent fails three and
preserves one; the reference and current caller pass four. Run
`bun test evals/coding-agent/calibrate-capture-cadence.test.js` for calibration.
The grader checks saved values at both capture handoffs. It does not execute
React mount effects, a browser DOM, native persistence, pause/authorization
policy or real capture. Fixtures are installed only at grading. This is not
execution-isolation evidence or a model trial.

`app-workflow-sharing-entry-consent` renders the real workspace prompt and sharing
controls with synthetic settings, consent-service and native-token ports. Nine
outcomes cover independent entry, backend readiness, account hydration/switching,
notice persistence, reconnects and preserved explicit consent and schedule actions.
The parent fails six entry outcomes and preserves three; the reference and current
source pass nine. Run `bun test evals/coding-agent/calibrate-sharing-entry.test.js`
for eleven controls, including equivalent conditions, unused correct code, local
consent granted by skipping, missing account notices and lost positive consent.
Missing source remains a setup error. Fixtures and dependency links are installed
only at grading. This does not establish server enforcement, native durability,
real uploads, execution isolation or model improvement.

`app-workflow-voice-immutable-response` runs the actual gateway and Durable Object
in the existing local Workers harness, with local D1 and synthetic account and
voice-provider replies. The parent returns 500 instead of the intended 400;
the reference preserves invalid-request JSON, session creation and empty session
termination, with cache and CORS headers. Service-only rejection is preserved.
Run `bun test evals/coding-agent/calibrate-workflow-voice-response.test.js` for ten
controls, including equivalent response reconstruction, unused correct code,
lost status/body/headers and missing-source setup classification. Install the
gateway dependencies, including Miniflare and Wrangler, before verification.
Wrangler only bundles with `--dry-run`; no deployment or real provider call runs.
Fixtures and runtime links are installed only when grading starts. This is local
Workers evidence, not production delivery, billing safety, agent isolation or
model improvement.

`app-chat-foreground-save-ownership` runs the real foreground event hook and
React lifecycle with synthetic event, persistence and native ports. Four outcomes
cover switches to new and existing empty sessions, stable-session saves and empty
events. The parent fails both switched saves and preserves two outcomes; the
reference and current source pass four. Run
`bun test evals/coding-agent/calibrate-foreground-save.test.js` for eight controls,
including an equivalent callback-refresh solution, unused correct code, disabled
saves, wrong destinations and missing-source setup classification. The persistence
port follows the existing save callback contract and serializes synthetic records.
This does not test actual filesystem durability, full session-switch integration,
concurrent/background saves, native event delivery, isolation or model quality.
Fixtures and dependency links are installed only when grading starts.

`app-settings-restart-persistence` runs the actual settings provider, write queue
and update banner with synthetic React, storage and native restart ports. Four
outcomes cover a delayed save, another edit during the drain, failed-save refusal
with recovery, and an idle restart. The parent fails three and preserves one;
the reference and current source pass four. Run
`bun test evals/coding-agent/calibrate-settings-restart.test.js` for nine controls,
including unawaited drain, swallowed failures, unused correct code, blanket
restart denial and missing-source classification. The fixture is installed only
when grading begins. This checks the persisted snapshot at the macOS/Linux
handoff, not OS durability, encryption, native installation, Windows behavior,
cross-window synchronization, isolation or model performance.

`app-pipe-store-load-error` renders the actual store component with synthetic
network, cache and native ports. Ten outcomes distinguish payload, HTTP and
network failures from genuine empty catalogs and verify retries to populated
and empty results without stale error UI. The parent fails six error outcomes
and preserves four catalog outcomes; the reference and current component pass
ten. The earlier grader accepted an empty-catalog denial mutant. Run
`bun test evals/coding-agent/calibrate-pipe-store-error.test.js` for nine controls,
including that bypass, equivalent copy/cache strategy, unused correct code,
disabled retry, blanket errors and missing-source setup classification.
Fixtures and dependency links are installed only when grading starts. This
checks rendered behavior with controlled ports, not real cache coherence,
native registry delivery, complete localization, isolation or model capability.

`app-consumer-stale-managed-settings` runs actual settings read, write and reset
operations, the write queue and build-authority gate against synthetic native,
store, React rendering and external ports. Confirmed consumer builds release stale
policy; enterprise builds and failed IPC preserve it. Twelve outcomes include
ordinary edits without cached policy. The parent fails three consumer outcomes
and preserves nine; the reference and current source pass twelve.
Run `bun test evals/coding-agent/calibrate-stale-policy.test.js` for calibration.
The task concerns persisted frontend choices, not actual native recording,
migration authority, store encryption, IPC delivery, isolation or model quality.

`app-card-ask-login-hydration` runs the actual provider, controller and dialog
with synthetic external ports. Nine outcomes cover initial and delayed account
loading, post-mount sign-in, once-per-install persistence and suppressed prompts.
The parent fails two intended outcomes and preserves seven; the reference passes
nine. Run `bun test evals/coding-agent/calibrate-card-login.test.js` with desktop
test dependencies installed for eight controls, including unused correct code,
equivalent private names/test attributes, lost suppression or persistence, and
missing-source setup classification. Current product provider tests separately
pass twelve outcomes with current rollout controls. This historical configured
flow does not authorize enabling a rollout. Graders and dependency links are
installed only when grading starts; no live checkout, native behavior, execution
isolation or model capability is established.

`app-business-capacity-plan-picker` drives the actual account settings component
with synthetic native, settings and telemetry ports. Eight outcomes cover visible
capacity plans and prices, exact billing targets, current-plan labeling, the next
capacity step and preserved login/account navigation. The parent fails six
intended outcomes and preserves two; the historical fix passes all eight. The
same outcomes pass on current source using its offline localization test setup.
Run `bun test evals/coding-agent/calibrate-capacity-plan-picker.test.js` with the
desktop test dependencies installed. Nine controls include incorrect targets,
missing navigation, an unused correct module, blanket current-plan labels, lost
account navigation, equivalent helper/test-id names and query ordering, and
missing-source setup classification. The grader does not require test IDs or
private helper names. Fixtures and dependency links are installed only at grading.
This does not establish live billing, backend proration, native behavior, agent
isolation or model capability.

`app-terminal-quota-retry` exercises the actual foreground event hook with
synthetic native commands and event delivery. Seven event outcomes cover terminal
quota/model retry cancellation, finalization, retained transient retries, delayed
throttling recovery and successful answers; 76 historical helper assertions remain.
The parent fails three terminal outcomes and preserves 80 assertions; the reference
passes all 83. A disabled stop condition previously passed the source-name grader.
Run `bun test evals/coding-agent/calibrate-terminal-quota.test.js` for eight controls
including disabled/blanket stopping, lost stop effects, equivalent detector naming,
blanket retry suppression and missing-source setup classification. Runtime links
are installed only for grading. This does not establish native process termination,
live billing, isolation or model performance.

`app-acp-billing-saved-recovery` exercises the real foreground event hook,
provider presentation and saved-message rendering with synthetic native, event,
storage and network ports. Twelve outcomes cover provider-specific account
recovery with and without HTTP 429, persistence, automatic versus manual retries,
stale-session retry suppression, context overflow and successful recovery.
The parent fails seven intended outcomes and preserves five; the reference
passes twelve. Guidance is checked semantically, with an equivalent-prose control.
Run `bun test evals/coding-agent/calibrate-acp-billing-recovery.test.js` with the
desktop test dependencies installed. Graders and dependency links are installed
only after grading starts; those links do not establish execution isolation.
No native ACP, live billing, entitlement safety or model performance is measured.

`ai-gateway-voice-transcription-budget` exercises the actual voice route, budget
readers and transcription handler with SQLite-backed D1 reads and synthetic
identity and provider ports.
The parent fails four intended budget refusals and preserves three outcomes;
the historical reference passes all seven. Exact cap boundaries refuse provider
work, while values immediately below all caps preserve the original audio bytes.
Run `bun test evals/coding-agent/calibrate-voice-transcription-budget.test.js` with
the gateway dependencies installed. Controls reject unused correct code, ignored
gates, provider work before refusal, blanket denial and fabricated transcripts,
and accept equivalent private bindings and SQL. A wrong account bucket is rejected.
Missing source is a setup failure. Telemetry writes remain inert.
This does not establish concurrent reservation safety, duration billing, anonymous
identity, realtime metering, live delivery, isolation or model capability.

`app-daily-summary-terminal-error` runs the actual summary orchestration and
its internal helpers against synthetic native commands and event delivery.
Thirteen outcomes cover terminal message/agent errors, original provider detail,
partial-text precedence, retry hints, empty-result retry bounds and cleanup.
The parent fails seven intended outcomes and preserves six; the reference and
current orchestration pass all thirteen. This does not establish activity UI,
recording, provider delivery, general runtime-start recovery or model performance.

Run `bun test evals/coding-agent/calibrate-daily-summary-errors.test.js` with the
desktop test dependencies installed. Ten controls include parent/reference,
equivalent helper renaming, an unused correct module, lost error detail,
ignored agent-end errors, retry-hint refusal, omitted cleanup, blanket refusal,
and missing-source setup failure. Dependencies and fixtures are installed only
when grading begins; dependency links do not establish agent isolation.

`app-onboarding-sdk-cold-start-assignment` runs the historical React page with
PostHog 1.359.1, the SDK pinned by that source revision. It observes eleven
cold-route, stale-identity, pinned-route, timeout, opt-out and unmount outcomes.
Transport responses are synthetic; unpinned requests are served at a fixed
latency without requiring a particular number of requests or callbacks. The
parent fails four cold outcomes and one stale-cache outcome, preserving six;
the reference passes all eleven. This complements the earlier mocked-callback
login case below. It does not certify live analytics, native behavior or model
performance.

Run `bun test evals/coding-agent/calibrate-onboarding-sdk.test.js` with the exact
locked SDK and desktop test dependencies installed. Calibration rejects an
unused correct page, stale acceptance and blanket control, accepts an equivalent
predicate, and separates missing-source setup failures. The grader refuses a
mismatched SDK runtime and denies live fetch/XHR. Fixtures and dependency links
are materialized only when grading starts; dependency links do not establish
execution isolation. No model trial is implied.

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

Playwright component-test missing-input and missing-export builds are
`playwright_ct_build_error` when the planned and unrun counts match and the build
failure diagnostic is complete. Assertions, partial execution, successful exits
and incomplete diagnostics retain their previous outcomes. The controls use
synthetic paths and symbols; no private application source is embedded.

This is bounded diagnostic recognition, not universal error attribution. Unknown
setup/compiler failures, including other test frameworks, may still be ordinary
nonzero exits. Inspect logs before promoting a case; preserve command exit codes
in wrappers. An error is not proof that infrastructure, rather than a candidate
change, caused it. Report error counts and inspect candidate-caused errors before
comparing model success rates. No isolation or model-quality claim follows.

Run the synthetic runner controls with `bun test ./evals/coding-agent/run.test.ts`.
Fifty-seven end-to-end controls cover baseline/reference timeouts and signals,
missing ESM/CommonJS modules, Node/Bun syntax and Bun import errors, Vitest
collection failures (including alias imports and Vite resolve-import diagnostics), missing PostCSS-plugin startup
failures, Rust/Cargo compilation failures and assertions quoting compiler output,
Playwright component-test Vite builds that leave all discovered tests unrun,
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

### Binary source fixtures

`bun test evals/coding-agent/binary-fixtures.test.ts` verifies the actual runner
with a temporary synthetic Git repository. Git-backed fixtures must retain all
256 byte values, including NUL and invalid UTF-8, and report hashes of those exact
bytes. The control also preserves local binary fixtures, default and explicit
source refs, UTF-8 text, empty files, executable flags and binary oracle patches.
The synthetic broken state fails its intended assertion; the reference passes.
The command adapter retains Buffers when `encoding: null` is requested and keeps
normal command output as text. This is harness calibration, not model evaluation
or proof of process isolation; no real recordings or customer files are used.

## Localization recovery preserves accepted output

`app-localization-recovery-preservation` executes the actual translation service
with synthetic provider responses and disposable catalogs. Cold recovery must
not overwrite an accepted rich-text or ICU translation with an incompatible
legacy download. Fourteen outcomes cover arrival order, later valid corrections,
frontend/native catalogs, multiple locales, disjoint messages, retained rejected
diagnostics, source identity/format refusal, warm-cache preservation and stale
loose-output cleanup. The parent fails five persisted-output checks while nine
preserved behaviors pass; the service-only reference passes all fourteen.

Run `bun test evals/coding-agent/calibrate-localization-recovery.test.js` with
`@generaltranslation/icu` 0.1.2 available in the desktop dependency directory.
Ten calibration controls reject unused fixes, first-valid-only merging, dropped
diagnostics, frontend-only repair, identity bypass and blanket refusal. Equivalent
object assignment passes; missing service code remains a setup error. Current
source separately passes the fourteen outcomes and five existing service tests.

Fixtures and dependency links are materialized only for grading. No live provider,
real user content, native build, release or publication is involved. These are
corpus checks, not model trials, packaging validation or proof of trial isolation.

## Home-level MCP configuration permissions

`app-mcp-home-config-scope` exercises the actual Settings connect/disconnect
functions through synthetic filesystem and native path-resolution ports. Thirteen
outcomes cover home-directory permission refusal on POSIX, Windows and verbatim
Windows targets, plus preservation of existing JSON/TOML settings, backup and
error behavior. The parent fails three intended connection outcomes and preserves
ten; the source-only reference passes all thirteen. These are simulated path
semantics, not native Windows or desktop acceptance.

Run `bun test evals/coding-agent/calibrate-mcp-home-scope.test.js` for controls
covering parent/reference, unused-correct-source and write/backup bypasses, an
equivalent implementation and missing-source setup failure. Dependencies are
linked only for grading. No real config, credential or agent is accessed; these
checks do not establish model improvement or enforced workspace isolation.

## Bounded external chat discovery

`app-external-chat-scan-boundary` runs the actual historical discovery entry point
with synthetic directory and metadata ports. Eight outcomes cover the seven-day
cutoff, eligible-file cap, oversized files, unreadable/missing sources, independent
sources and repeated discovery. Transcript reads, parsing, storage writes, events
and network calls are rejected. The parent fails five intended assertions and
preserves three outcomes; the reference and current scanner pass all eight.

Run `bun test evals/coding-agent/calibrate-external-chat-scan.test.js` for eleven
controls: parent/reference, unused correct code, equivalent private names and
comparison, unbounded metadata reads, oversized cap consumption, strict cutoff,
stale Claude files, empty results, transcript reads and missing-source setup.
These calibrate the grader; they are not model trials. The historical oracle
changes only the scanner. UI, native filesystem permissions, actual import
persistence and newer maintenance/sync behavior are outside this case. The
separate current product dialog check uses a synthetic scan/import port. No real
chat histories are read, and no execution-isolation claim follows.

## TTS WAV response boundary

`ai-gateway-tts-wav-response` executes the actual speech handler, voice utility
and response helpers against a synthetic provider. Fifteen outcomes cover WAV
request parameters and byte preservation, malformed signatures and short bodies,
provider HTTP/transport/body failures, explicit recovery, invalid input and
preserved MP3 utility calls. Only the voice utility is the historical oracle.

Run `bun test evals/coding-agent/calibrate-tts-wav.test.js`. Ten controls cover
parent/reference, an unused correct utility, equivalent helper naming, missing
container selection, arbitrary-byte acceptance, discarded audio, forced WAV
validation, blanket refusal and missing-source setup failure.

These are corpus and grader checks, not model trials. The unrelated transcription
SDK and completion factory are fail-closed ports. Gateway authentication/rate
limits, actual playback, live provider compatibility and full WAV container
integrity are outside this signature-level contract. No real audio, native build,
model call or dependency link is used; execution isolation remains unproven.

`ai-gateway-paid-tts-dispatch` invokes the actual gateway dispatcher, authentication,
paid-plan policy and voice handler with synthetic verifier, entitlement API,
rate-limiter and provider ports. Seven outcomes cover anonymous, Free, unknown
plan, Basic, Business, denied-standing and invalid-input behavior. Paid responses
retain exact provider bytes and one original-text request. The oracle applies
only the historical dispatcher fix.

Run `bun test evals/coding-agent/calibrate-paid-tts.test.js` with gateway JavaScript
dependencies installed. Grading links them only after the trajectory ends. This
is not proof of agent isolation, live authentication/payment/provider operation,
transcription policy, playback or model improvement. Separately selected current
product route tests preserve transcription behavior; they are not hidden outcomes
of this case.

## Abandoned SQLite read snapshots

`app-abandoned-read-wal-cleanup` runs the real database manager, SQLx pool and
SQLite WAL on synthetic temporary files. Six outcomes exercise dropped guards,
explicit release, aborted requests, active-reader consistency, ordinary release
and deadline interruption. Writes during and after cleanup must survive reopen
and an integrity check. The oracle is limited to the historical cancellable-read
implementation; it does not apply scheduler or native recovery changes.

Run `bun test evals/coding-agent/calibrate-wal-read-cleanup.test.js` with the locked
Rust dependencies available offline and a task-owned `target` cache. Calibration
checks the parent/reference, an unused corrected implementation, equivalent
cleanup logic and connection retirement, unconditional rollback, a stale cancellation handler and missing
source classification. Set `SCREENPIPE_EVAL_CALIBRATION_RECEIPTS` to retain
per-control logs. Hidden fixtures and build-cache links are added only for grading.

This case does not establish native recording resumption, scheduler policy,
migration authority, actual device histories, execution isolation or model gains.
Build failures remain infrastructure failures; inspect the executed assertion
logs before treating any failure as the intended historical defect.
## Conversation save outcomes

`app-chat-concurrent-save` exercises the persistence API and reads back the saved
JSON through synthetic filesystem ports. Its grader no longer imports a helper
or reset function introduced by the reference fix: the parent reaches eight
behavior failures while preserving four outcomes, and the source-only reference
passes all twelve. Outcomes cover stale and overlapping message saves, streaming
richness, saved ordering, scalar intent, concurrent flag updates, missing IDs and
recovery after a rejected write.

Run `bun test evals/coding-agent/calibrate-chat-save.test.js` with the desktop
Vitest dependencies installed. Nine controls cover parent/reference, an unused
correct helper, equivalent private names, conflict bypass, always keeping disk,
streaming/scalar clobbering and missing-source setup failure. Set
`SCREENPIPE_EVAL_CALIBRATION_RECEIPTS` to retain per-control logs. Fixtures and
dependencies are materialized only for grading.

The twelve outcomes also pass against current persistence source using the
historical synthetic test setup. This is not the complete current app suite,
independent native webview scheduling, real filesystem durability, proof of
workspace isolation or a model trial.

## Registered pipe-run outputs

`app-pipe-run-registered-outputs` executes the public chat-inspector hook with
real artifact and citation helpers against a synthetic local API. Six outcomes
cover active-run visibility without tool calls, other-run exclusion, explicit
output deduplication, ordinary chat, leaving the pipe context and recovery after
a temporary API refusal. The parent fails three intended outcomes and preserves
three; the hook-only reference passes all six.

Run `bun test evals/coding-agent/calibrate-pipe-run-outputs.test.js` with desktop
React/Vitest dependencies installed. Seven controls cover parent/reference, an
unused corrected hook, equivalent helper naming, removed source filtering,
blanket suppression and missing-source setup failure. Set
`SCREENPIPE_EVAL_CALIBRATION_RECEIPTS` to retain per-control logs. Fixtures and
dependency links are materialized only for grading. These are corpus checks,
not model trials, full chat UI or native persistence evidence, or proof of
execution isolation. No real files, recordings or provider accounts are used.

## Connection-probe response compatibility

`app-connection-probe-response` exercises the public connection-test service with
synthetic provider responses and real request/error helpers. Sixteen outcomes
cover streaming-default custom, OpenAI, Ollama and Anthropic gateways, token
parameter recovery, configured connection identity, JSON compatibility, empty
messages, error details, reply length and cancellation. The historical parent
fails five response assertions and preserves eleven outcomes; the source-only
reference and current service pass all sixteen.

Run `bun test evals/coding-agent/calibrate-connection-probe.test.js` with desktop
Vitest dependencies installed. Ten controls reject unused fixes, retry/provider
regressions, constant replies and lost credentials. A valid SSE parser passes
without requiring a particular request flag. Missing source remains a setup
error. Hidden fixtures and dependencies are materialized only for grading.
These are corpus checks, not model trials, settings persistence, native/live
provider acceptance or proof of execution isolation.

## Pipe write permission hook

`app-pipe-write-permission-hook` exercises the actual registered extension hook
with synthetic permissions and tool events. Eighteen outcomes include outside
file writes, multi-operand shell writes, expansions and opaque scripts, plus
permitted writes and reads. No commands are executed. This does not establish
complete shell analysis, native enforcement, symlink safety or agent isolation.
Run `bun test evals/coding-agent/calibrate-pipe-write-hook.test.js` for historical,
current, equivalent-implementation, unused-correct and mutation controls.

## Complete free entitlement evidence

`app-complete-free-entitlement-evidence` executes the real account normalizer and
policy interfaces against synthetic account values with a fixed clock. Complete
legacy denial becomes verified free; partial newer evidence remains unknown.
Twenty-six outcomes preserve offline free policy, identity/token boundaries,
explicit denial and valid paid plans. The parent fails ten intended assertions
and preserves sixteen; the historical fix and current source pass all 26.

Run `bun test evals/coding-agent/calibrate-free-evidence.test.js` for ten controls,
including unused correct code, equivalent private names, missing cloud/feature
evidence, whitespace authentication and unsupported sources. Missing source is
a setup error. Only URL configuration is mocked. The companion paid-plan-label
case covers a separate omission invariant. Fixtures are installed at grading;
no UI/native recording, live provider verification, agent isolation or model
improvement is established.

## Account-standing provenance

`ai-gateway-account-standing-provenance` exercises the real gateway HTTP router,
authentication and durable-object admission logic. Twelve synthetic scenarios
cover temporary sign-in locks, proven deletion versus a stale website account ID,
banned accounts, preserved model discovery and refusal before provider work.
With explicit denial reason checks, the historical parent fails ten complete
outcomes and preserves two; the reference
passes all twelve. This does not establish live identity verification, cache
migration, native retry behavior, concurrency safety or model improvement.

Run `bun test evals/coding-agent/calibrate-account-standing.test.js` for the
known-broken/correct, unused fix, permissive admission, blanket refusal, equivalent
private field and missing-source controls. Dependency setup errors are separate
from intended behavior failures. Use the shared runner's `--verify` for the case.

### Attachment owner handoff

`app-attachment-owner-handoff` exercises the actual attachment hook and in-memory chat store across delayed file reads, pane unmount, foreground navigation, pointer-scoped drops, cancellation and read failure. Hidden/deleted owners stay absent and ordinary multiple-file attachment survives. Native file/dialog/extraction and locale ports are synthetic; this does not establish native delivery, disk persistence or full composer integration. Run `bun test evals/coding-agent/calibrate-attachment-owner.test.js` with the desktop test dependencies available. Historical verification and mutation calibration are not model trials or an isolation claim.

### Background allowance request preservation

`ai-gateway-background-request-preservation` drives the existing chat handler through synthetic provider ports. Thirteen outcomes preserve message roles, context, tool schemas, output budgets, response formats and streamed tool results during enabled allowance recovery, plus successful-primary and refusal behavior. Parent verification fails four intended outcomes and preserves nine; the historical fix passes thirteen. Run `bun test evals/coding-agent/calibrate-background-request.test.js`. Paid-plan HTTP admission, safety-refusal policy, actual provider compatibility, concurrent accounting, execution isolation and model performance remain separate. Fixtures and dependency links are installed only when grading starts.


## Unaccepted canvas positions

`app-canvas-preview-persistence` renders the real overview and canvas against
synthetic native, generation and settings ports. Five outcomes check a fresh
canvas during proposal review, normal editing, existing annotations, rejection
and acceptance. The parent fails the unaccepted-position assertion and preserves
four outcomes; the reference and current component pass all five. Native writes
are copied at invocation and complete asynchronously; stored effects are checked
without requiring exact call counts, DOM identity or private names.

Run `bun test evals/coding-agent/calibrate-canvas-outcome.test.js` with desktop
test dependencies installed. Controls cover unused correct code, blanket write
suppression, dropped annotations and blocked acceptance; equivalent private names
and test attributes pass. Missing source is a setup error. Hidden fixtures and
dependencies are installed only at grading. This does not establish native
storage, browser geometry, agent isolation or model performance.

## Onboarding notification transport

`app-onboarding-notification-transport` exercises the existing follow-up
orchestration, activation storage, time helper and app-control client with
synthetic native and transport ports. Six outcomes cover runtime-port delivery,
configuration fallback, refusal followed by retry, replay suppression, failed
engine dispatch, future deadlines and missing views. It observes the default
transport rather than injecting a replacement notification helper. The historical
parent fails three delivery outcomes and preserves three; the reference and
current source pass all six.

Run `bun test evals/coding-agent/calibrate-notification-transport.test.js` with
desktop dependencies installed. Fixtures and dependency links are materialized
only when grading begins. These checks do not establish native notification
display, completed Pipe results, policy authority to start work, multi-window
concurrency, execution isolation or model performance. The task covers an already
scheduled follow-up and does not authorize activating paused work.

## Lazy streaming errors

`ai-gateway-lazy-stream-initial-error` exercises the actual OpenAI-compatible
provider with synthetic SDK iterables and inert telemetry. Initial lazy quota
and service failures reject before a successful stream is returned. Five nearby
outcomes preserve SDK creation errors, text, tool fragments and usage, empty
streams, and SSE errors after partial delivery. The parent fails the two initial
error outcomes and preserves five; the reference and current provider pass seven.

Run `bun test evals/coding-agent/calibrate-stream-initial-error.test.js` for nine
controls, including unused correct code, equivalent iterator names, lost or
repeated first chunks, incorrect later error status and missing-source setup
classification. No dependencies or build caches are linked by this case. Fixtures
are materialized at grading time. This does not establish caller fallback
selection, cancellation, live provider behavior, execution isolation or model
performance, and does not reinstate historical Argus routing policy.

## Hosted-AI settlement replay

`ai-gateway-settlement-replay-atomicity` exercises the existing `logCost`
entrypoint against synthetic local workerd D1. Ten outcomes cover concurrent
replay, independent requests, conflicting cost/ownership, atomic rollback,
lost commit acknowledgement, zero cost and preserved legacy, unbudgeted and
speech accounting. The parent fails six intended outcomes and preserves four;
the reference and current source pass ten.

Run `bun test evals/coding-agent/calibrate-settlement-replay.test.js` with
Miniflare `3.20250718.3` available in `packages/ai-gateway/node_modules`.
Ten calibration controls include an unused corrected implementation, blanket
success, collapsed request identities, ignored cost conflicts and non-atomic
writes. Equivalent private names pass; missing source is a setup error.
The case checks account and aggregate effects without requiring a particular
ledger table or helper design. Fixtures and dependency links appear only at
grading time; dependency links do not establish agent isolation. Current product
tests separately cover additional ledger windows. This case does not establish
HTTP admission, hold release, every budget window, deployed migrations, actual
provider billing or model performance.

`app-public-hosted-ai-allowance` exercises actual request reservations against
local workerd D1. Fifteen outcomes check public monthly/trial ceilings, healthy
releasable holds, concurrent admission, stricter private limits and malformed
configuration. Run `bun test evals/coding-agent/calibrate-public-allowance.test.js`
with gateway dependencies available. This does not execute HTTP entitlement,
provider delivery, final settlement, production activation, native behavior,
agent isolation or model trials. Fixtures and dependencies are added at grading.

`app-reservation-admission-proof` executes reservation and exact release against
local workerd D1 with synthetic write-result faults. Zero or missing change
metadata must not deny stored reservations; positive metadata must not fabricate
admission. Seven outcomes include concurrency, full capacity, sibling retention
and write failure. The parent fails five and preserves two; reference/current
pass seven. Run `bun test evals/coding-agent/calibrate-admission-proof.test.js`
for ten controls, including an equivalent row-reading method. This is not HTTP
authentication, provider execution, settlement, production fault prevalence,
agent isolation or a model trial.

## Provider spend-cap guidance

`ai-gateway-provider-cap-guidance` invokes the existing chat handler with
synthetic provider and telemetry ports. Nine outcomes cover JSON and streaming
cap errors, exhausted chains, successful fallback, intact input, healthy replies,
malformed images, empty input, authentication failures and ordinary throttling.
The parent fails three guidance outcomes and preserves six; reference/current
pass nine. Fallback already works in the parent.

Run `bun test evals/coding-agent/calibrate-provider-cap-guidance.test.js` with
gateway dependencies available. Eleven controls include unused correct code,
raw error leakage, blanket classification, lost fallback/tools, duplicate alerts,
equivalent private names/prose and missing-source setup classification. Fixtures
and dependency links are added at grading time. This does not establish HTTP
authentication, accounting, actual provider availability, complete log redaction,
execution isolation or model performance.

## Active IP quota retention

`ai-gateway-active-ip-quota-retention` runs the actual runtime maintenance entrypoint
and its SQL against an in-memory SQLite database through a sequential D1 adapter.
Eight outcomes cover active counts with stale update metadata, reset-date boundaries,
expired rows with recent metadata, repeated cleanup, other usage tiers, bounded
backlog cleanup and preserved aggregates. The parent fails four intended outcomes
and preserves four; the historical reference and current maintenance pass eight.
The current usage writer also refreshes update timestamps. This case preserves
legacy or delayed metadata handling, not a claim that every current write is stale.

Run `bun test evals/coding-agent/calibrate-ip-quota-retention.test.js` for nine controls:
broken/reference/current, unused correct code, equivalent SQL/private bindings,
no-op cleanup, blanket removal, an unbounded batch and missing-source setup failure.
Set `EVAL_CALIBRATION_RESULTS_DIR` to retain the per-control logs. No installed
packages are needed, and the hidden fixture is materialized only at grading.
These outcomes do not prove workerd/D1 concurrency or atomicity, deployed cron
delivery, full quota admission, agent isolation or model improvement.

## Settings identity refusal

`app-settings-telemetry-identity` renders the real SettingsProvider with synthetic
settings, native and PostHog ports. Five outcomes cover explicit user refusal,
runtime refusal, a pending runtime decision, opted-in account identity and
unmounting before version completion. The historical parent fails four and
preserves one; reference and current source pass five.

Run `bun test evals/coding-agent/calibrate-telemetry-identity.test.js` for eight
controls, including unused correct source, blanket suppression, ignored user
preference, equivalent private names and missing-source setup classification.
Fixtures and dependencies are installed only when grading starts. This does not
establish native environment parsing, actual capture delivery, unknown preference
or failed IPC policy, execution isolation or model performance.

`app-chat-timeline-offset` renders the actual MarkdownBlock and Markdown parser with synthetic native/store ports. Twelve outcomes cover raw and encoded offsets, captured instants, timestamp precedence over start_time, invalid timestamps and preserved frame/artifact/web links. Run `bun test evals/coding-agent/calibrate-chat-timeline-offset.test.js` for grader controls. This is not native event delivery, OS deeplink handling, frame retrieval, sub-millisecond precision, execution isolation or a model trial. Graders and dependency links are installed only when grading begins.

`app-local-api-authority` runs the actual localFetch wrapper, global fetch
interceptor and shared notification action executor with synthetic native config
and transport. Twenty-four outcomes cover deceptive URL authorities, configured
ports, document-relative URLs, notification refusal and preserved local auth,
request bodies, explicit auth, disabled auth and key-refresh retry. The parent
fails fourteen and preserves ten; reference/current pass all twenty-four.
Run `bun test evals/coding-agent/calibrate-local-api-authority.test.js` for eight
controls, including equivalent helper names, inactive correct code, blanket auth
suppression, missing notification guards and missing-source setup classification.
Fixtures/dependencies are installed only at grading. This does not establish
native transport, redirects/cookies, toast component behavior, server authorization,
agent isolation or model performance.

### Untrusted chat HTML

`app-chat-raw-html-sanitization` renders the historical MarkdownBlock with
synthetic native/browser ports. Both message roles reject active embedded, form,
style and base elements, inline styles and unsafe URL attributes. Six nearby
outcomes preserve formatting, fragments, web navigation and local previews.
Anchor IDs may use any working scheme; the grader does not demand a sanitizer
library or private helper. The workspace chat package resolves from the tested
commit, while installed external dependencies are matched across arms.

Run `bun test evals/coding-agent/calibrate-chat-html-outcomes.test.js` with
frontend dependencies including `rehype-sanitize` 6 installed. Controls include
parent/reference/current, an equivalent anchor scheme, unused fix, bypass, empty
output, one-role-only repair, dropped safe HTML, styles, broken fragments and
missing-source setup failure. These are corpus/grader checks, not agent trials,
a full browser exploit defense or proof of execution isolation.

### Remote Markdown images

`app-markdown-remote-images` renders the actual chat MarkdownBlock (both roles),
the shared MemoizedReactMarkdown and the meeting note editor (`NoteEditor` and
`createMeetingNoteEditorExtensions`), with synthetic native media and HTTP
ports. Seventy-two outcomes check that remote, protocol-relative, relative,
reference-style, raw `<img>` and `<picture><source srcset>` images, and remote
or network-share media, create no element that loads them and never reach the
media reader, while their alt text, link or code stays visible; an image with no
alt text shows its address. Network-share media includes a home-relative path
that resolves to a share and local-looking strings from which the reader would
take a share path; images whose source is removed for safety keep their alt
text, and a local image the reader cannot open keeps its alt text and path. In a
meeting note, remote images an AI summary wrote or a later update brings (also
in place of an embedded image) do not load, keep their alt text and stay in the
note's Markdown, also when the note is copied through the editor's clipboard
handling and pasted into a note, while embedded data: images still show and keep
their alt text and size when pasted. A web image pasted into a note that cannot
be downloaded stays in the note's Markdown as its address. Local absolute,
file-URL, Windows (also with doubled, Markdown-escaped backslashes) and
home-relative files still render through the native reader. The parent fails
sixty-four outcomes and preserves eight; the first, markdown-only fix fails
twenty-three; the second and third fail the note copy, later-update and seven
visible-fallback outcomes; the fourth fails the seven visible-fallback outcomes;
the fix and current source pass all.

Run `bun test evals/coding-agent/calibrate-markdown-remote-images.test.js`.
Controls include parent/reference/current, the first four fixes, an equivalent
plain-text address, a restored remote `<img>` fallback, an alt-text-only
fallback, an unreadable local image that shows nothing, re-allowed
picture/source, an extension-only media check, a media check that allows a
second leading separator, accepts Windows network paths or reads a doubled
backslash after a drive as a share, network shares treated as local, blanket
image removal, a note editor that renders any source, deletes remote images from
the note, drops pasted images it could not download, takes over pastes of
embedded images or reuses an image view for a different source, unused correct
source and missing-source setup failure. Webview CSP, Mermaid diagrams (jsdom
cannot lay them out; unit tests and browser checks cover the no-network frame),
pasting from other apps, loading a blocked note image on request, native file
policy and execution isolation are outside this evidence.

`ai-gateway-trusted-runner-admission` runs the actual HTTP entrypoint, authentication,
Free-plan gates, chat handler and provider adapter with synthetic external ports.
Fourteen outcomes cover successful machine and paid-human replies, forged or
unconfigured credentials, Free background refusal, unknown plans, rate limits
and invalid input. The parent fails five outcomes and preserves nine; the
reference and current source pass fourteen. Twelve calibration controls reject
partial fixes, header/prefix bypasses, unused correct code, fabricated success
and blanket refusal, and accept an equivalent guard expression. Run
`bun test evals/coding-agent/calibrate-trusted-runner.test.js` with gateway
dependencies installed. The fetch boundary is installed before SDK imports,
which can capture fetch at initialization. Graders and dependency links are
installed only after the trajectory. These checks do not establish JWT
cryptography, live inference, concurrent spend safety, complete current billing
integration, agent isolation or model performance.

## Unicode migration search probes

`app-migration-unicode-search-probe` converts temporary synthetic SQLite histories
through the actual storage API. Seven outcomes cover control characters, diagram
glyphs, non-Latin text, symbol-only and ordinary histories, missing-index refusal,
low-disk refusal and external-reader refusal followed by explicit retry. The
historical parent fails three conversion outcomes and preserves four; the fix
passes all seven. Reopened payloads, search results, frame counts, completion state
and storage verification are checked without requiring a tokenization helper.

Run `bun test evals/coding-agent/calibrate-migration-unicode.test.js` for the
parent/reference, equivalent implementation, unused fix, skipped search checks,
lost payloads, fabricated success and missing-source controls. Calibration uses
an ordinary task-local target directory and independent temporary databases.
The corpus case has no dependency or build-cache links, and its fixture is
installed only when grading starts. Its offline Cargo command has a 180-second
limit. Compilation and setup errors cannot establish the intended regression.

This case tests explicitly requested offline conversion correctness. It does not
establish native rollout authority, cohort/stop controls, recovery-copy deletion
policy, all interruption paths, live recording continuity, execution isolation
or model performance. See [the rollout review](MIGRATION-ROLLOUT-REVIEW.md) for the
separate authority requirements.

## Trial state after a paid upgrade

`app-trial-upgrade-expiration` runs the historical Account component with a fixed
clock and synthetic settings, billing, entitlement-refresh and native event ports.
Nine outcomes cover stale trial notice suppression, saved expiry and entitlement
after confirmed checkout, unconfirmed checkout preservation, manual-trial billing,
Basic account behavior and signed-out/tokenless accounts. The parent fails two
intended outcomes and preserves seven; the reference passes all nine.

Run `bun test evals/coding-agent/calibrate-trial-upgrade.test.js` for nine controls.
Equivalent DOM attributes and split persistence writes pass. Unused correct code,
blanket countdown suppression, retained expiry, missing refresh and unconfirmed
activation fail. Missing active source is a Vitest collection error. The grader
checks visible account behavior and the settings port's final snapshot, without
requiring test IDs or a particular sequence of persistence calls.

Only the Account, expiration component and entitlement helper are oracle paths.
Home integration, real settings durability, live billing/refresh delivery and
current full application integration are outside this case. Dependencies and the
fixture are materialized only for grading. No model trial or enforced-isolation
claim follows from this verification.

## Capture startup retry

`app-capture-start-rejection-recovery` runs the actual onboarding component with
synthetic native, health and clock ports. Eight outcomes cover returned and thrown
startup failures, successful-session reuse, pending-session serialization, permanent
refusal, idle media, authenticated health and unrelated health responses. The
parent fails both recovery outcomes and preserves six; reference and current source
pass eight.

Run `bun test evals/coding-agent/calibrate-capture-recovery.test.js` with desktop
test dependencies installed. Ten controls include unused corrected code, fabricated
startup success, overlapping attempts, premature advancement, capture disruption,
equivalent private bindings and missing-source classification. Hidden fixtures
and dependency links appear only at grading. This checks the React/native-command
boundary; it does not establish native capture, permission delivery, full UI
unmount/skip recovery, migration authority, agent isolation or model performance.

## Session verification schedule

`app-auth-verification-schedule` runs the actual React auth guard with synthetic
settings, native credential and clock ports. Twelve outcomes cover stable startup
and periodic checks, callback refresh, token changes, sign-out, focus cooldown,
hidden windows, unmount and session-expiry ownership. The parent fails three
scheduling outcomes and preserves nine; reference and current source pass twelve.

Run `bun test evals/coding-agent/calibrate-auth-schedule.test.js` for thirteen
controls. A recursive timer implementation passes; unused fixed code, disabled
checks, stale callbacks, lost token resets, cross-account logout and missing native
credential cleanup fail. Missing source is a collection error. Fixtures and
dependencies are installed only when grading starts. This checks the React port
boundary, not live account refresh, native credential persistence, recording,
execution isolation or model performance.

The bounded first-run preview case exercises the actual hook with synthetic native status, activity reads and clock. Its calibration command is `bun test evals/coding-agent/calibrate-bounded-preview.test.js`. This checks corpus outcomes and grader controls; it does not execute native history queries or measure agent performance.


### Gateway response-lifetime accounting

`app-gateway-response-lifetime-cost-settlement` exercises the real HTTP handler
and daily cost writer with synthetic provider and database ports. Both JSON and
SSE responses must retain exactly one write with actual input, output, and cached
input counts through request completion. Three nearby outcomes preserve tool
responses and unauthenticated rejection. The parent loses two deferred writes;
the historical fix passes all five outcomes. Twelve calibration controls include
synchronous JSON accounting, equivalent background scheduling, detached work,
unused fixed code, missing writes, lost cached counts, reordered SQL, and a missing-module
infrastructure failure. Run `bun test evals/coding-agent/calibrate-cost-lifetime.test.js`.

The simulated lifetime ends after the handler, response body, and registered work
complete; the database operation completes on a later scheduler turn. Actual SQL executes
against an in-memory SQLite ledger; assertions inspect the resulting row. This is
not native Workers termination, live D1 durability, retry or concurrent billing
coverage. Hidden fixtures and dependency links appear only at grading time;
execution isolation and model performance remain unproven.

## Recording resume controls

`app-recording-global-device-resume` renders the actual `RecordingStatus`
component with real Radix popover and tooltip controls in jsdom. Synthetic API
and callback ports observe global session resume separately from per-device
resume. Eight outcomes cover both resume modes, global pause, mixed device
states, legacy monitors without IDs, missing callbacks and request-failure
rollback. The parent fails three resume outcomes and preserves five; applying
only the historical component fix passes all eight.

Run `bun test evals/coding-agent/calibrate-recording-resume.test.js` with the
frontend dependencies installed. Eleven controls include the current component,
an equivalent private-name change, unused correct code, reversed mode routing,
broken pause, lost rollback and missing-source classification. A separate
current-only check preserves disabled-capture settings recovery; that newer
prop is not required by the historical task. The grading config uses a plain
translation port, so translation delivery is outside this evidence.

This case covers frontend decisions and synthetic effect boundaries. It does
not establish Home callback wiring, native recording resumption, operating-system
capture, agent isolation or model improvement. The hidden fixture and dependency
link are installed only after the trajectory ends. No evaluated agent runs in
calibration or baseline/reference verification.

## OpenAI streaming tool policy regression

`app-openai-stream-tool-choice` executes the historical OpenAI provider with a synthetic SDK transport. The broken parent loses explicit tool choices on four streams and the unsupported-usage retry; seven neighboring outcomes still pass. The provider-only historical repair and current source pass all twelve checks.

The grader checks caller-selected policy, tool schemas, model/messages, input preservation, retry behavior, native tool fragments, content, usage and stream termination. Eleven calibration controls include equivalent code, an unused repair, forced policies, lost schemas/fragments and a missing-source setup error.

```sh
bun test evals/coding-agent/calibrate-openai-tool-choice.test.js
```

This covers the provider boundary with synthetic transport. It does not establish model adherence, actual tool execution, gateway authentication, native Pi policy, agent isolation or model gains. The existing GLM case covers response conversion and remains separate.

## Repeated chat prompts

`app-chat-repeat-prompt-identity` runs the actual sidebar selector with synthetic
in-memory records. Independent sends and legacy records stay separate; true
message copies still collapse. Twelve outcomes also preserve wrappers, branches,
pipe runs, the existing creation window, visible survivors and input records.

Run `bun test evals/coding-agent/calibrate-chat-repeat-identity.test.js` with
frontend dependencies installed. Controls include an equivalent identity encoding,
unused correct code, disabled deduplication, identity-field omissions, a hidden
survivor and missing-source classification. Fixtures and dependency links appear
only at grading. This does not execute disk history/search, metadata transport,
a mounted sidebar, native delivery, agent isolation or model trials.

## OCR derived-copy retry

`app-ocr-derived-copy-retry` runs the real native redaction worker against a
temporary SQLite database and local regex redactors. Five outcomes cover map
and spanless OCR scrubbing, geometry and clean-text preservation, optional-column
opt-outs, and a rejected OCR write followed by a worker restart and successful
retry. The fixture is installed only when grading starts. No dependency or build
cache links are declared. The hidden grader accepts replacement labels and JSON
formatting that preserve the required behavior.

The case supplies a synthetic schema with the relevant completion columns. It
does not verify migrations, process death or database reopening, capture
continuity, old-row backfill, whitespace-split entities, live model providers,
agent isolation or model capability. Run the shared runner with
`--case app-ocr-derived-copy-retry --verify`; compilation and extraction failures
must remain infrastructure errors, not evidence of the historical defect.

### Enterprise local policy waits

`app-enterprise-local-policy-waits` runs the actual enterprise authentication hook with synthetic HTTP, settings and native-command boundaries. Fourteen outcomes cover six stalled local operations, late install metadata, rejected/expired credentials, credential choice, account-only access, recording pause, native denial and healthy policy persistence. The task allows ten seconds for one stalled operation; it does not require a particular timer helper or warning message.

Run `bun test evals/coding-agent/calibrate-enterprise-policy-waits.test.js` to check the broken parent, historical reference, current hook, equivalent helper names, disconnected correct source, omitted persistence, excessive wait, native/pause bypasses and missing-source infrastructure failure. These checks do not establish native recording enforcement, real disk durability, host isolation or model performance.

`app-learning-save-readback` runs the actual opted-in learning extension with
synthetic service replies and temporary local state. Five outcomes reject a
mismatched saved identity, origin or content despite matching response hashes.
Seven nearby outcomes cover hash failures, uncertain writes, restart protection,
successful creation, whitespace normalization and owned updates. The parent fails
five and preserves seven; the reference and current source pass all twelve.
Run `bun test evals/coding-agent/calibrate-learning-save-readback.test.js` for ten
controls, including equivalent helper naming, unused correct code, blanket save
refusal, lost reports, ignored hashes, lost pending state and missing source.
Fixtures appear only at grading. This checks the extension and its local receipts;
real skill-store durability, native authorization, context privacy filtering,
execution isolation and model performance remain outside this evidence.

## Active recording storage volume

`app-active-recording-storage-volume` runs the actual React storage hook with
synthetic native and settings ports. Ten outcomes compare low and healthy active
volumes against conflicting saved paths, then cover refresh, native reserve
boundaries, probe failures, disabled checks and late results. The parent fails
four volume outcomes and preserves six; the historical fix and current hook
pass all ten. Run `bun test evals/coding-agent/calibrate-active-storage-volume.test.js`
for twelve controls, including unused correct code, a wrong-volume bypass,
blanket warning suppression, an equivalent boundary and missing-source errors.
Fixtures and runtime links appear only when grading begins. This does not test
real disk space, IPC delivery, native recording or migration policy, execution
isolation or model performance.


`ai-gateway-wif-token-retry` exercises the public Vertex token method with real
ephemeral RSA signing and synthetic transport. Each exchange recovers from
transient HTTP and network failures, bounds retries, and refuses permanent
errors. Signed claims, exchange credentials, valid-token caching and legacy
authentication remain intact. The parent fails eight outcomes and preserves six;
the historical fix and current source pass fourteen. Run
`bun test evals/coding-agent/calibrate-wif-token-retry.test.js` for fourteen
controls, including equivalent backoff, an unused repair, disconnected exchanges,
wrong credentials and lost caching. Fixtures appear only at grading and require
no dependency links. Missing provider source is a setup failure. This does not
establish real provider availability, gateway HTTP admission, concurrent or
cross-account cache isolation, execution isolation or model performance.

`app-pipe-run-terminal-preservation` mounts the actual recorder through a synthetic
event bus and uses its real NDJSON parser. Eight outcomes cover intermediate turns,
complete terminal transcripts, ordinary completion, disabled history, foreign events,
foreground ownership and duplicate terminals. The parent fails two outcomes and
preserves six; the historical recorder fix and current source pass eight. Run
`bun test evals/coding-agent/calibrate-pipe-run-terminal.test.js` for calibration.
Storage and settings are synthetic; this does not establish native delivery, disk
durability, crash recovery, continued-chat behavior, agent isolation or model quality.
The hidden fixture is installed only when grading begins.


`app-transcription-nova-language` runs the actual batch transcription handler and
A/B service with synthetic audio and intercepted provider transport. Twelve
outcomes cover automatic, single, multiple, normalized and legacy language
selection, query precedence, audio preservation and successful/error payloads.
The parent fails nine language outcomes and preserves three; the service-only
historical fix and current source pass all twelve. Run
`bun test evals/coding-agent/calibrate-transcription-language.test.js` for eleven
controls, including an equivalent implementation, unused correct code, wrong
language shortcuts, lost audio and missing-source/syntax infrastructure errors.
Fixtures appear only at grading and need no dependency links. This does not
establish speech recognition quality, native settings persistence, real provider
delivery, alternate-provider behavior, execution isolation or model improvement.

## Manual sync HTTP failures

`app-manual-sync-http-failure` mounts AccountSection with synthetic local HTTP,
settings and native ports. Sixteen outcomes cover pull/push refusal, server-error
feedback, non-JSON status fallback, retry, successful sequencing, network errors
and disabled choices. The parent fails nine outcomes and preserves seven; the
historical reference and current component pass sixteen. Run
`bun test evals/coding-agent/calibrate-manual-sync.test.js` for correct, broken,
bypass, equivalent, preserved-behavior and setup-error controls. Hidden fixtures
and dependency links appear only after the trajectory. This does not establish
native persistence, encryption, real account access, provider delivery, execution
isolation or model improvement.

The `app-native-calendar-unavailable-poll` case executes the actual frontend
calendar module with synthetic HTTP and native-command ports. Nine outcomes
cover repeated unavailable polls, explicit disconnected responses, stale or
unknown status recovery, connected empty calendars, authorized HTTP failures,
and preserved Google/ICS providers. The parent fails two intended outcomes and
preserves seven; reference and current source pass nine.
Run `bun test evals/coding-agent/calibrate-calendar-unavailable.test.js` for eleven
controls, including equivalent implementations, unused repairs, blanket native
suppression and missing-module setup errors. Only the frontend calendar module
is applied from the historical fix. Native endpoint mappings, OS permissions,
OAuth refresh, publisher backoff, enforced agent isolation and model performance
remain outside this evidence. Fixtures and dependencies are installed at grading.


`app-meeting-stop-save-refusal` mounts the real historical NoteView with synthetic
editor-input, HTTP and native ports. Five outcomes preserve draft-save ordering,
overlapping edits, ordinary autosave and unchanged notes, while ensuring an
explicit Stop still runs once after a failed save, with a warning and no false
Saved indication. The parent fails that Stop outcome and preserves four; the
historical reference passes five. Separate current-component checks preserve
these outcomes with current display and inactive-service adapters.
Run `bun test evals/coding-agent/calibrate-meeting-stop.test.js` with desktop test
dependencies available for eleven historical grader controls, including inline warnings, empty feedback, changed
warning copy, unused correct source, early/duplicate Stop, silent refusal, false
Saved status and missing-source classification. Hidden fixtures and dependency
links appear only when grading begins. This does not test editor internals,
native stop/deferral release, database durability, global recording pause, full
current dependency parity, execution isolation or model improvement.

## Memory tags around malformed rows

`app-memory-tag-filter-malformed-json` executes actual database list/count methods
against disposable SQLite databases. Six outcomes cover malformed stored tags,
exact multi-tag matching, missing tags, full-text search, unfiltered reads, source
and importance filters, ordering, pagination and preservation of stored values.
The parent fails four outcomes and preserves two; the historical source-only fix
passes six. Run `bun test evals/coding-agent/calibrate-memory-tag-filter.test.js`
for correct, broken, equivalent, disconnected, partial-repair, ignored-filter,
blanket-filter and missing-source controls. Hidden fixtures appear only at grading.
No build-cache links are declared. This does not establish sync ingestion, HTTP
routing, hybrid storage, concurrent writes, execution isolation or model quality.

## Redaction across missing schema targets

`app-redact-missing-schema-target` runs the actual native Worker with local regex
redaction and synthetic temporary SQLite data. Six outcomes cover missing tables
and columns, later-row progress, ordinary redaction, clean-text preservation,
pause/resume, transient-write retry and corruption-error backoff with shutdown.
The parent fails the two missing-schema outcomes and preserves four; the
historical reference and current source pass all six. The task discloses the
small-workload timing bounds and does not require an exact implementation.

Run the shared runner with `--case app-redact-missing-schema-target --verify`.
The hidden fixture appears only at grading; no dependency or target-cache links
are declared. Calibration rejects unused correct code, blanket skipping, treating
all errors as missing schema and lost pause behavior, while accepting an
equivalent missing-object predicate. Compilation/setup failures are infrastructure
errors. The malformed-database error is supplied by a synthetic SQLite trigger,
not an actually corrupt database. This does not establish migration safety,
capture continuity, real corruption recovery, host isolation or model capability.
