// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reload } = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { reloadFeatureFlags: reload } }));
import { subscribeToFeatureFlagRefresh } from "./feature-flag-refresh";

const stops: (() => void)[] = [];
function subscribe(canRefresh?: () => boolean) {
  const stop = subscribeToFeatureFlagRefresh(canRefresh);
  stops.push(stop);
  return stop;
}
function visible(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("shared feature flag refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    reload.mockReset();
    visible("visible");
  });
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop());
    vi.useRealTimers();
  });

  it("shares a five-minute background schedule across consumers", () => {
    subscribe();
    vi.advanceTimersByTime(300);
    subscribe();
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(299_700);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("reuses fresh flags through repeated focus and visibility events", () => {
    subscribe();
    for (let i = 0; i < 59; i++) {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("focus"));
      visible("visible");
    }
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("refreshes stale flags on foreground and schedules from that refresh", () => {
    subscribe();
    visible("hidden");
    vi.advanceTimersByTime(75_000);
    expect(reload).toHaveBeenCalledTimes(1);
    visible("visible");
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(299_999);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("refreshes on wake when wall time advanced but the performance clock paused", () => {
    subscribe();
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(299_999);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("keeps the five-minute deadline when the wall clock moves backwards", () => {
    subscribe();
    vi.advanceTimersByTime(10_000);
    vi.setSystemTime(Date.now() - 6 * 60 * 60 * 1000);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(289_999);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not poll while hidden or after the last consumer unmounts", () => {
    const stopA = subscribe();
    const stopB = subscribe();
    stopA();
    vi.advanceTimersByTime(300_000);
    expect(reload).toHaveBeenCalledTimes(2);
    visible("hidden");
    vi.advanceTimersByTime(3_600_000);
    expect(reload).toHaveBeenCalledTimes(2);
    stopB();
    visible("visible");
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(300_000);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains each consumer's opt-out policy and resumes when allowed", () => {
    let allowed = false;
    subscribe(() => allowed);
    vi.advanceTimersByTime(300_000);
    expect(reload).not.toHaveBeenCalled();
    allowed = true;
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1);
    allowed = false;
    vi.advanceTimersByTime(300_000);
    expect(reload).toHaveBeenCalledTimes(1);
    subscribe(); // Functional remote-control flags retain their own policy.
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("retries when SDK initialization initially throws", () => {
    reload.mockImplementationOnce(() => {
      throw new Error("not initialized");
    });
    subscribe();
    vi.advanceTimersByTime(300_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("bounds thirty minutes of continuous visible polling to seven requests", () => {
    subscribe();
    vi.advanceTimersByTime(30 * 60_000);
    expect(reload).toHaveBeenCalledTimes(7); // initial + six periodic refreshes
  });

  it("refreshes on focus after a minute without waiting for the five-minute timer", () => {
    subscribe();
    vi.advanceTimersByTime(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(299_999);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("an unavailable consumer does not block an eligible consumer", () => {
    subscribe(() => {
      throw new Error("unavailable");
    });
    subscribe();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
