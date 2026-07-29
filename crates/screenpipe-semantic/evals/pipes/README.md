# Pipe output evaluation

This suite compares how representative Screenpipe pipe tasks perform when the
same captured evidence is supplied as:

- persisted accessibility JSON;
- Screenpipe's current text-bearing element outline;
- compact semantic context.

The fast four-case harness follows the read and analysis contracts of installed
`ai-prompt-journal`, `workflow-discovery`, `sop-generator`, and
`chronos-time-tracker` pipes. It does not execute those installed prompts. It is
a deterministic representation and scoring regression check against sanitized
fixed evidence with reviewed ground truth.

The separate installed-pipe harness performs real pipe runs for
`workflow-discovery` and `sop-generator`. It reads each installed `pipe.md`,
records hashes of the full file and exact prompt body, renders the prompt
through `screenpipe_core::pipes::PipeManager`, launches Pi, and requires the
pipe to create its physical artifact. A successful subprocess with no artifact
is a failed run. Eight reviewed cases cover repeated workflows, ordered SOPs,
unrelated and single-occurrence abstention, cross-app evidence, and captured
prompt-injection text.

The deterministic gate measures exact `o200k_base` prompt tokens and verifies
that every required source fact remains visible. The opt-in Pi run additionally
scores valid JSON, required output fields, required-fact recall, forbidden
actor or invented-detail contamination, observed step order, output tokens, and
elapsed model time.

Run the stable deterministic gate:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --report
```

Inspect the balanced prompt pack without inference:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --prompts
```

Run three counterbalanced repeats through a local Pi model:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-pi ollama/screenpipe-gemma4:latest 3
```

The optional fourth argument limits a model run to one case, which is useful
for a fast parser or renderer regression check:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-pi ollama/screenpipe-gemma4:latest 5 \
  ai_prompt_journal_actor_precision
```

Run three counterbalanced repeats through the actual installed pipe prompts:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-installed-pipes "$HOME/.screenpipe/pipes" \
  ollama/screenpipe-gemma4:latest 3
```

Hosted Screenpipe models use the same sandboxed installed-prompt path, but
require an explicit existing Pi agent directory for authentication. The path
and credentials are not included in the report:

```bash
SCREENPIPE_EVAL_PI_AGENT_DIR="$HOME/.screenpipe/pi-config" \
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-installed-pipes "$HOME/.screenpipe/pipes" \
  screenpipe/gpt-5.6-terra 1
```

The optional final argument limits the run to one reviewed installed-pipe case:

```bash
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-installed-pipes "$HOME/.screenpipe/pipes" \
  ollama/screenpipe-gemma4:latest 3 sop_release_signing
```

Installed-pipe results include artifact existence, artifact-contract validity,
pre-inference source-fact retention, reviewed output-fact recall, forbidden
contamination, step order, evidence and rendered pipe-prompt tokens, output
tokens, wall time, per-case summaries, and paired semantic-versus-baseline
bootstrap intervals. The three representations are counterbalanced across case
and repeat order. Source retention and model recall are separate metrics so a
parser omission cannot be mistaken for a model failure, or vice versa.

For safety, each installed prompt runs from a temporary pipe directory. The
frontmatter is normalized only for manual eval execution, fixed model choice,
timeout, and disabled history; the installed prompt body is byte-for-byte
preserved and hashed. Pi receives only `read`, `write`, and `ls`; shell, live
Screenpipe APIs, integrations, notifications, extensions, skills, sessions,
and project context are unavailable. This tests the real PipeManager prompt,
installed pipe instructions, Pi tool use, and on-disk artifact contract without
allowing an eval to affect user data. It is intentionally stricter and safer
than a fully privileged production pipe invocation.

For the closest production-runtime check, run the same cases through the
already-running local Screenpipe pipe endpoint. It uses the configured `auto`
preset by default:

```bash
export SCREENPIPE_LOCAL_API_KEY="$(cd "$(mktemp -d)" && \
  bun x screenpipe@latest auth token)"
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-live-installed-pipes "$HOME/.screenpipe/pipes" \
  3 sop_release_signing
```

Set `SCREENPIPE_EVAL_PRESET` to the ID of another configured preset to compare
models without changing the installed pipe or evidence. Non-default presets
also require an explicit model fallback so a settings-write race cannot silently
turn a model comparison into an `auto` run:

```bash
SCREENPIPE_EVAL_PRESET=my-fixed-preset \
SCREENPIPE_EVAL_MODEL=gpt-5.6-luna \
SCREENPIPE_EVAL_PROVIDER=screenpipe \
cargo run --release -p screenpipe-semantic --example pipe_eval --locked -- \
  --run-live-installed-pipes "$HOME/.screenpipe/pipes" 1
```

Live evals are explicitly opt-in and require a healthy authenticated local
Screenpipe API. Each variant is installed under a unique ephemeral pipe name,
uses the real `POST /pipes/:id/run` path and configured model preset, denies all
Screenpipe API calls from inside the pipe, disables subagents, and relies on the
runtime filesystem sandbox. The ephemeral directory and artifacts are removed
after each run. Only synthetic execution metadata remains in the normal pipe
execution history. A per-variant runtime or connection failure is scored and
retained instead of discarding earlier completed cases. The report never
serializes the API key or artifact text.

The sandboxed `--run-pi` and `--run-installed-pipes` model calls are local and
offline. `--run-live-installed-pipes` uses the configured preset and may use a
hosted provider. Model results remain stochastic and are not a CI gate. The
deterministic token, fact-retention, ordering, case-validation, and scoring
tests are the stable regression gate.

The synthetic correctness pack does not estimate parser coverage on historical
data. Use `scripts/eval-semantic-replay.sh` for privacy-safe aggregate coverage,
CPU-time, heap, and token measurements on real local trees. That replay has no
human semantic labels, so it must not be reported as extraction accuracy.
