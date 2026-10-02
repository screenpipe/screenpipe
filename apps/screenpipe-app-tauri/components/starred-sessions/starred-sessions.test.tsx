// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportStarredSession,
  sessionContext,
  useStarredSessions,
  type StarredSession,
} from "./use-starred-sessions";
import { StarredSessionPanel } from "./starred-session-panel";
import { StarredTimeline } from "./starred-timeline";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  chat: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@/lib/hooks/use-tauri-event", () => ({ useTauriEvent: vi.fn() }));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: mocks.chat }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: mocks.reveal }));
let saved: StarredSession[];
const session: StarredSession = {
  id: "example",
  start: "2026-10-02T17:00:00.000Z",
  end: "2026-10-02T17:18:00.000Z",
  revision: 1,
  has_audio: true,
  hd_requested: false,
};
const response = (value: unknown, ok = true) => ({
  ok,
  json: async () => value,
});
beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  mocks.fetch.mockImplementation(async (_path, init) => {
    if (init?.method === "POST") {
      const row = {
        ...JSON.parse(init.body),
        revision: JSON.parse(init.body).revision + 1,
        has_audio: false,
      };
      saved = [row, ...saved.filter((s) => s.id !== row.id)];
      return response(row);
    }
    return response({ data: saved });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function Panel() {
  return <StarredSessionPanel state={useStarredSessions()} />;
}
describe("starred sessions", () => {
  it("opens one shared dialog from the timeline without a sidebar entry", async () => {
    render(
      <>
        <StarredTimeline />
        <StarredTimeline showStrip />
      </>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Star session", exact: true }),
    );
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "15 min" })).toBeVisible();
  });

  it("keeps secondary actions collapsed and offers a new session after ending", async () => {
    saved = [{ ...session, start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 60000).toISOString() }];
    render(<Panel />);
    await screen.findByRole("button", { name: "End session" });
    expect(screen.queryByText("Keep an important stretch of work easy to find.")).toBeNull();
    expect(screen.queryByText("Audio not found")).toBeNull();
    expect(screen.queryByLabelText("Saved session")).toBeNull();
    const more = screen.getByText("More");
    expect(more.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(more);
    expect(more.closest("details")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Ask about session" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    await screen.findByRole("button", { name: "New session" });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "5 min" }));
    await screen.findByRole("button", { name: "End session" });
    expect(saved).toHaveLength(2);
  });
  it("persists a timed boundary and restores it on remount", async () => {
    const hook = renderHook(useStarredSessions);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(() => hook.result.current.start(15, true));
    const star = hook.result.current.active!;
    expect(Date.parse(star.end) - Date.parse(star.start)).toBe(15 * 60000);
    expect(star.hd_requested).toBe(true);
    hook.unmount();
    const reopened = renderHook(useStarredSessions);
    await waitFor(() =>
      expect(reopened.result.current.active?.id).toBe(star.id),
    );
    await act(() => reopened.result.current.end());
    expect(reopened.result.current.active).toBeUndefined();
  });
  it("retries the identical request after a lost response", async () => {
    const hook = renderHook(useStarredSessions);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    mocks.fetch.mockRejectedValueOnce(new Error("network interrupted"));
    await act(() => hook.result.current.start(5));
    const failed = mocks.fetch.mock.calls.find(
      (c) => c[1]?.method === "POST",
    )![1].body;
    await act(() => hook.result.current.retry());
    expect(
      mocks.fetch.mock.calls.filter((c) => c[1]?.method === "POST").at(-1)![1]
        .body,
    ).toBe(failed);
  });
  it("expired sessions stay saved but are no longer active", async () => {
    saved = [
      {
        ...session,
        start: new Date(Date.now() - 60000).toISOString(),
        end: new Date(Date.now() - 1).toISOString(),
      },
    ];
    const hook = renderHook(useStarredSessions);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(hook.result.current.active).toBeUndefined();
    expect(hook.result.current.sessions).toHaveLength(1);
  });
  it("offers all four durations and no audio checkbox", async () => {
    render(<Panel />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "15 min" })).toBeEnabled(),
    );
    for (const n of [5, 15, 30, 60])
      expect(screen.getByRole("button", { name: `${n} min` })).toBeVisible();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText("Session capture quality"), {
      target: { value: "hd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "30 min" }));
    await waitFor(() => expect(saved[0]?.hd_requested).toBe(true));
    expect(Date.parse(saved[0].end) - Date.parse(saved[0].start)).toBe(
      30 * 60000,
    );
  });
  it("saves edited boundaries with the current revision", async () => {
    saved = [session];
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit session end" }));
    const before = screen.getByLabelText("Session end") as HTMLInputElement;
    const date = new Date(session.end);
    date.setMinutes(date.getMinutes() + 5);
    const value = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
    fireEvent.change(before, { target: { value } });
    fireEvent.keyDown(before, { key: "Enter" });
    fireEvent.blur(before);
    await waitFor(() => expect(saved[0].revision).toBe(2));
    expect(Date.parse(saved[0].end)).toBe(Date.parse(session.end) + 5 * 60000);
    expect(mocks.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Edit times" })).toBeNull();
  });
  it("does not truncate stored milliseconds when leaving an unchanged time", async () => {
    saved = [{ ...session, end: "2026-10-02T17:18:00.456Z" }];
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit session end" }));
    fireEvent.blur(screen.getByLabelText("Session end"));
    expect(saved[0].end).toBe("2026-10-02T17:18:00.456Z");
    expect(mocks.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });
  it("saves a start time on blur and cancels an end edit with Escape", async () => {
    saved = [session];
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit session start" }));
    const input = screen.getByLabelText("Session start") as HTMLInputElement;
    const earlier = new Date(Date.parse(session.start) - 60000);
    const local = new Date(earlier.getTime() - earlier.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    fireEvent.change(input, { target: { value: local } });
    fireEvent.blur(input);
    await waitFor(() => expect(saved[0].start).toBe(earlier.toISOString()));
    fireEvent.click(screen.getByRole("button", { name: "Edit session end" }));
    const end = screen.getByLabelText("Session end");
    fireEvent.change(end, { target: { value: local } });
    fireEvent.keyDown(end, { key: "Escape" });
    fireEvent.blur(end);
    expect(saved[0].end).toBe(session.end);
    expect(mocks.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
    expect(screen.queryByLabelText("Session end")).toBeNull();
  });
  it("keeps invalid inline edits visible without writing them", async () => {
    saved = [session];
    render(<Panel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit session end" }));
    const end = screen.getByLabelText("Session end");
    fireEvent.change(end, { target: { value: "" } });
    fireEvent.blur(end);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid date and time.");
    fireEvent.change(end, { target: { value: "2020-01-01T10:00" } });
    fireEvent.keyDown(end, { key: "Enter" });
    expect(screen.getByRole("alert")).toHaveTextContent("End time must be after start time.");
    expect(mocks.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
    expect(screen.getByLabelText("Session end")).toBeVisible();
  });
  it("exports exact bounds and automatically uses captured audio", async () => {
    mocks.fetch.mockResolvedValueOnce(
      response({ output_path: "/tmp/session.mp4" }),
    );
    expect(
      await exportStarredSession({
        ...session,
        end: new Date(Date.now() - 1000).toISOString(),
      }),
    ).toBe("/tmp/session.mp4");
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).include_audio).toBe(
      true,
    );
    expect(sessionContext(session)).toContain("starred_session_id=example");
  });
  it("does not export a future interval", async () => {
    await expect(
      exportStarredSession({
        ...session,
        end: new Date(Date.now() + 60000).toISOString(),
      }),
    ).rejects.toThrow("End the session");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
