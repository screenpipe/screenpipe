# Task for worker

Implement the requested Screenpipe contribution end-to-end in this repository. Requirements: add Google Antigravity to the AI Tools section; refactor/extend the current installed-AI-tool scanning utility so one extensible source of truth detects all currently supported mainstream AI tools whose conventions are already represented/verified in this repo (at minimum every existing supported installer plus Antigravity; avoid speculative unverified formats); add one-click installation buttons/actions for every detected/supported AI tool, installing Screenpipe MCP plus API and CLI skills where that tool supports skills, with correct cross-platform config paths and bundled Bun fallback; use existing install methods as reference; preserve user configs safely and idempotently; tests for detection/install/uninstall and UI. Read VISION.md and DESIGN.md. Follow AGENTS.md including file headers. Create a feature branch, inspect current architecture, implement, run focused tests/typecheck/bindings checks as appropriate. Do not push or open PR. Return summary, changed files, tests, residual risks. Acceptance: verified.

## Acceptance Contract
Acceptance level: verified
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```