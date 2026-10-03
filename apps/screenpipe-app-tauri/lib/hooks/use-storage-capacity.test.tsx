// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { renderHook, act, cleanup } from "@testing-library/react";
import { vi, it, expect, beforeEach, afterEach } from "vitest";
import { useStorageCapacity } from "./use-storage-capacity";
const mocks = vi.hoisted(() => ({
  settings: { dataDir: "/configured" },
  active: vi.fn(),
  capacity: vi.fn(),
}));
vi.mock("./use-settings", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    getActiveDataDir: mocks.active,
    getStorageCapacity: mocks.capacity,
  },
}));
const sample = {
  totalBytes: 1000,
  availableBytes: 100,
  smallCapacity: true,
  lowSpace: true,
  recommendedDays: 7,
};
beforeEach(() => {
  vi.useFakeTimers();
  mocks.settings = { dataDir: "/configured" };
  mocks.active.mockReset().mockResolvedValue({ status: "ok", data: "/active" });
  mocks.capacity.mockReset().mockResolvedValue({ status: "ok", data: sample });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("waits, measures the active volume, and polls without scanning recordings", async () => {
  const { result } = renderHook(() => useStorageCapacity(60_000, 900_000));
  await act(() => vi.advanceTimersByTimeAsync(59_999));
  expect(mocks.active).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(mocks.capacity).toHaveBeenCalledWith("/active");
  expect(result.current.capacity).toEqual(sample);
  await act(() => vi.advanceTimersByTimeAsync(840_000));
  expect(mocks.capacity).toHaveBeenCalledTimes(2);
});
it("does not turn a failed probe into zero free space", async () => {
  mocks.capacity.mockResolvedValue({
    status: "error",
    error: "missing volume",
  });
  const { result } = renderHook(() => useStorageCapacity());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.error).toBe(true);
  expect(result.current.capacity).toBeNull();
});
it("rejects impossible samples", async () => {
  mocks.capacity.mockResolvedValue({
    status: "ok",
    data: { ...sample, availableBytes: 1001 },
  });
  const { result } = renderHook(() => useStorageCapacity());
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.error).toBe(true);
});
it("ignores a delayed response after changing the recording directory", async () => {
  let resolveOld!: (value: any) => void;
  mocks.capacity.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const { result, rerender } = renderHook(() => useStorageCapacity());
  await act(() => vi.advanceTimersByTimeAsync(1));
  mocks.settings = { dataDir: "/new" };
  mocks.active.mockResolvedValue({ status: "ok", data: "/new-active" });
  rerender();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(result.current.directory).toBe("/new-active");
  await act(async () =>
    resolveOld({
      status: "ok",
      data: { ...sample, totalBytes: 10, availableBytes: 1 },
    }),
  );
  expect(result.current.directory).toBe("/new-active");
  expect(result.current.capacity).toEqual(sample);
});
