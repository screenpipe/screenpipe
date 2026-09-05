// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePersonalWorkProfile, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

const files = new Map<string, string>();

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async (path: string) => files.has(path)),
  mkdir: vi.fn(async () => undefined),
  readTextFile: vi.fn(async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error("missing");
    return value;
  }),
  remove: vi.fn(async (path: string) => { files.delete(path); }),
  rename: vi.fn(async (from: string, to: string) => {
    const value = files.get(from);
    if (value === undefined) throw new Error("missing");
    files.delete(from);
    files.set(to, value);
  }),
  writeTextFile: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
}));

import {
  loadWorkflowAnalysisFromDisk,
  loadWorkProfileFromDisk,
  resetWorkflowDiskStorageForTests,
  saveWorkflowAnalysisToDisk,
  saveWorkProfileToDisk,
} from "./disk-storage";

describe("workflow disk storage", () => {
  beforeEach(() => {
    files.clear();
    resetWorkflowDiskStorageForTests();
  });

  it("stores the workflow catalog and work profile in app-local files", async () => {
    await saveWorkflowAnalysisToDisk(fixtureWorkflowAnalysis);
    await saveWorkProfileToDisk(fixturePersonalWorkProfile);

    expect(await loadWorkflowAnalysisFromDisk()).toEqual(fixtureWorkflowAnalysis);
    expect(await loadWorkProfileFromDisk()).toEqual(fixturePersonalWorkProfile);
    expect(files.has("workflows/catalog.json")).toBe(true);
    expect(files.has("workflows/profile.json")).toBe(true);
  });

  it("keeps the last good catalog as a readable backup", async () => {
    await saveWorkflowAnalysisToDisk(fixtureWorkflowAnalysis);
    await saveWorkflowAnalysisToDisk({ ...fixtureWorkflowAnalysis, analyzedAt: "2026-09-05T12:00:00Z" });
    files.set("workflows/catalog.json", "not json");

    expect(await loadWorkflowAnalysisFromDisk()).toEqual(fixtureWorkflowAnalysis);
  });

  it("does not delete unreadable files", async () => {
    files.set("workflows/catalog.json", "not json");

    await expect(loadWorkflowAnalysisFromDisk()).rejects.toThrow("left untouched");
    expect(files.get("workflows/catalog.json")).toBe("not json");
  });
});
