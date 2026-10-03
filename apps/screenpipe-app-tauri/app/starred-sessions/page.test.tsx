// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  hide: vi.fn(),
  fetch: vi.fn(),
  visibility: null as null | ((e: { payload: boolean }) => void),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { hideStarredSessions: mocks.hide },
}));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (_: string, callback: typeof mocks.visibility) => {
    mocks.visibility = callback;
  },
}));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hide.mockResolvedValue({ status: "ok", data: null });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
});
afterEach(cleanup);

it("opens just the duration picker and dismisses with Escape", async () => {
  render(<Page />);
  expect(
    await screen.findByRole("dialog", { name: "Starred work sessions" }),
  ).toBeVisible();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "15 min" })).toBeEnabled(),
  );
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.hide).toHaveBeenCalledTimes(1);
});
it("unmounts controls while hidden and reloads on reopening", async () => {
  render(<Page />);
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  act(() => mocks.visibility!({ payload: false }));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => mocks.visibility!({ payload: true }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "5 min" })).toBeVisible();
});
it("keeps storage errors and retry visible inside the picker", async () => {
  mocks.fetch.mockResolvedValue({
    ok: false,
    json: async () => ({ error: "could not access starred sessions" }),
  });
  render(<Page />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not access starred sessions",
  );
  expect(screen.getByRole("button", { name: "15 min" })).toBeDisabled();
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "15 min" })).toBeEnabled(),
  );
});
it("does not dismiss when an editor consumes Escape", () => {
  render(<Page />);
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  event.preventDefault();
  window.dispatchEvent(event);
  expect(mocks.hide).not.toHaveBeenCalled();
});
