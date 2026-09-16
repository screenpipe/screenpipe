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
  const commit = () => tools.workflow_commit.execute("save", { workflows: [] });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { events, pi, fetch, commit, stderr, context, tools };
}
it("recovers a rejected commit through Pi follow-up and accepts a no-change receipt", async () => {
  const h = await harness();
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
it("does not retry an aborted or provider-error turn", async () => {
  const h = await harness();
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
  h.fetch.mockResolvedValueOnce(Response.json({}));
  await expect(h.commit()).rejects.toThrow("valid save receipt");
  await h.events.agent_end(stopped);
  expect(h.pi.sendMessage).toHaveBeenCalledOnce();
});

it("adds workflow save tools without replacing normal harness tools", async () => {
  const h = await harness();
  expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  expect(h.events.tool_call).toBeUndefined();
  expect(h.events.tool_result).toBeUndefined();
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it("uses the catalog revision rather than the pipeline revision when saving", async () => {
  const h = await harness();
  h.fetch.mockResolvedValueOnce(Response.json({revision:4,checkedThrough:h.context.now}));
  await h.commit();
  expect(JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body)).toMatchObject({expected_revision:3,pipeline_revision:2,checked_through:h.context.now,workflows:[]});
});

it("does not checkpoint an unresolved screenshot verification failure", async () => {
  const h = await harness();
  h.fetch.mockResolvedValueOnce(Response.json({error:"Recorder unavailable"},{status:503}));
  await expect(h.tools.workflow_inspect_frame.execute("inspect",{frame_id:7})).rejects.toThrow("Recorder unavailable");
  await expect(h.commit()).rejects.toThrow("Screenshot verification failed");
  h.fetch.mockResolvedValueOnce(Response.json({frame_id:7}));
  h.fetch.mockResolvedValueOnce(new Response(new Uint8Array([1]),{headers:{"content-type":"image/png"}}));
  await h.tools.workflow_inspect_frame.execute("retry",{frame_id:7});
  h.fetch.mockResolvedValueOnce(Response.json({revision:4,checkedThrough:h.context.now}));
  await expect(h.commit()).resolves.toBeDefined();
});


it("allows a missing capture to be omitted without blocking a supported update", async () => {
  const h = await harness();
  h.fetch.mockResolvedValueOnce(Response.json({error:"Capture was deleted"},{status:404}));
  await expect(h.tools.workflow_inspect_frame.execute("inspect",{frame_id:7})).rejects.toThrow("Capture was deleted");
  h.fetch.mockResolvedValueOnce(Response.json({revision:4,checkedThrough:h.context.now}));
  await expect(h.commit()).resolves.toBeDefined();
});
