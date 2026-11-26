// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryStatusNotice } from "./memory-status-notice";

const callbacks = {
  onCheck: vi.fn(async () => {}),
  onOpenRecording: vi.fn(),
  onOpenPermission: vi.fn(),
  onOpenStorage: vi.fn(),
};

it("shows startup only when the wait persists and clears it when ready", () => {
  vi.useFakeTimers();
  try {
    const { rerender } = render(<MemoryStatusNotice state="connecting" {...callbacks} />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to local history…");
    rerender(<MemoryStatusNotice state={undefined} {...callbacks} />);
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("checks the connection without replacing the status or content", async () => {
  const { getByRole } = render(<MemoryStatusNotice state="disconnected" {...callbacks} />);
  expect(getByRole("status")).toHaveTextContent("Local history is temporarily unavailable");
  await act(async () => fireEvent.click(getByRole("button", { name: "Check connection" })));
  expect(callbacks.onCheck).toHaveBeenCalledOnce();
  expect(getByRole("status")).toHaveTextContent("Local history is temporarily unavailable");
});

it.each([
  ["screen-permission", "Open System Settings", callbacks.onOpenPermission],
  ["screen-stalled", "Recording settings", callbacks.onOpenRecording],
  ["low-storage", "Manage storage", callbacks.onOpenStorage],
] as const)("opens the recovery action for %s", (state, action, callback) => {
  render(<MemoryStatusNotice state={state} {...callbacks} />);
  fireEvent.click(screen.getByRole("button", { name: action }));
  expect(callback).toHaveBeenCalledOnce();
});
