// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Runs the installed, version-checked Pi with the shipped tools. No app state is saved.
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile, readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { cases, draft } from "./cases";
import { grade, type Outcome } from "./grade";

const args = process.argv.slice(2);
const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const live = args.includes("--live");
const output = option("--output");
if (!output) throw Error("Use --output PRIVATE_DIRECTORY [--live] [--source BASELINE_SOURCE] [--case CASE_ID]. Live calls consume the existing account allowance; exhaustion stops the suite.");
const repo = resolve(import.meta.dir, "../../..");
if (resolve(output) === repo || resolve(output).startsWith(repo + "/")) throw Error("Keep traces outside the repository.");
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw Error("Choose an empty output directory to preserve earlier traces.");
const source = option("--source");
const toolPath = source ? resolve(source, "video-tool.ts") : join(repo, "packages/workflows-ui/src/video-tool.ts");
const promptPath = source ? resolve(source, "video-edit-prompt.ts") : join(repo, "packages/workflows-ui/src/video-edit-prompt.ts");
const skillPath = source ? resolve(source, "SKILL.md") : join(repo, "packages/workflows-ui/skills/video-sop/SKILL.md");
const { applyVideoEdit } = await import(toolPath);
const { videoEditPrompt } = await import(promptPath);
const runtime = join(homedir(), ".screenpipe/pi-agent/node_modules/@earendil-works/pi-coding-agent");
const version = JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).version;
const piSource = await readFile(join(repo, "crates/screenpipe-core/src/agents/pi.rs"), "utf8");
if (!piSource.includes(`@earendil-works/pi-coding-agent@${version}"`)) throw Error("Installed Pi differs from the product pin.");
const hashes: Record<string, string> = {};
for (const path of [toolPath, promptPath, skillPath, import.meta.path, join(import.meta.dir, "cases.ts"), join(import.meta.dir, "grade.ts")])
  hashes[path.split("/").at(-1)!] = createHash("sha256").update(await readFile(path)).digest("hex");
const selected = cases.filter(c => !option("--case") || c.id === option("--case"));
if (!selected.length) throw Error("Unknown case");
const results: any[] = [];
await writeFile(join(output, "manifest.json"), JSON.stringify({ basis: live ? "model_replay" : "scripted_runtime", version, model: live ? "screenpipe/auto" : "local-scripted", maxTurns: 8, timeoutMs: 180000, maxTokens: 8192, hashes, cases: selected.map(c => c.id) }, null, 2), { mode: 0o600 });
for (const test of selected) {
  const root = await mkdtemp(join(tmpdir(), "screenpipe-video-eval-"));
  const config = join(root, "config"), project = join(root, "project");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const started = Date.now();
  try {
    await mkdir(join(project, ".pi/skills/video-sop"), { recursive: true });
    await mkdir(config, { recursive: true });
    await copyFile(skillPath, join(project, ".pi/skills/video-sop/SKILL.md"));
    await writeFile(join(project, "video-project.json"), JSON.stringify({ draft: test.source ?? draft, images: {} }));
    await writeFile(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false }, defaultThinkingLevel: "off" }));
    // A protocol fixture checks actual agent tool awaiting without hosted speech.
    const renderer = join(root, "renderer");
    await writeFile(renderer, `#!/usr/bin/env node\nconst fs=require('fs'),root=process.argv[3];console.log(JSON.stringify({progress:'Rendering 1 of 1'}));fs.mkdirSync(root+'/rendered');fs.writeFileSync(root+'/rendered/video.mp4','protocol fixture');fs.writeFileSync(root+'/rendered/captions.vtt','WEBVTT');console.log(JSON.stringify({complete:true}));`, {mode:0o700});
    const requests: any[] = [];
    if (live) {
      // Reuse the same configured product route and account. Never fall back to another provider.
      const saved = join(homedir(), ".screenpipe/pi-config");
      const models = JSON.parse(await readFile(join(saved, "models.json"), "utf8"));
      const provider = models.providers.screenpipe;
      const model = provider.models.find((m: any) => m.id === "auto");
      if (!model) throw Error("Configured product model is unavailable");
      await writeFile(join(config, "models.json"), JSON.stringify({ providers: { screenpipe: { ...provider, models: [{ ...model, maxTokens: 8192 }] } } }), { mode: 0o600 });
      await copyFile(join(saved, "auth.json"), join(config, "auth.json"));
    } else {
      // These tool calls are fixtures, not model decisions. They verify the real CLI/tool boundary.
      const turns: any[] = [
        { name: "read_video_sop", arguments: { guidance: true } },
        { name: "read_video_sop", arguments: {} },
        ...(test.expected?.render ? [{name: "render_video_sop", arguments: {}}] : test.expected ? [{ name: "edit_video_sop", arguments: test.shortening ? { changes: [{ id: "section-0", narration: "Open request; confirm owner. If missing, ask coordinator before proceeding." }], render: false } : test.expected }] : []),
      ];
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = await request.json(); requests.push(body);
        const call = turns[requests.length - 1];
        const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: test.answer ? `The project says: ${test.answer}.` : "The proposal is ready for the app to validate." };
        const chunk = (d: any, finish_reason: string | null) => `data: ${JSON.stringify({ id: "eval", object: "chat.completion.chunk", created: 0, model: "eval", choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`;
        return new Response(chunk(delta, null) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      } });
      await writeFile(join(config, "models.json"), JSON.stringify({ providers: { eval: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fictional", models: [{ id: "eval", name: "Eval", input: ["text", "image"], reasoning: false, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    }
    child = Bun.spawn([process.execPath, join(runtime, "dist/cli.js"), "--provider", live ? "screenpipe" : "eval", "--model", live ? "auto" : "eval", "--mode", "json", "--no-session", "--no-extensions", "--extension", toolPath, "--no-skills", "--no-context-files", "--no-prompt-templates", "--tools", "read_video_sop,edit_video_sop,render_video_sop", "--print", videoEditPrompt(test.request, test.history ?? [])], {
      cwd: project, env: { ...process.env, SCREENPIPE_VIDEO_CLI: renderer, PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: "1", JITI_TRY_NATIVE: "0" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    let timedOut = false, budgetExceeded = false, stdout = "", turns = 0, partial = "";
    const timeout = setTimeout(() => { timedOut = true; child!.kill(); }, 180000);
    const stderrPromise = new Response(child.stderr).text();
    try {
      for await (const bytes of child.stdout) {
        const text = new TextDecoder().decode(bytes); stdout += text; partial += text;
        const lines = partial.split("\n"); partial = lines.pop()!;
        for (const line of lines) { try { if (JSON.parse(line).type === "turn_start" && ++turns > 8) { budgetExceeded = true; child.kill(); } } catch {} }
      }
      await child.exited;
    } finally { clearTimeout(timeout); }
    const stderr = await stderrPromise;
    const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const assistant = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => e.message);
    const last = assistant.at(-1);
    const outcome: Outcome = { draft: structuredClone(test.source ?? draft), render: false, answer: last?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "", completed: child.exitCode === 0 && last?.stopReason === "stop" && events.some(e => e.type === "agent_end"), errors: [], tools: [], read: false, guidance: false, patches: 0 };
    for (const event of events) {
      if (event.type === "tool_execution_start") outcome.tools.push(event.toolName);
      if (event.type !== "tool_execution_end" || event.isError) continue;
      const call = events.find(e => e.type === "tool_execution_start" && e.toolCallId === event.toolCallId);
      if (event.toolName === "read_video_sop") { if (call?.args?.guidance) outcome.guidance = true; else outcome.read = true; }
      if (event.toolName === "render_video_sop") { outcome.render = true; outcome.renderCompleted = true; }
      if (event.toolName === "edit_video_sop") {
        outcome.patches++;
        try { const patch = JSON.parse(event.result.content.find((c: any) => c.type === "text").text); outcome.draft = applyVideoEdit(test.source ?? draft, patch); outcome.render = patch.render || outcome.render; }
        catch (e) { outcome.errors.push(String(e)); }
      }
    }
    if (timedOut || budgetExceeded) outcome.errors.push(timedOut ? "timeout" : "turn budget exceeded");
    if (last?.errorMessage) outcome.errors.push(last.errorMessage);
    if (!live && requests.some(r => r.tools?.length !== 3 || r.tools.some((t: any) => !["read_video_sop", "edit_video_sop", "render_video_sop"].includes(t.function.name)))) outcome.errors.push("Wrong tools exposed to model");
    const failures = grade(test, outcome);
    // Only actual provider/runtime errors are classified as blocked, never source text or a refusal.
    const providerError = String(last?.errorMessage ?? stderr);
    const blocked = live && /quota|allowance|exhaust|unauthorized|401|429|usage.limit|credit|authentication|api key/i.test(providerError);
    const status = blocked ? "blocked" : failures.length ? "failed" : "passed";
    const record = { id: test.id, status, seconds: (Date.now() - started) / 1000, failures, outcome };
    await writeFile(join(output, `${test.id}.json`), JSON.stringify({ ...record, events, stderr, ...(live ? {} : { requests }) }, null, 2), { mode: 0o600 });
    results.push(record); console.log(JSON.stringify({ id: test.id, status, failures }));
    if (blocked) break;
  } catch (error) { results.push({ id: test.id, status: "infrastructure_error", error: String(error) }); console.log(JSON.stringify(results.at(-1))); break; }
  finally { child?.kill(); if (child) await child.exited; server?.stop(true); await rm(root, { recursive: true, force: true }); }
}
await writeFile(join(output, "results.json"), JSON.stringify({ results, notRun: selected.filter(c => !results.some(r => r.id === c.id)).map(c => c.id) }, null, 2), { mode: 0o600 });
if (results.some(r => r.status !== "passed")) process.exitCode = 1;
