// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { ensureWorkflowTask, enableWorkflowTask, loadWorkflowTaskSetup, getWorkflowJob, startWorkflowJob, saveWorkflowCorrections, saveWorkflowFeedback } from "./scheduled-discovery";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import { requireInspectedFrames } from "@screenpipe-ext/workflow-catalog";

vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
const fetchMock = vi.mocked(localFetch);
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
beforeEach(() => fetchMock.mockReset());

describe("workflow scheduled-task adapter", () => {
  it("installs through the existing bundled task endpoint without re-enabling a paused task", async () => {
    fetchMock.mockResolvedValue(response({ installed: false }));
    await ensureWorkflowTask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/pipes/bundled/workflow-discovery/install");
  });
  it("coalesces Update now with an already tracked execution", async () => {
    fetchMock.mockResolvedValueOnce(response({ installed: false })).mockResolvedValueOnce(response({ data: [{ id: 23, status: "running" }] }));
    expect(await startWorkflowJob()).toMatchObject({ id: "23", status: "processing" });
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/run"))).toBe(false);
  });
  it.each([{ installed: true }, { installed: false, enabled_override: null }, { installed: false, enabled_override: false }])("never enables on entry: %j", async (state) => {
    fetchMock.mockResolvedValueOnce(response(state));
    await ensureWorkflowTask();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reads the actual enabled state and schedule", async () => {
    fetchMock.mockResolvedValueOnce(response({ installed: false })).mockResolvedValueOnce(response({ data: { config: { enabled: false, title: "My discovery", schedule: "every 48h" } } }));
    expect(await loadWorkflowTaskSetup()).toEqual({ enabled: false, title: "My discovery", schedule: "every 48h" });
    expect(fetchMock).toHaveBeenLastCalledWith("/pipes/workflow-discovery", undefined);
  });
  it("enables only through the explicit action without starting a second runner", async () => {
    fetchMock.mockResolvedValueOnce(response({ installed: false })).mockResolvedValueOnce(response({ success: true }));
    await enableWorkflowTask();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/pipes/bundled/workflow-discovery/install", "/pipes/workflow-discovery/enable"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ enabled: true });
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
  it("saves only the edited correction, never a stale full catalog", async () => {
    const prior = { analyzedAt: "2026-09-15T12:00:00Z", analysis: { workflows: [{ id: "wf-a", title: "Updated elsewhere", userCorrection: "Old" }] } };
    fetchMock.mockResolvedValueOnce(response(prior)).mockResolvedValueOnce(response({ success: true }));
    await saveWorkflowCorrections({ ...prior, analysis: { workflows: [{ id: "wf-a", title: "Stale title", userCorrection: "New" }] } } as any);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ id: "wf-a", correction: "New" });
  });
  it("requires inspecting selected frames, while allowing text-only evidence", () => {
    expect(() => requireInspectedFrames([{ stages: [{ screenshotFrameId: 7 }] }], new Set())).toThrow(/Inspect/);
    expect(() => requireInspectedFrames([{ stages: [{ screenshotFrameId: 7 }] }], new Set([7]))).not.toThrow();
    expect(() => requireInspectedFrames([{ stages: [{}] }], new Set())).not.toThrow();
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
