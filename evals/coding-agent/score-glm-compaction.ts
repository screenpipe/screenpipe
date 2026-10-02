// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { regressions } from "./glm-compaction-regressions";
import { cases, grade } from "./glm-compaction-cases";

// Versioned supplemental grading. The original strict verdicts and raw outputs
// remain in results.json. The task did not prescribe a status enum, and its
// source calls the unsent draft "prepared", so that synonym is not data loss.
export function assess(text: string, expected: Record<string, unknown>) {
  const strict = grade(text, expected);
  let actual = strict.actual;
  if (!actual) {
    const fenced = text.match(/```json\s*([\s\S]*?)```/);
    if (fenced) { try { actual = JSON.parse(fenced[1]); } catch {} }
  }
  if (!actual) return { strict, factsPassed: false, factFailures: ["no_parseable_answer"], actual: null };
  const normalized = { ...actual };
  if (expected.status === "draft" && ["prepared", "unsent", "not sent", "prepared, not sent"].includes(normalized.status)) normalized.status = "draft";
  const facts = grade(JSON.stringify(normalized), expected);
  return { strict, factsPassed: facts.passed, factFailures: facts.failures, actual };
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error("Pass one or more saved results.json paths; no model calls are made.");
  for (const path of paths) {
    const original = await Bun.file(path).json();
    const records: any[] = [];
    for (const row of original.runs) {
      const expected = [...cases, ...regressions].find(c => c.id === row.case)!.expected;
      if (row.fullContext) records.push({ case: row.case, phase: "full-context", ...assess(row.fullContext.text, expected) });
      for (const trial of row.trials) for (const stage of trial.stages) records.push({ case: row.case, phase: "compacted", repeat: trial.repeat, cycle: stage.cycle, ...assess(stage.text, expected) });
    }
    for (const row of original.splitRuns ?? []) records.push({ case: row.case, phase: "split", cycle: row.cycle,
      summaryError: row.summaryError, originalHistoryPreserved: row.originalHistoryPreserved,
      ...assess(row.text ?? "", cases.find(c => c.id === "source-middle")!.expected) });
    const report = { rubricVersion: 3, source: path, completed: !!original.completedAt,
      infrastructureErrors: original.runs.filter((r: any) => r.error).map((r: any) => ({ case: r.case, error: r.error })), records };
    await Bun.write(path.replace(/\.json$/, ".graded-v3.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ source: path, completed: report.completed, errors: report.infrastructureErrors,
      byPhase: Object.fromEntries(["full-context", "compacted", "split"].map(phase => { const r = records.filter(r => r.phase === phase);
        return [phase, { total: r.length, factsPassed: r.filter(r => r.factsPassed).length, strictPassed: r.filter(r => r.strict.passed).length }]; })) }));
  }
}
