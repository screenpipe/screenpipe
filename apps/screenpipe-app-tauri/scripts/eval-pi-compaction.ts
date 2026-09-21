// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const root = await mkdtemp(join(tmpdir(), "screenpipe-pi-compaction-"));
async function run(args: string[], cwd = root, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}`);
}
try {
  const source = await readFile(join(repo, "crates/screenpipe-core/src/agents/pi.rs"), "utf8");
  const version = source.match(/PI_PACKAGE: &str = "@earendil-works\/pi-coding-agent@([^"]+)"/)![1];
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: {
    "@earendil-works/pi-coding-agent": version, "@earendil-works/pi-ai": version,
  } }));
  await run([process.execPath, "install", "--ignore-scripts"]);
  if (!process.argv.includes("--baseline")) {
    // Exercise the same parser and atomic write as app/automation startup.
    // git apply accepts patch formats that the production diffy parser rejects.
    const patcher = ["cargo", "run", "--locked", "-p", "screenpipe-core",
      "--example", "patch_pi_compaction", "--", root];
    await run(patcher, repo);
    const runtime = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
    const patched = await readFile(runtime, "utf8");
    await run(patcher, repo);
    if (await readFile(runtime, "utf8") !== patched) {
      throw new Error("Pi compaction patch changed an already-patched runtime");
    }
  }
  await run([process.execPath, "test", join(repo, "crates/screenpipe-core/assets/pi-context-compaction.test.ts")], root,
    { ...process.env, SCREENPIPE_TEST_PI_DIR: root });
} finally {
  await rm(root, { recursive: true, force: true });
}
