// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { ensureWorkflowTask, getWorkflowJob, startWorkflowJob, saveWorkflowCorrections } from "./scheduled-discovery";
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
  it("does not mistake an old saved catalog for a successful new run", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: { id: 24, status: "completed", started_at: "2026-09-15T12:00:00Z" } }))
      .mockResolvedValueOnce(response({ analyzedAt: "2026-09-14T12:00:00Z", checkedThrough: "2026-09-14T12:00:00Z" }));
    expect(await getWorkflowJob("24")).toMatchObject({ status: "failed" });
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
});
