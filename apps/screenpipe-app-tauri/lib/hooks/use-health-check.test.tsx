// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, cleanup, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useHealthCheck } from "./use-health-check";

vi.mock("@/lib/api", () => ({
  appendAuthToken: (url: string) => url,
  ensureApiReady: async () => {},
  getApiBaseUrl: () => "http://127.0.0.1:3030",
  redactApiUrlForLogs: (url: string) => url,
}));

it("reconnects after the recorder closes the health socket cleanly", async () => {
  const sockets: HealthSocket[] = [];
  class HealthSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = HealthSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    close() {}

    constructor(readonly url: string) {
      sockets.push(this);
    }
  }

  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", HealthSocket);
  try {
    const { result } = renderHook(() => useHealthCheck());
    await act(async () => {});
    expect(sockets).toHaveLength(1);

    act(() => sockets[0].onclose?.(new CloseEvent("close", { code: 1000, wasClean: true })));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.isServerDown).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(sockets).toHaveLength(2);
    act(() => sockets[1].onopen?.());
    expect(result.current.isServerDown).toBe(false);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
