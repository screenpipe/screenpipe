// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  dialog: vi.fn(),
  write: vi.fn(),
}));
vi.mock("./agent-runner", () => ({ runWorkflowAgent: mocks.run }));
vi.mock("./assistant", () => ({
  assistantProviderConfig: { provider: "screenpipe-cloud", model: "auto" },
  ASSISTANT_TOOLS: ["search-content"],
}));
vi.mock("./disk-storage", () => ({
  loadGuideFromDisk: mocks.load,
  saveGuideToDisk: mocks.save,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.dialog }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.write }));
import { desktopGuides } from "./guides";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
const guide = {
  version: 1,
  workflowKey: workflow.id || workflow.title,
  sourceRevision: workflow.revision ?? 0,
  title: "Guide",
  summary: "",
  prerequisites: [],
  steps: [
    {
      title: "Collect",
      instruction: "Read sources",
      expectedResult: "",
      sourceStage: 0,
      includeImage: false,
    },
  ],
  exceptions: [],
  completion: [],
  questions: [],
};
beforeEach(() => vi.clearAllMocks());
it("uses the shared agent runner and validates its output", async () => {
  mocks.run.mockResolvedValue(JSON.stringify(guide));
  const signal = new AbortController().signal;
  expect(await desktopGuides.generate(workflow, signal, () => {})).toEqual(
    guide,
  );
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "guide",
      signal,
      config: expect.objectContaining({ provider: "screenpipe-cloud" }),
    }),
  );
  mocks.run.mockResolvedValue(
    JSON.stringify({ ...guide, workflowKey: "wrong" }),
  );
  await expect(
    desktopGuides.generate(workflow, signal, () => {}),
  ).rejects.toThrow();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("does not write when the native export dialog is cancelled", async () => {
  mocks.dialog.mockResolvedValue(null);
  expect(await desktopGuides.export("html", "Title")).toBe(false);
  expect(mocks.write).not.toHaveBeenCalled();
  mocks.dialog.mockResolvedValue("/selected/guide.html");
  expect(await desktopGuides.export("html", "Title")).toBe(true);
  expect(mocks.write).toHaveBeenCalledWith("/selected/guide.html", "html");
});
