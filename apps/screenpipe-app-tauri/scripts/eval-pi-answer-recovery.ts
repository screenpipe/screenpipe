// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Real pinned Pi + production extension, with a fictional local model endpoint.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../..");
const runtime = process.env.SCREENPIPE_EVAL_PI_DIR || resolve(import.meta.dir, "..");
const source = await readFile(join(repo, "crates/screenpipe-core/src/agents/pi.rs"), "utf8");
const version = source.match(/PI_PACKAGE: &str = "@earendil-works\/pi-coding-agent@([^"]+)"/)![1];
assert.equal(JSON.parse(await readFile(join(runtime, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version, version);
const root = await mkdtemp(join(tmpdir(), "screenpipe-answer-recovery-"));
const extension = resolve(import.meta.dir, "../src-tauri/assets/extensions/answer-recovery.ts");
const baseline = process.argv.includes("--baseline");

async function evaluate(scenario: string) {
  const dir = join(root, scenario);
  const config = join(dir, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(dir, "evidence.txt"), "Fictional inbox classification: DMARC reports are routine, not important.\n");
  let calls = 0;
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json();
    requests.push(body);
    calls += 1;
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({
      id: "eval", object: "chat.completion.chunk", created: 0, model: "eval",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    if (scenario === "provider-error") return new Response(JSON.stringify({ error: { message: "fictional invalid API key" } }), { status: 401 });
    if (calls === 1 && scenario !== "normal") {
      return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "read-evidence", type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: join(dir, "evidence.txt") }) } }] }, null)
        + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (scenario === "stopped") {
      setTimeout(() => child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`), 10);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", reasoning_content: "Waiting." }, null)));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    const empty = calls === 2 || scenario === "no-progress";
    const result = empty
      ? chunk({ role: "assistant", reasoning_content: "Checking the evidence." }, null) + chunk({}, scenario === "length" ? "length" : scenario === "missing-tool" ? "tool_calls" : "stop")
      : chunk({ role: "assistant", content: "The saved classification treats DMARC reports as routine. The inbox cleanup still needs verification; no mail has been changed." }, null) + chunk({}, "stop");
    return new Response(result + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  await writeFile(join(config, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await writeFile(join(config, "models.json"), JSON.stringify({ providers: { eval: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fictional-key",
    models: [{ id: "eval", name: "Eval", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const child = Bun.spawn([process.execPath, join(runtime, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--provider", "eval", "--model", "eval", "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-extensions",
    ...(!baseline ? ["--extension", extension] : [])], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: "1", JITI_TRY_NATIVE: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderrPromise = new Response(child.stderr).text();
  const events: any[] = [];
  let pending = "";
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => child.kill(), 60_000);
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Read evidence.txt and report the classification and what remains unfinished." })}\n`);
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try { events.push(JSON.parse(line)); } catch { continue; }
        if (events.at(-1)?.type === "agent_end") child.kill();
      }
    }
    await child.exited;
    const stderr = await stderrPromise;
    assert(!stderr.includes("Failed to load extension"), stderr);
    assert(events.some((event) => event.type === "agent_end"), `no terminal event: ${stderr}`);
    const last = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
    const text = last?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
    const shouldAnswer = scenario === "normal" || (!baseline && ["empty", "length", "missing-tool"].includes(scenario));
    assert.equal(Boolean(text), shouldAnswer, `${scenario}: ${JSON.stringify(last)}\n${stderr}`);
    if (scenario !== "normal" && scenario !== "provider-error") {
      assert.equal(events.filter((event) => event.type === "tool_execution_end").length, 1, "completed read must not replay");
    }
    if (shouldAnswer && scenario !== "normal") {
      assert.equal(calls, 3);
      assert(requests[2].messages.some((message: any) => message.role === "tool" && JSON.stringify(message).includes("DMARC")), "recovery must reuse the tool evidence");
      assert.equal(events.filter((event) => event.type === "agent_end").length, 1, "recovery stays inside the active turn");
      assert.equal(events.filter((event) => event.type === "message_start" && event.message?.role === "user").length, 1, "recovery must not fabricate another user turn");
      assert(stderr.includes("action=complete outcome=answered"));
    }
    if (scenario === "no-progress") assert.equal(calls, baseline ? 2 : 3, "empty recovery without new evidence must settle");
    if (!baseline && scenario === "no-progress") {
      assert(stderr.includes("outcome=incomplete cause=no_new_evidence recovery=retry"));
      if (process.env.SCREENPIPE_INCOMPLETE_REPORT_FIXTURE) await appendFile(process.env.SCREENPIPE_INCOMPLETE_REPORT_FIXTURE, stderr);
    }
    if (scenario === "provider-error") assert.equal(calls, 1, "provider auth failures must not be retried by answer recovery");
    if (scenario === "stopped") assert.equal(calls, 2, "Stop must not trigger answer recovery");
    console.log(`PASS ${baseline ? "baseline" : "fixed"} ${scenario}: requests=${calls}, final_answer=${Boolean(text)}`);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    server.stop(true);
  }
}

try {
  for (const scenario of ["empty", "length", "missing-tool", "no-progress", "normal", "provider-error", "stopped"]) await evaluate(scenario);
} finally { await rm(root, { recursive: true, force: true }); }
