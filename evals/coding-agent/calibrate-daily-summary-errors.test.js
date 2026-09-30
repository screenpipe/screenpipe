// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
const repo = resolve(import.meta.dir, "../..");
const fix = "ee91ade94484a349c98fd7ad9613f4a6018b50bf";
const parent = "e58cc923243682bb8fb9d87fbf5f33d41f122a2f";
const source = "apps/screenpipe-app-tauri/lib/daily-summary-pi.ts";
const files = ["tsconfig.json", "lib/daily-summary-pi.ts", "lib/daily-summary-prompt.ts", "lib/model-metadata.ts", "lib/events/error-text.ts", "lib/utils/internal-session.ts"].map(p => "apps/screenpipe-app-tauri/" + p);
const grader = "evals/coding-agent/graders/daily-summary-errors.test.js";
const runtime = realpathSync(join(repo, "apps/screenpipe-app-tauri/node_modules"));
const output = process.env.CALIBRATION_OUTPUT_DIR;
function replace(text, from, to) { if (!text.includes(from)) throw Error("Control mutation no longer matches reference"); return text.replaceAll(from, to); }
const controls = [
  { name: "parent", ref: parent, pass: false },
  { name: "reference", ref: fix, pass: true },
  { name: "equivalent", ref: fix, pass: true, mutate: s => replace(replace(s, "terminalAssistantError", "providerFailure"), "terminalError && event.willRetry !== true", "event.willRetry !== true && terminalError") },
  { name: "unused", ref: parent, pass: false, extra: true },
  { name: "lost-detail", ref: fix, pass: false, mutate: s => replace(s, "new Error(terminalError)", 'new Error("AI failed")') },
  { name: "ignored-agent-end", ref: fix, pass: false, mutate: s => replace(s, "const terminalError = finalAssistantError(envelope);", "const terminalError = null;") },
  { name: "retry-hint", ref: fix, pass: false, mutate: s => replace(s, "terminalError && event.willRetry !== true", "terminalError") },
  { name: "no-cleanup", ref: fix, pass: false, mutate: s => replace(s, "    unregister();", "    // omitted cleanup") },
  { name: "blanket-refusal", ref: fix, pass: false, mutate: s => replace(s, "  const sessionPrefix =", '  throw new Error("all requests refused");\n  const sessionPrefix =') },
  { name: "missing", ref: fix, pass: false, missing: true },
];
for (const control of controls) test(control.name, () => {
  const root = mkdtempSync(join(tmpdir(), "daily-summary-calibration-"));
  try {
    for (const path of files) {
      const dest = join(root, path); mkdirSync(dirname(dest), { recursive: true });
      let text = execFileSync("git", ["show", control.ref + ":" + path], { cwd: repo, encoding: "utf8" });
      if (path === source && control.mutate) text = control.mutate(text);
      writeFileSync(dest, text);
    }
    if (control.extra) writeFileSync(join(root, source + ".unused"), execFileSync("git", ["show", fix + ":" + source], { cwd: repo }));
    if (control.missing) rmSync(join(root, source));
    mkdirSync(dirname(join(root, grader)), { recursive: true }); writeFileSync(join(root, grader), readFileSync(join(repo, grader)));
    symlinkSync(runtime, join(root, "apps/screenpipe-app-tauri/node_modules"), "dir");
    const result = spawnSync(process.execPath, ["--no-env-file", "test", grader], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (output) {
      mkdirSync(output, { recursive: true }); writeFileSync(join(output, control.name + ".json"), JSON.stringify({ control: control.name, ref: control.ref, exit_code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2) + "\n");
    }
    expect(result.signal).toBeNull(); expect(result.error).toBeUndefined();
    expect(result.status === 0).toBe(control.pass);
    if (control.missing) { expect(result.stderr).toMatch(/0 pass/); expect(result.stderr).toMatch(/Cannot find module|ModuleNotFound/); }
    else { expect(result.stderr).toMatch(/Ran 13 tests/); expect(result.stderr).not.toMatch(/Unhandled error|Cannot find module/); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45000);
