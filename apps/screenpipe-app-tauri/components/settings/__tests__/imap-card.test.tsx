// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { commands } from "@/lib/utils/tauri";
import { ImapCard } from "../imap-card";

vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
vi.mock("@/lib/utils/tauri", () => ({ commands: { readClipboardText: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

it("adds a second IMAP account and disconnects only that account", async () => {
  const personal = { instance: null, connected: true, credentials: { username: "personal@example.com" } };
  const work = { instance: "work", connected: true, credentials: { username: "work@example.com" } };
  const accounts = [personal] as Array<typeof personal | typeof work>;
  const fetchMock = vi.mocked(localFetch);
  fetchMock.mockImplementation(async (path, options) => {
    if (path === "/connections/imap/instances") return Response.json({ instances: accounts });
    if (path === "/connections/imap/test") return Response.json({ success: true });
    if (path === "/connections/imap/accounts" && options?.method === "POST") {
      accounts.push(work);
      return Response.json({ instance: "work" });
    }
    if (path === "/connections/imap/instances/work" && options?.method === "DELETE") {
      accounts.pop();
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected path: ${path}`);
  });

  render(<ImapCard />);
  expect(await screen.findByText("personal@example.com")).toBeInTheDocument();
  expect(screen.getByText("Default inbox · read-only")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), { target: { value: "work@example.com" } });
  fireEvent.change(screen.getByPlaceholderText("App-specific password"), { target: { value: "appsecret" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));

  expect(await screen.findByText("work@example.com")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect work@example.com" }));
  await waitFor(() => expect(screen.queryByText("work@example.com")).not.toBeInTheDocument());
  expect(screen.getByText("personal@example.com")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith("/connections/imap", expect.anything());
});

it("waits for a new clipboard copy when adding a second Gmail account", async () => {
  const fetchMock = vi.mocked(localFetch);
  fetchMock.mockClear();
  fetchMock.mockImplementation(async (path) => {
    if (path === "/connections/imap/instances") {
      return Response.json({ instances: [{
        instance: null,
        connected: true,
        credentials: { username: "personal@gmail.com" },
      }] });
    }
    return Response.json({ success: true });
  });

  render(<ImapCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Add account" }));
  fireEvent.change(screen.getByPlaceholderText("you@gmail.com"), { target: { value: "work@gmail.com" } });

  vi.useFakeTimers();
  try {
    const clipboard = vi.mocked(commands.readClipboardText);
    clipboard.mockResolvedValue({ status: "ok", data: "aaaa bbbb cccc dddd" });
    fireEvent.click(screen.getByRole("button", { name: "Get app password" }));
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(fetchMock.mock.calls.some(([url]) => url === "/connections/imap/test")).toBe(false);

    clipboard.mockResolvedValue({ status: "ok", data: "pppp qqqq rrrr ssss" });
    await act(() => vi.advanceTimersByTimeAsync(1200));
    const testCall = fetchMock.mock.calls.find(([url]) => url === "/connections/imap/test");
    expect(JSON.parse(String(testCall?.[1]?.body)).credentials).toMatchObject({
      username: "work@gmail.com",
      password: "ppppqqqqrrrrssss",
    });
  } finally {
    vi.useRealTimers();
  }
});
