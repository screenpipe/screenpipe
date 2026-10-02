// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import { exportGuideHtml } from "../../../../packages/workflows-ui/src/guide-images";
import { guideKey, type WorkflowGuide } from "../../../../packages/workflows-ui/src/guide";
const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
const capture = { frameId: 42, timestamp: "2026-09-22T10:00:00Z", app: "Notes", visualVerified: true, matchDistanceSeconds: 0, dataUrl: "" };
workflow.stages[0].screenshot = capture;
workflow.stages[0].screenshots = [capture];
const guide: WorkflowGuide = { version: 1, workflowKey: guideKey(workflow), sourceRevision: workflow.revision ?? 0, title: "Read notes", summary: "", prerequisites: [], exceptions: [], completion: [], questions: [], steps: [{ title: "Read", instruction: "Read the brief", expectedResult: "", sourceStage: 0, includeImage: true }] };
const revoke = vi.fn();
beforeEach(() => { revoke.mockClear(); Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true }); });
it("copies pixels only into an explicit export and releases the temporary image", async () => {
  const load = vi.fn().mockResolvedValue({ ...capture, dataUrl: "blob:export" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => new Blob(["pixel"], { type: "image/png" }) }));
  try {
    const html = await exportGuideHtml(guide, workflow, true, load);
    expect(html).toContain("data:image/png;base64,");
    expect(load).toHaveBeenCalledWith(capture.timestamp, capture.app, expect.any(AbortSignal), 42);
    expect(capture.dataUrl).toBe("");
    expect(revoke).toHaveBeenCalledWith("blob:export");
  } finally { vi.unstubAllGlobals(); }
});
it("never fetches images for text-only exports or a stale SOP", async () => {
  const load = vi.fn();
  await exportGuideHtml(guide, workflow, false, load);
  await exportGuideHtml({ ...guide, sourceRevision: 999 }, workflow, true, load);
  expect(load).not.toHaveBeenCalled();
});
it("reports a missing selected capture instead of silently exporting an incomplete guide", async () => {
  await expect(exportGuideHtml(guide, workflow, true, vi.fn().mockResolvedValue(null))).rejects.toThrow("no longer available");
});

it("preserves analysis and nested frame references while omitting copied pixels", async () => {
  const { serializeWorkflowData } = await import("../../../../packages/workflows-ui/src/screenshots");
  const saved = { quality: { grade: "strong", screenshotCount: 1 }, screenshot: { ...capture, dataUrl: "data:image/png;base64,AAAA" }, drafts: [{ screenshot: { ...capture, dataUrl: "data:image/png;base64,BBBB" } }] };
  const restored = JSON.parse(serializeWorkflowData(saved));
  expect(restored.quality).toEqual(saved.quality);
  expect(restored.screenshot).toEqual(capture);
  expect(restored.drafts[0].screenshot).toEqual(capture);
  expect(saved.screenshot.dataUrl).toContain("AAAA");
});

it("does not retrieve a screenshot explicitly excluded by the editor", async () => {
  const unreviewed = structuredClone(workflow);
  unreviewed.stages[0].screenshot!.visualVerified = false;
  unreviewed.stages[0].screenshots![0].visualVerified = false;
  const load = vi.fn();
  await exportGuideHtml({ ...guide, steps: guide.steps.map(step => ({ ...step, imageExcluded: true })) }, unreviewed, true, load);
  expect(load).not.toHaveBeenCalled();
});

it("preserves selected screenshot order when a stage has multiple captures", async () => {
  const multiple = structuredClone(workflow);
  const second = { ...capture, frameId: 43, timestamp: "2026-09-22T10:01:00Z" };
  multiple.stages[0].screenshots = [capture, second];
  const load = vi.fn().mockResolvedValue({ ...capture, dataUrl: "blob:export" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ blob: async () => new Blob(["pixel"], { type: "image/png" }) }));
  try {
    expect(await exportGuideHtml(guide, multiple, true, load)).toContain("data:image/png;base64,");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(capture.timestamp, capture.app, expect.any(AbortSignal), 42);
    expect(multiple.stages[0].screenshots).toEqual([capture, second]);
  } finally { vi.unstubAllGlobals(); }
});
