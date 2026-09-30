// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { posix } from "node:path";

let state;
function appPort(name, factory) {
  mock.module(name, factory);
  const stem = new URL("../../../apps/screenpipe-app-tauri/" + name.slice(2), import.meta.url).pathname;
  for (const suffix of [".ts", ".tsx", ".js"]) {
    if (existsSync(stem + suffix)) { mock.module(stem + suffix, factory); break; }
  }
}
mock.module("@tauri-apps/api/path", () => ({ homeDir: async () => "/synthetic", join: async (...parts) => posix.join(...parts) }));
appPort("@/lib/events/bus", () => ({
  mountAgentEventBus: async () => {},
  registerForeground: (_id, handler) => {
    state.handler = handler;
    return () => { state.unregistered++; state.handler = null; };
  },
}));
appPort("@/lib/utils/tauri", () => ({ commands: {
  piStart: async () => { state.starts++; return { status: "ok", data: { running: true } }; },
  piPrompt: async () => {
    const turn = state.prompts++;
    // Native dispatch acknowledgement completes before the synthetic events.
    setTimeout(() => { for (const event of state.turns[turn] ?? []) state.handler?.({ event }); }, 0);
    return { status: "ok", data: null };
  },
  piStop: async () => { state.stops++; return { status: "ok", data: { running: false } }; },
} }));
globalThis.fetch = async () => { state.network++; throw Error("Live network forbidden"); };
const { runDailySummaryWithPi } = await import("../../../apps/screenpipe-app-tauri/lib/daily-summary-pi.ts");
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });
const end = (...messages) => ({ type: "agent_end", messages });
const message = (value, extra = {}) => ({ type: "message_end", message: value, ...extra });
const fail = (text, extra = {}) => assistant("", { stopReason: "error", errorMessage: text, ...extra });
const quota = 'HTTP 429 {"error":{"code":"hosted_ai_allowance_exceeded"}}';
const options = {
  date: new Date("2026-08-18T12:00:00Z"), range: { start: "synthetic-start", end: "synthetic-end" },
  preset: { id: "synthetic", provider: "screenpipe-cloud", url: "", model: "auto", prompt: "" },
  userToken: "synthetic-token", prompt: "Summarize synthetic activity", systemPrompt: "Synthetic test instructions",
};
beforeEach(() => { state = { handler: null, turns: [], starts: 0, prompts: 0, stops: 0, unregistered: 0, network: 0 }; });
afterEach(() => { expect(state.network).toBe(0); });
async function run(turns) {
  state.turns = turns;
  return runDailySummaryWithPi(options).then(value => ({ ok: true, value }), error => ({ ok: false, error: error.message }));
}
function cleaned() {
  expect(state.starts).toBe(1); expect(state.unregistered).toBe(1); expect(state.stops).toBeGreaterThanOrEqual(1);
}
for (const [name, event, expected] of [
  ["message error preserves allowance code", message(fail(quota)), quota],
  ["agent-end error preserves rate-limit code", end(fail("rate_limit_exceeded")), "rate_limit_exceeded"],
  ["message legacy error field is preserved", message(fail(undefined, { error: "legacy-provider-refusal" })), "legacy-provider-refusal"],
  ["agent-end legacy error field is preserved", end(fail(undefined, { error: "legacy-provider-refusal" })), "legacy-provider-refusal"],
  ["missing provider text has an actionable fallback", message(fail("")), "AI request failed"],
  ["terminal error beats partial assistant text", message(fail(quota, { content: [{ type: "text", text: "unfinished partial" }] })), quota],
]) {
  test(name, async () => {
    const result = await run([[event, end(assistant("ordinary completion after failed turn"))]]);
    expect(result.ok).toBe(false);
    if (expected === "AI request failed") expect(result.error?.trim().length).toBeGreaterThan(0);
    else expect(result.error).toContain(expected);
    expect(state.prompts).toBe(1); cleaned();
  });
}
test("agent-end terminal error beats earlier assistant prose", async () => {
  const result = await run([[end(assistant("stale prose"), fail(quota))]]);
  expect(result.ok).toBe(false); expect(result.error).toContain(quota); expect(state.prompts).toBe(1); cleaned();
});
test("explicit retry hint preserves later successful completion", async () => {
  const result = await run([[message(fail(quota), { willRetry: true }), end(assistant(" recovered summary "))]]);
  expect(result).toEqual({ ok: true, value: "recovered summary" }); expect(state.prompts).toBe(1); cleaned();
});
test("non-assistant error-like messages do not suppress a valid summary", async () => {
  const result = await run([[message({ role: "toolResult", stopReason: "error", errorMessage: quota }), end({ role: "user", stopReason: "error", errorMessage: quota }, assistant("valid summary"))]]);
  expect(result).toEqual({ ok: true, value: "valid summary" }); expect(state.prompts).toBe(1); cleaned();
});
test("successful assistant response is preserved and trimmed", async () => {
  expect(await run([[end(assistant(" final summary "))]])).toEqual({ ok: true, value: "final summary" });
  expect(state.prompts).toBe(1); cleaned();
});
test("one empty completion retry may recover valid text", async () => {
  expect(await run([[end()], [end(assistant("recovered after tools"))]])).toEqual({ ok: true, value: "recovered after tools" });
  expect(state.prompts).toBe(2); cleaned();
});
test("repeated empty completion fails after one bounded retry", async () => {
  const result = await run([[end()], [end()]]);
  expect(result.ok).toBe(false); expect(result.error).toMatch(/empty/i);
  expect(state.prompts).toBe(2); cleaned();
});
test("ordinary error events still preserve provider detail", async () => {
  const result = await run([[{ type: "error", errorMessage: quota }]]);
  expect(result.ok).toBe(false); expect(result.error).toContain(quota);
  expect(state.prompts).toBe(1); cleaned();
});
