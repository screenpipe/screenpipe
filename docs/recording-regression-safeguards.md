# Fast recording regression safeguards

<!-- doc-covers: none -->

This is the first, deliberately narrow safeguard for recording releases. It
protects an existing Windows pixel-restoration invariant without building the
desktop application or calling a model. It also provides an offline validator
for synthetic native capture results. It does **not** establish that a Windows
release has passed a real desktop capture test.

## Evidence and scope

The [reported regression](https://screenpipe.slack.com/archives/C0CLU50VDHS/p1795739055035029)
was partial-black screenshots and overlapping windows against black backgrounds
after v2.7.153. The issue says the bug is fixed. PR
[#7979](https://github.com/screenpipe/screenpipe/pull/7979) is a suspected cause,
not a verified root cause. Its description documents persistent WGC display
capture, window witnesses, scene churn tests, and synthetic native probes.
The Slack report was supplied in the issue; this investigation did not access
the Slack conversation independently.

Current code in `screenshot_privacy/windows.rs` restores opaque allowed witness
RGB directly. Its comment explains that comparing isolated-window RGB with the
display compositor can black out ordinary shadows/theme differences. Existing
Windows unit tests cover this, movement, ownership changes, and transparency,
but are behind the Windows module boundary. The ignored live tests require an
unlocked console. The existing `screenshot_redaction_probe` persists and reopens
JPEGs, checks excluded marker leakage, and emits JSONL. Its usefulness test is
only `allowed_pixels > 0 && stored_allowed_pixels > 0`, which can miss a
mostly-black frame.

Existing Rust/Windows integration workflows have 90-minute timeouts and build
large native dependencies. The macOS capture-fidelity scenario waits 90 seconds
for pipeline flushing and primarily checks health/OCR/events, rather than Windows
pixel coverage. These are configured budgets and waits, not measured CI timings.
`metrics.rs` and `/health` expose corrupt-black/green counters, but near-black
skips are treated as progress to avoid false alarms from excluded windows or
DRM. Those counters cannot reliably identify this partial-black regression.
This change leaves recording, redaction, health semantics, and telemetry intact.

`Release App` prepares immutable versioned artifacts. Publication is a separate,
human-only admin action, described in `human-only-app-publication.md`; its server
implementation is not in this checkout. A green artifact build alone is not a
server-enforced publication guarantee.

## Practical alternatives

| Approach | Signal / cost | Decision |
| --- | --- | --- |
| Portable production invariants | Sub-second locally; no native dependency build, network, or model calls during tests | Run locally, on relevant PRs, daily on main, and before release preparation |
| Synthetic Windows desktop probe | Exercises WGC, overlap/switches, redaction, and persisted output; needs an isolated console and prepared binaries | Provide strict offline result validation now; hardware automation remains pending |
| Broad end-to-end or model-scored screenshot eval | Useful breadth, but more dependencies, latency, flakiness, and inference cost | Keep separate; do not make it the daily development loop |
| Customer screenshot or black-pixel telemetry | Ambiguous on dark/DRM/excluded content; creates privacy and false-alarm risks | Do not add collection or use as a publication gate |
| Small candidate rollout | Finds hardware/driver failures synthetic tests miss; requires human rollout and recovery policy | Recommend after native canary validation; do not activate live settings here |

Public practices reviewed on 2026-11-27:

- [PostHog development process](https://posthog.com/handbook/engineering/development-process)
  recommends small changes, developer verification, dogfooding, and partial
  features behind flags. This supports a small, reproducible developer command;
  it is not evidence that PostHog uses our proposed capture gate.
- [GitLab deployment process](https://handbook.gitlab.com/handbook/engineering/deployments-and-releases/deployments/)
  starts from green builds, blocks on reliable canary smoke tests, and describes
  a 30-minute canary period plus manual promotion. Apply the separation of
  cheap checks, representative canaries, and promotion; do not copy their whole
  infrastructure or timing budget into a desktop recorder.
- [Google SRE: Canarying Releases](https://sre.google/workbook/canarying-releases/)
  explains limiting exposure and selecting application-specific quality signals,
  including for noninteractive processing. For capture, persistence and allowed
  pixel coverage matter in addition to process liveness.

These are public written practices, not interviews. Nobody was contacted.
Optional question for YC peers: “Which sub-minute checks and synthetic desktop
canaries actually block your releases? How do you bind results to the shipped
artifact, handle unavailable hardware, and route failures without alert spam?”

## Implemented loop

```sh
bun test ./scripts/recording-regression/
```

The suite extracts the existing pure `restore_opaque_witness_pixel` function from
the selected production source and compiles it with `rustc --test` and synthetic
fixtures. It requires the function and its production call site to remain
present; extraction/refactor failures block rather than silently skip. It tests
opaque coverage, compositor RGB differences, withheld nonopaque pixels, and
output alpha. Deliberate blackout and privacy-leak mutations must fail the same
tests. This small source bridge avoids changing native capture code merely to
test it. If that helper is refactored, update the bridge with the native tests;
do not weaken or skip it to get green.

The bridge does not compile the full Windows module or test Win32, GPU drivers,
window selection, geometry, scene ordering, or real persistence. The source call
site check is a structural guard, not proof that every capture path uses it.

```text
Before: PR -> large native CI --------------------> human publication check
After:  PR -> fast invariant + negative controls -> early actionable failure
        release SHA -> same verifier ------------> artifact builds -> human gate
        synthetic Windows probe -> offline coverage validator (hardware pending)
```

The new path-filtered workflow also runs daily on main and on manual dispatch.
Failures produce a failed GitHub check, annotation, and reproduction instructions.
It monitors the portable invariant, not a live Windows desktop. There are no
retries that turn product failures green, timing-sensitive FPS assertions, new
services, or outbound alert webhooks. GitHub Actions notifications depend on the
maintainer's subscription settings; no team routing was configured.

`Release App` uses the verifier from `github.workflow_sha` against the exact
resolved release SHA in a separate checkout. Missing/renamed invariants fail
closed, including historical recovery candidates. Both localization and draft
preparation depend on this job, so normal and enterprise-recovery artifact paths
cannot pass through a failed check. There is no skip input. Existing uploaded
artifacts and the external admin publication endpoint are unaffected.

## Synthetic native recurrence validation

On an isolated synthetic Windows desktop, the existing probe's stdout can be
validated without uploading screenshots:

```sh
bun scripts/recording-regression/check-probe.ts scenario.json probe.jsonl
```

Example scenario configuration (illustrative floors, **not a calibrated baseline**):

```json
{
  "name": "overlapping-windows",
  "samples": 60,
  "width": 1280,
  "height": 720,
  "minAllowedPixels": 150000,
  "minStoredAllowedPixels": 140000
}
```

The validator requires every scheduled sample and a consistent summary, the
expected full-size capture and reopened JPEG, zero excluded magenta pixels,
minimum cyan coverage in both outputs, an advancing native sequence/time, and
one display session throughout. It rejects missing metrics, malformed input,
partial success, and impossible counts. The CLI emits only aggregate metrics
or a bounded scenario/sample failure reason. Do not upload raw JSONL: the probe
also logs paths/errors and writes images locally. Validator output is an offline
measurement, not a trusted release attestation; arbitrary submitted JSON cannot
unlock publication.

Hardware setup and native validation are **not active or verified by this PR**:

1. A human must authorize any paid VM use and confirm a validated disposable
   Windows dev image exists. Follow
   `.claude/skills/develop-screenpipe-windows/SKILL.md` and its image reference;
   never run capture probes on the live release builder or a personal desktop.
2. Build the existing `windows_privacy_fixture` and `screenshot_redaction_probe`
   examples at the exact candidate SHA using that workflow. Pin monitor size,
   DPI, screenshot FPS, fixture positions, and snapshot width. Use synthetic
   `allowed`/`blocked` windows for stationary overlap, `allowed-churn` for moving
   allowed content, and `churn` for excluded overlap/Z-order changes. Add explicit
   foreground switching; the fixture's Z-order churn alone is not an Alt-Tab test.
3. Run `exclude` probes in a persistent session, e.g.
   `screenshot_redaction_probe.exe <local-output> exclude 0 60 250 4 > probe.jsonl`.
   Validate every scenario separately. Run the existing `policy-cycle` probe
   separately for full-exclusion and recovery: its intentionally black phase
   must not be fed to this allowed-content validator. Keep geometry transitions
   and native tests as additional coverage, rather than relaxing steady-scene floors.
4. Calibrate and review per-scenario floors on a known-good build; record known
   visible cyan area and JPEG loss. Fix floors before testing a candidate and
   prove a partial-black negative control fails. Aggregate coverage cannot catch
   all spatial corruption or unexpected non-magenta leakage. Region-level image
   assertions are a future extension, not coverage claimed here.
5. Retain native images and raw probe logs inside the disposable environment.
   Export only reviewed aggregate results, exact source SHA, artifact digest,
   scenario/baseline version, and test environment identity. Configure an owned,
   bounded canary job and failure subscription before calling native monitoring
   live; distinguish unavailable/locked hardware from capture assertion failures.

## Remaining publication and alert setup

A human owning the external releases service must enforce a successful trusted
native-canary attestation for the **exact source SHA and signed artifact digest**
before promotion, in addition to this fast gate. Missing, stale, cancelled,
incomplete, or infrastructure-failed evidence must block promotion; attestations
must come from the approved runner/service identity, never a user-supplied file
or an unrelated green PR check. Rebuilding an artifact invalidates its evidence.
Use one failure incident per candidate/scenario and a recovery notice, with a
named owner and run link. Subscribe to failed Actions runs now if desired;
webhook credentials and external alert routing require separate human setup.

Until that integration and the native canary exist, the automatic block here
applies to **artifact preparation for the tested invariant only**. It cannot
guarantee that an already staged artifact will not be published or that the
reported Windows defect cannot recur through a different path. No release,
publication setting, paid service, or customer-data collection was changed.
