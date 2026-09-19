// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Recognize bounded, known setup diagnostics. This is not a general proof that
// an unrecognized exit is an assertion failure; promotion still needs log review.
export function classifyGraderError(grader) {
  if (grader.error || grader.signal || grader.status === null) return "process";
  if (grader.status === 0) return null;
  if (grader.status === 126 || grader.status === 127) return "command_unavailable";
  const stderr = (grader.stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  if (/^# Unhandled error between tests\s*$/m.test(stderr) &&
      /^\s*\d+ errors?\s*$/m.test(stderr)) return "bun_unhandled_error";
  // Vitest prints collection errors on stderr but its final test count on
  // stdout. Use the last summary so diagnostic text printed by a test cannot
  // hide a later genuine assertion failure. Unknown formats still need review.
  const stdout = (grader.stdout ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const summary = [...stdout.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1]?.trim();
  if (summary === "no tests" && /^\s*Test Files\s+\d+ failed/m.test(stdout) &&
      /Failed Suites [1-9]/.test(stderr) &&
      /^Error: Failed to load url /m.test(stderr)) return "vitest_collection_error";
  // Only the first thrown-error header classifies a Node failure. Assertion
  // messages may quote complete setup diagnostics on later lines.
  const header = stderr.match(/^([A-Za-z]*Error)(?: \[([A-Z_0-9]+)\])?:[^\n]*/m);
  if (header?.[1] === "Error" &&
      (header[2] === "ERR_MODULE_NOT_FOUND" ||
       (header[0].startsWith("Error: Cannot find module ") &&
        /^\s*code: ['"]MODULE_NOT_FOUND['"]/m.test(stderr)))) return "node_missing_module";
  if (header?.[1] === "SyntaxError" && /^\s+at /m.test(stderr)) return "node_syntax_error";
  return null;
}
