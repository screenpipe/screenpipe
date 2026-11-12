// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, vi } from "vitest";
import { openBrainSection, assertEvidenceFreshnessTitle } from "../../e2e/helpers/brain-view";
import { normalizeSidebarNavLayout, resolveVisibleSidebarNavIds, SIDEBAR_NAV_ORDER } from "../utils/sidebar-nav-layout";
import { summarizeLiveViewFreshness } from "../live-views/freshness";
import type { BrainViewSlot } from "../utils/tauri";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Brain E2E entry and freshness contracts", () => {
  it("opens the real Brain route even when Library is hidden in the default sidebar", async () => {
    const visible = resolveVisibleSidebarNavIds(normalizeSidebarNavLayout(undefined), SIDEBAR_NAV_ORDER);
    let route = "/home?section=pipes";
    const location = {
      get href() { return route; },
      set href(_value: string) { throw new Error("Full reload drops Pi event listeners"); },
    };
    vi.stubGlobal("window", { location });
    vi.stubGlobal("$", async () => ({
      waitForExist: async () => {
        if (!visible.includes("brain")) throw new Error("Library is hidden in the default sidebar");
      },
    }));
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: async (command: string, args: any) => {
        if (command !== "show_window" || args.window?.Home?.page !== "brain") {
          throw new Error("Expected scoped Home navigation to Brain");
        }
        route = "/home?section=brain";
      },
    });
    vi.stubGlobal("browser", {
      execute: async (navigate: () => void) => navigate(),
      executeAsync: (callback: (...args: any[]) => void, ...args: unknown[]) =>
        new Promise((resolve) => callback(...args, resolve)),
    });
    await openBrainSection();
    expect(route).toBe("/home?section=brain");
  });

  it("accepts separate data age and source-check age from the real freshness summarizer", () => {
    const slot = {
      binding: { pipeName: "time-breakdown" },
      value: {
        updatedAt: "2026-08-07T11:57:00Z",
        evidence: [{ ts: "2026-08-03T15:00:00Z" }],
        payload: {},
      },
    } as BrainViewSlot;
    const summary = summarizeLiveViewFreshness([slot], Date.parse("2026-08-07T12:00:00Z"), "today");
    expect(() => assertEvidenceFreshnessTitle(summary.label)).not.toThrow();
  });

  it.each([null, "Updated just now", "Data through Aug 3", "Sources checked just now"])("rejects incomplete freshness: %s", (title) => {
    expect(() => assertEvidenceFreshnessTitle(title)).toThrow();
  });
});
