// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Exercise the pinned Pi session/loop, not a mock of the compaction hook.
// Only the model responses and evidence tool are fictional. Real Private
// history still needs a native outcome evaluation in addition to this test.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import contextPruning from "../../../../crates/screenpipe-core/assets/extensions/context-pruning";

async function runLongTask(options: { reads?: number; cancelDuringCompaction?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-context-regression-"));
  const readsRequired = options.reads ?? 16;
  let reads = 0, saves = 0, overflows = 0, summaries = 0;
  let resumedWithSummary = false;
  const events: string[] = [];
  const model: any = {
    id: "private-context-fixture", name: "Private context fixture",
    provider: "context-fixture", api: "openai-completions",
    baseUrl: "https://unused.invalid", contextWindow: 32768, maxTokens: 8192,
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"),
  });
  runtime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, api: model.api, apiKey: "fictional-key", models: [model],
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, keepRecentTokens: 8192, reserveTokens: 8192 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true,
    extensionFactories: [contextPruning],
    systemPrompt: "Complete the evidence review and save once. Preserve SOURCE_CANARY.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, model, modelRuntime: runtime,
    resourceLoader: loader, sessionManager: SessionManager.inMemory(directory),
    settingsManager: settings, tools: ["evidence", "save"], thinkingLevel: "off",
    customTools: [
      { name: "evidence", label: "Evidence", description: "Read the next evidence page",
        parameters: Type.Object({}), execute: async () => {
          reads++;
          return { content: [{ type: "text", text: `SOURCE_CANARY page ${reads}\n` + "Recorded evidence. ".repeat(800) }], details: {} };
        } },
      { name: "save", label: "Save", description: "Commit the reviewed result",
        parameters: Type.Object({}), execute: async () => {
          expect(reads).toBe(readsRequired);
          saves++;
          return { content: [{ type: "text", text: "SAVED" }], details: {} };
        } },
    ],
  });
  session.subscribe(event => { events.push(event.type); });
  session.agent.streamFunction = (_model, context, streamOptions) => {
    const stream = new AssistantMessageEventStream();
    const summary = !context.tools?.length;
    const chars = JSON.stringify(context.messages).length;
    const input = Math.ceil(chars / 4);
    const response: any = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [], stopReason: "stop",
      usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const finish = () => {
      stream.push({ type: "start", partial: response });
      if (response.stopReason === "error" || response.stopReason === "aborted")
        stream.push({ type: "error", reason: response.stopReason, error: response });
      else stream.push({ type: "done", reason: response.stopReason, message: response });
    };
    if (streamOptions?.signal?.aborted) {
      response.stopReason = "aborted";
      response.errorMessage = "Aborted";
    } else if (input > model.contextWindow) {
      // Summaries use the same small model, so enforce its limit there too.
      overflows++;
      response.stopReason = "error";
      response.errorMessage = `context_length_exceeded: ${input} > 32768`;
    } else if (summary) {
      summaries++;
      if (options.cancelDuringCompaction) {
        streamOptions?.signal?.addEventListener("abort", () => {
          response.stopReason = "aborted";
          response.errorMessage = "Aborted";
          finish();
        }, { once: true });
        // Stop from outside the active loop, as the app's Stop action does.
        setTimeout(() => { void session.abort(); }, 0);
        return stream;
      }
      response.content = [{ type: "text", text: "Reviewed SOURCE_CANARY evidence. Continue remaining pages, then save exactly once." }];
    } else if (!saves) {
      resumedWithSummary ||= summaries > 0 && JSON.stringify(context.messages).includes("Reviewed SOURCE_CANARY");
      response.stopReason = "toolUse";
      response.content = [{ type: "toolCall", id: `call-${reads}-${saves}`, name: reads < readsRequired ? "evidence" : "save", arguments: {} }];
    } else response.content = [{ type: "text", text: "Saved result." }];
    queueMicrotask(finish);
    return stream;
  };
  try {
    await session.prompt("Review all evidence pages, preserving SOURCE_CANARY, then save.");
    return { reads, saves, summaries, overflows, resumedWithSummary, events };
  } finally {
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("32K model compacts within a long tool run, retains evidence and saves once without overflow", async () => {
  const result = await runLongTask();
  expect(result.reads).toBe(16);
  expect(result.saves).toBe(1);
  expect(result.summaries).toBeGreaterThan(0);
  expect(result.resumedWithSummary).toBe(true);
  expect(result.overflows).toBe(0);
  expect(result.events.filter(e => e === "agent_start")).toHaveLength(1);
}, 15000);

test("small requests save without unnecessary compaction", async () => {
  const result = await runLongTask({ reads: 1 });
  expect(result.saves).toBe(1);
  expect(result.summaries).toBe(0);
  expect(result.overflows).toBe(0);
});

test("Stop during between-turn compaction does not resume or save", async () => {
  const result = await runLongTask({ cancelDuringCompaction: true });
  expect(result.summaries).toBeGreaterThan(0);
  expect(result.reads).toBeLessThan(16);
  expect(result.saves).toBe(0);
  expect(result.overflows).toBe(0);
}, 15000);
