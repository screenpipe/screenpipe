// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

const browserValues = new Map<string, string>();
const browserStorage = {
  clear: () => browserValues.clear(),
  getItem: (key: string) => browserValues.get(key) ?? null,
  removeItem: (key: string) => browserValues.delete(key),
  setItem: (key: string, value: string) => browserValues.set(key, value),
};

const mocks = vi.hoisted(() => ({
  loadAnalysis: vi.fn(),
  saveAnalysis: vi.fn(),
  loadProfile: vi.fn(),
  saveProfile: vi.fn(),
  generateSkill: vi.fn(),
  saveSkill: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { openLoginWindow: vi.fn() },
}));
vi.mock("./runtime", () => ({
  analyzeCapturedWork: vi.fn(),
  ensureWorkflowRuntime: vi.fn(),
  generateWorkflowSkill: mocks.generateSkill,
  saveWorkflowSkill: mocks.saveSkill,
}));
vi.mock("./assistant", () => ({ desktopAssistant: {} }));
vi.mock("./disk-storage", () => ({
  isStoredWorkflowAnalysis: (value: unknown) => {
    const record = value as { schemaVersion?: number; analysis?: { workflows?: unknown[] } } | null;
    return record?.schemaVersion === 5 && Array.isArray(record.analysis?.workflows);
  },
  loadWorkflowAnalysisFromDisk: mocks.loadAnalysis,
  saveWorkflowAnalysisToDisk: mocks.saveAnalysis,
  loadWorkProfileFromDisk: mocks.loadProfile,
  saveWorkProfileToDisk: mocks.saveProfile,
}));

import { desktopWorkflowsPlatform } from "./desktop-platform";

describe("desktop workflows persistence", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: browserStorage });
    window.localStorage.clear();
    mocks.loadAnalysis.mockReset().mockResolvedValue(null);
    mocks.saveAnalysis.mockReset().mockResolvedValue(undefined);
    mocks.loadProfile.mockReset().mockResolvedValue(null);
    mocks.saveProfile.mockReset().mockResolvedValue(undefined);
    mocks.generateSkill.mockReset();
    mocks.saveSkill.mockReset();
  });

  it("keeps video on the native loopback stream and opens moments through IPC", async () => {
    const media = { kind: "video", url: "http://127.0.0.1:4567/media/12345678-1234-1234-1234-123456789abc", frameId: 12, timestamp: "2026-09-10T10:00:00Z", offsetSeconds: 2, matchDistanceSeconds: 0 };
    mocks.invoke.mockResolvedValueOnce(media).mockResolvedValue(undefined);
    expect(await desktopWorkflowsPlatform.loadWorkflowRecording!(media.timestamp, "Editor")).toEqual(media);
    await desktopWorkflowsPlatform.openCapturedMoment!(12, media.timestamp);
    expect(mocks.invoke).toHaveBeenCalledWith("open_workflow_captured_moment", { frameId: 12, timestamp: media.timestamp });
    await desktopWorkflowsPlatform.releaseWorkflowRecording!(media.url);
    expect(mocks.invoke).toHaveBeenCalledWith("release_workflow_recording", { url: media.url });
  });

  it("rejects non-local video URLs", async () => {
    mocks.invoke.mockResolvedValueOnce({ kind: "video", url: "https://example.com/private.mp4" });
    await expect(desktopWorkflowsPlatform.loadWorkflowRecording!("2026-09-10T10:00:00Z", "Editor")).rejects.toThrow("Invalid local recording address");
  });

  it("migrates the legacy catalog to disk without deleting its source", async () => {
    window.localStorage.setItem("screenpipe-workflows:last-analysis-v2", "not json");
    window.localStorage.setItem("screenpipe-workflows:last-analysis", JSON.stringify(fixtureWorkflowAnalysis));

    await expect(desktopWorkflowsPlatform.loadCapturedWork?.(90)).resolves.toEqual(fixtureWorkflowAnalysis);
    expect(mocks.saveAnalysis).toHaveBeenCalledWith(fixtureWorkflowAnalysis);
    expect(window.localStorage.getItem("screenpipe-workflows:last-analysis")).not.toBeNull();
  });

  it("uses the disk catalog before browser migration data", async () => {
    const diskCatalog = { ...fixtureWorkflowAnalysis, analyzedAt: "2026-09-05T12:00:00Z" };
    mocks.loadAnalysis.mockResolvedValue(diskCatalog);
    window.localStorage.setItem("screenpipe-workflows:last-analysis", JSON.stringify(fixtureWorkflowAnalysis));

    await expect(desktopWorkflowsPlatform.loadCapturedWork?.(90)).resolves.toEqual(diskCatalog);
    expect(mocks.saveAnalysis).not.toHaveBeenCalled();
  });

  it("saves every completed catalog through native disk storage", async () => {
    await desktopWorkflowsPlatform.saveCapturedWork?.(fixtureWorkflowAnalysis);

    expect(mocks.saveAnalysis).toHaveBeenCalledWith(fixtureWorkflowAnalysis);
  });

  it("uses the native agent harness and local skill library", async () => {
    const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
    const draft = {
      name: "review-pull-requests",
      description: "Review a pull request when a change is ready.",
      instructions: "# Review\n\n1. Inspect the change.",
      sourceWorkflow: workflow.title,
    };
    const receipt = {
      name: draft.name,
      path: "/skills/review-pull-requests/SKILL.md",
      updated: true,
      destinations: ["Screenpipe", "Codex"],
      warnings: [],
    };
    mocks.generateSkill.mockResolvedValue(draft);
    mocks.saveSkill.mockResolvedValue(receipt);
    const onProgress = vi.fn();

    await expect(desktopWorkflowsPlatform.generateWorkflowSkill?.(workflow, null, onProgress)).resolves.toEqual(draft);
    await expect(desktopWorkflowsPlatform.saveWorkflowSkill?.(draft)).resolves.toEqual(receipt);
    expect(mocks.generateSkill).toHaveBeenCalledWith(workflow, null, onProgress);
    expect(mocks.saveSkill).toHaveBeenCalledWith(draft);
  });
});
