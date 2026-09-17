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
  executeNotificationAction: vi.fn(),
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
