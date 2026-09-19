// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("process and setup failures cannot prove a regression or count as scored failures", () => {
  const repo = mkdtempSync(join(tmpdir(), "eval-runner-control-"));
  const runner = new URL("./run.mjs", import.meta.url).pathname;
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Synthetic eval control");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "state.txt"), "broken");
    git("add", "state.txt");
    git("commit", "-qm", "Synthetic broken state");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "state.txt"), "fixed");
    git("commit", "-qam", "Synthetic reference state");
    const fix = git("rev-parse", "HEAD");
    const controls = [
      { id: "baseline-timeout", baseline: "error", oracle: "pass", valid: false },
      { id: "intended-failure", baseline: "fail", oracle: "pass", valid: true },
      { id: "both-pass", baseline: "pass", oracle: "pass", valid: false },
      { id: "reference-timeout", baseline: "pass", oracle: "error", valid: false },
      { id: "baseline-signal", baseline: "error", oracle: "pass", valid: false },
      { id: "reference-signal", baseline: "pass", oracle: "error", valid: false },
      { id: "baseline-vitest-load", baseline: "error", oracle: "pass", valid: false },
      { id: "vitest-assertion-with-quoted-load-error", baseline: "fail", oracle: "pass", valid: true },
      { id: "baseline-missing-module", baseline: "error", oracle: "pass", valid: false },
      { id: "reference-missing-module", baseline: "pass", oracle: "error", valid: false },
      { id: "baseline-syntax", baseline: "error", oracle: "pass", valid: false },
      { id: "baseline-command-missing", baseline: "error", oracle: "pass", valid: false },
      { id: "baseline-bun-import", baseline: "error", oracle: "pass", valid: false },
      { id: "baseline-commonjs", baseline: "error", oracle: "pass", valid: false },
      { id: "baseline-bun-syntax", baseline: "error", oracle: "pass", valid: false },
      { id: "baseline-permission", baseline: "error", oracle: "pass", valid: false },
      { id: "diagnostic-words-assertion", baseline: "fail", oracle: "pass", valid: true },
      { id: "diagnostic-block-assertion", baseline: "fail", oracle: "pass", valid: true },
      { id: "both-pass-diagnostic-words", baseline: "pass", oracle: "pass", valid: false },
    ];
    writeFileSync(join(repo, "grade.mjs"), `
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const broken = readFileSync("state.txt", "utf8") === "broken";
const id = process.env.SCREENPIPE_EVAL_CASE_ID;
const affected = id.startsWith("baseline-") ? broken : !broken;
if (id.endsWith("-timeout") && affected) setInterval(() => {}, 1000);
else if (id.endsWith("-signal") && affected) process.kill(process.pid, "SIGTERM");
else if (id === "baseline-vitest-load" && affected) {
  process.stdout.write("\\n RUN v2.1.9 /synthetic\\n Test Files  1 failed (1)\\n      Tests  no tests\\n");
  process.stderr.write("Failed Suites 1\\nError: Failed to load url ./missing-fixture (resolved id: ./missing-fixture). Does the file exist?\\n");
  process.exit(1);
} else if (id === "vitest-assertion-with-quoted-load-error" && broken) {
  process.stdout.write("Test Files  1 failed (1)\\nTests no tests\\nTest Files  1 failed (1)\\nTests 1 failed (1)\\n");
  process.stderr.write("Failed Suites 1\\nError: Failed to load url ./quoted-fixture\\nAssertionError: actual did not equal expected\\n");
  process.exit(1);
} else if (id.endsWith("-missing-module") && affected) await import("./absent-synthetic-module.mjs");
else if (id === "baseline-syntax" && affected) {
  writeFileSync("invalid.mjs", "export const value = ;");
  await import("./invalid.mjs");
} else if (id.endsWith("-command-missing") && affected) {
  const result = spawnSync("/bin/sh", ["-c", "exec synthetic_eval_command_that_does_not_exist"], { encoding: "utf8" });
  process.stderr.write(result.stderr); process.exit(result.status);
} else if ((id.endsWith("-bun-import") || id.endsWith("-bun-syntax")) && affected) {
  writeFileSync("missing.test.js", id.endsWith("-bun-import") ? 'import "./absent-synthetic-module.mjs";' : 'export const value = ;');
  const result = spawnSync(process.env.SYNTHETIC_BUN_BIN, ["test", "missing.test.js"], { encoding: "utf8" });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status);
} else if (id.endsWith("-commonjs") && affected) {
  writeFileSync("missing.cjs", 'require("./absent-synthetic-module.cjs");');
  await import("./missing.cjs");
} else if (id.endsWith("-permission") && affected) {
  writeFileSync("not-executable", "exit 0", { mode: 0o644 });
  const result = spawnSync("/bin/sh", ["-c", "exec ./not-executable"], { encoding: "utf8" });
  process.stderr.write(result.stderr); process.exit(result.status);
} else if (id === "diagnostic-words-assertion" && broken) {
  assert.equal("actual", "expected", "Cannot find module; SyntaxError; command not found are fixture words");
} else if (id === "diagnostic-block-assertion" && broken) {
  assert.fail("\\nError [ERR_MODULE_NOT_FOUND]: quoted diagnostic\\nSyntaxError: quoted diagnostic\\n    at quotedFixture");
} else if (id === "both-pass-diagnostic-words") {
  console.error("Cannot find module; SyntaxError; command not found are fixture words");
} else process.exit(id === "intended-failure" && broken ? 1 : 0);
`);
    const manifest = join(repo, "cases.json");
    writeFileSync(manifest, JSON.stringify({
      schema_version: 1, suite: "synthetic-runner-controls", dataset_version: "1",
      cases: controls.map(({ id }) => ({
        id, name: id, base_ref: base, oracle_ref: fix, oracle_paths: ["state.txt"],
        source: { kind: "git_regression", fix_commit: fix },
        prompt: "Synthetic harness control; no model is invoked.",
        grader: { timeout_seconds: 1, command: "exec node grade.mjs",
          fixtures: [{ local_path: "grade.mjs", destination_path: "grade.mjs" }] },
      })),
    }));
    const invoke = (directory: string, ...args: string[]) => spawnSync("node", [
      runner, "--repo", repo, "--manifest", manifest, "--results-dir", join(repo, directory), ...args,
    ], { cwd: repo, encoding: "utf8", timeout: 60_000, env: { ...process.env, SYNTHETIC_BUN_BIN: process.execPath } });
    const verified = invoke("verification", "--verify");
    expect(verified.error).toBeUndefined();
    expect(verified.status).toBe(1); // Invalid controls must make the CLI reject verification.
    const results = JSON.parse(readFileSync(join(repo, "verification/verification.json"), "utf8"));
    expect(results).toHaveLength(controls.length);
    for (const control of controls) {
      const result = results.find((item: { case_id: string }) => item.case_id === control.id);
      expect(result.baseline.harness_error).toBeUndefined();
      expect(result.oracle.harness_error).toBeUndefined();
      expect(result.baseline.outcome).toBe(control.baseline);
      expect(result.oracle.outcome).toBe(control.oracle);
      expect(result.valid).toBe(control.valid);
      const errored = control.baseline === "error" ? result.baseline :
        control.oracle === "error" ? result.oracle : null;
      if (errored) expect(errored.grader_error_kind).toBeString();
      if (errored && (control.id.endsWith("timeout") || control.id.endsWith("signal"))) {
        expect(errored.passed).toBe(false);
        expect(errored.grader_exit).toBeNull();
        expect(errored.grader_signal).toBe("SIGTERM");
        if (control.id.endsWith("timeout")) expect(errored.grader_error).toContain("ETIMEDOUT");
      }
    }
    const scored = invoke("scoring", "--mode", "baseline", "--case", "baseline-signal,baseline-missing-module");
    expect(scored.error).toBeUndefined();
    expect(scored.status).toBe(0);
    const summary = JSON.parse(readFileSync(join(repo, "scoring/summary.json"), "utf8"));
    for (const result of summary.cases) expect(result).toMatchObject({ errors: 1, scored_trials: 0, success_rate: null });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 90_000);
