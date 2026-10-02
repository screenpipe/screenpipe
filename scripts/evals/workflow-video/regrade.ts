// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Regrade saved trajectories without rerunning a model or replacing the original scores.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cases } from "./cases";
import { grade } from "./grade";
for (const dir of process.argv.slice(2)) {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const original = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
  const results = original.results.map((r: any) => {
    if (!r.outcome || r.status === "blocked") return r;
    const failures = grade(cases.find(c => c.id === r.id)!, r.outcome);
    return { id: r.id, originalStatus: r.status, status: failures.length ? "failed" : "passed", failures };
  });
  const report = { basis: manifest.basis, scorerHash: createHash("sha256").update(await readFile(join(import.meta.dir, "grade.ts"))).digest("hex"), results, notRun: original.notRun };
  await writeFile(join(dir, "regraded.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory: dir, passed: results.filter((r: any) => r.status === "passed").length, total: results.length, failures: results.filter((r: any) => r.status !== "passed") }));
}
