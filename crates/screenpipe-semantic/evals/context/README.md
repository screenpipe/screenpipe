# Semantic context evaluation

This fixed suite compares three representations of the same ten synthetic,
privacy-safe accessibility trees:

- persisted accessibility JSON;
- Screenpipe's current text-bearing element outline;
- compact semantic context rendered for an AI agent.

The report uses the exact `o200k_base` tokenizer. It scores both context-only
tokens and the complete fixed Pi input prompt, retained task facts, tokens per
retained fact, known off-screen suppression, parser selection, compact-tree
heap, and a 1,000-iteration local adapt/parse/render benchmark for each case.
Every case includes one synthetic, explicitly off-screen distractor that must
remain visible in the raw baselines and absent from semantic context while all
visible facts remain available. Seven cases cover the shared parser families
and three cover exact ChatGPT, Claude, and Obsidian app overrides; catalog tests
separately keep all 47 supported target profiles matched.

Run the deterministic report:

```bash
cargo run -p screenpipe-semantic --example context_eval --locked -- --report
```

Run a privacy-safe replay over time-distributed samples from the local
Screenpipe database:

```bash
scripts/eval-semantic-replay.sh \
  --days 30 \
  --samples-per-app 25 \
  --max-apps 25 \
  --output /tmp/screenpipe-semantic-replay-report.json
```

To iterate on one app parser, add an exact captured app name, for example
`--app-name ChatGPT --samples-per-app 100`.

The script first selects frame IDs and structural sizes, then retrieves only
those exact trees into a mode-0600 temporary file. The private tree export is
deleted before the aggregate report is generated. Reports contain only app
names, counts, parser IDs, sizes, exact token counts, timing, and bounded-tree
heap estimates. They never contain captured text, values, URLs, or semantic
output.

Real replay measures applicability, abstention, context reduction, latency,
and memory across the user's actual tree shapes. It does not establish parser
correctness because historical captures have no human-labelled semantic gold.
Use the fixed fixtures or a separately reviewed sanitized capture pack for
fidelity gates. A model comparison over parser-generated labels would measure
answerability, not correctness, and must not be reported as an accuracy score.

Generate a balanced 30-row JSONL prompt pack for a Pi or other model A/B run:

```bash
cargo run -p screenpipe-semantic --example context_eval --locked -- --prompts \
  > /tmp/screenpipe-semantic-context-prompts.jsonl
```

Each case has identical question and expected answer across `raw_json`,
`current_outline`, and `semantic`. Model accuracy must be reported separately
from deterministic fact retention. A model run is intentionally opt-in so CI
never requires credentials, network access, or paid inference.

Run the complete 30-prompt A/B through a local Pi model:

```bash
cargo run --release -p screenpipe-semantic --example context_eval --locked -- \
  --run-pi ollama/screenpipe-gemma4:latest
```

The runner disables tools, extensions, skills, project context, sessions, and
startup network checks. Only the privacy-safe synthetic suite enters the model.

This suite measures AI input efficiency. The database integration separately
tests transactional normalized writes, exact parse-run reuse, immutable item
versions, run-scoped ephemeral items, FTS retrieval, retention cleanup, and
SQLite page growth:

```bash
cargo test -p screenpipe-db --test semantic_storage_test -- --nocapture
```

The storage regression measures incremental semantic pages and write time for
repeated and changing synthetic traces. It does not claim total disk reduction
because opted-in capture still retains existing raw text, tree JSON, elements,
and media.
