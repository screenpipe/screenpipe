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
function tool() { let registered: any; extension({ registerTool: (value: any) => { registered = value; } } as any); return registered; }
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
