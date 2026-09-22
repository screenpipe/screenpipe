// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMonitor } from "../use-permission-monitor";

const mocks = vi.hoisted(() => ({
  pathname: "/onboarding",
  retryScreenpipe: vi.fn(),
  spawnScreenpipe: vi.fn(),
  showWindow: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => Promise<void>>>(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/utils/tauri", () => ({ commands: mocks }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => mocks.listen(...args) }));

async function emit(name: string, payload: unknown = null) {
  await act(async () => {
    await Promise.all([...mocks.listeners.get(name) ?? []].map(handler => handler({ payload })));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pathname = "/onboarding";
  mocks.listeners.clear();
  mocks.retryScreenpipe.mockResolvedValue({ status: "ok", data: null });
  mocks.showWindow.mockResolvedValue({ status: "ok", data: null });
  mocks.listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => Promise<void>) => {
    const handlers = mocks.listeners.get(name) ?? new Set();
    handlers.add(handler);
    mocks.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("recording recovery listener", () => {
  it.each(["/onboarding", "/onboarding/setup", "/permission-recovery", "/shortcut-reminder", "/"])(
    "routes recovery through native intent-preserving retry on %s", async path => {
      mocks.pathname = path;
      renderHook(() => usePermissionMonitor());
      await emit("request-server-restart");
      expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
      expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
      expect(mocks.showWindow).not.toHaveBeenCalled();
    },
  );

  it("keeps one listener through navigation and StrictMode, and removes it on unmount", async () => {
    const hook = renderHook(() => usePermissionMonitor(), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    for (const path of ["/", "/onboarding", "/permission-recovery"]) {
      mocks.pathname = path;
      await act(async () => hook.rerender());
      expect(mocks.listeners.get("request-server-restart")?.size).toBe(1);
      await emit("request-server-restart");
    }
    const staleHandler = [...mocks.listeners.get("request-server-restart")!][0];
    await act(async () => hook.unmount());
    await staleHandler({ payload: null });
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(3);
    expect(mocks.listeners.get("request-server-restart")?.size).toBe(0);
  });

  it("coalesces overlapping requests but permits recovery after an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail!: (error: Error) => void;
    mocks.retryScreenpipe.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
    renderHook(() => usePermissionMonitor());
    const handler = [...mocks.listeners.get("request-server-restart")!][0];
    const first = handler({ payload: null });
    await handler({ payload: null });
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
    fail(new Error("temporary startup failure"));
    await first;
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(2);
  });

  it("reports a native error result", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.retryScreenpipe.mockResolvedValue({ status: "error", error: "startup failed" });
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(error).toHaveBeenCalledWith("Deferred server restart failed:", expect.objectContaining({ message: "startup failed" }));
  });

  it("cleans up registration that resolves after unmount", async () => {
    let register!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    mocks.listen.mockReturnValueOnce(new Promise(resolve => { register = resolve; }));
    const hook = renderHook(() => usePermissionMonitor());
    hook.unmount();
    await act(async () => register(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("handles registration failure and cleanup without unhandled rejection", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("event bridge unavailable");
    mocks.listen.mockRejectedValueOnce(failure);
    const hook = renderHook(() => usePermissionMonitor());
    await act(async () => hook.unmount());
    expect(error).toHaveBeenCalledWith("Failed to listen for server restart requests:", failure);
  });

  it.each(["/onboarding", "/permission-recovery", "/shortcut-reminder"])(
    "preserves permission-dialog exclusions on %s", async path => {
      mocks.pathname = path;
      renderHook(() => usePermissionMonitor());
      await emit("permission-lost", { screen_recording: true });
      await emit("permission_needed", { kind: "screen_recording" });
      expect(mocks.showWindow).not.toHaveBeenCalled();
    },
  );

  it("still opens permission recovery from Home", async () => {
    mocks.pathname = "/";
    renderHook(() => usePermissionMonitor());
    await emit("permission-lost", { screen_recording: true });
    expect(mocks.showWindow).toHaveBeenCalledWith("PermissionRecovery");
  });
});
