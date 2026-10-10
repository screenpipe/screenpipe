// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  localFetch: vi.fn(),
  reload: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit, listen: vi.fn() }));
vi.mock("@/lib/api", () => ({ localFetch: mocks.localFetch }));
vi.mock("@/lib/hooks/use-timeline-cache", () => ({
  clearTimelineCache: vi.fn(async () => undefined),
}));
vi.mock("@/lib/hooks/use-timeline-selection", () => ({
  useTimelineSelection: () => ({
    selectionRange: {
      start: new Date("2026-10-08T10:00:00Z"),
      end: new Date("2026-10-08T10:05:00Z"),
      frameIds: ["101", "102"],
    },
    tagFrames: vi.fn(),
    removeTagFromFrames: vi.fn(),
    setSelectionRange: vi.fn(),
    tags: {},
  }),
}));
vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

import { TimelineTagToolbar } from "./timeline-tag-toolbar";

describe("deleting a timeline range", () => {
  const location = window.location;

  beforeEach(() => {
    // jsdom's reload can't be spied on in place.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...location, reload: mocks.reload },
    });
    mocks.localFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ frames_deleted: 3, audio_transcriptions_deleted: 1 }),
        ),
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: location,
    });
  });

  async function deleteRange() {
    render(<TimelineTagToolbar anchorRect={{ x: 0, y: 0, width: 200 }} />);
    fireEvent.click(screen.getByTitle("Delete selected range"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    });
  }

  it("tells the other windows before reloading", async () => {
    mocks.emit.mockResolvedValue(undefined);
    await deleteRange();

    expect(mocks.emit).toHaveBeenCalledWith("recorded-data-deleted");
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads even when telling the other windows never finishes", async () => {
    mocks.emit.mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();
    await deleteRange();
    expect(mocks.reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });
});
