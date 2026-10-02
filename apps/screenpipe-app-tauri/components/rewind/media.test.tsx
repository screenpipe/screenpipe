// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMediaFileCommand = vi.hoisted(() => vi.fn());

vi.mock("@/lib/utils/tauri", () => ({
  commands: { getMediaFile: getMediaFileCommand },
}));

import { MediaComponent } from "./media";

// Long enough for the player to use up all of its retries.
const RETRIES_DONE_MS = 4_000;

describe("MediaComponent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMediaFileCommand.mockResolvedValue({ status: "error", error: "File does not exist" });
  });

  afterEach(() => {
    vi.useRealTimers();
    getMediaFileCommand.mockReset();
  });

  // Meeting and transcript players have no text to show instead, so a file
  // that failed before gets the full loading and retries again.
  it("retries a recording with no fallback in full each time it is mounted", async () => {
    const path = "/Users/me/.screenpipe/data/Mic (input)_2026-09-28_10-30-00.mp4";
    const first = render(<MediaComponent filePath={path} />);
    await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));

    expect(screen.getByText(/Failed to load media/)).toBeInTheDocument();
    expect(getMediaFileCommand).toHaveBeenCalledTimes(4);
    first.unmount();
    getMediaFileCommand.mockClear();

    render(<MediaComponent filePath={path} />);
    expect(screen.getByText("Loading media...")).toBeInTheDocument();
    expect(screen.queryByText(/Failed to load media/)).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));
    expect(screen.getByText(/Failed to load media/)).toBeInTheDocument();
    expect(getMediaFileCommand).toHaveBeenCalledTimes(4);
  });
});
