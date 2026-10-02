// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async (path: string) => files.has(path)),
  mkdir: vi.fn(async () => {}),
  readTextFile: vi.fn(async (path: string) => files.get(path)),
  writeTextFile: vi.fn(async (path: string, text: string) => {
    files.set(path, text);
  }),
  remove: vi.fn(async (path: string) => {
    files.delete(path);
  }),
  rename: vi.fn(async (old: string, next: string) => {
    if (!files.has(old)) throw new Error("Missing file");
    files.set(next, files.get(old)!);
    files.delete(old);
  }),
}));
import {
  loadGuideFromDisk,
  saveGuideToDisk,
  resetWorkflowDiskStorageForTests,
} from "./disk-storage";
import type { WorkflowGuide } from "@screenpipe/workflows-ui";
const guide: WorkflowGuide = {
  version: 1,
  workflowKey: "research",
  sourceRevision: 1,
  title: "Research",
  summary: "",
  prerequisites: [],
  steps: [
    {
      title: "Read",
      instruction: "Read the brief.",
      expectedResult: "",
      sourceStage: null,
      includeImage: false,
    },
  ],
  exceptions: [],
  completion: [],
  questions: [],
};
beforeEach(() => {
  files.clear();
  resetWorkflowDiskStorageForTests();
});
it("serializes concurrent edits without dropping another workflow", async () => {
  await Promise.all([
    saveGuideToDisk(guide),
    saveGuideToDisk({ ...guide, workflowKey: "second" }),
    saveGuideToDisk({ ...guide, title: "Updated" }),
  ]);
  expect((await loadGuideFromDisk("research"))?.title).toBe("Updated");
  expect((await loadGuideFromDisk("second"))?.title).toBe("Research");
  expect(await loadGuideFromDisk("__proto__")).toBeNull();
});
it("recovers the backup when the primary is corrupt", async () => {
  files.set("workflows/guides.json", "broken");
  files.set(
    "workflows/guides.backup.json",
    JSON.stringify({ research: guide }),
  );
  expect(await loadGuideFromDisk("research")).toEqual(guide);
});
it("preserves unreadable drafts instead of replacing them", async () => {
  files.set("workflows/guides.json", "broken");
  files.set("workflows/guides.backup.json", "also broken");
  await expect(saveGuideToDisk(guide)).rejects.toThrow("unreadable");
  expect([...files.values()]).toEqual(["broken", "also broken"]);
});

it("keeps screenshot review through disk validation and backup recovery", async () => {
  const reviewed = structuredClone(guide);
  reviewed.steps[0] = {
    ...reviewed.steps[0],
    sourceStage: 0,
    includeImage: true,
    imageReview: { frameId: 3090, timestamp: "2026-09-11T10:00:00Z" },
  };
  await saveGuideToDisk(reviewed);
  expect(await loadGuideFromDisk("research")).toEqual(reviewed);
  await saveGuideToDisk({ ...reviewed, title: "Updated" });
  files.set("workflows/guides.json", "broken");
  expect(await loadGuideFromDisk("research")).toEqual(reviewed);
});

it("persists video edits alongside the SOP through reload", async () => {
  const video = { version: 1 as const, sourceHash: "abc", scenes: [{ id: "section-0", title: "Video title", narration: "Shorter narration.", includeImage: false }] };
  await saveGuideToDisk({ ...guide, video });
  resetWorkflowDiskStorageForTests();
  const loaded = await loadGuideFromDisk(guide.workflowKey);
  expect(loaded?.video).toEqual(video);
  expect(loaded?.steps).toEqual(guide.steps);
});

it("reopening waits for an in-flight save instead of returning an older draft", async () => {
  await saveGuideToDisk(guide);
  const pending = saveGuideToDisk({ ...guide, title: "Latest edit" });
  expect((await loadGuideFromDisk("research"))?.title).toBe("Latest edit");
  await pending;
});

it("lists saved SOPs independently of the current workflow catalog after restart", async () => {
  const { listGuidesFromDisk } = await import("./disk-storage");
  await saveGuideToDisk(guide);
  await saveGuideToDisk({ ...guide, workflowKey: "removed-source" });
  resetWorkflowDiskStorageForTests();
  expect((await listGuidesFromDisk()).map(g => g.workflowKey)).toEqual(["research", "removed-source"]);
});

it("persists uninstalled skill drafts and their edits without overwriting other skills", async () => {
  const { listSkillDraftsFromDisk, saveSkillDraftToDisk } = await import("./disk-storage");
  const draft = { name: "review", description: "Review a brief", instructions: "Read the brief", sourceWorkflow: "Research" };
  await Promise.all([saveSkillDraftToDisk("first", draft), saveSkillDraftToDisk("second", draft)]);
  const pending = saveSkillDraftToDisk("first", { ...draft, instructions: "Edited instructions" });
  expect((await listSkillDraftsFromDisk()).find(d => d.workflowKey === "first")?.draft.instructions).toBe("Edited instructions");
  await pending;
  resetWorkflowDiskStorageForTests();
  expect(await listSkillDraftsFromDisk()).toHaveLength(2);
});

it("keeps corrupt skill storage intact and reports failure instead of an empty Library", async () => {
  const { listSkillDraftsFromDisk, saveSkillDraftToDisk } = await import("./disk-storage");
  files.set("workflows/skill-drafts.json", "bad");
  await expect(listSkillDraftsFromDisk()).rejects.toThrow("unreadable");
  await expect(saveSkillDraftToDisk("first", { name: "review", description: "", instructions: "", sourceWorkflow: "" })).rejects.toThrow("unreadable");
  expect(files.get("workflows/skill-drafts.json")).toBe("bad");
});
