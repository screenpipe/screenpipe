// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import workflowCatalog, { validateStageHandoff } from "@screenpipe-ext/workflow-catalog";
import contextPruning from "@screenpipe-ext/context-pruning";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directories: string[] = [];
const priorExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = priorExitCode; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stopped = { messages: [{ role: "assistant", stopReason: "stop" }] };
async function harness(stage = 4, items: any[] = []) {
  const events: Record<string, (event?: any, ctx?: any) => Promise<any>> = {};
  const tools: Record<string, any> = {};
  const pi = { on: (name: string, run: any) => { events[name] = run; }, registerTool: (tool: any) => { tools[tool.name] = tool; }, setActiveTools: vi.fn(), sendMessage: vi.fn() };
  workflowCatalog(pi as any);
  const parent = mkdtempSync(join(tmpdir(), "workflow-save-test-"));
  directories.push(parent);
  const cwd = join(parent, ["workflow-activity", "workflow-patterns", "workflow-procedures", "workflow-timing", "workflow-discovery"][stage]); mkdirSync(cwd);
  writeFileSync(join(cwd, ".screenpipe-permissions.json"), JSON.stringify({ pipe_token: "fixture", api_base: "http://127.0.0.1:3030" }));
  await events.session_start({}, { cwd });
  const context = { stage, input: {items, coverage: []}, revision: 3, now: "2026-09-15T12:00:00Z", ready: true, inputRevision: 2, checkedThrough: "2026-09-15T12:00:00Z" };
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
it("keeps small stage context inline", async () => {
  const h = await harness(3, [{candidateId:"receipt", workflowId:"wf-receipt"}]);
  const output = await h.tools.workflow_context.execute("context", {});
  expect(JSON.parse(output.content[0].text).pipeline.input.items[0].candidateId).toBe("receipt");
  expect(JSON.parse(output.content[0].text).contextFile).toBeUndefined();
});
it("preserves oversized handoffs through the real result guard and paginated read path", async () => {
  const items = [
    {candidateId:"receipt", workflowId:"wf-receipt", sources:Array.from({length:500}, (_,i) => ({quote:"Fictional invoice evidence " + i}))},
    {candidateId:"final-candidate", workflowId:"wf-final", concreteSteps:["Retain this final procedure"], timingRuns:[]},
  ];
  const h = await harness(3, items);
  const hooks: Record<string, any> = {};
  contextPruning({on:(name:string, handler:any) => { hooks[name] = handler; }} as any);
  // Reproduce the original loss of the stage input at the shared 30K guard.
  const oversized = {content:[{type:"text",text:JSON.stringify({...h.context,pipeline:h.context})}]};
  expect((await hooks.tool_result({toolName:"workflow_context",...oversized})).isError).toBe(true);
  const output = await h.tools.workflow_context.execute("context", {});
  expect(await hooks.tool_result({toolName:"workflow_context",...output})).toBeUndefined();
  const receipt = JSON.parse(output.content[0].text);
  expect(receipt).toMatchObject({stage:3,ready:true,inputCount:2});
  const full = readFileSync(receipt.contextFile,"utf8");
  expect(JSON.parse(full).pipeline.input.items).toEqual(items);
  expect(JSON.parse(full).outputContract.saveTool).toBe("workflow_stage_commit");
  if (process.platform !== "win32") expect(statSync(receipt.contextFile).mode & 0o777).toBe(0o600);
  expect(await hooks.tool_result({toolName:"read",content:[{type:"text",text:full}]})).toBeUndefined();
  // A refreshed context replaces the snapshot and retains the latest input.
  h.context.input.items[1].concreteSteps = ["Updated procedure"];
  await h.tools.workflow_context.execute("refresh", {});
  expect(JSON.parse(readFileSync(receipt.contextFile,"utf8")).pipeline.input.items[1].concreteSteps).toEqual(["Updated procedure"]);
  await expect(h.tools.workflow_stage_commit.execute("save",{items:[],coverage:[]})).rejects.toThrow("dropped");
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

it("preserves every candidate through timing, even when one occurrence cannot be measured", () => {
  const known = {candidateId: "invoice", workflowId: "wf-invoice", concreteSteps: ["Save receipt"], sources: [{timestamp:"2026-09-16T10:00:00Z",app:"Receipts",quote:"Receipt saved"}]};
  const unknown = {candidateId: "follow-up", workflowId: "wf-follow-up", concreteSteps: ["Draft follow-up"]};
  const pipeline = {stage:3,input:{items:[known,unknown]}};
  const measured = {...known,timingRuns:[{start:{timestamp:"2026-09-16T09:58:00Z",app:"Receipts",quote:"Start receipt"},end:known.sources[0],summary:"Save one receipt"}]};
  expect(() => validateStageHandoff(pipeline,[measured])).toThrow("dropped");
  expect(() => validateStageHandoff(pipeline,[{candidateId:"recent-meeting",timingRuns:[],timingNote:"Start unknown"}])).toThrow("upstream");
  expect(() => validateStageHandoff(pipeline,[known,unknown])).toThrow("timingRuns");
  expect(() => validateStageHandoff(pipeline,[measured,{...unknown,timingRuns:[],timingNote:"No completed outcome captured"}])).not.toThrow();
});
it("rejects identity changes and duplicates in procedure enrichment", () => {
  const input = {candidateId:"receipt",workflowId:"wf-receipt"};
  const pipeline = {stage:2,input:{items:[input]}};
  expect(() => validateStageHandoff(pipeline,[{...input,workflowId:"wf-meeting"}])).toThrow("workflow IDs");
  expect(() => validateStageHandoff(pipeline,[input,input])).toThrow("one item");
  expect(() => validateStageHandoff(pipeline,[{...input,exclusionReason:"Only an unread request"}])).not.toThrow();
});

it("rejects lost handoff data before writing and preserves the backend checkpoint receipt", async () => {
  const candidate = {candidateId:"receipt",workflowId:"wf-receipt",stages:[{name:"Save receipt"}]};
  const h = await harness(3,[candidate]);
  await expect(h.tools.workflow_stage_commit.execute("save",{items:[],coverage:[]})).rejects.toThrow("dropped");
  expect(h.fetch).toHaveBeenCalledTimes(2);
  const items = [{...candidate,timingRuns:[],timingNote:"Start not captured"}];
  h.fetch.mockResolvedValueOnce(Response.json({revision:4,checkedThrough:"2026-09-14T12:00:00Z"}));
  await expect(h.tools.workflow_stage_commit.execute("save",{items,coverage:[]})).rejects.toThrow("save receipt");
  h.fetch.mockResolvedValueOnce(Response.json({revision:4,checkedThrough:h.context.checkedThrough}));
  await expect(h.tools.workflow_stage_commit.execute("save",{items,coverage:[]})).resolves.toBeDefined();
  expect(JSON.parse(h.fetch.mock.calls.at(-1)?.[1].body).items[0]).toMatchObject(candidate);
});
