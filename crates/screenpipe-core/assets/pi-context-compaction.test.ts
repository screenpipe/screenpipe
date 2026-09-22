// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Run via apps/screenpipe-app-tauri/scripts/eval-pi-compaction.ts. The real
// pinned SDK runs in a disposable install; only the model and tool are synthetic.
import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const install = process.env.SCREENPIPE_TEST_PI_DIR;
if (!install) throw new Error("Run scripts/eval-pi-compaction.ts to use an isolated Pi runtime");
const sdk = await import(pathToFileURL(join(install, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(install, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const roots: string[] = [];
const sessions: any[] = [];
afterEach(async () => {
  setSystemTime();
  for (const session of sessions.splice(0)) session.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(options: { steps?: number; enabled?: boolean; failSummary?: boolean; stopOnSummary?: boolean; steerOnSummary?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "screenpipe-compaction-session-"));
  roots.push(root);
  const modelDefinition = { id: "test-32k", name: "test-32k", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 };
  const runtime = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider("test", { api: "openai-completions", baseUrl: "http://unused.invalid/v1", apiKey: "synthetic-key", models: [modelDefinition] });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: options.enabled ?? true }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "System context. ".repeat(4000) });
  await loader.reload();
  const toolCalls: number[] = [];
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel("test", "test-32k"), settingsManager: settings, resourceLoader: loader,
    thinkingLevel: "off", sessionManager: sdk.SessionManager.create(root, join(root, "sessions")), tools: ["lookup"],
    customTools: [{ name: "lookup", label: "Lookup", description: "Retrieve the next research result",
      parameters: { type: "object", properties: { step: { type: "number" } }, required: ["step"] },
      execute: async (_id: string, args: { step: number }) => {
        toolCalls.push(args.step);
        return { content: [{ type: "text", text: `Research result ${args.step}: ` + "evidence ".repeat(670) }], details: {} };
      } }] });
  sessions.push(session);
  const events: any[] = [];
  const requests: { tokens: number; summary: boolean; corrected: boolean }[] = [];
  let summaries = 0;
  let modelCalls = 0;
  let steered = false;
  session.subscribe((event: any) => {
    events.push(event);
    if (event.type === "compaction_start" && options.steerOnSummary && !steered) {
      steered = true;
      void session.steer("USER CORRECTION: preserve my newest instruction");
    }
  });
  // Real provider turns advance wall time. Instant synthetic turns can share
  // the compaction timestamp and incorrectly look like pre-summary usage.
  let clock = Date.now();
  session.agent.streamFunction = (_model: any, context: any, requestOptions: any) => {
    setSystemTime(new Date(clock += 10));
    const stream = createAssistantMessageEventStream();
    const summary = !context.tools?.length;
    const tokens = Math.ceil((context.systemPrompt?.length ?? 0) / 4)
      + context.messages.reduce((n: number, message: any) => n + sdk.estimateTokens(message), 0) + (summary ? 0 : 100);
    requests.push({ tokens, summary, corrected: JSON.stringify(context.messages).includes("USER CORRECTION") });
    let message: any = { role: "assistant", provider: "test", model: "test-32k", api: "openai-completions",
      content: [], stopReason: "stop", timestamp: Date.now(),
      usage: { input: tokens, output: 32, totalTokens: tokens + 32, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const finish = () => {
      stream.push(message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : { type: "done", reason: message.stopReason, message });
      stream.end(message);
    };
    if (requestOptions.signal?.aborted) {
      message = { ...message, stopReason: "aborted", errorMessage: "Aborted" };
      finish();
      return stream;
    }
    if (summary) {
      summaries++;
      if (options.stopOnSummary) {
        requestOptions.signal.addEventListener("abort", () => {
          message = { ...message, stopReason: "aborted", errorMessage: "Aborted" };
          finish();
        }, { once: true });
        void session.abort();
        return stream;
      }
      message.content = [{ type: "text", text: "The user asked to finish the research. Prior lookup results are summarized. Continue with the remaining steps and preserve the user's latest instruction." }];
    } else {
      modelCalls++;
      message.content = toolCalls.length < (options.steps ?? 14)
        ? [{ type: "toolCall", id: `lookup-${toolCalls.length + 1}`, name: "lookup", arguments: { step: toolCalls.length + 1 } }]
        : [{ type: "text", text: "Research complete." }];
      message.stopReason = message.content[0].type === "toolCall" ? "toolUse" : "stop";
    }
    if (tokens > 32768 || (summary && options.failSummary)) {
      message = { ...message, content: [], stopReason: "error", usage: { ...message.usage, input: 0, output: 0, totalTokens: 0 },
        errorMessage: summary && options.failSummary ? "summary provider failed" : `request (${tokens} tokens) exceeds the available context size (32768 tokens)` };
    }
    finish();
    return stream;
  };
  return { session, toolCalls, events, requests, get summaries() { return summaries; }, get modelCalls() { return modelCalls; } };
}

test("compacts inside one tool sequence before overflow, then persists resumable context", async () => {
  const h = await harness();
  await h.session.prompt("Finish all research steps; preserve the original request.");
  expect(h.toolCalls).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  expect(h.summaries).toBeGreaterThan(0);
  expect(h.requests.every(request => request.tokens <= 32768)).toBe(true);
  expect(h.events.filter(event => event.type === "agent_start")).toHaveLength(1);
  expect(h.events.filter(event => event.type === "agent_end")).toHaveLength(1);
  expect(h.events.findIndex(event => event.type === "compaction_start")).toBeLessThan(h.events.findIndex(event => event.type === "agent_end"));
  expect(h.session.messages.at(-1).content[0].text).toBe("Research complete.");
  const restored = sdk.SessionManager.open(h.session.sessionManager.getSessionFile());
  expect(restored.getBranch().some((entry: any) => entry.type === "compaction")).toBe(true);
  expect(restored.buildSessionContext().messages.some((message: any) => message.role === "compactionSummary")).toBe(true);
}, 20000);

test("delivers a user correction queued during compaction exactly once", async () => {
  const h = await harness({ steerOnSummary: true });
  await h.session.prompt("Finish the research.");
  expect(h.toolCalls).toHaveLength(14);
  expect(h.requests.every(request => request.tokens <= 32768)).toBe(true);
  expect(h.requests.some(request => !request.summary && request.corrected)).toBe(true);
  expect(h.events.filter(event => event.type === "message_end" && event.message.role === "user"
    && JSON.stringify(event.message.content).includes("USER CORRECTION"))).toHaveLength(1);
}, 20000);

test("user stop cancels the in-flight summary without continuing tools", async () => {
  const h = await harness({ stopOnSummary: true });
  await h.session.prompt("Finish the research.");
  expect(h.summaries).toBe(1);
  expect(h.toolCalls.length).toBeLessThan(14);
  expect(h.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(0);
  expect(h.events.at(-1).type).toBe("agent_settled");
}, 20000);

test("failed summaries retain the original history", async () => {
  const h = await harness({ failSummary: true, steps: 6 });
  await h.session.prompt("Finish the research.");
  expect(h.summaries).toBeGreaterThan(0);
  expect(h.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(0);
  expect(h.session.messages.filter((message: any) => message.role === "toolResult")).toHaveLength(h.toolCalls.length);
  expect(h.events.some(event => event.type === "compaction_end" && event.errorMessage)).toBe(true);
}, 20000);

test("short chats and explicitly disabled auto-compaction do not compact", async () => {
  for (const options of [{ steps: 2 }, { steps: 6, enabled: false }]) {
    const h = await harness(options);
    await h.session.prompt("Finish the research.");
    expect(h.summaries).toBe(0);
    expect(h.toolCalls).toHaveLength(options.steps);
  }
}, 20000);
