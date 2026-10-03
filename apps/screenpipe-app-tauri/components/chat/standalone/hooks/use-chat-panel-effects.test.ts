// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/**
 * Opening the composer's "+" menu refreshes its tag and app lists. The effect
 * used to depend on the loading flags, so every finished fetch re-ran it and
 * started the next one for as long as the menu was open, each a query against
 * the local database.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useChatPanelEffects } from "./use-chat-panel-effects";

vi.mock("@/lib/utils/tauri", () => ({
  commands: { piAbortActive: vi.fn(), closeWindow: vi.fn() },
}));

afterEach(cleanup);

type MenuState = {
  appFilterOpen: boolean;
  appItemsLength: number;
  appsLoading: boolean;
  tagsLoading: boolean;
};

function renderMenu(initial: MenuState) {
  const refreshAppItems = vi.fn();
  const refreshTagItems = vi.fn();
  const fixed = {
    inputRef: { current: null },
    mentionDropdownIsOpen: false,
    isLoading: false,
    isStreaming: false,
    piActiveStopRequestedRef: { current: false },
    piSessionIdRef: { current: "" },
    setIsLoading: vi.fn(),
    setIsStreaming: vi.fn(),
    refreshAppItems,
    refreshTagItems,
  };
  const hook = renderHook((state: MenuState) => useChatPanelEffects({ ...fixed, ...state }), {
    initialProps: initial,
  });
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

  it("leaves a fetch that is already running alone", () => {
    const { refreshAppItems, refreshTagItems } = renderMenu({
      ...open,
      appItemsLength: 0,
      appsLoading: true,
      tagsLoading: true,
    });
    expect(refreshAppItems).not.toHaveBeenCalled();
    expect(refreshTagItems).not.toHaveBeenCalled();
  });

  it("does nothing while the menu is closed", () => {
    const { refreshAppItems, refreshTagItems } = renderMenu({ ...open, appFilterOpen: false, appItemsLength: 0 });
    expect(refreshAppItems).not.toHaveBeenCalled();
    expect(refreshTagItems).not.toHaveBeenCalled();
  });
});
