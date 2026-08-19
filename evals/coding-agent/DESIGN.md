# Regression-eval design

This corpus follows Anthropic's agent-eval model: a task is run in an isolated
environment, the full trial trajectory is retained, and deterministic graders
score the resulting product behavior. The repository tests are hidden outcome
graders; they are not the evaluated object by themselves.

Primary references:

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic eval datasets](https://github.com/anthropics/evals)
- [Long-running agent harness examples](https://github.com/anthropics/cwc-long-running-agents)

The `anthropics/evals` repository is a useful example of versioned task data and
validation, but its datasets evaluate model-written dialogue behavior rather
than repository-changing coding agents. This suite therefore uses the task,
trial, grader, transcript, outcome, and harness structure from Anthropic's
current guidance instead of copying that older repository's execution model.

## Corpus contract

- Regression cases come from a real fixing commit with a testable broken parent.
- `source.fix_commit` must resolve to the same commit as `oracle_ref`.
- `--verify` must observe the parent fail and the known fix pass.
- The agent gets a depth-one detached checkout of the broken commit, with no
  future history, oracle patch, or hidden grader available during its trial.
- Build caches that could contain future artifacts are linked only after the
  agent stops; build tools still validate their content hashes before reuse.
- Prompts specify observable behavior and safety boundaries, not an expected
  implementation trajectory.
- Existing behavior is retained through positive and negative grader examples.
- Agent, grader, and harness failures remain distinct in the result artifacts.
- Repeated trials report success rate, estimated `pass@k` and `pass^k`, and
  observed any/all-pass outcomes. Transcripts remain available for review.

Regression cases should approach reliable all-trial success before gating a
development pipeline. New capability cases belong in a separate manifest and
may begin with a deliberately lower success rate.

## Mine and promote cases

```bash
node evals/coding-agent/mine-history.mjs \
  --repo /path/to/repository \
  --ref origin/main \
  --since '18 months ago' > /tmp/eval-candidates.json
```

The miner finds fix-shaped commits that changed potential deterministic graders.
Promotion is intentionally reviewed: confirm the original failure from the
commit/PR, write a sanitized outcome-focused prompt, select graders that cover
both the fix and preserved behavior, then add the exact parent/fix pair to the
manifest and run `--verify`.
