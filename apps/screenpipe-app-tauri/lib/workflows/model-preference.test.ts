// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, expect, it, vi } from "vitest";
const files = vi.hoisted(() => new Map<string, string>());
const fs = vi.hoisted(() => ({
  exists: vi.fn(async (path: string) => files.has(path)),
  readTextFile: vi.fn(async (path: string) => files.get(path)),
  writeTextFile: vi.fn(async (path: string, text: string) => { files.set(path, text); }),
  rename: vi.fn(async (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); }),
  remove: vi.fn(async (path: string) => { files.delete(path); }),
}));
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@/lib/utils/tauri", () => ({ commands: { getScreenpipeBaseDir: async () => ({ status: "ok", data: "/test/base" }) } }));
import { workflowModelPreference } from "./model-choice";
beforeEach(() => { files.clear(); vi.clearAllMocks(); });
it("persists Private atomically in the native engine's data directory", async () => {
  expect(await workflowModelPreference.load()).toBe("intelligent");
  await workflowModelPreference.save("private");
  expect([...files.keys()]).toEqual(["/test/base/workflows-model.json"]);
  expect(await workflowModelPreference.load()).toBe("private");
  expect(fs.rename).toHaveBeenCalled();
});
it("keeps the previous Private selection when a replacement fails", async () => {
  await workflowModelPreference.save("private");
  fs.rename.mockRejectedValueOnce(Error("disk full"));
  await expect(workflowModelPreference.save("intelligent")).rejects.toThrow("disk full");
  expect(await workflowModelPreference.load()).toBe("private");
  expect(files.size).toBe(1);
});
it("never treats damaged preferences as permission to use Intelligent", async () => {
  files.set("/test/base/workflows-model.json", "{");
  await expect(workflowModelPreference.load()).rejects.toThrow();
  expect(fs.writeTextFile).not.toHaveBeenCalled();
});
