// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  clearRetainedState,
  useRetainedState,
} from "@/lib/hooks/use-retained-state";

describe("useRetainedState", () => {
  it("starts from the initial value the first time", () => {
    const { result } = renderHook(() => useRetainedState("test:first", 1));
    expect(result.current[0]).toBe(1);
  });

  it("calls a lazy initializer only when nothing is retained", () => {
    let calls = 0;
    const init = () => {
      calls += 1;
      return "fresh";
    };
    const first = renderHook(() => useRetainedState("test:lazy", init));
    act(() => first.result.current[1]("kept"));
    first.unmount();

    const second = renderHook(() => useRetainedState("test:lazy", init));
    expect(second.result.current[0]).toBe("kept");
    expect(calls).toBe(1);
  });

  it("gives the next mount the last value instead of the initial one", () => {
    const first = renderHook(() => useRetainedState("test:remount", "loading"));
    act(() => first.result.current[1]("loaded"));
    act(() => first.result.current[1]((prev) => `${prev} twice`));
    first.unmount();

    const second = renderHook(() => useRetainedState("test:remount", "loading"));
    expect(second.result.current[0]).toBe("loaded twice");
  });

  it("keeps keys apart", () => {
    const a = renderHook(() => useRetainedState("test:a", 0));
    act(() => a.result.current[1](5));
    a.unmount();

    const b = renderHook(() => useRetainedState("test:b", 0));
    expect(b.result.current[0]).toBe(0);
  });

  it("starts over after clearRetainedState", () => {
    const first = renderHook(() => useRetainedState("test:clear", "loading"));
    act(() => first.result.current[1]("loaded"));
    first.unmount();

    clearRetainedState();

    const second = renderHook(() => useRetainedState("test:clear", "loading"));
    expect(second.result.current[0]).toBe("loading");
  });

  it("saves nothing from a mount that was open during the clear", () => {
    const open = renderHook(() => useRetainedState("test:open", "loading"));
    act(() => open.result.current[1]("before"));

    clearRetainedState();
    act(() => open.result.current[1]("after"));
    open.unmount();

    const next = renderHook(() => useRetainedState("test:open", "loading"));
    expect(next.result.current[0]).toBe("loading");

    // Mounts from after the clear save as usual.
    act(() => next.result.current[1]("fresh"));
    next.unmount();
    const last = renderHook(() => useRetainedState("test:open", "loading"));
    expect(last.result.current[0]).toBe("fresh");
  });
});
