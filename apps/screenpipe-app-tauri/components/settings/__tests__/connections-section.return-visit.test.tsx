// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const commandFns: Record<string, ReturnType<typeof vi.fn>> = {};
  return {
    localFetch: vi.fn(),
    settings: { user: null as { id: string; token: string } | null },
    // Any command the section calls answers "ok"; tests override the few
    // whose answers matter.
    commands: new Proxy(commandFns, {
      get: (fns, name) =>
        typeof name !== "string" || name === "then"
          ? undefined
          : (fns[name] ??= vi.fn(async () => ({ status: "ok", data: null }))),
    }),
  };
});

vi.mock("@/lib/utils/tauri", () => ({ commands: mocks.commands }));
vi.mock("@/lib/api", () => ({ localFetch: mocks.localFetch }));
vi.mock("@/lib/cache", () => ({
  apiCache: {
    get: () => null,
    getStale: () => null,
    set: () => undefined,
    isFresh: () => false,
    invalidate: () => undefined,
  },
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({ settings: mocks.settings, updateSettings: vi.fn() }),
}));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "macos",
  locale: async () => "en-US",
}));
// Nothing is installed on this machine.
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => false),
  readTextFile: vi.fn(async () => {
    throw new Error("missing");
  }),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ Command: { create: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: async () => "/home",
  tempDir: async () => "/tmp",
  join: async (...parts: string[]) => parts.join("/"),
  dirname: async (path: string) => path.split("/").slice(0, -1).join("/"),
}));
vi.mock("@/lib/ai-tools-mcp", () => ({
  detectAiTools: async () => [],
  isClaudeCodeMcpInstalled: async () => false,
}));
vi.mock("@/lib/external-agent-skills", () => ({
  areExternalAgentSkillsInstalled: async () => false,
}));
vi.mock("@/lib/grokbot-connection", () => ({
  isGrokBotDetected: async () => false,
  isGrokBotConnected: async () => false,
}));
vi.mock("@/lib/hooks/use-hardcoded-tiles", () => ({
  getCodexConfigPath: async () => "/home/.codex/config.toml",
  getGrokConfigPath: async () => "/home/.grok/user-settings.json",
  getInstalledMcpVersion: async () => null,
  isCodexMcpInstalled: async () => false,
  isCursorMcpInstalled: async () => false,
  isGrokMcpInstalled: async () => false,
}));
vi.mock("@/lib/connections/foreground-oauth", () => ({
  foregroundAfterOAuth: vi.fn(),
}));
vi.mock("@/lib/connections/mcp-oauth", () => ({
  appDeepLinkScheme: async () => "screenpipe",
}));
vi.mock("@/lib/http/tauri-fetch", () => ({ tauriFetchWithDeadline: vi.fn() }));
vi.mock("../composio-card", async () => ({
  ComposioCard: () => null,
  COMPOSIO_TOOLKITS: (await import("@/lib/composio")).COMPOSIO_TOOLKITS,
}));
vi.mock("../ai-tools-card", () => ({ AiToolsCard: () => null }));
vi.mock("../apple-calendar-card", () => ({ AppleCalendarCard: () => null }));
vi.mock("../google-calendar-card", () => ({ GoogleCalendarCard: () => null }));
vi.mock("../imap-card", () => ({ ImapCard: () => null }));
vi.mock("../google-docs-card", () => ({ GoogleDocsCard: () => null }));
vi.mock("../ics-calendar-card", () => ({ IcsCalendarCard: () => null }));
vi.mock("../remote-agent-card", () => ({ RemoteAgentCard: () => null }));
vi.mock("../browser-url-card", () => ({ BrowserUrlCard: () => null }));
vi.mock("../user-browser-card", () => ({ UserBrowserCard: () => null }));
vi.mock("../voice-memos-card", () => ({ VoiceMemosCard: () => null }));
vi.mock("../custom-mcp-card", () => ({ CustomMcpCard: () => null }));
vi.mock("../skills-card", () => ({ SkillsCard: () => null }));
vi.mock("../pi-extensions-card", () => ({ PiExtensionsCard: () => null }));
vi.mock("../whatsapp-panel", () => ({ WhatsAppPanel: () => null }));
vi.mock("../grokbot-panel", () => ({ GrokBotPanel: () => null }));

import { ConnectionsSection } from "../connections-section";

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const pending = () => new Promise<never>(() => undefined);

// `catalog` answers the connections list; everything else answers empty.
function serve(catalog: () => Promise<Response>) {
  mocks.localFetch.mockImplementation((path: string) =>
    path === "/connections" ? catalog() : json({ data: [] }),
  );
}

// The app names listed under "Connected"; none when the group isn't shown.
function connectedApps() {
  const heading = screen.queryByRole("heading", { name: "Connected" });
  if (!heading) return [];
  return Array.from(
    heading.parentElement!.querySelectorAll('[role="button"]'),
    (row) => row.querySelector("p")?.textContent,
  );
}

const MORE_APPS = /^\d+ more$/;

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  mocks.settings.user = null;
  serve(() => json({ data: [] }));
  vi.stubGlobal("fetch", vi.fn(pending));
  mocks.commands.listImportedSkills.mockResolvedValue({ status: "ok", data: [] });
  mocks.commands.chatgptOauthStatus.mockResolvedValue({
    status: "ok",
    data: { logged_in: false },
  });
  mocks.commands.oauthStatus.mockResolvedValue({
    status: "ok",
    data: { connected: false },
  });
  mocks.commands.getBrowsersAutomationStatus.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Connections on a return visit", () => {
  it("shows the catalog loading again when the last visit's catalog fetch failed", async () => {
    // The fetch retries with 2 s waits between attempts.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<ConnectionsSection />);
    await act(() => vi.advanceTimersByTimeAsync(4_000));
    expect(await screen.findByText(MORE_APPS)).toBeInTheDocument();
    cleanup();

    serve(pending);
    render(<ConnectionsSection />);

    // A count here would pass the hardcoded tiles off as the whole catalog.
    expect(screen.getByText("Loading apps")).toBeInTheDocument();
    expect(screen.queryByText(MORE_APPS)).toBeNull();
  });

  it("does not show one account's Composio connections to another account or a signed-out window", async () => {
    mocks.settings.user = { id: "user-a", token: "token-a" };
    vi.mocked(fetch).mockImplementation(() => json({ gmail: { connected: true } }));
    render(<ConnectionsSection />);
    await waitFor(() => expect(connectedApps()).toContain("Gmail"));
    cleanup();

    mocks.settings.user = { id: "user-b", token: "token-b" };
    vi.mocked(fetch).mockImplementation(pending);
    render(<ConnectionsSection />);
    await settle();

    expect(connectedApps()).not.toContain("Gmail");
    cleanup();

    mocks.settings.user = null;
    render(<ConnectionsSection />);
    await settle();

    expect(connectedApps()).not.toContain("Gmail");
  });

  it("stops showing ChatGPT as connected when this visit's status check fails", async () => {
    mocks.commands.chatgptOauthStatus.mockResolvedValue({
      status: "ok",
      data: { logged_in: true },
    });
    render(<ConnectionsSection />);
    await waitFor(() => expect(connectedApps()).toContain("ChatGPT"));
    cleanup();

    mocks.commands.chatgptOauthStatus.mockRejectedValue(new Error("ipc closed"));
    render(<ConnectionsSection />);
    await settle();

    expect(connectedApps()).not.toContain("ChatGPT");
  });
});
