# Parser context quality

These four synthetic regression cases measure what an agent receives, not
parser execution speed. Their expected values are hand-authored independently
of parser output. They check exact bodies, task state, owners, deadlines,
priority and parent relationships, plus UI-noise exclusion and rendered fields.
Unknown task state stays unknown; due labels are retained verbatim without
inventing a date or timezone. Authored action words and link text stay in bodies.

```sh
cargo test -p screenpipe-semantic --test context_quality --locked
cargo run --release -p screenpipe-semantic --example context_quality --locked
```

The example emits per-case check failures and exact `o200k_base` token counts
for serialized captured nodes and semantic context. To compare revisions, copy
this exact `evals/quality` directory and example into the base checkout before
running it. Do not compare different fixtures or tokenizer versions.

Against base `acdcd8b21d7674e9493c19ad130f54eae9e8283a`, the same fixtures improve
from 16/33 to 33/33 checks and from 207 to 188 context tokens. The 33 checks are
25 exact field/relationship checks, six exclusion checks and two rendered-field
checks. They are regression assertions, not independent facts or a live-app
accuracy score.

| Case | Checks before → after | Context tokens before → after |
|---|---:|---:|
| Slack message actions | 4/8 → 8/8 | 69 → 56 |
| Task decision fields | 2/8 → 8/8 | 19 → 37 |
| Task state evidence | 8/12 → 12/12 | 78 → 62 |
| Mail body actions | 2/5 → 5/5 | 41 → 33 |

The task case needs more tokens because it restores missing owner, due and
priority fields and corrects status. Shorter context alone is not success.
This suite covers known structural contracts, not all app versions or real
Windows/macOS UI behavior. Run the existing context and pipe evals as regression
gates as well; no model calls, cloud credentials or private captures are needed.
