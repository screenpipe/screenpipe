// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  localFetch: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", () => ({
  localFetch: mocks.localFetch,
  getApiBaseUrl: () => "http://localhost:3030",
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: { user: null, aiPresets: [] },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}));
vi.mock("nuqs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nuqs")>()),
  useQueryState: () => [null, vi.fn()],
}));
vi.mock("@/lib/hooks/use-managed-policy", () => ({
  useManagedPolicy: () => ({ isManagedDeployment: false, policy: {} }),
}));
vi.mock("@/lib/cloud-agent-rollout", () => ({
  useCloudAgentRunnerRolloutEnabled: () => false,
}));
vi.mock("@/lib/hooks/use-device-monitor", () => ({
  useDeviceMonitor: () => ({
    devices: [],
    discoverDevices: vi.fn(),
    discovering: false,
  }),
}));
vi.mock("@/lib/hooks/use-team", () => ({
  useTeam: () => ({
    team: null,
    role: null,
    configs: [],
    configsFetched: true,
    members: [],
    pushConfigPlain: vi.fn(),
    deleteConfig: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/use-interval", () => ({ useInterval: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => undefined),
  once: vi.fn(async () => () => undefined),
  listen: vi.fn(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(event, handler);
      return () => mocks.listeners.delete(event);
    },
  ),
}));
vi.mock("@/lib/events/bus", () => ({
  mountAgentEventBus: vi.fn(async () => undefined),
  registerDefault: vi.fn(() => () => undefined),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(async () => false),
  readTextFile: vi.fn(async () => ""),
  writeTextFile: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  mkdir: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(async () => "/home"),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("../provider-automations-panel", () => ({
  ProviderAutomationsPanel: () => null,
}));
vi.mock("../cloud-pipes-tab", () => ({ CloudPipesTab: () => null }));

import { PipesSection } from "../pipes-section";

function pipe(name: string) {
  return {
    config: { name, schedule: "every 1h", enabled: true },
    last_run: null,
    last_success: null,
    is_running: false,
    prompt_body: "body",
    raw_content: `---\nschedule: every 1h\n---\nbody`,
    last_error: null,
    current_execution_id: null,
    consecutive_failures: 0,
    recent_executions: [],
  };
}

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

// `list` answers the pipes list; everything else answers empty.
function serve(list: () => Promise<Response>) {
  mocks.localFetch.mockImplementation((path: string) => {
    if (String(path).startsWith("/pipes?")) return list();
    if (String(path).startsWith("/pipes/favorites")) return json({ data: [] });
    return json({ data: [] });
  });
}

const pipesListCalls = () =>
  mocks.localFetch.mock.calls.filter(([path]) =>
    String(path).startsWith("/pipes?"),
  ).length;

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

beforeEach(() => {
  window.localStorage.clear();
  // The detail pane reads logs with plain fetch.
  vi.stubGlobal("fetch", vi.fn(() => json({ data: [] })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mocks.listeners.clear();
  window.localStorage.clear();
});

describe("Scheduled tasks on a return visit", () => {
  it("shows the kept list at once on a return visit", async () => {
    serve(() => json({ data: [pipe("daily-recap")] }));
    render(<PipesSection />);
    await screen.findAllByText("daily-recap");
    cleanup();

    serve(() => new Promise(() => undefined));
    render(<PipesSection />);

    expect(screen.getAllByText("daily-recap").length).toBeGreaterThan(0);
  });

  it("loads from the skeleton again when the last visit's load failed", async () => {
    serve(() => json({ error: "down" }, 503));
    render(<PipesSection />);
    await screen.findByText("Screenpipe backend is unavailable");
    cleanup();

    serve(() => new Promise(() => undefined));
    render(<PipesSection />);

    expect(screen.queryByText("No scheduled tasks yet")).toBeNull();
    expect(document.querySelector('[class*="animate-pulse"]')).not.toBeNull();
  });

  it("shows the backend error, not the kept list, when this visit's load fails", async () => {
    serve(() => json({ data: [pipe("daily-recap")] }));
    render(<PipesSection />);
    await screen.findAllByText("daily-recap");
    cleanup();

    // The local API stops answering while the user is on another tab.
    serve(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<PipesSection />);

    expect(
      await screen.findByText("Screenpipe backend is unavailable"),
    ).toBeInTheDocument();
    // The kept rows, with their run status and toggles, would pass for live.
    expect(screen.queryByText("daily-recap")).toBeNull();
  });

  it("opens a deep link to a task added since the kept list, once this visit's list arrives", async () => {
    serve(() => json({ data: [pipe("daily-recap")] }));
    render(<PipesSection />);
    await screen.findAllByText("daily-recap");
    cleanup();

    // A task was created elsewhere and a link to it arrives before the
    // return visit's list does.
    window.localStorage.setItem("pendingPipeDeepLink", "new-task");
    let answer!: (response: Response) => void;
    serve(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    render(<PipesSection />);
    await settle();

    // The kept list lacks the task; the link must stay pending.
    expect(window.localStorage.getItem("pendingPipeDeepLink")).toBe("new-task");

    await act(async () => {
      answer(
        new Response(
          JSON.stringify({ data: [pipe("daily-recap"), pipe("new-task")] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    await settle();

    expect(window.localStorage.getItem("pendingPipeDeepLink")).toBeNull();
    expect(pipesListCalls()).toBeGreaterThan(0);
    // Opened: the detail pane fetches the selected task's executions.
    expect(
      vi.mocked(fetch).mock.calls.some(([path]) =>
        String(path).includes("/pipes/new-task/executions"),
      ),
    ).toBe(true);
  });
});
