// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const proposal = join(import.meta.dir, "digital-clone-store-proposal");
const payload = JSON.parse(readFileSync(join(proposal, "submission-payload.json"), "utf8"));
const fields = ["category", "description", "icon", "readme_md", "slug", "source_md", "title"];
if (Object.keys(payload).sort().join() !== fields.join()) throw new Error("payload fields changed");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const runtime = readFileSync(join(proposal, "runtime-proposed.js"), "utf8");
const runtimeHash = hash(runtime);
if (!payload.source_md.includes(`digest("hex")!=="${runtimeHash}"`)) throw new Error("bootstrap hash mismatch");
if (Buffer.byteLength(payload.source_md) > 65_536) throw new Error("store source too large");

const root = mkdtempSync(join(tmpdir(), "digital-clone-proposal-"));
const run = async (args: string[], timeout = 30_000) => {
  const child = Bun.spawn({
    cmd: [process.execPath, "run", join(root, "wiki/runtime/clone.js"), ...args],
    cwd: root,
    env: { ...process.env, DIGITAL_CLONE_ROOT: root, DIGITAL_CLONE_TEST_API: `http://127.0.0.1:${server.port}`, SCREENPIPE_LOCAL_API_KEY: "fixture-token" },
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exit };
};

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "[]" } }] });
    return Response.json({ data: [], pagination: { total: 0, limit: 200, offset: 0 } });
  },
});

try {
  writeFileSync(join(root, "pipe.md"), payload.source_md);
  writeFileSync(join(root, ".screenpipe-permissions.json"), JSON.stringify({ pipe_token: "fixture-token" }));
  mkdirSync(join(root, "wiki/runtime"), { recursive: true });
  const bootstrapBlock = payload.source_md.match(/```typescript\n([\s\S]*?)\n```\n\n<!-- BUN_RUNTIME -->/)?.[1];
  if (!bootstrapBlock) throw new Error("bootstrap missing");
  writeFileSync(join(root, "bootstrap.ts"), bootstrapBlock);
  const bootstrap = Bun.spawnSync({ cmd: [process.execPath, "run", "bootstrap.ts"], cwd: root, windowsHide: true });
  if (bootstrap.exitCode !== 0) throw new Error(`bootstrap failed: ${bootstrap.stderr.toString()}`);
  if (hash(readFileSync(join(root, "wiki/runtime/clone.js"), "utf8")) !== runtimeHash) throw new Error("extracted runtime differs");

  const setup = await run(["setup"]);
  if (setup.exit !== 0) throw new Error(`setup failed: ${setup.stderr}`);
  const context = await run(["context"]);
  const maintain = await run(["maintain"], 60_000);
  const launch = await run(["launch"]);
  if (launch.exit !== 0) throw new Error(`launch failed: ${launch.stderr}`);
  const launched = JSON.parse(launch.stdout.trim().split("\n").at(-1)!);
  let status = launched;
  for (let attempt = 0; attempt < 60 && ["running", "interrupted"].includes(status.status); attempt++) {
    await Bun.sleep(100);
    const polled = await run(["launch", "--status"]);
    status = JSON.parse(polled.stdout.trim().split("\n").at(-1)!);
  }
  if (!["complete", "partial"].includes(status.status)) throw new Error(`launched maintenance did not produce a receipt: ${status.status}`);

  const consoleProbe = join(root, "console-probe.ps1");
  writeFileSync(consoleProbe, "Add-Type '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);' -Name W -Namespace N; $h=[N.W]::GetConsoleWindow(); [IO.File]::WriteAllText($env:PROBE_OUT, [N.W]::IsWindowVisible($h).ToString())");
  const probeOut = join(root, "bun-spawn-visible.txt");
  const probe = Bun.spawn({ cmd: ["powershell", "-NoProfile", "-File", consoleProbe], env: { ...process.env, PROBE_OUT: probeOut }, windowsHide: true, stdout: "ignore", stderr: "pipe" });
  if (await probe.exited !== 0) throw new Error(`Bun windowsHide probe failed: ${await new Response(probe.stderr).text()}`);
  if (readFileSync(probeOut, "utf8") !== "False") throw new Error("Bun.spawn exposed a visible console");

  console.log(JSON.stringify({ bun: Bun.version, bootstrap: "passed", setup: setup.exit, context: context.exit, maintain: maintain.exit, launch_status: status.status, windows_visible: false, runtime_sha256: runtimeHash }, null, 2));
} finally {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
