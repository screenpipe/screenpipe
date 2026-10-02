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
  // Playwright CT can discover tests and then fail its Vite build before any
  // test runs. Require matching planned/unrun counts, a known build diagnostic
  // and the build terminator. Executed outcomes or assertion headers must win
  // even when their messages quote these diagnostics.
  const planned = stdout.match(/^Running ([1-9]\d*) tests? using [1-9]\d* workers?\s*$/m)?.[1];
  const unrun = stdout.match(/^\s*([1-9]\d*) did not run\s*$/m)?.[1];
  const noExecutedPlaywright = !/^\s*[1-9]\d* (?:passed|failed|skipped|flaky|timed out)\b/m.test(stdout);
  const noAssertion = !/^(?:\s*Error: expect\(|\s*AssertionError(?: \[[^\]]+\])?:)/m.test(stdout + "\n" + stderr);
  if (planned && unrun === planned && noExecutedPlaywright && noAssertion &&
      /^✗ Build failed in /m.test(stderr) &&
      (/^Error: \[vite:load-fallback\] Could not load [^\n]+: ENOENT:/m.test(stdout) ||
       /^RollupError: [^\n]+ is not exported by [^\n]+, imported by /m.test(stdout))) {
    return "playwright_ct_build_error";
  }
  const summary = [...stdout.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1]?.trim();
  // A failed suite can collect zero tests while neighboring suites pass or skip.
  // Only summaries without executed failures qualify; diagnostic and assertion
  // guards still apply to both streams, including quoted setup errors.
  const collectionSummary = summary === "no tests" ||
    /^(?:\d+ (?:passed|skipped))(?: \| \d+ (?:passed|skipped))* \(\d+\)$/.test(summary ?? "");
  if (collectionSummary && noAssertion && /^\s*Test Files\s+\d+ failed/m.test(stdout) &&
      /Failed Suites [1-9]/.test(stderr) &&
      ((/^Error: Failed to resolve import ['"][^\r\n]+['"] from ['"][^\r\n]+['"]\. Does the file exist\?\s*$/m.test(stderr) &&
        !/^AssertionError(?: \[[^\]]+\])?:/m.test(stderr)) ||
       /^Error: Failed to load url /m.test(stderr) ||
       // Vitest wraps failures inside vi.mock factories. Require its wrapper,
       // the caused-by missing URL, no failed tests, and no assertions.
       (/^Error: \[vitest\] There was an error when mocking a module\./m.test(stderr) &&
        /^Caused by: Error: Failed to load url [^\n]+Does the file exist\?\s*$/m.test(stderr) &&
        !/^AssertionError(?: \[[^\]]+\])?:/m.test(stderr)) ||
       /^Error: Cannot find module ['"][^\n]+['"] imported from ['"][^\n]+['"]\.\s*$/m.test(stderr))) return "vitest_collection_error";
  // A beforeAll build failure can register tests but skip every affected test.
  // Passing neighboring suites do not turn a compile failure into an assertion.
  // Preserve executed failures and assertion headers, including quoted diagnostics.
  const buildHookSummary = summary?.match(/^(?:(?:\d+ (?:passed|skipped))(?: \| )?)+ \(\d+\)$/);
  if (buildHookSummary && /[1-9]\d* skipped/.test(summary) &&
      /^\s*Test Files\s+.*[1-9]\d* failed/m.test(stdout) && /Failed Suites [1-9]/.test(stderr) &&
      /^Error: Command failed: [^\n]*\bbun(?:\.exe)? (?:build|run build)\b/m.test(stderr) &&
      /^error: Could not resolve: ["'][^\n]+["']\s*$/m.test(stderr) &&
      !/^AssertionError(?: \[[^\]]+\])?:/m.test(stderr)) return "vitest_bun_build_setup_error";
  // Vite can reject PostCSS startup before printing a test-count summary.
  // Require the specific missing-plugin diagnostic and startup banner; an
  // executed-test summary or assertion header must keep its behavioral result.
  if ((summary === undefined || summary === "no tests") &&
      /^\s*RUN\s+v\d+\./m.test(stdout) && /Unhandled Rejection/.test(stderr) &&
      /^Failed to load PostCSS config:/m.test(stderr) &&
      /Loading PostCSS Plugin failed: Cannot find module ['"][^\n]+['"]/.test(stderr) &&
      /[/\\]postcss\.config\.[cm]?[jt]s/.test(stderr) &&
      !/^AssertionError(?: \[[^\]]+\])?:/m.test(stderr)) return "vitest_postcss_setup_error";
  // Rust compilation ends before its test executable can run. Require both
  // a compiler diagnostic and a terminating compiler summary, and preserve
  // executed test/panic/assertion outcomes even if they quote those lines.
  const rustTestsFailed = /^test result: FAILED\. \d+ passed; [1-9]\d* failed;/m.test(stdout);
  const assertionHeader = /^AssertionError(?: \[[^\]]+\])?:/m.test(stderr) ||
    /^thread ['"][^\n]+['"] panicked at /m.test(stderr);
  if (!rustTestsFailed && !assertionHeader &&
      /^error(?:\[E\d{4}\])?: (?!aborting due to |could not compile )/m.test(stderr) &&
      (/^error: aborting due to \d+ previous errors?\s*$/m.test(stderr) ||
       /^error: could not compile [`'"][^\n]+[`'"](?: \([^\n]*\))? due to \d+ previous errors?/m.test(stderr))) {
    return "rust_compile_error";
  }
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
