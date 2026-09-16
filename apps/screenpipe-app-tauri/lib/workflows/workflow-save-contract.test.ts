// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import workflowCatalog from "@screenpipe-ext/workflow-catalog";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directories: string[] = [];
const priorExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = priorExitCode; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stopped = { messages: [{ role: "assistant", stopReason: "stop" }] };
async function harness() {
  const events: Record<string, (event?: any, ctx?: any) => Promise<any>> = {};
  const tools: Record<string, any> = {};
  const pi = { on: (name: string, run: any) => { events[name] = run; }, registerTool: (tool: any) => { tools[tool.name] = tool; }, setActiveTools: vi.fn(), sendMessage: vi.fn() };
  workflowCatalog(pi as any);
  const parent = mkdtempSync(join(tmpdir(), "workflow-save-test-"));
  directories.push(parent);
  const cwd = join(parent, "workflow-discovery"); mkdirSync(cwd);
  writeFileSync(join(cwd, ".screenpipe-permissions.json"), JSON.stringify({ pipe_token: "fixture", api_base: "http://127.0.0.1:3030" }));
  await events.session_start({}, { cwd });
  const context = { revision: 3, now: "2026-09-15T12:00:00Z", ready: true, inputRevision: 2, checkedThrough: "2026-09-15T12:00:00Z" };
  const fetch = vi.fn().mockImplementation(async () => Response.json(context));
  vi.stubGlobal("fetch", fetch);
  await tools.workflow_context.execute("context", {});
  const commit = () => tools.workflow_commit.execute("save", { expected_revision: 3, checked_through: context.now, workflows: [] });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { events, pi, fetch, commit, stderr, context };
}
it("recovers a rejected commit through Pi follow-up and accepts a no-change receipt", async () => {
  const h = await harness();
  await h.events.tool_result({ toolName: "search-content", isError: false });
  h.fetch.mockResolvedValueOnce(Response.json({ error: "Source quote does not support the claim" }, { status: 422 }));
  await expect(h.commit()).rejects.toThrow("Source quote");
  await h.events.agent_end(stopped);
  expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "workflow-save-required" }), { deliverAs: "followUp", triggerTurn: true });
  h.fetch.mockResolvedValueOnce(Response.json({ revision: 4, changes: { created: 0, updated: 0 }, checkedThrough: h.context.now }));
  await h.commit();
  await h.events.agent_end(stopped);
  await h.events.agent_settled();
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(h.stderr).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(priorExitCode);
});
it("bounds recovery and fails the process when the agent stops without a receipt", async () => {
  const h = await harness();
  await h.events.agent_end(stopped);
  await h.events.agent_end(stopped);
  await h.events.agent_settled();
  expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(String(h.stderr.mock.calls[0][0]))).toMatchObject({ error: { code: "missing_output" } });
});
it("never checkpoints failed source reads or retries an aborted/provider-error turn", async () => {
  const h = await harness();
  await h.events.tool_result({ toolName: "search-content", isError: true });
  await expect(h.commit()).rejects.toThrow("source reads have failed");
  for (const stopReason of ["aborted", "error"]) {
    await h.events.agent_end({ messages: [{ role: "assistant", stopReason }] });
    await h.events.agent_settled();
  }
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(h.stderr).not.toHaveBeenCalled();
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it("fails a truncated response without pretending the task saved", async () => {
  const h = await harness();
  await h.events.agent_end({ messages: [{ role: "assistant", stopReason: "length" }] });
  await h.events.agent_settled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(h.stderr).toHaveBeenCalledOnce();
});
it("requires an actual save receipt, not merely an HTTP 200", async () => {
  const h = await harness();
  await h.events.tool_result({ toolName: "search-content", isError: false });
  h.fetch.mockResolvedValueOnce(Response.json({}));
  await expect(h.commit()).rejects.toThrow("valid save receipt");
  await h.events.agent_end(stopped);
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
});

it("checks actual index reads and pagination before advancing an activity interval", async () => {
  const { checkedCoverage } = await import("@screenpipe-ext/workflow-catalog");
  const interval = {start:"2026-09-15T10:00:00Z",end:"2026-09-15T11:00:00Z",complete:true};
  const page = {tool:"search-content",query:{start_time:interval.start,end_time:interval.end},offset:0,count:2,total:3};
  expect(() => checkedCoverage([interval],[],[])).toThrow("activity index");
  expect(() => checkedCoverage([interval],[interval],[page])).toThrow("unread pages");
  expect(checkedCoverage([interval],[interval],[page,{...page,offset:2,count:1}])[0]).toMatchObject({method:"activity-index-and-targeted-sources"});
});
