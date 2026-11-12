// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ScreenshotFrameRateCard } from "./screenshot-frame-rate-card";

afterEach(cleanup);

describe("screenshot frame rate", () => {
  it("commits a valid sampling rate and leaves an invalid draft uncommitted", () => {
    const update = vi.fn();
    render(<ScreenshotFrameRateCard value={24} onChange={update} />);
    const input = screen.getByRole("spinbutton", { name: "Screenshot frame rate" });
    expect((input as HTMLInputElement).value).toBe("24");
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    expect(update).toHaveBeenCalledExactlyOnceWith(30);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/HD video has its own frame rate/)).toBeTruthy();
  });
});
