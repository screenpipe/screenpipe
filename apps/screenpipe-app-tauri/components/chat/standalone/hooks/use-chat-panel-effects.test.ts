// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/**
 * Opening the composer's "+" menu refreshes its tag and app lists. The effect
 * used to depend on the loading flags, so every finished fetch re-ran it and
 * started the next one for as long as the menu was open, each a query against
 * the local database.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSqlAutocomplete, useTagAutocomplete } from "@/lib/hooks/use-sql-autocomplete";
import { useChatPanelEffects } from "./use-chat-panel-effects";

// Requests to the local API wait until the test answers them, so the test
// decides when each fetch finishes.
const network = vi.hoisted(() => ({ tags: 0, apps: 0, unanswered: [] as Array<() => void> }));

vi.mock("@/lib/api", () => ({
  localFetch: vi.fn((path: string) => {
    const isTags = path.startsWith("/tags/autocomplete");
    if (isTags) network.tags++;
    else network.apps++;
    const body = isTags ? [{ name: "work", count: 3 }] : [];
    return new Promise((resolve) => {
      network.unanswered.push(() => resolve({ ok: true, json: async () => body }));
    });
  }),
}));

vi.mock("@/lib/utils/tauri", () => ({
  commands: { piAbortActive: vi.fn(), closeWindow: vi.fn() },
}));

afterEach(cleanup);

const panelProps = {
  inputRef: { current: null },
  mentionDropdownIsOpen: false,
  isLoading: false,
  isStreaming: false,
  piActiveStopRequestedRef: { current: false },
  piSessionIdRef: { current: "" },
  setIsLoading: vi.fn(),
  setIsStreaming: vi.fn(),
};

type MenuState = {
  appFilterOpen: boolean;
  appItemsLength: number;
  appsLoading: boolean;
  tagsLoading: boolean;
};

function renderMenu(initial: MenuState) {
  const refreshAppItems = vi.fn();
  const refreshTagItems = vi.fn();
  const hook = renderHook(
    (state: MenuState) => useChatPanelEffects({ ...panelProps, refreshAppItems, refreshTagItems, ...state }),
    { initialProps: initial },
  );
  return { ...hook, refreshAppItems, refreshTagItems };
}

const open = { appFilterOpen: true, appItemsLength: 12, appsLoading: false, tagsLoading: false };

describe("composer filter menu refresh", () => {
  it("refreshes tags once per opening, not again after every fetch", () => {
    const { rerender, refreshTagItems } = renderMenu(open);
    expect(refreshTagItems).toHaveBeenCalledTimes(1);

    // The fetch it started runs and finishes, three times over.
    for (let i = 0; i < 3; i++) {
      rerender({ ...open, tagsLoading: true });
      rerender({ ...open, tagsLoading: false });
    }
    expect(refreshTagItems).toHaveBeenCalledTimes(1);

    // Closing and reopening refreshes again.
    rerender({ ...open, appFilterOpen: false });
    rerender(open);
    expect(refreshTagItems).toHaveBeenCalledTimes(2);
  });

  it("asks for apps once per opening even when none come back", () => {
    const empty = { ...open, appItemsLength: 0 };
    const { rerender, refreshAppItems } = renderMenu(empty);
    expect(refreshAppItems).toHaveBeenCalledTimes(1);

    // A new user with no apps yet, or a failed request: still nothing.
    for (let i = 0; i < 3; i++) {
      rerender({ ...empty, appsLoading: true });
      rerender({ ...empty, appsLoading: false });
    }
    expect(refreshAppItems).toHaveBeenCalledTimes(1);
  });

  it("leaves a fetch that is already running alone, and does not follow it with another", () => {
    const running = { ...open, appItemsLength: 0, appsLoading: true, tagsLoading: true };
    const { rerender, refreshAppItems, refreshTagItems } = renderMenu(running);
    expect(refreshAppItems).not.toHaveBeenCalled();
    expect(refreshTagItems).not.toHaveBeenCalled();

    // That fetch finishes while the menu is still open; its result is fresh.
    rerender({ ...running, appsLoading: false, tagsLoading: false });
    expect(refreshAppItems).not.toHaveBeenCalled();
    expect(refreshTagItems).not.toHaveBeenCalled();
  });

  it("does nothing while the menu is closed", () => {
    const { refreshAppItems, refreshTagItems } = renderMenu({ ...open, appFilterOpen: false, appItemsLength: 0 });
    expect(refreshAppItems).not.toHaveBeenCalled();
    expect(refreshTagItems).not.toHaveBeenCalled();
  });

  it("sends one tag and one app request per opening with the real autocomplete hooks", async () => {
    const answerRequests = () =>
      act(async () => {
        for (const answer of network.unanswered.splice(0)) answer();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    const { rerender } = renderHook(
      ({ appFilterOpen }: { appFilterOpen: boolean }) => {
        const apps = useSqlAutocomplete("app");
        const tags = useTagAutocomplete();
        useChatPanelEffects({
          ...panelProps,
          appFilterOpen,
          appItemsLength: apps.items.length,
          appsLoading: apps.isLoading,
          tagsLoading: tags.isLoading,
          refreshAppItems: apps.refresh,
          refreshTagItems: tags.refresh,
        });
      },
      { initialProps: { appFilterOpen: false } },
    );
    await answerRequests(); // the lists' first load, before the menu opens
    network.tags = 0;
    network.apps = 0;

    // Every request finishes while the menu stays open; the app list stays empty.
    rerender({ appFilterOpen: true });
    for (let i = 0; i < 3; i++) await answerRequests();
    expect([network.tags, network.apps]).toEqual([1, 1]);

    rerender({ appFilterOpen: false });
    rerender({ appFilterOpen: true });
    await answerRequests();
    expect([network.tags, network.apps]).toEqual([2, 2]);
  });
});
