// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./workflow-team-share";
let cwd: string, dir: string, task: string | undefined, tool: any, server: any, requests: any[];
beforeEach(() => {
  cwd = process.cwd(); task = process.env.SCREENPIPE_PIPE_NAME;
  dir = mkdtempSync(join(tmpdir(), "workflow-sharing-")); process.chdir(dir);
  process.env.SCREENPIPE_PIPE_NAME = "workflow-share"; requests = [];
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
    expect(req.headers.get("authorization")).toBe("Bearer local-capability");
    expect(new URL(req.url).pathname).toBe("/workflows/team-sharing");
    requests.push(req.method === "POST" ? await req.json() : null);
    return Response.json({ ready: true, receipt: "saved" });
  }});
  writeFileSync(join(dir, ".screenpipe-permissions.json"), JSON.stringify({ api_base: `http://127.0.0.1:${server.port}`, pipe_token: "local-capability" }));
  extension({ registerTool: (value: any) => { tool = value; } } as any);
});
afterEach(() => {
  server.stop(true); process.chdir(cwd); rmSync(dir, { recursive: true });
  if (task === undefined) delete process.env.SCREENPIPE_PIPE_NAME; else process.env.SCREENPIPE_PIPE_NAME = task;
});
const run = (input: any, signal = new AbortController().signal) => tool.execute("id", input, signal);
test("routes classifications through the recorder using its scoped capability", async () => {
  const input = { action: "classify", workflow_id: "id", hash: "hash", classification: "professional" };
  expect((await run(input)).isError).not.toBe(true); expect(requests).toEqual([input]);
});
test("the classifier cannot opt in or change its destination", async () => {
  await expect(run({ action: "configure", enabled: true })).rejects.toThrow("Unknown sharing action");
  expect(requests).toHaveLength(0);
});
test("does not export a capability to a nonlocal address", async () => {
  writeFileSync(join(dir, ".screenpipe-permissions.json"), JSON.stringify({ api_base: "https://example.com", pipe_token: "local-capability" }));
  await expect(run({ action: "context" })).rejects.toThrow("Local recorder capability unavailable"); expect(requests).toHaveLength(0);
});
test("a stopped agent cannot make a request", async () => {
  const stop = new AbortController(); stop.abort();
  await expect(run({ action: "context" }, stop.signal)).rejects.toThrow(); expect(requests).toHaveLength(0);
});
test("preserves large candidate text instead of classifying truncated instructions", async () => {
  const candidate = { ready: true, candidates: [{ hash: "a", workflow: { description: "private instruction ".repeat(1000) } }] };
  server.reload({ fetch: () => Response.json(candidate) });
  const result = await run({ action: "context" }); const pointer = JSON.parse(result.content[0].text);
  expect(result.content[0].text.length).toBeLessThan(6000);
  expect(JSON.parse(readFileSync(pointer.path, "utf8"))).toEqual(candidate);
  expect(statSync(pointer.path).mode & 0o777).toBe(0o600);
});
test("a provider failure is not a publication receipt", async () => {
  server.reload({ fetch: () => Response.json({ error: "Membership revoked" }, { status: 403 }) });
  await expect(run({ action: "classify", classification: "professional" })).rejects.toThrow("Membership revoked");
});
test("ordinary workflow agents do not receive the sharing tool", () => {
  process.env.SCREENPIPE_PIPE_NAME = "workflow-review";
  let registered = false; extension({ registerTool: () => { registered = true; } } as any);
  expect(registered).toBe(false);
});
