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
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { openLoginWindow: vi.fn() },
}));
vi.mock("./runtime", () => ({
  analyzeCapturedWork: vi.fn(),
  ensureWorkflowRuntime: vi.fn(),
}));
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
});
