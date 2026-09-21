// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePermissionMonitor } from "../use-permission-monitor";

const mocks = vi.hoisted(() => ({
  pathname: "/onboarding",
  spawnScreenpipe: vi.fn(),
  retryScreenpipe: vi.fn(),
  listen: vi.fn(),
  isCapturePaused: vi.fn(),
  showWindow: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => Promise<void>>>(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));
vi.mock("@/lib/utils/tauri", () => ({ commands: mocks }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => mocks.listen(...args) }));

async function emit(name: string, payload: unknown = null) {
  await act(async () => {
    for (const handler of mocks.listeners.get(name) ?? []) await handler({ payload });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  mocks.listen.mockReset().mockImplementation(async (name: string, handler: (event: { payload: unknown }) => Promise<void>) => {
    const handlers = mocks.listeners.get(name) ?? new Set();
    handlers.add(handler);
    mocks.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  });
  mocks.pathname = "/onboarding";
  mocks.retryScreenpipe.mockResolvedValue({ status: "ok", data: null });

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
      expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
      await emit("request-server-restart");
      expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
      expect(mocks.retryScreenpipe).toHaveBeenCalledWith();
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
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(4);
    await act(async () => hook.unmount());
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(4);
  });

  it("reports a native startup error without retrying or claiming recovery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.retryScreenpipe.mockResolvedValue({ status: "error", error: "recording access denied" });
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(error).toHaveBeenCalledWith("Deferred server restart failed:", expect.objectContaining({ message: "recording access denied" }));
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
  });

  it("handles a rejected startup invocation", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("native invoke unavailable");
    mocks.retryScreenpipe.mockRejectedValue(failure);
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(error).toHaveBeenCalledWith("Deferred server restart failed:", failure);
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
  });

  it("uses native intent-preserving retry instead of a racy pause-check and user-start pair", async () => {
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
    expect(mocks.isCapturePaused).not.toHaveBeenCalled();
    expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
  });

  it("coalesces overlapping requests and allows a later recovery attempt", async () => {
    let finish!: (result: { status: "ok"; data: null }) => void;
    mocks.retryScreenpipe.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderHook(() => usePermissionMonitor());
    const handler = [...mocks.listeners.get("request-server-restart")!][0];
    await act(async () => {
      const first = handler({ payload: null });
      await waitFor(() => expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1));
      await handler({ payload: null });
      expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
      finish({ status: "ok", data: null });
      await first;
    });
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale callback immediately after unmount", async () => {
    const hook = renderHook(() => usePermissionMonitor());
    const handler = [...mocks.listeners.get("request-server-restart")!][0];
    hook.unmount();
    await handler({ payload: null });
    expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
  });

  it("unsubscribes even when native listener registration completes after unmount", async () => {
    let registered!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    mocks.listen.mockReturnValueOnce(new Promise(resolve => { registered = resolve; }));
    const hook = renderHook(() => usePermissionMonitor());
    const handler = mocks.listen.mock.calls[0][1];
    hook.unmount();
    await act(async () => {
      await handler({ payload: null });
      registered(unlisten);
    });
    expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("handles failed listener registration without an unhandled rejection on cleanup", async () => {
    const failure = new Error("event bridge unavailable");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listen.mockRejectedValueOnce(failure);
    const hook = renderHook(() => usePermissionMonitor());
    await act(async () => {});
    expect(error).toHaveBeenCalledWith("Failed to listen for server restart requests:", failure);
    await act(async () => hook.unmount());
    expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
  });

  it("survives React StrictMode setup and cleanup without duplicate recovery", async () => {
    renderHook(() => usePermissionMonitor(), {
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    await act(async () => {});
    expect(mocks.listeners.get("request-server-restart")?.size).toBe(1);
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(1);
  });

  it("allows independent windows to retry through the native serializer", async () => {
    const first = renderHook(() => usePermissionMonitor());
    mocks.pathname = "/shortcut-reminder";
    const second = renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(2);
    expect(mocks.spawnScreenpipe).not.toHaveBeenCalled();
    await act(async () => first.unmount());
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(3);
    await act(async () => second.unmount());
    expect(mocks.listeners.get("request-server-restart")?.size).toBe(0);
  });

  it("accepts a later event after the previous native retry fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.retryScreenpipe.mockRejectedValueOnce(new Error("temporary startup error"));
    renderHook(() => usePermissionMonitor());
    await emit("request-server-restart");
    await emit("request-server-restart");
    expect(mocks.retryScreenpipe).toHaveBeenCalledTimes(2);
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
      expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
    });
  }

  it("still opens permission recovery from Home", async () => {
    mocks.pathname = "/";
    renderHook(() => usePermissionMonitor());
    await emit("permission-lost", { screen_recording: true });
    expect(mocks.showWindow).toHaveBeenCalledTimes(1);
    expect(mocks.showWindow).toHaveBeenCalledWith("PermissionRecovery");
    expect(mocks.retryScreenpipe).not.toHaveBeenCalled();
  });
});
