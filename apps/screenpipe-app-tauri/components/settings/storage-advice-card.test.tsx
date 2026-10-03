// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { StorageAdviceCard } from "./storage-advice-card";
const mocks = vi.hoisted(() => ({
  settings: {} as any,
  reading: {} as any,
  update: vi.fn(),
  fetch: vi.fn(),
  managed: false,
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({
    settings: mocks.settings,
    updateSettings: mocks.update,
  }),
}));
vi.mock("@/lib/hooks/use-storage-capacity", () => ({
  useStorageCapacity: () => mocks.reading,
}));
vi.mock("@/lib/hooks/use-managed-policy", () => ({
  useManagedPolicy: () => ({
    isManagedDeploymentResolved: true,
    isSettingLocked: () => mocks.managed,
  }),
}));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("gt-react", () => ({
  useGT:
    () =>
    (s: string, v: Record<string, unknown> = {}) =>
      s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? k)),
}));
beforeEach(() => {
  mocks.settings = {
    localRetentionEnabled: true,
    localRetentionDays: 14,
    localRetentionMode: "media",
  };
  mocks.reading = {
    capacity: {
      totalBytes: 1024 * 1024 ** 3,
      availableBytes: 12 * 1024 ** 3,
      smallCapacity: false,
      lowSpace: true,
      recommendedDays: 7,
    },
    directory: "/recordings",
    loading: false,
    error: false,
    refresh: vi.fn(),
  };
  mocks.managed = false;
  mocks.update.mockReset().mockImplementation(async (updates) => {
    mocks.settings = { ...mocks.settings, ...updates };
  });
  mocks.fetch.mockReset().mockImplementation(async (path: string) => ({
    ok: true,
    json: async () =>
      path.includes("preview") ? { bytes: 3 * 1024 ** 3, file_count: 240 } : {},
  }));
});
afterEach(cleanup);
async function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review 7-day policy" }));
  await screen.findByText("Estimated older media: 240 files, 3.0 GB.");
}
it("distinguishes a large nearly-full drive and writes only after confirmation", async () => {
  render(<StorageAdviceCard />);
  expect(screen.getByText("Total capacity")).toBeInTheDocument();
  expect(screen.queryByText("Small drive")).not.toBeInTheDocument();
  expect(mocks.fetch).not.toHaveBeenCalled();
  await review();
  expect(mocks.update).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  );
  await screen.findByText("7-day media policy saved");
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
    enabled: true,
    mode: "media",
    retention_days: 7,
  });
  expect(mocks.update).toHaveBeenCalledWith(
    expect.objectContaining({
      localRetentionDays: 7,
      localRetentionMode: "media",
    }),
  );
});
it("cancel preserves the existing policy", async () => {
  render(<StorageAdviceCard />);
  await review();
  fireEvent.click(screen.getByRole("button", { name: "Keep current policy" }));
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it("blocks confirmation when deletion preview fails", async () => {
  mocks.fetch.mockRejectedValue(new Error("offline"));
  render(<StorageAdviceCard />);
  fireEvent.click(screen.getByRole("button", { name: "Review 7-day policy" }));
  await screen.findByText(
    "Could not preview older media. Retry before changing the policy.",
  );
  expect(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  ).toBeDisabled();
  expect(mocks.update).not.toHaveBeenCalled();
});
it("retains the old policy when configure fails", async () => {
  render(<StorageAdviceCard />);
  await review();
  mocks.fetch.mockResolvedValue({ ok: false });
  fireEvent.click(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  );
  await screen.findByText(
    "Could not confirm the policy change. Try again to apply the 7-day policy.",
  );
  expect(mocks.update).not.toHaveBeenCalled();
});
it("retries persistence without reconfiguring an already-active policy", async () => {
  mocks.update.mockRejectedValueOnce(new Error("disk"));
  render(<StorageAdviceCard />);
  await review();
  fireEvent.click(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  );
  await screen.findByText(/The 7-day policy is active/);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry saving settings" }),
  );
  await screen.findByText("7-day media policy saved");
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(mocks.update).toHaveBeenCalledTimes(2);
});
it("keeps success visible during a same-drive refresh", async () => {
  const { rerender } = render(<StorageAdviceCard />);
  await review();
  fireEvent.click(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  );
  await screen.findByText("7-day media policy saved");
  mocks.reading = { ...mocks.reading, directory: "", loading: true };
  rerender(<StorageAdviceCard />);
  mocks.reading = {
    ...mocks.reading,
    directory: "/recordings",
    loading: false,
  };
  rerender(<StorageAdviceCard />);
  expect(screen.getByText("7-day media policy saved")).toBeInTheDocument();
});
it("does not suggest a change when the volume cannot be measured", () => {
  mocks.reading = { ...mocks.reading, capacity: null, error: true };
  render(<StorageAdviceCard />);
  expect(screen.queryByText("Review 7-day policy")).not.toBeInTheDocument();
  expect(screen.getByText(/Storage could not be checked/)).toBeInTheDocument();
});
it("preserves managed retention", () => {
  mocks.managed = true;
  render(<StorageAdviceCard />);
  expect(
    screen.getByText("Retention is managed by your organization."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Review 7-day policy")).not.toBeInTheDocument();
});

it("stops claiming the saved policy is active after a manual change", async () => {
  const { rerender } = render(<StorageAdviceCard />);
  await review();
  fireEvent.click(
    screen.getByRole("button", { name: "Use 7-day media policy" }),
  );
  await screen.findByText("7-day media policy saved");
  mocks.settings = { ...mocks.settings, localRetentionDays: 30 };
  rerender(<StorageAdviceCard />);
  expect(
    screen.queryByText("7-day media policy saved"),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Review 7-day policy" }),
  ).toBeInTheDocument();
});
