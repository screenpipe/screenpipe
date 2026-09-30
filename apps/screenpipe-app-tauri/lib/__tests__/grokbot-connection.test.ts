// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, describe, expect, it, vi } from "vitest";
import { grokBotConnection, isGrokBotDetected } from "../grokbot-connection";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  platform: vi.fn(),
  grokbotConnection: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home/test",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: mocks.exists }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: mocks.platform }));
vi.mock("@/lib/utils/tauri", () => ({ commands: mocks }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.platform.mockReturnValue("macos");
  mocks.exists.mockResolvedValue(false);

});

describe("Grok Bot discovery", () => {
  it("detects the desktop app without requiring a Grok CLI install", async () => {
    mocks.exists.mockImplementation(async (path: string) => path === "/Applications/Grok Bot.app");
    expect(await isGrokBotDetected()).toBe(true);
  });

  it("detects a Windows companion through its own settings", async () => {
    mocks.platform.mockReturnValue("windows");
    mocks.exists.mockImplementation(async (path: string) => path === "/home/test/.grokbot/settings.json");
    expect(await isGrokBotDetected()).toBe(true);
  });

  it("does not confuse .grok settings with Grok Bot", async () => {
    mocks.exists.mockImplementation(async (path: string) => path.startsWith("/home/test/.grok/"));
    expect(await isGrokBotDetected()).toBe(false);
  });

  it("keeps detecting when one application location is unreadable", async () => {
    mocks.exists.mockImplementation(async (path: string) => {
      if (path === "/Applications/Grok Bot.app") throw new Error("permission denied");
      return path === "/home/test/Applications/Grok Bot.app";
    });
    expect(await isGrokBotDetected()).toBe(true);
  });
});

describe("Grok Bot native connection", () => {
  it("uses the native verified status and does not send credentials into the renderer", async () => {
    mocks.grokbotConnection.mockResolvedValue({ status: "ok", data: { detected: true, connected: true } });
    expect((await grokBotConnection("connect")).connected).toBe(true);
    expect(mocks.grokbotConnection).toHaveBeenCalledWith("connect");
  });
  it("surfaces setup failures and rejects malformed statuses", async () => {
    mocks.grokbotConnection.mockResolvedValue({ status: "error", error: "Open Grok Bot" });
    await expect(grokBotConnection()).rejects.toThrow("Open Grok Bot");
    mocks.grokbotConnection.mockResolvedValue({ status: "ok", data: {} });
    await expect(grokBotConnection()).rejects.toThrow("invalid connection status");
  });
});
