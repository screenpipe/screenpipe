// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Opt-in: one synthetic request through the installed, authenticated Pi runtime.
// No recorder access, tools, saved session, or catalog writes.
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
const base = join(homedir(), ".screenpipe");
const assets = resolve(import.meta.dir, "../../../crates/screenpipe-core/assets/extensions");
const dir = await mkdtemp(join(tmpdir(), "screenpipe-private-eval-"));
try {
  await mkdir(join(dir, "lib"));
  await writeFile(join(dir, "tinfoil.ts"), (await readFile(join(assets, "tinfoil.ts"), "utf8"))
    .replace("__SCREENPIPE_PI_PACKAGE_JSON__", JSON.stringify(join(base, "pi-agent/package.json"))));
  for (const file of ["tinfoil-transport.ts", "glm-protocol.ts"]) {
    await writeFile(join(dir, "lib", file), await readFile(join(assets, "lib", file)));
  }
  const child = Bun.spawn([process.execPath,
    join(base, "pi-agent/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--mode", "json", "--no-session", "--no-extensions", "--extension", join(dir, "tinfoil.ts"),
    "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "",
    "--provider", "screenpipe", "--model", "glm-5.3-flash-reap50-iq3m", "--print",
    "Reply with exactly READY. Do not use tools. This is a synthetic connectivity test.",
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: join(base, "pi-config") }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 55_000);
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const statuses = events.filter(e => e.type === "extension_ui_request" && e.key === "screenpipe-confidential").map(e => JSON.parse(e.text));
  const verified = statuses.find(e => e.state === "response_verified");
  const proof = verified?.document;
  const answer = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message;
  const passed = exit === 0 && statuses[0]?.state === "verifying" && proof?.securityVerified === true
    && proof.codeFingerprint === proof.enclaveFingerprint && proof.configRepo === "screenpipe/privacy-filter"
    && proof.enclaveHost === "pii.screenpipe.containers.tinfoil.dev" && answer?.stopReason === "stop"
    && answer.content.some((part: any) => part.type === "text" && part.text.trim() === "READY");
  console.log(JSON.stringify({ passed, exit, states: statuses.map(e => e.state), model: answer?.model, stderrPresent: !!stderr.trim() }));
  if (!passed) process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
