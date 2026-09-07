// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGrokBotSetupPrompt, isGrokBotDetected } from "../grokbot-connection";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  platform: vi.fn(),
  getLocalApiConfig: vi.fn(),
  bunCheck: vi.fn(),
  getActiveDataDir: vi.fn(),
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
  mocks.getLocalApiConfig.mockResolvedValue({ port: 3137, key: "sp-secret-fixture", auth_enabled: true });
  mocks.bunCheck.mockResolvedValue({ status: "ok", data: { available: true, path: "/Applications/Screenpipe.app/Contents/Resources/bun" } });
  mocks.getActiveDataDir.mockResolvedValue({ status: "ok", data: "/home/test/Screenpipe profile" });
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

describe("Grok Bot setup", () => {
  it("uses the active instance and bundled runtime without copying its API key", async () => {
    const prompt = await getGrokBotSetupPrompt();
    expect(prompt).toContain('"SCREENPIPE_LOCAL_API_URL": "http://127.0.0.1:3137"');
    expect(prompt).toContain('"SCREENPIPE_DATA_DIR": "/home/test/Screenpipe profile"');
    expect(prompt).toContain('"bun": "/Applications/Screenpipe.app/Contents/Resources/bun"');
    expect(prompt).not.toContain("sp-secret-fixture");
    expect(prompt).toContain("request local-command approval through Grok Bot");
    expect(prompt).toContain("Do not claim recording access is verified until an authenticated query succeeds");
    expect(prompt).toContain("/activity-summary");
  });

  it.each([null, {}, { port: 0 }, { port: 65536 }, { port: "3030" }])("refuses an unavailable local address: %j", async (api) => {
    mocks.getLocalApiConfig.mockResolvedValue(api);
    await expect(getGrokBotSetupPrompt()).rejects.toThrow("local address is unavailable");
  });

  it("does not fall back to a different profile when the active data directory is unknown", async () => {
    mocks.getActiveDataDir.mockResolvedValue({ status: "error", error: "unavailable" });
    await expect(getGrokBotSetupPrompt()).rejects.toThrow("data location is unavailable");
  });
});
