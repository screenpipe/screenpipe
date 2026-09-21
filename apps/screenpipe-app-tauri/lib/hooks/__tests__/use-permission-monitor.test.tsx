// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMonitor } from "../use-permission-monitor";

const mocks = vi.hoisted(() => ({
  pathname: "/onboarding",
  spawnScreenpipe: vi.fn(),
  isCapturePaused: vi.fn(),
  showWindow: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => Promise<void>>>(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/utils/tauri", () => ({ commands: mocks }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => Promise<void>) => {
    const handlers = mocks.listeners.get(name) ?? new Set();
    handlers.add(handler);
    mocks.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  }),
}));

async function emit(name: string, payload: unknown = null) {
  await act(async () => {
    for (const handler of mocks.listeners.get(name) ?? []) await handler({ payload });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.pathname = "/onboarding";
  mocks.spawnScreenpipe.mockResolvedValue({ status: "ok", data: null });
  mocks.isCapturePaused.mockResolvedValue(false);
  mocks.showWindow.mockResolvedValue({ status: "ok", data: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("native server restart requests", () => {
  for (const path of ["/onboarding", "/onboarding/setup", "/permission-recovery", "/shortcut-reminder", "/"]) {
    it(`recovers a missing recording server on ${path}`, async () => {
      mocks.pathname = path;
      renderHook(() => usePermissionMonitor());
      expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
      await emit("request-server-restart");
      expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(1);
      expect(mocks.spawnScreenpipe).toHaveBeenCalledWith(null);
      expect(mocks.showWindow).not.toHaveBeenCalled();
    });
  }

  it("keeps one restart listener when navigation enters and leaves setup", async () => {
    const hook = renderHook(() => usePermissionMonitor());
    for (const path of ["/", "/onboarding", "/permission-recovery", "/"]) {
      mocks.pathname = path;
      await act(async () => hook.rerender());
      expect(mocks.listeners.get("request-server-restart")?.size).toBe(1);
      await emit("request-server-restart");
    }
    expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(4);
    await act(async () => hook.unmount());
    await emit("request-server-restart");
    expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(4);
  });

  it("reports a native startup error without retrying or claiming recovery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.spawnScreenpipe.mockResolvedValue({ status: "error", error: "recording access denied" });
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(error).toHaveBeenCalledWith("Deferred server restart failed:", expect.objectContaining({ message: "recording access denied" }));
    expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected startup invocation", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("native invoke unavailable");
    mocks.spawnScreenpipe.mockRejectedValue(failure);
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(error).toHaveBeenCalledWith("Deferred server restart failed:", failure);
    expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(1);
  });

  it("does not turn a deliberately paused recording back on", async () => {
    mocks.isCapturePaused.mockResolvedValue(true);
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
  });

  it("coalesces overlapping requests and allows a later recovery attempt", async () => {
    let finish!: (result: { status: "ok"; data: null }) => void;
    mocks.spawnScreenpipe.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderHook(() => usePermissionMonitor());
    const handler = [...mocks.listeners.get("request-server-restart")!][0];
    await act(async () => {
      const first = handler({ payload: null });
      await waitFor(() => expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(1));
      await handler({ payload: null });
      expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(1);
      finish({ status: "ok", data: null });
      await first;
    });
    await emit("request-server-restart");
    expect(mocks.spawnScreenpipe).toHaveBeenCalledTimes(2);
  });

  it("does not restart after unmount while the pause check is pending", async () => {
    let finish!: (paused: boolean) => void;
    mocks.isCapturePaused.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => usePermissionMonitor());
    const handler = [...mocks.listeners.get("request-server-restart")!][0];
    const pending = handler({ payload: null });
    hook.unmount();
    await act(async () => {
      finish(false);
      await pending;
    });
    expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
  });
});

describe("permission dialogs remain separate from server recovery", () => {
  for (const path of ["/onboarding", "/permission-recovery", "/shortcut-reminder"]) {
    it(`does not interrupt ${path} with another permission window`, async () => {
      mocks.pathname = path;
      renderHook(() => usePermissionMonitor());
      await emit("permission-lost", { screen_recording: true });
      await emit("permission_needed", { kind: "screen_recording" });
      expect(mocks.showWindow).not.toHaveBeenCalled();
      expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
    });
  }

  it("still opens permission recovery from Home", async () => {
    mocks.pathname = "/";
    renderHook(() => usePermissionMonitor());
    await emit("permission-lost", { screen_recording: true });
    expect(mocks.showWindow).toHaveBeenCalledTimes(1);
    expect(mocks.showWindow).toHaveBeenCalledWith("PermissionRecovery");
    expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
  });
});
