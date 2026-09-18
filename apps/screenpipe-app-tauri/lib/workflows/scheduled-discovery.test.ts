// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { WORKFLOW_TASKS, stopWorkflowJob, ensureWorkflowTask, enableWorkflowTask, loadWorkflowTaskSetup, getWorkflowJob, startWorkflowJob, saveWorkflowCorrections, saveWorkflowFeedback } from "./scheduled-discovery";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
const fetchMock = vi.mocked(localFetch);
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
beforeEach(() => fetchMock.mockReset());

describe("workflow scheduled-task adapter", () => {
  function pipelineMock(running = false) {
    const enabled = new Map(WORKFLOW_TASKS.map(name => [name, true]));
    fetchMock.mockImplementation(async (path, init) => {
      const url = String(path);
      if (url.includes("/install")) return response({ installed: false });
      const task = WORKFLOW_TASKS.find(name => url.startsWith(`/pipes/${name}`))!;
      if (url.endsWith("/enable")) { enabled.set(task, JSON.parse(String(init?.body)).enabled); return response({ success: true }); }
      if (url.includes("/executions?")) return response({ data: running && task === "workflow-procedures" ? [{ id:23, status:"running", started_at:"2026-09-15T12:00:00Z" }] : [] });
      if (url.endsWith("/run")) return response({ execution_id:24 });
      if (url.endsWith("/stop")) return response({ success:true });
      if (url.includes("/workflows/pipeline")) return response({ ready:url.endsWith("workflow-timing") });
      return response({ data:{config:{ enabled:enabled.get(task), title:task, schedule:"every 24h" }} });
    });
    return enabled;
  }
  it("installs all templates without enabling them", async () => {
    pipelineMock();
    await ensureWorkflowTask();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.every(([path]) => String(path).endsWith("/install"))).toBe(true);
  });
  it("coalesces Update now with any running enrichment stage", async () => {
    pipelineMock(true);
    expect(await startWorkflowJob()).toMatchObject({ id:"workflow-procedures:23", status:"processing" });
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/run"))).toBe(false);
  });
  it("resumes pending downstream work before starting another history scan", async () => {
    pipelineMock();
    expect(await startWorkflowJob()).toMatchObject({id:"workflow-timing:24"});
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/pipes/workflow-timing/run");
  });
  it("keeps a partially disabled group paused until explicit consent", async () => {
    const enabled = pipelineMock(); enabled.set("workflow-patterns",false);
    expect(await loadWorkflowTaskSetup()).toMatchObject({enabled:false});
    await expect(startWorkflowJob()).rejects.toThrow("Enable workflow tasks");
    await enableWorkflowTask();
    expect(await loadWorkflowTaskSetup()).toMatchObject({enabled:true});
  });
  it("pauses every dependency before stopping running agents", async () => {
    pipelineMock(); await stopWorkflowJob();
    expect(fetchMock.mock.calls.slice(0,5).every(([path]) => String(path).endsWith("/enable"))).toBe(true);
    expect(fetchMock.mock.calls.slice(5).every(([path]) => String(path).endsWith("/stop"))).toBe(true);
  });
  it("does not mistake an old saved catalog for a successful new run", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { id: 24, status: "completed", started_at: "2026-09-15T12:00:00Z" } }))
      .mockResolvedValueOnce(response({ analyzedAt: "2026-09-14T12:00:00Z", checkedThrough: "2026-09-14T12:00:00Z" }));
    expect(await getWorkflowJob("24")).toMatchObject({ status: "failed" });
  });
  it("accepts a current no-change checkpoint and reports its zero changes", async () => {
    const now = "2026-09-15T12:00:00Z";
    fetchMock.mockResolvedValueOnce(response({ data: { id: 25, status: "completed", started_at: now } }))
      .mockResolvedValueOnce(response({ analyzedAt: now, checkedThrough: now, changes: { created: 0, updated: 0 } }));
    expect(await getWorkflowJob("25")).toMatchObject({ status: "complete", result: { changes: { created: 0, updated: 0 } } });
  });
  it("shows a missing-save failure without loading the prior run's success counts", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { id: 25, status: "failed", error_type: "missing_output" } }));
    expect(await getWorkflowJob("25")).toMatchObject({ status: "failed", message: expect.stringContaining("previous workflows") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("preserves a successful legacy receipt before the new tasks are enabled", async () => {
    const now = "2026-09-15T12:00:00Z";
    fetchMock.mockImplementation(async path => {
      const url = String(path);
      if (url.includes("/executions?")) return response({data:[]});
      if (url.includes("/executions/")) return response({data:{id:27,status:"completed",started_at:now}});
      if (url.includes("/pipeline")) return response({inputRevision:0,blockedReason:"Enable workflow-activity"});
      return response({analyzedAt:now,checkedThrough:now,changes:{created:0,updated:0}});
    });
    expect(await getWorkflowJob("workflow-discovery:27")).toMatchObject({status:"complete",result:{changes:{created:0,updated:0}}});
  });
  it("allows scheduler handoff time, then offers to resume without a false save failure", async () => {
    const finished = new Date(Date.now() - 45_000).toISOString();
    const execution = {id:48,status:"completed",started_at:finished,finished_at:finished};
    fetchMock.mockImplementation(async path => {
      const url = String(path);
      if (url.includes("/executions/")) return response({data:execution});
      if (url.includes("/executions?")) return response({data:url.includes("workflow-activity")?[execution]:[]});
      if (url.includes("/pipeline")) return response({inputRevision:0,upToDate:false,blockedReason:null});
      return response({analyzedAt:"2026-09-14T12:00:00Z",pipelineRevision:0});
    });
    expect(await getWorkflowJob("workflow-activity:48")).toMatchObject({status:"queued"});
    execution.finished_at = new Date(Date.now() - 120_000).toISOString();
    expect(await getWorkflowJob("workflow-activity:48")).toMatchObject({status:"incomplete",message:expect.stringContaining("Resume")});
  });
  it("treats a timed-out task as a terminal failure instead of waiting forever", async () => {
    fetchMock.mockResolvedValueOnce(response({data:{id:48,status:"timed_out"}}));
    expect(await getWorkflowJob("48")).toMatchObject({status:"failed"});
  });
  it("saves only the edited correction, never a stale full catalog", async () => {
    const prior = { analyzedAt: "2026-09-15T12:00:00Z", analysis: { workflows: [{ id: "wf-a", title: "Updated elsewhere", userCorrection: "Old" }] } };
    fetchMock.mockResolvedValueOnce(response(prior)).mockResolvedValueOnce(response({ success: true }));
    await saveWorkflowCorrections({ ...prior, analysis: { workflows: [{ id: "wf-a", title: "Stale title", userCorrection: "New" }] } } as any);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ id: "wf-a", correction: "New" });
  });
  it("keeps an activity failure visible after downstream tasks finish without input", async () => {
    const activity = {id:30,status:"failed",error_type:"missing_output",started_at:"2026-09-15T10:00:00Z"};
    const timing = {id:31,status:"completed",started_at:"2026-09-15T10:01:00Z"};
    fetchMock.mockImplementation(async path => {
      const url = String(path);
      if (url.includes("/executions/")) return response({data:timing});
      if (url.includes("/executions?")) return response({data:url.includes("workflow-activity")?[activity]:url.includes("workflow-timing")?[timing]:[]});
      return response({inputRevision:0});
    });
    expect(await getWorkflowJob("workflow-timing:31")).toMatchObject({id:"workflow-activity:30",status:"failed",message:expect.stringContaining("previous workflows")});
  });
  it("saves feedback through the authenticated correction endpoint without starting a task", async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await saveWorkflowFeedback({ ...fixtureWorkflowAnalysis.analysis.workflows[0], id: "wf-selected" }, "Use Attio.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/workflows/corrections", expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "wf-selected", correction: "Use Attio." }) }));
  });
  it("rejects missing workflow identity and reports server save failures", async () => {
    const workflow = { ...fixtureWorkflowAnalysis.analysis.workflows[0], id: undefined };
    await expect(saveWorkflowFeedback(workflow, "Use Attio.")).rejects.toThrow("Refresh this workflow");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Workflow no longer exists" }), { status: 404 }));
    await expect(saveWorkflowFeedback({ ...workflow, id: "deleted" }, "Use Attio.")).rejects.toThrow("Workflow no longer exists");
  });
});

vi.mock("@/lib/workflows/rollout", () => ({ useWorkflowsRolloutEnabled: () => true, requireWorkflowsRollout: vi.fn() }));

it("offers resume for a restart interruption, including executions stored as failed", async () => {
  fetchMock.mockResolvedValueOnce(response({data:{id:51,status:"failed",error_type:"interrupted",error_message:"interrupted by system restart"}}));
  expect(await getWorkflowJob("51")).toMatchObject({status:"incomplete",message:expect.stringContaining("Screenpipe restarted")});
});
