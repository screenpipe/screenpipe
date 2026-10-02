// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Exercise the real installer and filesystem durability dependency without
// compiling unrelated recording/media dependencies from screenpipe-core.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const testRoot = mkdtempSync(path.join(tmpdir(), "screenpipe-starter-tests-"));
try {
  mkdirSync(path.join(testRoot, "src"));
  writeFileSync(path.join(testRoot, "Cargo.toml"), `[package]\nname = "screenpipe-starter-contract"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n[dependencies]\nscreenpipe-fs = { path = ${JSON.stringify(path.join(repoRoot, "crates/screenpipe-fs"))} }\n`);
  writeFileSync(path.join(testRoot, "src/lib.rs"), `#[path = ${JSON.stringify(path.join(repoRoot, "crates/screenpipe-core/src/starter_skills.rs"))}]\nmod starter_skills;\n`);
  const result = spawnSync("cargo", ["test", "--manifest-path", path.join(testRoot, "Cargo.toml"), "--lib"], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
