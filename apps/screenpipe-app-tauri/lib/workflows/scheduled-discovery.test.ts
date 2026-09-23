// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { WORKFLOW_TASKS, stopWorkflowJob, ensureWorkflowTask, enableWorkflowTask, loadWorkflowTaskSetup, getWorkflowJob, startWorkflowJob, saveWorkflowCorrections, saveWorkflowFeedback, loadScheduledCatalog } from "./scheduled-discovery";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
vi.mock("@/lib/api", () => ({localFetch:vi.fn()}));
vi.mock("@/lib/workflows/rollout", () => ({requireWorkflowsRollout:vi.fn(),syncWorkflowsRollout:vi.fn().mockResolvedValue(undefined)}));
const fetchMock = vi.mocked(localFetch);
const response = (data:unknown,status=200) => new Response(JSON.stringify(data),{status});
const end = "2026-09-19T12:00:00Z";
let ws:any, executions:Record<string,any>, enabled:Map<string,boolean>, catalog:any;
beforeEach(() => {
  fetchMock.mockReset();
  ws = {cycle:{status:"running",end,finished:{}},drafts:{}};
  executions = {};
  enabled = new Map(WORKFLOW_TASKS.map(task=>[task,true]));
  catalog = {analyzedAt:"2026-09-18T12:00:00Z",checkedThrough:"2026-09-18T12:00:00Z"};
  fetchMock.mockImplementation(async (path,init)=>{
    const url=String(path);
    if(url.endsWith("/install")) return response({installed:false});
    if(url==="/workflows/catalog") return response(catalog);
    if(url==="/workflows/workspace") return response({revision:1,cycle:ws.cycle});
    if(url.startsWith("/workflows/workspace?")) return response({workspace:ws,ready:url.endsWith("workflow-review")});
    if(url==="/workflows/corrections") return response({success:true});
    const task = WORKFLOW_TASKS.find(task=>url.startsWith(`/pipes/${task}`));
    if(!task) return response({error:"Not installed"},404);
    if(url.endsWith("/enable")) {enabled.set(task,JSON.parse(String(init?.body)).enabled);return response({success:true});}
    if(url.endsWith("/stop")) return response({success:true});
    if(url.endsWith("/run")) return response({execution_id:24});
    if(url.includes("/executions?")) return response({data:executions[task]?[executions[task]]:[]});
    return response({data:{config:{enabled:enabled.get(task),title:task}}});
  });
});
describe("workflow agent workspace adapter",()=>{
  it("installs four templates without opting into background AI",async()=>{
    await ensureWorkflowTask();expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([path])=>String(path).endsWith("/install"))).toBe(true);
  });
  it("coalesces updates with any running agent",async()=>{
    executions["workflow-deepen"]={id:23,status:"running",started_at:end};
    expect(await startWorkflowJob()).toMatchObject({id:"workflow-deepen:23",status:"processing"});
    expect(fetchMock.mock.calls.some(([path])=>String(path).endsWith("/run"))).toBe(false);
  });
  it("starts or resumes a fixed request then runs ready review work",async()=>{
    expect(await startWorkflowJob()).toMatchObject({id:"workflow-review:24"});
    const calls=fetchMock.mock.calls.map(([path])=>String(path));
    expect(calls.indexOf("/workflows/workspace")).toBeLessThan(calls.indexOf("/pipes/workflow-review/run"));
  });
  it("resumes all ready agents without waiting for a previously acknowledged event",async()=>{
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(path,init)=>{
      if(String(path).startsWith("/workflows/workspace?")) return response({workspace:ws,ready:["workflow-discover","workflow-maintain"].some(task=>String(path).endsWith(task))});
      return original(path,init);
    });
    await startWorkflowJob();
    expect(fetchMock.mock.calls.filter(([path])=>String(path).endsWith("/run")).map(([path])=>path)).toEqual([
      "/pipes/workflow-discover/run","/pipes/workflow-maintain/run",
    ]);
  });
  it("tracks a scheduler execution that wins the manual-start race",async()=>{
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(path,init)=>{
      if(String(path).endsWith("/run")) {
        executions["workflow-review"]={id:25,status:"running",started_at:end};
        return response({error:"Pipe is already running"});
      }
      return original(path,init);
    });
    expect(await startWorkflowJob()).toMatchObject({id:"workflow-review:25"});
  });
  it("keeps start failures visible when no active execution was persisted",async()=>{
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(path,init)=>String(path).endsWith("/run")
      ? response({error:"Execution storage unavailable"}) : original(path,init));
    await expect(startWorkflowJob()).rejects.toThrow("Execution storage unavailable");
  });
  it("preserves a disabled role until explicit opt-in",async()=>{
    enabled.set("workflow-maintain",false);
    expect(await loadWorkflowTaskSetup()).toMatchObject({enabled:false});
    await expect(startWorkflowJob()).rejects.toThrow("Enable workflow tasks");
    await enableWorkflowTask();expect(await loadWorkflowTaskSetup()).toMatchObject({enabled:true});
  });
  it("stops this cycle before cancelling all roles, preserving schedule preferences",async()=>{
    enabled.set("workflow-maintain",false);
    const before=new Map(enabled);
    await stopWorkflowJob();
    expect(fetchMock.mock.calls[0][0]).toBe("/workflows/workspace");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({action:"pause",task:"workflow-discover"});
    expect(fetchMock.mock.calls.slice(1).map(([path])=>path)).toEqual(WORKFLOW_TASKS.map(t=>`/pipes/${t}/stop`));
    expect(enabled).toEqual(before);
  });
  it("attempts every cancellation even when one runner fails to stop",async()=>{
    const original=fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async(path,init)=>String(path)==="/pipes/workflow-discover/stop"
      ? response({error:"Runner unavailable"},500) : original(path,init));
    await expect(stopWorkflowJob()).rejects.toThrow("Runner unavailable");
    expect(fetchMock.mock.calls.filter(([path])=>String(path).endsWith("/stop"))).toHaveLength(4);
    expect([...enabled.values()].every(Boolean)).toBe(true);
  });
  it("does not change tasks when persisting the pause fails",async()=>{
    fetchMock.mockResolvedValueOnce(response({error:"Save failed"},500));
    await expect(stopWorkflowJob()).rejects.toThrow("Save failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reports a persisted stop after restart instead of an old agent failure",async()=>{
    ws.cycle.status="paused";
    executions["workflow-review"]={id:26,status:"cancelled",started_at:end};
    expect(await getWorkflowJob("workflow-review:26")).toMatchObject({status:"incomplete",message:"Update stopped. Resume to continue from saved progress."});
  });
  it("never treats an old catalog as completion of a fresh request",async()=>{
    ws.cycle.status="complete";
    expect(await getWorkflowJob("old-job")).toMatchObject({status:"incomplete"});
  });
  it("accepts a verified no-change finish for the exact requested end",async()=>{
    ws.cycle.status="complete";catalog={analyzedAt:end,checkedThrough:end,changes:{created:0,updated:0}};
    expect(await getWorkflowJob("review:25")).toMatchObject({status:"complete",result:{changes:{created:0,updated:0}}});
  });
  it("partial publication remains incomplete until all drafts are resolved",async()=>{
    catalog={analyzedAt:end,checkedThrough:end,changes:{created:1,updated:0}};
    ws.drafts={pending:{status:"open"},published:{status:"published"}};
    expect(await getWorkflowJob("review:25")).toMatchObject({status:"incomplete",message:expect.stringContaining("1 workflow draft")});
  });
  it.each(["missing_output","timed_out","interrupted"])("surfaces %s even after an unrelated idle agent completes",async error=>{
    executions["workflow-discover"]={id:30,status:error==="timed_out"?error:"failed",error_type:error,started_at:end};
    executions["workflow-maintain"]={id:31,status:"completed",started_at:end};
    expect(await getWorkflowJob("workflow-maintain:31")).toMatchObject({id:"workflow-discover:30",status:error==="interrupted"?"incomplete":"failed"});
  });
  it("does not resurrect failures from an older request",async()=>{
    executions["workflow-discover"]={id:20,status:"failed",started_at:"2026-09-18T12:00:00Z"};
    expect(await getWorkflowJob("legacy:20")).toMatchObject({status:"incomplete"});
  });
  it("saves only human corrections, never a stale full catalog",async()=>{
    catalog={analyzedAt:end,analysis:{workflows:[{id:"wf-a",title:"Changed elsewhere",userCorrection:"Old"}]}};
    await saveWorkflowCorrections({...catalog,analysis:{workflows:[{id:"wf-a",title:"Stale",userCorrection:"New"}]}});
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({id:"wf-a",correction:"New"});
  });
  it("saves feedback without starting an agent",async()=>{
    await saveWorkflowFeedback({...fixtureWorkflowAnalysis.analysis.workflows[0],id:"wf-a"},"Use Attio");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/workflows/corrections");
  });
  it("rejects missing identity and propagates failed saves",async()=>{
    const workflow={...fixtureWorkflowAnalysis.analysis.workflows[0],id:undefined};
    await expect(saveWorkflowFeedback(workflow,"Feedback")).rejects.toThrow("Refresh");
    fetchMock.mockResolvedValueOnce(response({error:"Workflow no longer exists"},404));
    await expect(saveWorkflowFeedback({...workflow,id:"deleted"},"Feedback")).rejects.toThrow("no longer exists");
  });
});


describe("catalog request lifecycle", () => {
  it("bounds stalled requests and classifies timeouts for reconnect", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const result = loadScheduledCatalog();
      const rejected = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("propagates cancellation and cleans up its deadline", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_path, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      const controller = new AbortController();
      const result = loadScheduledCatalog(controller.signal);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

it("uses the persisted update cycle across agent handoffs, resume and completion", async () => {
  ws.cycle.id = "cycle-a";
  executions["workflow-discover"] = { id: 1, status: "running", started_at: end };
  expect(await getWorkflowJob("workflow-discover:1")).toMatchObject({ id: "workflow-discover:1", cycleId: "cycle-a" });
  executions["workflow-discover"].status = "completed";
  executions["workflow-review"] = { id: 2, status: "running", started_at: end };
  expect(await getWorkflowJob("workflow-discover:1")).toMatchObject({ id: "workflow-review:2", cycleId: "cycle-a" });
  executions["workflow-review"].status = "completed";
  ws.cycle.status = "paused";
  expect(await getWorkflowJob("workflow-review:2")).toMatchObject({ status: "incomplete", cycleId: "cycle-a" });
  expect(await startWorkflowJob()).toMatchObject({ cycleId: "cycle-a" });
  ws.cycle.status = "complete";
  catalog = { analyzedAt: end, checkedThrough: end };
  expect(await getWorkflowJob("workflow-review:2")).toMatchObject({ status: "complete", cycleId: "cycle-a" });
  ws.cycle.id = "cycle-b";
  expect(await getWorkflowJob("workflow-review:2")).toMatchObject({ cycleId: "cycle-b" });
});
