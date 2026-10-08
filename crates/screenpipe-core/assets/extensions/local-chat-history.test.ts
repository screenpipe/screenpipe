// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./local-chat-history";
const cwd = process.cwd();
const oldName = process.env.SCREENPIPE_PIPE_NAME;
const originalFetch = globalThis.fetch;
let directory: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (oldName === undefined) delete process.env.SCREENPIPE_PIPE_NAME; else process.env.SCREENPIPE_PIPE_NAME = oldName;
  process.chdir(cwd);
  if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined;
});
function harness() {
  let registered: any; let beforeStart: any;
  extension({ registerTool: (value: any) => { registered = value; }, on: (event: string, handler: any) => { if (event === "before_agent_start") beforeStart = handler; } } as any);
  return { tool: registered, beforeStart };
}
function tool() { return harness().tool; }
function pipe() { directory = mkdtempSync(join(tmpdir(), "chat-history-test-")); process.chdir(directory); process.env.SCREENPIPE_PIPE_NAME = "workflow-discover"; }
test("uses the scheduled pipe capability and retains pagination on empty pages", async () => {
  pipe(); writeFileSync(".screenpipe-permissions.json", JSON.stringify({ api_base: "http://127.0.0.1:3030", pipe_token: "sp_pipe_fixture" }));
  let request: any;
  globalThis.fetch = (async (url: URL, init: any) => { request = { url: String(url), init }; return Response.json({ results: [], next_offset: 50 }); }) as any;
  const result = await tool().execute("1", { action: "search", source: "codex", offset: 0, query: "research" }, new AbortController().signal);
  expect(request.url).toContain("/agent/chat-history/search?source=codex&query=research&offset=0");
  expect(request.init.headers.Authorization).toBe("Bearer sp_pipe_fixture");
  expect(JSON.parse(result.content[0].text).next_offset).toBe(50);
});
test("never falls back to unrestricted host auth when a pipe capability is missing", async () => {
  pipe(); let called = false; globalThis.fetch = (async () => { called = true; return Response.json({}); }) as any;
  const result = await tool().execute("1", { action: "read", source: "claude", id: "session" }, new AbortController().signal);
  expect(result.isError).toBe(true); expect(called).toBe(false);
});
test("blocks remote API targets before transmitting a token", async () => {
  pipe(); writeFileSync(".screenpipe-permissions.json", JSON.stringify({ api_base: "https://example.com", pipe_token: "sp_pipe_fixture" }));
  let called = false; globalThis.fetch = (async () => { called = true; return Response.json({}); }) as any;
  const result = await tool().execute("1", { action: "search", source: "hermes" }, new AbortController().signal);
  expect(result.isError).toBe(true); expect(called).toBe(false);
});

test("digital clone receives native research instructions and reads all providers with its own capability", async () => {
  pipe(); process.env.SCREENPIPE_PIPE_NAME = "digital-clone";
  writeFileSync(".screenpipe-permissions.json", JSON.stringify({ api_base: "http://127.0.0.1:3030", pipe_token: "sp_pipe_clone_fixture" }));
  const h = harness();
  const result = await h.beforeStart({ systemPrompt: "Maintain the existing user wiki. Do not read excluded sources." });
  expect(result.systemPrompt).toStartWith("Maintain the existing user wiki. Do not read excluded sources.");
  expect(result.systemPrompt).toContain("use local_chat_history");
  expect(result.systemPrompt).toContain("Claude Code, Codex and Hermes");
  const calls: string[] = [];
  globalThis.fetch = (async (url: URL, init: any) => {
    expect(init.headers.Authorization).toBe("Bearer sp_pipe_clone_fixture");
    calls.push(url.pathname + url.search);
    return url.pathname.endsWith("search") ? Response.json({ results: [{ id: "fixture-session" }], next_offset: null }) : Response.json({ messages: [{ role: "user", text: "I prefer concise briefs.", source: `chat:${url.searchParams.get("source")}:fixture-session:1` }], next_offset: null });
  }) as any;
  for (const source of ["claude", "codex", "hermes"]) {
    const search = await h.tool.execute("search", { action: "search", source }, new AbortController().signal);
    const id = JSON.parse(search.content[0].text).results[0].id;
    const read = await h.tool.execute("read", { action: "read", source, id }, new AbortController().signal);
    expect(JSON.parse(read.content[0].text).messages[0]).toEqual({ role: "user", text: "I prefer concise briefs.", source: `chat:${source}:fixture-session:1` });
  }
  expect(calls).toHaveLength(6);
});
test("ordinary chat and unrelated pipes do not receive automatic mining instructions", () => {
  for (const name of [undefined, "day-recap", "workflow-review"]) {
    if (name === undefined) delete process.env.SCREENPIPE_PIPE_NAME; else process.env.SCREENPIPE_PIPE_NAME = name;
    const h = harness(); expect(h.beforeStart).toBeUndefined(); expect(h.tool.name).toBe("local_chat_history");
  }
});
test("digital clone reports denied history instead of falling back or hiding the gap", async () => {
  pipe(); process.env.SCREENPIPE_PIPE_NAME = "digital-clone";
  writeFileSync(".screenpipe-permissions.json", JSON.stringify({ api_base: "http://127.0.0.1:3030", pipe_token: "sp_pipe_clone_fixture" }));
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ error: "Native history denied by owner permissions" }, { status: 403 }); }) as any;
  const result = await tool().execute("1", { action: "search", source: "codex" }, new AbortController().signal);
  expect(result.isError).toBe(true); expect(result.content[0].text).toContain("denied by owner permissions"); expect(calls).toBe(1);
});
