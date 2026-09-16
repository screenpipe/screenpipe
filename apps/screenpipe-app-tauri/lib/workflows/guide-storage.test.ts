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
