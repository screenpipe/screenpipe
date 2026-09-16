// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect, vi, beforeEach, afterEach } from "vitest";
const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  open: vi.fn(),
  run: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  dialog: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { getCloudToken: mocks.token },
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));
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
beforeEach(() => {vi.clearAllMocks(); mocks.token.mockResolvedValue("test-token"); vi.stubGlobal("fetch",vi.fn(async()=>Response.json({allowed:true})));});
afterEach(()=>vi.unstubAllGlobals());
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

it("uploads only reviewed SOP text with existing authentication", async () => {
  mocks.token.mockResolvedValue("test-token");
  const id = "12345678-1234-1234-1234-123456789abc";
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id }), { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await desktopGuides.openWeb!(guide as any);
    const request = fetcher.mock.calls[0][1];
    expect(request.headers.Authorization).toBe("Bearer test-token");
    const payload = JSON.parse(request.body);
    expect(Object.keys(payload).sort()).toEqual([
      "content",
      "title",
      "workflowKey",
    ]);
    expect(payload.content).toContain("Read sources");
    expect(mocks.open).toHaveBeenCalledWith(
      `https://screenpipe.com/sops/${id}`,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
it("keeps the local draft when hosting is unavailable", async () => {
  mocks.token.mockResolvedValue("test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("", { status: 503 })),
  );
  try {
    await expect(desktopGuides.openWeb!(guide as any)).rejects.toThrow(
      "saved on this device",
    );
    expect(mocks.open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([403,429,503])("does not start generation when access fails (%s)",async(status)=>{
 vi.stubGlobal("fetch",vi.fn(async()=>Response.json({error:"Access unavailable"},{status})));
 await expect(desktopGuides.generate(workflow,new AbortController().signal,()=>{})).rejects.toThrow("Access unavailable");
 expect(mocks.run).not.toHaveBeenCalled();
});
