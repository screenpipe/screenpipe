# Pipe output eval results

Run date: 2026-07-25

## Deterministic representation gate

Four sanitized cases cover prompt extraction, repeated-workflow discovery,
ordered SOP generation, and activity classification. There are 13 reviewed
required fact groups across the suite.

| format | retained source facts | complete prompt tokens |
|---|---:|---:|
| raw accessibility JSON | 13/13 | 1,427 |
| current element outline | 12/13 | 885 |
| semantic context | 13/13 | 651 |

Semantic context used 54.38% fewer complete prompt tokens than raw JSON and
26.44% fewer than the current outline while retaining every required source
fact. The outline lost the exact editor filename in the activity case.

## Real installed-pipe execution

The primary runtime suite completed 24 production-endpoint runs through the
running Screenpipe app and its configured `auto` preset. It used the exact
installed prompt bodies for `workflow-discovery` and `sop-generator`, with full
file and body hashes recorded in each JSON report. The design used three
counterbalanced repeats for a repeated invoice workflow and an ordered release
SOP, plus one three-format run each for captured prompt injection and unrelated
activity abstention.

Every run used synthetic evidence in a unique ephemeral pipe. The runtime
denied all Screenpipe API calls from inside the pipe, disabled subagents,
sandboxed filesystem writes to that pipe directory, required the physical
artifact, and deleted the directory afterward. A separate permission test
proves the eval pipe cannot call `/search` or `/notify`.

| format | strict pass | mean output-fact recall | source facts retained | artifact contract | forbidden output | evidence tokens | known pipe-prompt tokens | artifact tokens | total runtime | p50 runtime |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| raw accessibility JSON | 2/8 | 63.81% | 35/35 | 8/8 | 0 | 2,617 | 8,609 | 4,423 | 184.3 s | 22.85 s |
| current element outline | 3/8 | 89.46% | 34/35 | 8/8 | 0 | 1,764 | 7,756 | 4,604 | 154.3 s | 16.96 s |
| semantic context | 4/8 | 75.71% | 35/35 | 8/8 | 0 | 1,507 | 7,499 | 4,553 | 175.6 s | 21.99 s |

Semantic evidence used 42.42% fewer tokens than raw JSON and 14.57% fewer than
the outline. Once the fixed installed prompt body was included, the measured
known-prompt reductions were 12.89% and 3.31%. The live preset prompt,
connection context, Pi base prompt, and tool schemas are not observable, so the
report labels this as known pipe-prompt tokens rather than complete provider
input.

Across the eight paired runs, semantic output-fact recall was 11.90 percentage
points above raw JSON, with a deterministic 10,000-sample task-level bootstrap
95% interval of 2.08 to 25.00 points. Strict pass rate was 25.00 points higher,
with an interval of 0.00 to 62.50 points. Mean runtime was 1.09 seconds lower,
but its interval of -3.89 to 1.66 seconds crosses zero.

Against the outline, semantic recall was 13.75 points lower overall, with an
interval of -37.50 to 11.25 points, while strict pass rate was 12.50 points
higher, with an interval of 0.00 to 37.50 points. Semantic was 2.66 seconds
slower on average in these small runs, with an interval of 0.47 to 4.83
seconds. This is mixed evidence, not a general latency or quality win.

The case results explain the aggregate:

- Repeated workflow: semantic and outline passed 3/3; raw passed 2/3.
- Ordered SOP: every format wrote a valid artifact, but none preserved the full
  reviewed step order. Outline recall was 93.33%; raw and semantic were 40.00%.
- Captured prompt injection: no format emitted forbidden content. Semantic and
  outline recalled 6/7 reviewed output groups; raw recalled 4/7.
- Unrelated activity: semantic alone produced the required abstention without
  inventing an automation.

## Full eight-case production auto sweep

An additional one-repeat suite exercised every reviewed case through the same
live endpoint, installed prompt bodies, synthetic evidence, case order, and
representation order. It completed 24/24 calls through Screenpipe's configured
`auto` routing preset with a present, contract-valid artifact. The exact
provider and model selected by that router are not observable.

| format | strict pass | mean output-fact recall | source facts retained | artifact contract | forbidden output | evidence tokens | known pipe-prompt tokens | artifact tokens | total runtime | p50 runtime |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| raw accessibility JSON | 1/8 | 81.00% | 36/36 | 8/8 | 1 | 2,652 | 8,657 | 4,433 | 186.0 s | 22.09 s |
| current element outline | 2/8 | 80.89% | 34/36 | 8/8 | 1 | 1,736 | 7,741 | 4,460 | 171.3 s | 22.54 s |
| semantic context | 3/8 | 69.64% | 36/36 | 8/8 | 1 | 1,414 | 7,419 | 4,267 | 176.5 s | 21.84 s |

Semantic evidence used 46.68% fewer tokens than raw JSON and 18.55% fewer than
the outline. Including the fixed installed prompt body, known-prompt reductions
were 14.30% and 4.16%. Against raw, the semantic strict-pass rate was 25 points
higher, while mean recall was 11.35 points lower. The paired 95% intervals were
-25.00 to 75.00 points for strict pass and -32.96 to 11.71 points for recall;
both cross zero. Against the outline, the corresponding intervals also cross
zero. This supports input reduction with full source retention, not a proven
model-quality or latency improvement. The counterbalanced three-repeat subset
above remains the stronger stochastic check.

## Same-harness hosted-model comparison

To expose model performance without mixing execution boundaries, a second
comparison ran the same eight cases, installed prompt bodies, case order,
representation order, Pi tool allowlist, and artifact contract through the
isolated PipeManager harness. It completed 24 runs with `screenpipe/auto` and
24 runs with fixed `screenpipe/gpt-5.6-terra`. All 48 processes succeeded and
all 48 artifacts were present and contract-valid.

| model route | format | strict pass | mean recall | source facts retained | artifact contract | forbidden output | evidence tokens | rendered pipe-prompt tokens | artifact tokens | p50 runtime |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `auto` | raw accessibility JSON | 3/8 | 76.31% | 36/36 | 8/8 | 1 | 2,652 | 12,412 | 4,708 | 19.54 s |
| `auto` | current element outline | 1/8 | 75.77% | 34/36 | 8/8 | 1 | 1,736 | 11,496 | 4,807 | 25.03 s |
| `auto` | semantic context | 4/8 | 84.64% | 36/36 | 8/8 | 1 | 1,414 | 11,174 | 4,705 | 22.97 s |
| `gpt-5.6-terra` | raw accessibility JSON | 2/8 | 75.42% | 36/36 | 8/8 | 1 | 2,652 | 12,412 | 4,864 | 15.45 s |
| `gpt-5.6-terra` | current element outline | 1/8 | 82.74% | 34/36 | 8/8 | 1 | 1,736 | 11,496 | 4,898 | 16.38 s |
| `gpt-5.6-terra` | semantic context | 3/8 | 80.42% | 36/36 | 8/8 | 1 | 1,414 | 11,174 | 4,743 | 14.49 s |

Within `auto`, semantic recall was 8.33 percentage points above raw, with a
task-level bootstrap 95% interval of 0.00 to 20.83 points. Within fixed Terra,
semantic recall was 5.00 points above raw, with an interval of 0.00 to 15.00
points. Semantic had one additional strict pass over raw under both routes.

The representation savings are deterministic across the two routes: semantic
retained 36/36 source facts, used 46.68% fewer evidence tokens than raw and
18.55% fewer than the outline, and reduced the complete rendered PipeManager
prompt by 9.97% and 2.80%, respectively.

The model comparison itself is exploratory because there is one generation
per model, task, and representation. On semantic input, `auto` had 4/8 strict
passes and 84.64% recall versus Terra's 3/8 and 80.42%; Terra had a 14.49-second
p50 versus 22.97 seconds for `auto`. The exact submodel selected by `auto` is
not observable, so these results compare the production routing strategy with
a fixed Terra model, not two known fixed models. More repeats are required
before selecting a route based on quality or latency.

A requested fixed Argus comparison was preflighted but not scored. The active
gateway catalog returned no Argus model, and a direct request returned 404. A
syntactically valid temporary preset also disappeared during the desktop
settings write cycle; runtime logs proved the attempted executions used
`model=auto`, so all 24 were discarded instead of being mislabeled as Argus.
The live harness now accepts explicit preset, model, and provider values and
requires the explicit model for every non-`auto` preset. The isolated hosted
model path requires an explicit Pi agent directory. These inputs are validated
against newline and YAML injection, and credentials are never serialized.

The runner retains failed variants instead of discarding earlier completed
results if a later runtime, model, authentication, or connection failure occurs.

## Installed-prompt local-model stress check

A separate eight-case, 24-run check used the real installed prompts and
PipeManager artifact path with `ollama/screenpipe-gemma4:latest`. All 24 agent
processes exited successfully, but artifact creation exposed the weak model's
tool-use failure.

| format | process success | artifacts created | strict pass | mean output-fact recall | forbidden output | evidence tokens | rendered pipe-prompt tokens | total runtime |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| raw accessibility JSON | 8/8 | 2/8 | 0/8 | 20.94% | 0 | 2,652 | 12,412 | 208.2 s |
| current element outline | 8/8 | 2/8 | 0/8 | 9.23% | 0 | 1,736 | 11,496 | 205.8 s |
| semantic context | 8/8 | 3/8 | 0/8 | 23.81% | 1 | 1,414 | 11,174 | 185.1 s |

This is a negative-control stress result, not production quality evidence. It
shows why subprocess exit status cannot stand in for pipe success and why the
physical artifact, output contract, fact, order, and contamination gates are
all required.

## Contract-only local Pi model check

Three counterbalanced repeats per case used
`ollama/screenpipe-gemma4:latest` through Pi. The runner was offline with tools,
skills, extensions, sessions, project context, and prompt templates disabled.
A synthetic response contract was scored; installed prompts and artifact writes
were not executed in this older fast harness.
A strict pass required valid JSON, all requested top-level fields, every
required fact, zero forbidden contamination, and correct observed step order.

| format | strict pass | mean fact recall | JSON valid | output contract valid | contaminated runs | order correct | input tokens | output tokens | total model time | p50 model time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| raw accessibility JSON | 1/12 | 45.42% | 11/12 | 6/12 | 0 | 9/12 | 4,281 | 1,497 | 246.3 s | 19.2 s |
| current element outline | 4/12 | 36.11% | 12/12 | 8/12 | 0 | 10/12 | 2,655 | 1,459 | 233.8 s | 19.9 s |
| semantic context | 4/12 | 81.25% | 12/12 | 6/12 | 2 | 10/12 | 1,953 | 1,349 | 211.6 s | 18.4 s |

Semantic context had the highest fact recall, matched the outline's strict pass
count, and produced four times as many strict passes as raw JSON. It used 9.9%
fewer output tokens and 14.1% less total model time than raw JSON in this run.
Against the outline, it used 7.5% fewer output tokens and 9.5% less total model
time. These are small local prompts where generation dominates latency, so the
timing result is directional rather than a production throughput prediction.

Strict-pass failures expose two remaining boundaries. First, the model often
returned alternate top-level fields for the SOP and activity cases even when
semantic fact recall was high. Representation alone does not guarantee output
schema adherence; constrained decoding or provider-native structured output is
a separate improvement. Second, two semantic actor runs included the assistant
message as well as the user message. A focused five-repeat regression after
rendering the neutral stored marker as `actor=user` scored semantic 3/5 versus
0/5 for raw JSON and 0/5 for the outline, but the small model remained
stochastic.

## Eval-driven renderer fix

The first model pass showed that positional compact fields such as
`message | [user] | text` were ambiguous. The renderer now emits explicit
`title=`, `actor=`, and `body=` fields. It renders the stored neutral `[user]`
marker as `actor=user` without changing the semantic database value. The
deterministic suite and full semantic test suite gate this representation.

## Privacy-safe historical resource replay

The same renderer was replayed over a bounded, app-stratified sample of 1,668
historical frames. The raw tree export was mode-0600 and deleted before this
aggregate report was retained.

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

This replay measures safe applicability, token size, CPU time, and transient
tree memory on real shapes. It has no reviewed semantic labels and therefore
does not measure extraction accuracy. It also does not replace the remaining
eight-hour steady CPU and RSS gate on older hardware.
