// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Real pinned Pi repairing a previously installed incompatible extension.
// Only the model response is synthetic; all installs/config live in a temp dir.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "screenpipe-pi-extensions-"));
const config = join(root, "pi-config");
const runtime = join(root, "pi-agent");
const project = join(root, "project");
const repo = resolve(import.meta.dir, "../../..");
const source = await readFile(join(repo, "crates/screenpipe-core/src/agents/pi.rs"), "utf8");
const packageSource = source.match(/REQUIRED_PI_EXTENSION_PACKAGE: &str = "([^"]+)"/)![1];
const extensionVersion = packageSource.split("@").at(-1)!;
const brokenVersion = "0.78.0"; // Uses toToolDeclaration, absent from Pi 0.84.1.
const configuredPackage = process.argv.includes("--incompatible-package")
  ? `npm:pi-subagents@${brokenVersion}` : packageSource;
const version = source.match(/PI_PACKAGE: &str = "@earendil-works\/pi-coding-agent@([^"]+)"/)![1];
// Read the production spawn policy so removing it also fails the runtime eval.
const isolation = source.slice(source.indexOf("pub fn apply_pi_isolation_env("), source.indexOf("/// Marker file recording"));
const nativeImport = isolation.match(/apply\("JITI_TRY_NATIVE", "([^"]+)"\)/)?.[1];
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: "1" };
delete env.JITI_TRY_NATIVE;
if (!process.argv.includes("--baseline") && nativeImport !== undefined) env.JITI_TRY_NATIVE = nativeImport;

async function run(args: string[], cwd: string, stopOnSettled = false) {
  const child = Bun.spawn(args, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 60_000);
  const stderr = new Response(child.stderr).text();
  let stdout = "";
  if (stopOnSettled) child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Say extension startup works." })}\n`);
  else child.stdin.end();
  try {
    for await (const chunk of child.stdout) {
      stdout += new TextDecoder().decode(chunk);
      if (stopOnSettled && stdout.split("\n").some(line => {
        try { return JSON.parse(line).type === "agent_end"; } catch { return false; }
      })) child.kill();
    }
    return { code: await child.exited, stdout, stderr: await stderr };
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}

const requests: { tools?: { function: { name: string } }[] }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/chat/completions");
    requests.push(await request.json());
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "eval", object: "chat.completion.chunk", created: 0, model: "eval",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    return new Response(chunk({ role: "assistant", content: "Extension startup works." }, null)
      + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});

try {
  for (const dir of [runtime, join(config, "npm"), project]) await mkdir(dir, { recursive: true });
  for (const [dir, dependencies] of [
    [runtime, { "@earendil-works/pi-coding-agent": version }],
    [join(config, "npm"), { "pi-subagents": brokenVersion }],
  ] as const) {
    await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module", dependencies }));
    const install = await run([process.execPath, "install", "--ignore-scripts"], dir);
    assert.equal(install.code, 0, install.stderr);
  }
  const staleBun = join(root, "old-screenpipe-install", process.platform === "win32" ? "bun.exe" : "bun");
  await writeFile(join(config, "settings.json"), JSON.stringify({
    packages: [configuredPackage],
    npmCommand: [staleBun],
    retry: { enabled: false },
    compaction: { enabled: false },
  }));
  const migration = await run([
    "cargo", "run", "--quiet", "-p", "screenpipe-core", "--example", "pi-settings-migrate", "--",
    config, process.execPath,
  ], repo);
  assert.equal(migration.code, 0, migration.stderr);
  const migrated = JSON.parse(await readFile(join(config, "settings.json"), "utf8"));
  assert.deepEqual(migrated.npmCommand, [process.execPath]);
  assert.deepEqual(migrated.packages, [packageSource]);
  assert.deepEqual(migrated.compaction, { enabled: false, keepRecentTokens: 8192 });
  console.log(`PASS migration: missing managed Bun repaired to current runnable Bun; unrelated settings preserved`);
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { eval: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fictional-eval-key",
    models: [{ id: "eval", name: "Eval", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const cli = join(runtime, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const args = [process.execPath, cli, "--provider", "eval", "--model", "eval", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"];
  // A scheduled run must recover before anyone opens interactive chat.
  for (const mode of ["json", "rpc"]) {
    const result = await run([...args, "--mode", mode, ...(mode === "json" ? ["--print", "Say extension startup works."] : [])], project, mode === "rpc");
    assert.doesNotMatch(result.stderr, /Failed to load extension/, `${mode}: ${result.stderr}`);
    const events = result.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    assert(events.some(event => event.type === "message_end" && event.message.role === "assistant"
      && event.message.stopReason === "stop" && event.message.content.some((part: { text?: string }) => part.text === "Extension startup works.")),
    `${mode}: no completed assistant response\n${result.stderr}\n${result.stdout}`);
    if (mode === "json") assert.equal(result.code, 0, result.stderr);
    assert(requests.at(-1)?.tools?.some(tool => tool.function.name === "subagent"), `${mode}: subagent tool missing`);
    assert(requests.at(-1)?.tools?.some(tool => tool.function.name === "bg_wait"), `${mode}: bg_wait tool missing`);
    const installed = JSON.parse(await readFile(join(config, "npm/node_modules/pi-subagents/package.json"), "utf8"));
    assert.equal(installed.version, extensionVersion, `${mode}: incompatible package was not replaced`);
    console.log(`PASS ${mode}: pi-subagents ${brokenVersion} repaired to ${extensionVersion}, tools available, assistant response completed`);
  }
  // A real extension error must still report its originating cause.
  const broken = join(project, "broken.ts");
  await writeFile(broken, 'export default function () { throw new Error("eval extension startup failure"); }');
  const failed = await run([...args, "--mode", "json", "--no-extensions", "--extension", broken, "--print", "Hello"], project);
  assert.notEqual(failed.code, 0);
  assert(failed.stderr.includes(broken));
  assert.match(failed.stderr, /Failed to load extension.*eval extension startup failure/s);
  console.log("PASS failure: extension path and originating error remain visible");
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
