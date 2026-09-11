// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Explicit, local catalog recovery. Close Workflows before using --write.
// Usage: bun scripts/recover-workflow-catalog.ts <catalog> <older-backup> [--write]
import { copyFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { mergeWorkflowCatalog } from "../../../packages/workflows-ui/src/catalog";
import type { WorkflowAnalysis } from "../../../packages/workflows-ui/src/model";

const [catalogPath, backupPath, flag] = process.argv.slice(2);
if (!catalogPath || !backupPath || (flag && flag !== "--write")) throw new Error("Pass catalog path, older backup path, and optional --write");
function validate(value: WorkflowAnalysis) {
  if (value.schemaVersion !== 5 || !Array.isArray(value.analysis?.workflows)) throw new Error("Unsupported catalog. No files changed.");
  return value;
}
const current = validate(await Bun.file(catalogPath).json());
const previous = validate(await Bun.file(backupPath).json());
const merged = mergeWorkflowCatalog(previous, current);
console.log(JSON.stringify({ before: current.analysis.workflows.length, older: previous.analysis.workflows.length,
  recovered: merged.analysis.workflows.length, write: flag === "--write" }));
if (flag === "--write") {
  const recoveryBackup = `${catalogPath}.before-recovery-${Date.now()}`;
  await copyFile(catalogPath, recoveryBackup, constants.COPYFILE_EXCL);
  const temporary = `${recoveryBackup}.tmp`;
  await writeFile(temporary, JSON.stringify(merged), { flag: "wx", mode: 0o600 });
  await rename(temporary, catalogPath);
  console.log("Recovered catalog saved. Both original input catalogs remain recoverable.");
}
