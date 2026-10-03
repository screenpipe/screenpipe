// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { StorageAdviceNotifier } from "./storage-advice-notifier";
const mocks = vi.hoisted(() => ({
  settings: {} as any,
  capacity: {} as any,
  fetch: vi.fn(),
  blocked: false,
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({ settings: mocks.settings }),
}));
vi.mock("@/lib/hooks/use-managed-policy", () => ({
  useManagedPolicy: () => ({
    isManagedDeploymentResolved: true,
    isSectionHidden: () => mocks.blocked,
    isSettingLocked: () => false,
  }),
}));
vi.mock("@/lib/hooks/use-storage-capacity", () => ({
  useStorageCapacity: () => ({ capacity: mocks.capacity, directory: "/test" }),
}));
vi.mock("@/lib/notifications/app-server", () => ({
  appServerFetch: mocks.fetch,
}));
beforeEach(() => {
  localStorage.clear();
  mocks.blocked = false;
  mocks.settings = { localRetentionEnabled: false };
  mocks.capacity = {
    totalBytes: 1024 * 1024 ** 3,
    availableBytes: 12 * 1024 ** 3,
    smallCapacity: false,
    lowSpace: true,
    recommendedDays: 7,
  };
  mocks.fetch
    .mockReset()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: "notification sent" }),
    });
});
afterEach(cleanup);
it("deduplicates across remounts and allows another pressure notice after seven days", async () => {
  const first = render(<StorageAdviceNotifier />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  first.unmount();
  const second = render(<StorageAdviceNotifier />);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  second.unmount();
  localStorage.setItem(
    "storage-advice-v1:/test:pressure",
    String(Date.now() - 8 * 24 * 60 * 60 * 1000),
  );
  render(<StorageAdviceNotifier />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
});
it("never repeats the setup explanation", () => {
  mocks.settings = {
    localRetentionEnabled: true,
    localRetentionDays: 7,
    storageRetentionDefaultDays: 7,
  };
  localStorage.setItem("storage-advice-v1:/test:default", "1");
  render(<StorageAdviceNotifier />);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each(["failure", "quiet hours"])("allows retry after %s", async (reason) => {
  mocks.fetch.mockResolvedValueOnce(
    reason === "failure"
      ? { ok: false }
      : { ok: true, json: async () => ({ message: "notifications paused" }) },
  );
  const first = render(<StorageAdviceNotifier />);
  await waitFor(() =>
    expect(localStorage.getItem("storage-advice-v1:/test:pressure")).toBe("0"),
  );
  first.unmount();
  render(<StorageAdviceNotifier />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
});
it("does not notify when Storage is hidden", () => {
  mocks.blocked = true;
  render(<StorageAdviceNotifier />);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
