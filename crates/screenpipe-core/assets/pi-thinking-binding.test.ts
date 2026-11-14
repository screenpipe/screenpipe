// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Real pinned Pi and Anthropic SDK; synthetic HTTP implements the documented
// binding check. This proves request/stream handling, not live provider behavior.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const install = process.env.SCREENPIPE_TEST_PI_DIR;
if (!install) throw new Error("Run scripts/eval-pi-compaction.ts --thinking-binding");
const load = (path: string) => import(pathToFileURL(join(install, "node_modules", path)).href);
const sdk = await load("@earendil-works/pi-coding-agent/dist/index.js");
const { streamSimple } = await load("@earendil-works/pi-ai/dist/api/anthropic-messages.js");
const beta = "thinking-binding-controls-2026-08-01";
const model = { id: "claude-sonnet-5-5", name: "Sonnet", provider: "anthropic-byok", api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text"],
  compat: { forceAdaptiveThinking: true }, contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
afterEach(() => { warnings.length = 0; });
afterAll(() => { console.warn = originalWarn; });

function response(transformations: any[] = [], deltaTransformations: any[] = []) {
  const events = [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: model.id,
      content: [], usage: { input_tokens: 40, output_tokens: 1 }, input_transformations: transformations } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private reasoning canary" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "READY" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 }, input_transformations: deltaTransformations },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream", "request-id": "req_fixture" } });
}
const drop = { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" };
function error(message: string) {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
    { status: 400, headers: { "content-type": "application/json" } });
}

// Match Anthropic's prefix definition, excluding cache markers (which move).
function prefix(body: any) {
  return JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages.slice(0, 1) },
    (key, value) => key === "cache_control" ? undefined : value);
}

test("native request preserves betas, thinking settings and returned signatures", async () => {
  const context = { systemPrompt: "stable", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
  let sent: any;
  const result = await streamSimple(model, context, { apiKey: "synthetic-key", reasoning: "medium",
    headers: { "Anthropic-Beta": "context-management-2025-06-27" },
    fetch: async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      const betas = new Headers(init.headers).get("anthropic-beta")!.split(",");
      expect(betas).toContain(beta);
      expect(betas).toContain("context-management-2025-06-27");
      return response();
    } }).result();
  expect(sent.thinking.type).toBe("adaptive");
  expect(sent.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
  expect(sent.output_config.effort).toBe("medium");
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
  expect(result.content[0].thinkingSignature).toBe("fixture-signature");
  expect(warnings).toEqual([]);
});

test.each(["stable", "system", "tools", "history"])("real Pi continues after %s prefix, including saved-session restart", async change => {
  const root = await mkdtemp(join(tmpdir(), "screenpipe-thinking-session-"));
  const requests: any[] = [];
  let session: any;
  let firstPrefix: string | undefined;
  let changed = false;
  let toolDescription = "Original tool description";
  const transport = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const current = prefix(body);
    const hasThinking = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "thinking"));
    const mismatch = hasThinking && current !== firstPrefix;
    firstPrefix ??= current;
    if (mismatch && (!new Headers(init.headers).get("anthropic-beta")?.includes(beta) ||
        body.thinking?.block_binding?.prefix_mismatch_behavior !== "drop_block")) {
      return error('messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.');
    }
    return response(mismatch ? [drop] : []);
  };
  const create = async (manager: any) => {
    const runtime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "synthetic-key", models: [model] });
    const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => changed && change === "system" ? "changed system" : "stable system" });
    await loader.reload();
    const created = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
      model: runtime.getModel(model.provider, model.id), settingsManager: settings, resourceLoader: loader,
      thinkingLevel: "medium", sessionManager: manager, tools: ["lookup"],
      customTools: [{ name: "lookup", label: "Lookup", description: toolDescription,
        parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "evidence" }] }) }] });
    created.session.agent.streamFunction = (m: any, c: any, options: any) => streamSimple(m, c, {
      ...options, apiKey: "synthetic-key", fetch: transport, maxRetries: 0,
    });
    return created.session;
  };
  try {
    session = await create(sdk.SessionManager.create(root, join(root, "sessions")));
    await session.prompt("hello");
    expect(session.messages.at(-1).stopReason).toBe("stop");
    const sessionFile = session.sessionManager.getSessionFile();
    session.dispose();
    changed = true;
    if (change === "tools") toolDescription = "Changed tool description";
    // Persist an edited user turn as a real saved session, then reopen it.
    if (change === "history") {
      const saved = await readFile(sessionFile, "utf8");
      await writeFile(sessionFile, saved.replace('"text":"hello"', '"text":"edited hello"').replace('"content":"hello"', '"content":"edited hello"'));
    }
    session = await create(sdk.SessionManager.open(sessionFile));
    await session.prompt("continue");
    const completed = session.messages.at(-1);
    expect(completed.stopReason).toBe("stop");
    expect(completed.content.some((b: any) => b.text === "READY")).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[1].content[0].signature).toBe("fixture-signature");
    expect(warnings).toHaveLength(change === "stable" ? 0 : 1);
    if (change !== "stable") {
      expect(warnings[0]).toContain("outcome=request_accepted_without_block reason=prefix_binding_mismatch path=messages.1.content.0 request_id=req_fixture");
      expect(warnings[0]).not.toContain("canary");
      expect(warnings[0]).not.toContain("fixture-signature");
      if (process.env.SCREENPIPE_THINKING_REPORT_FIXTURE) {
        await writeFile(process.env.SCREENPIPE_THINKING_REPORT_FIXTURE, `Pi stderr: ${warnings[0]}\n`);
      }
    }
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["https://compatible.invalid", "https://api.anthropic.com"])("disabled thinking on %s gets no unsupported block_binding", async baseUrl => {
  const result = await streamSimple({ ...model, baseUrl }, { messages: [{ role: "user", content: "hello" }] }, {
    apiKey: "synthetic-key", reasoning: undefined, fetch: async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.thinking?.block_binding).toBeUndefined();
      if (baseUrl.includes("compatible")) expect(new Headers(init.headers).get("anthropic-beta") ?? "").not.toContain(beta);
      return response();
    },
  }).result();
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
});

test("corrupt signatures and unrelated 400s retain original failures without retry", async () => {
  for (const message of ['Invalid `signature` in `thinking` block', "invalid tool schema"]) {
    let attempts = 0;
    const result = await streamSimple(model, { messages: [{ role: "user", content: "hello" }] }, {
      apiKey: "synthetic-key", reasoning: "medium", fetch: async () => { attempts++; return error(message); },
    }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(message);
    expect(attempts).toBe(1);
  }
});


test("legacy budget thinking and caller mismatch policy remain intact", async () => {
  let sent: any;
  await streamSimple({ ...model, id: "claude-sonnet-4-5", compat: {} }, { messages: [{ role: "user", content: "hello" }] }, {
    apiKey: "synthetic-key", reasoning: "medium", onPayload: (params: any) => {
      params.thinking.block_binding = { prefix_mismatch_behavior: "error" };
    }, fetch: async (_url: any, init: any) => { sent = JSON.parse(init.body); return response(); },
  }).result();
  expect(sent.thinking.type).toBe("enabled");
  expect(sent.thinking.budget_tokens).toBeGreaterThan(0);
  expect(sent.thinking.block_binding.prefix_mismatch_behavior).toBe("error");
});

test("compatible adaptive provider gets no native control; fallback drops remain diagnosable", async () => {
  const result = await streamSimple({ ...model, baseUrl: "https://compatible.invalid" }, { messages: [{ role: "user", content: "hello" }] }, {
    apiKey: "synthetic-key", reasoning: "medium", fetch: async (_url: any, init: any) => {
      expect(JSON.parse(init.body).thinking.block_binding).toBeUndefined();
      expect(new Headers(init.headers).get("anthropic-beta") ?? "").not.toContain(beta);
      return response([], [drop, { ...drop, reason: "future_unknown_check" }, { ...drop, path: "private canary" }]);
    },
  }).result();
  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("reason=prefix_binding_mismatch");
  expect(warnings[0]).not.toContain("canary");
});
