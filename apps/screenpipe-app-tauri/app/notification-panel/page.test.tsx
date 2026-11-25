// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotificationPanelPage from "./page";

const bridge = vi.hoisted(() => ({
  receive: (_event: { payload: string }) => {},
  copy: vi.fn().mockResolvedValue(undefined),
  hide: vi.fn().mockResolvedValue(undefined),
  show: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name, callback) => {
    bridge.receive = callback;
    return Promise.resolve(() => {});
  }),
  emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    copyTextToClipboard: bridge.copy,
    hideNotificationPanel: bridge.hide,
    showNotificationPanel: bridge.show,
  },
}));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("localforage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue([]),
    setItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/components/markdown", () => ({
  notificationUrlTransform: (url: string) => url,
  openScreenpipeViewerLink: vi.fn(),
  screenpipeViewerPathFromHref: vi.fn(),
}));
vi.mock("@/lib/notifications/actions", () => ({
  executeNotificationAction: bridge.execute,
}));

const payload = {
  id: "compact-notification",
  type: "pipe",
  title: "Ready for review",
  body: "A proposal is ready.",
  pipe_name: "scaling",
  autoDismissMs: 0,
  actions: [
    {
      type: "deeplink",
      label: "Review",
      primary: true,
      url: "screenpipe://home",
    },
    { type: "dismiss", label: "Dismiss" },
  ],
};
async function deliver(data = payload) {
  await act(async () => {
    bridge.receive({ payload: JSON.stringify(data) });
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("compact notification panel", () => {
  it("keeps a single dismissal and reveals utilities and feedback only on request", async () => {
    render(<NotificationPanelPage />);
    await deliver();
    expect(screen.getAllByRole("button", { name: /dismiss/i })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByText("Ready for review"));
    expect(
      screen.queryByRole("button", { name: "Copy notification" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Useful notification" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy notification" }));
    await waitFor(() =>
      expect(bridge.copy).toHaveBeenCalledWith(
        "Ready for review\n\nA proposal is ready.",
      ),
    );
    expect(bridge.hide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Feedback" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Not useful notification" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "What should improve" }),
      { target: { value: "Include the source" } },
    );
    fireEvent.mouseLeave(screen.getByText("Ready for review"));
    expect(
      screen.getByRole("textbox", { name: "What should improve" }),
    ).toHaveValue("Include the source");
    await deliver({ ...payload, id: "next" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Notification options" }),
    ).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });

  it("shows a remote image in the body as alt text without loading it", async () => {
    const { container } = render(<NotificationPanelPage />);
    await deliver({
      ...payload,
      body: "chart below ![remote chart](https://example.com/x.png?d=secret)",
    });
    // The panel's own app icon is an <img>, so check only the body.
    const body = container.querySelector(".notif-md");
    expect(body).toHaveTextContent("chart below remote chart");
    expect(body?.querySelector("img")).toBeNull();
    expect(container.querySelector("img[src*='example.com']")).toBeNull();
  });

  it("pauses expiration while options are open and resumes when closed", async () => {
    vi.useFakeTimers();
    render(<NotificationPanelPage />);
    await deliver({ ...payload, autoDismissMs: 1000 });
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(bridge.hide).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Notification options" }),
    );
    act(() => vi.advanceTimersByTime(1200));
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });
});


describe("meeting join notification delivery", () => {
  const meeting = {
    ...payload, type: "meeting", title: "meeting starting in 1 min",
    actions: [
      { type: "meeting_join", id: "join", label: "join and take notes", url: "https://meet.google.com/example", primary: true },
      { type: "api", id: "hd", label: "+ HD", url: "/capture/hd/start", method: "POST", body: { boundTo: "prewarm_pending" } },
    ],
  };
  it("renders the split card and dispatches join + HD from the incoming notification", async () => {
    render(<NotificationPanelPage />);
    await deliver(meeting);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(1));
    expect(bridge.execute).toHaveBeenCalledWith(expect.objectContaining({ type: "meeting_join", url: meeting.actions[0].url, screen_detail: { boundTo: "prewarm_pending" } }), expect.anything());
    expect(screen.queryByRole("button", { name: "Notification options" })).toBeNull();
  });
  it("keeps the join action available after the scheduled handoff", async () => {
    vi.useFakeTimers();
    render(<NotificationPanelPage />);
    await deliver({
      ...meeting,
      title: "meeting starting in 30 sec",
      autoDismissMs: 60_000,
    });

    act(() => vi.advanceTimersByTime(31_000));
    expect(
      screen.getByRole("button", { name: /^join and take notes$/i }),
    ).toBeInTheDocument();
    expect(bridge.hide).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(30_000));
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });

  it("dismisses immediately while the join action is still running", async () => {
    let finish!: () => void;
    bridge.execute.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<NotificationPanelPage />);
    await deliver(meeting);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    await waitFor(() => expect(bridge.hide).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Meeting starting" })).toBeNull();
    await act(async () => finish());
  });
  it("shows capture failure only after closing the join card", async () => {
    bridge.execute.mockImplementationOnce(async (_action, context) => context.onScreenDetailError());
    render(<NotificationPanelPage />);
    await deliver(meeting);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    await waitFor(() => expect(bridge.show).toHaveBeenCalledTimes(1));
    expect(JSON.parse(bridge.show.mock.calls[0][0])).toMatchObject({ type: "warning", title: "Screen detail could not start" });
    expect(bridge.hide.mock.invocationCallOrder[0]).toBeLessThan(bridge.show.mock.invocationCallOrder[0]);
  });
});
