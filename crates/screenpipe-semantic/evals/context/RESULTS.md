# Semantic context eval results

Run date: 2026-07-25

## Deterministic representation suite

Release-mode results across seven representative parser-family fixtures and
three exact ChatGPT, Claude, and Obsidian fixtures:

The registry now contains 23 parser implementations covering all 47 cataloged
targets through shared families plus exact app overrides.

| format | retained facts | context tokens | complete prompt tokens | tokens per retained fact |
|---|---:|---:|---:|---:|
| raw accessibility JSON | 30/30 | 1,660 | 2,065 | 55.33 |
| current element outline | 26/30 | 1,081 | 1,486 | 41.58 |
| semantic context | 30/30 | 372 | 777 | 12.40 |

Semantic context used 62.4% fewer complete input-prompt tokens than raw JSON
and 47.7% fewer than the current outline. Each case included one explicitly
off-screen synthetic distractor. Raw JSON and the outline retained all 10;
semantic context retained zero while preserving all 30 visible facts. The
adapter suppressed 297 source bytes but retained every node's role, hierarchy,
identifiers, classes, state, and bounds.

Semantic context also retained task status, calendar schedule, and editor
identity facts that the text-only outline dropped. Representative compact trees
retained at most 1,656 heap bytes. Every release-mode 1,000-iteration adapt,
parse, and render benchmark stayed below 6 microseconds mean and p95 latency.
These tiny synthetic trees are regression signals, not the older-hardware
acceptance benchmark.

## Prior local Pi model check

A 2026-07-24 warmed, counterbalanced 30-prompt run used
`ollama/screenpipe-gemma4:latest` through Pi with tools, project context,
skills, extensions, sessions, and startup network checks disabled:

| format | correct answers |
|---|---:|
| raw accessibility JSON | 9/10 |
| current element outline | 5/10 |
| semantic context | 10/10 |

This model result is exploratory and not a CI gate. It is a single small local
model run, and repeated runs showed that answers can vary. The
deterministic token and fact-retention checks are the stable regression gate.
Claude was answered correctly in all three formats. Obsidian was correct from
raw and semantic context, while the current outline hallucinated an unrelated
output.

## Privacy-safe real-data replay

A time-distributed 90-day replay used a bounded, app-stratified sample from the
local Screenpipe database. The replay fetched 1,668 selected frame IDs into a
mode-0600 temporary file, deleted that private tree export before report
generation, and retained only aggregate structural metrics:

| metric | result |
|---|---:|
| app-identity matched frames | 441/1,668 |
| handled frames | 217/1,668 |
| handled among identity matches | 49.21% |
| raw tokens across handled frames | 3,217,866 |
| semantic tokens across handled frames | 161,802 |
| token reduction on handled frames | 94.97% |
| compact-tree build | 18 us p50, 203 us p95 |
| parser chain | 1 us p50, 74 us p95 |
| maximum compact-tree heap | 180,251 bytes |
| parser failures | 0 |

Per-app identities and sample counts from the local replay are intentionally not
committed because they are user-activity metadata. App-specific behavior is
covered by synthetic fixtures instead. Historical captures often lacked DOM
classes and structural container nodes, so fresh opt-in captures remain
necessary for parser contracts that depend on the transient structural sidecar.
The replay has no human semantic labels, so it measures safe applicability,
context size, time, and memory, not extraction correctness.

### Recent off-screen visibility audit

A separate read-only streaming replay on 2026-07-27 processed the newest 1,000
valid saved trees without writing captured text or app identities to disk or
the report:

| subset | frames | frames with suppressed content | suppressed nodes | suppressed source bytes |
|---|---:|---:|---:|---:|
| all sampled trees | 1,000 | 833 | 101,071 | 3,552,559 |
| parser candidates | 478 | 425 | 47,936 | 1,624,848 |
| handled semantic frames | 257 | 256 | 31,843 | 1,047,954 |

The handled frames rendered 107,537 semantic tokens versus 5,396,623 raw JSON
tokens, a 98.01% representation reduction, with zero parser failures. That
percentage measures the complete semantic projection rather than attributing
the entire reduction to visibility filtering. The direct visibility result is
that known off-screen text contributed about 1.05 MB of parser input across the
handled frames and no longer enters semantic memory. Inner scroll-container
clipping remains outside this audit because the current platform flag only
tests intersection with the focused window.

## Committed-data privacy audit

All checked-in accessibility fixtures and pipe evidence are synthetic. The
historical replay wrote selected raw trees only to a mode-0600 temporary file,
deleted it before report generation, and committed only aggregate metrics. A
test rejects local home paths, macOS temporary paths, non-example email
addresses, private-key material, and common credential prefixes in eval files,
fixtures, and this specification.

## Storage boundary

The normalized schema stores runs, canonical item versions, run-local
observations, and a nullable frame link. It never stores another tree JSON blob.
The SQLite page-growth regression first inserts 1,000 ordinary frame rows, then
measures only the active database pages added by semantic persistence:

| synthetic trace | semantic growth | bytes per frame | release write time |
|---|---:|---:|---:|
| 1,000 identical projections | 8,192 bytes | 8.2 | 72.1 us/frame |
| 1,000 changing projections | 802,816 bytes | 802.8 | 156.4 us/frame |

Identical frames share one run and one copy of each item. The changing trace
keeps one stable conversation item but creates a run-scoped message version for
every observation. The test also covers FTS indexes and the larger frame rows
caused by the non-null run link.

At one frame every 30 seconds, those synthetic endpoints extrapolate to about
24 KB/day and 8.6 MB/year for identical content, or 2.3 MB/day and 0.84 GB/year
if every frame changes. At one changing frame every 10 seconds, the semantic
layer would be about 6.9 MB/day and 2.53 GB/year. These are page-level synthetic
projections, not a measured user workload, and exclude screenshots, audio,
existing text, tree JSON, and elements.

This PR does not reduce total storage because opted-in capture keeps all
existing raw data. Reduction requires a later measured `lean` policy to clear
heavy raw tree and geometry only after a durable successful parse. A
representative real-capture trace remains necessary before choosing retention
defaults.

## Runtime boundary

Structured app context is off by default. With the setting disabled, Screenpipe
does not construct the parser registry or worker, enqueue trees, or write
semantic rows. When enabled, one latest-value slot replaces stale pending work,
one background task parses, and failures preserve the existing generic capture.
On one fresh Arc window, 30 warmed walks visited the same 38 nodes: the baseline
averaged 4.4 ms and semantic capture averaged 4.7 ms. Semantic capture retained
five transient structural nodes while persisted raw tree JSON remained exactly
4,987 bytes in both runs. This is a single-window development-machine check,
not the older-hardware acceptance benchmark.

The real replay now covers actual accessibility-tree sizes and supports the
bounded parse-work design, but it excludes continuous scheduling, synchronous
PII replacement, resident-process memory, and real-disk contention. It still
does not prove the under-0.5-percent CPU or under-20-MB RSS acceptance gates.
