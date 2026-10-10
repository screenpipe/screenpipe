// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDiskUsage: vi.fn(),
  dataDir: "default",
}));

vi.mock("@/lib/utils/tauri", () => ({
  commands: { getDiskUsage: mocks.getDiskUsage },
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: { dataDir: mocks.dataDir },
    getDataDir: async () => `/data/${mocks.dataDir}`,
  }),
}));

import { useDiskUsage } from "@/lib/hooks/use-disk-usage";

function usage(total: string) {
  return { status: "ok", data: { total_data_size: total } };
}

beforeEach(() => {
  mocks.dataDir = "default";
  mocks.getDiskUsage.mockResolvedValue(usage("1 GB"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDiskUsage", () => {
  it("shows the last numbers on a return visit and refreshes them quietly", async () => {
    const first = renderHook(() => useDiskUsage());
    expect(first.result.current.isLoading).toBe(true);
    await waitFor(() =>
      expect(first.result.current.diskUsage?.total_data_size).toBe("1 GB"),
    );
    first.unmount();

    let answer!: (value: unknown) => void;
    mocks.getDiskUsage.mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const second = renderHook(() => useDiskUsage());

    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.diskUsage?.total_data_size).toBe("1 GB");
    await waitFor(() => expect(answer).toBeDefined());
    expect(second.result.current.isLoading).toBe(false);

    await act(async () => answer(usage("2 GB")));
    expect(second.result.current.diskUsage?.total_data_size).toBe("2 GB");
  });

  it("still shows the loading state for an explicit refresh", async () => {
    const { result } = renderHook(() => useDiskUsage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mocks.getDiskUsage.mockImplementation(() => new Promise(() => undefined));
    act(() => void result.current.refetch());

    expect(result.current.isLoading).toBe(true);
  });

  it("stays loading through every render of a data dir change", async () => {
    const renders: Array<{ isLoading: boolean; hasUsage: boolean }> = [];
    const { result, rerender } = renderHook(() => {
      const state = useDiskUsage();
      renders.push({
        isLoading: state.isLoading,
        hasUsage: state.diskUsage !== null,
      });
      return state;
    });
    await waitFor(() => expect(result.current.diskUsage).not.toBeNull());

    mocks.dataDir = "/Volumes/external";
    mocks.getDiskUsage.mockImplementation(() => new Promise(() => undefined));
    renders.length = 0;
    rerender();

    // Without numbers and not loading, Storage would read "0 KB".
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.filter((r) => !r.hasUsage && !r.isLoading)).toEqual([]);
  });

  it("shows the loading state when the numbers belong to another data dir", async () => {
    const first = renderHook(() => useDiskUsage());
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    first.unmount();

    mocks.dataDir = "/Volumes/external";
    mocks.getDiskUsage.mockImplementation(() => new Promise(() => undefined));
    const second = renderHook(() => useDiskUsage());

    expect(second.result.current.isLoading).toBe(true);
  });
});
