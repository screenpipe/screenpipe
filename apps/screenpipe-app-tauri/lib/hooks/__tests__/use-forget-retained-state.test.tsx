// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stands in for Tauri's event bus: `emit` reaches every `listen`er, as an
// app-wide event reaches every window.
const bus = vi.hoisted(() => {
  type Listener = (event: { payload: unknown }) => void;
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    emit: vi.fn(async (event: string, payload?: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener({ payload });
    }),
    listen: vi.fn(async (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return () => listeners.get(event)!.delete(listener);
    }),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  emit: bus.emit,
  listen: bus.listen,
}));

import {
  CHAT_HISTORY_LIST_KEY,
  forgetRetainedStateEverywhere,
  useForgetRetainedStateOnDeletion,
} from "@/lib/hooks/use-forget-retained-state";
import { useRetainedState } from "@/lib/hooks/use-retained-state";

function keep(value: string) {
  const kept = renderHook(() => useRetainedState("test:kept", "empty"));
  act(() => kept.result.current[1](value));
  kept.unmount();
}

function nextMount() {
  return renderHook(() => useRetainedState("test:kept", "empty")).result
    .current[0];
}

describe("forgetting retained state after a deletion", () => {
  it("forgets this window's values and tells the other windows", async () => {
    keep("deleted window title");

    await forgetRetainedStateEverywhere();

    expect(nextMount()).toBe("empty");
    expect(bus.emit).toHaveBeenCalledWith("recorded-data-deleted");
  });

  it("forgets this window's values when another window deletes", async () => {
    renderHook(() => useForgetRetainedStateOnDeletion());
    await waitFor(() =>
      expect(bus.listeners.get("recorded-data-deleted")?.size).toBe(1),
    );
    keep("deleted window title");

    // Another window's deletion arrives as the app-wide event.
    await act(() => bus.emit("recorded-data-deleted"));

    expect(nextMount()).toBe("empty");
  });

  it("drops a chat deleted in any window from History's kept list", async () => {
    renderHook(() => useForgetRetainedStateOnDeletion());
    await waitFor(() => expect(bus.listeners.get("chat-deleted")?.size).toBe(1));
    const history = renderHook(() =>
      useRetainedState<{ id: string; title: string }[]>(CHAT_HISTORY_LIST_KEY, []),
    );
    act(() =>
      history.result.current[1]([
        { id: "a", title: "Divorce lawyer questions" },
        { id: "b", title: "Groceries" },
      ]),
    );
    history.unmount();

    // Deleted from the chat sidebar while History is closed.
    await act(() => bus.emit("chat-deleted", { id: "a" }));

    const next = renderHook(() =>
      useRetainedState<{ id: string; title: string }[]>(CHAT_HISTORY_LIST_KEY, []),
    );
    expect(next.result.current[0]).toEqual([{ id: "b", title: "Groceries" }]);
  });
});
