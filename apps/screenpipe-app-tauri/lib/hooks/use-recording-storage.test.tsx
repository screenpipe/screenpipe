// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingStorage } from "./use-recording-storage";

const mocks = vi.hoisted(() => ({
  settings: { dataDir: "default", stopRecordingOnLowDisk: true },
  getDataDir: vi.fn(async () => "/example/data"),
  getDiskUsage: vi.fn(),
  getLowDiskGuardConfig: vi.fn(async () => ({ thresholdBytes: 5 * 1024 ** 3 })),
}));
vi.mock("./use-settings", () => ({ useSettings: () => mocks }));
vi.mock("@/lib/utils/tauri", () => ({ commands: mocks }));
const usage = (gib: number) => ({ status: "ok", data: { available_space_bytes: gib * 1024 ** 3 } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.dataDir = "default";
  mocks.settings.stopRecordingOnLowDisk = true;
  mocks.getDiskUsage.mockResolvedValue(usage(3));
  mocks.getLowDiskGuardConfig.mockResolvedValue({ thresholdBytes: 5 * 1024 ** 3 });
});

describe("paused recording storage", () => {
  it("does not scan during recording or when the guard is disabled", () => {
    const { rerender } = renderHook(({ paused }) => useRecordingStorage(paused), { initialProps: { paused: false } });
    mocks.settings.stopRecordingOnLowDisk = false;
    rerender({ paused: true });
    expect(mocks.getDiskUsage).not.toHaveBeenCalled();
  });

  it("uses the native reserve, includes the boundary and clears after manual recovery", async () => {
    mocks.getDiskUsage.mockResolvedValueOnce(usage(5));
    const { result } = renderHook(() => useRecordingStorage(true));
    await waitFor(() => expect(result.current.warning?.availableBytes).toBe(5 * 1024 ** 3));
    mocks.getDiskUsage.mockResolvedValueOnce(usage(12));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.warning).toBeNull();
    expect(mocks.getDiskUsage).toHaveBeenCalledTimes(2);
  });

  it("does not report failed probes as zero free bytes", async () => {
    mocks.getDiskUsage.mockRejectedValueOnce(new Error("unavailable"));
    const { result } = renderHook(() => useRecordingStorage(true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.warning).toBeNull();
  });

  it("does not reuse a warning from another data directory", async () => {
    const { result, rerender } = renderHook(() => useRecordingStorage(true));
    await waitFor(() => expect(result.current.warning).not.toBeNull());
    mocks.settings.dataDir = "/another/volume";
    mocks.getDiskUsage.mockResolvedValueOnce(usage(30));
    rerender();
    expect(result.current.warning).toBeNull();
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.warning).toBeNull();
  });

  it("rejects invalid native thresholds instead of enabling a false warning", async () => {
    mocks.getLowDiskGuardConfig.mockResolvedValueOnce({ thresholdBytes: NaN });
    const { result } = renderHook(() => useRecordingStorage(true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.warning).toBeNull();
  });

  it("ignores late results after capture resumes", async () => {
    let finish!: (data: ReturnType<typeof usage>) => void;
    mocks.getDiskUsage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ paused }) => useRecordingStorage(paused), { initialProps: { paused: true } });
    await waitFor(() => expect(mocks.getDiskUsage).toHaveBeenCalledOnce());
    rerender({ paused: false });
    await act(async () => { finish(usage(0)); });
    expect(result.current.warning).toBeNull();
  });
});
