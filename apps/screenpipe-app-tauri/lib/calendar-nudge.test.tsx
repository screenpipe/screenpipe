// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  save: vi.fn(),
  snapshot: vi.fn(),
  fetch: vi.fn(),
  notify: vi.fn(),
  log: vi.fn(),
  capture: vi.fn(),
  persistedLogs: vi.fn(async () => {}),
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  getStore: async () => ({
    get: async (key: string) => mocks.values.get(key),
    set: async (key: string, value: unknown) => {
      mocks.values.set(key, value);
    },
  }),
  saveAndEncrypt: mocks.save,
}));
vi.mock("@/lib/utils/calendar", () => ({
  fetchUpcomingCalendarSnapshot: mocks.snapshot,
}));
vi.mock("@/lib/api", () => ({
  localFetch: mocks.fetch,
  ensureApiReady: async () => {},
  getApiBaseUrl: () => "http://localhost:3030",
  appendAuthToken: (s: string) => s,
}));
vi.mock("@/lib/notifications/app-server", () => ({
  appServerFetch: mocks.notify,
}));
vi.mock("@/lib/utils/tauri", () => ({ commands: { writeBrowserLogs: mocks.persistedLogs } }));
vi.mock("@/lib/logging/browser-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logging/browser-log")>("@/lib/logging/browser-log");
  return { ...actual, writeBrowserLogNow: (...args: Parameters<typeof actual.writeBrowserLogNow>) => {
    mocks.log(...args);
    actual.writeBrowserLogNow(...args);
  } };
});
vi.mock("posthog-js", () => ({ default: { capture: mocks.capture } }));
vi.mock("@/lib/notifications/actions", () => ({
  CALENDAR_CONNECTIONS_URL: "screenpipe://calendar-connections",
}));

import {
  CALENDAR_NUDGE_KEY,
  claimInlineCalendarNudge,
  dismissCalendarNudge,
  observeCalendarNudgeMeeting,
} from "./calendar-nudge";
import {
  MeetingCalendarReminder,
  sendCalendarReminder,
} from "@/components/meeting-calendar-reminder";
import { CalendarNudge } from "@/components/meeting-notes/calendar-nudge";
import type { MeetingRecord } from "@/lib/utils/meeting-format";

const meeting: MeetingRecord = {
  id: 42,
  meeting_start: "2026-10-02T10:00:00Z",
  meeting_end: "2026-10-02T10:30:00Z",
  meeting_app: "zoom",
  detection_source: "auto",
  title: null,
  attendees: null,
  note: null,
  created_at: "2026-10-02T10:00:00Z",
};
const active = {
  active: true,
  activeMeetingId: 42,
  meetingApp: "zoom",
  detectionSource: "auto",
};
const ui = (s: string) => s;
const idle = () => true;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.save.mockResolvedValue(undefined);
  mocks.snapshot.mockResolvedValue({
    connectedSources: [],
    unknownSources: [],
    failedSources: [],
    events: [],
  });
  mocks.notify.mockResolvedValue(
    Response.json({ success: true, message: "notification sent" }),
  );
  mocks.fetch.mockImplementation(async (url: string) =>
    Response.json(url === "/meetings/status" ? { active: false } : meeting),
  );
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_: string, run: () => Promise<unknown>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared calendar prompt budget", () => {
  it("seeing the note persists suppression of the fallback and other notes", async () => {
    await observeCalendarNudgeMeeting(active);
    expect(await claimInlineCalendarNudge(meeting)).toBe(true);
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(await claimInlineCalendarNudge({ ...meeting, id: 43 })).toBe(false);
    expect(await claimInlineCalendarNudge(meeting)).toBe(true);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalled();
  });
  it("dismissal survives a remount and suppresses every surface", async () => {
    const onConnect = vi.fn();
    render(<CalendarNudge meeting={meeting} onConnect={onConnect} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Connect calendar",
        exact: true,
      }),
    );
    expect(onConnect).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss calendar reminder" }),
    );
    await waitFor(() =>
      expect(mocks.values.get(CALENDAR_NUDGE_KEY)).toMatchObject({
        dismissed: true,
      }),
    );
    cleanup();
    render(<CalendarNudge meeting={meeting} onConnect={onConnect} />);
    await act(async () => {
      await claimInlineCalendarNudge(meeting);
    });
    expect(
      screen.queryByRole("button", { name: "Connect calendar", exact: true }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Calendar connections" }),
    ).toBeNull();
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it.each([
    { connectedSources: ["google"], unknownSources: [] },
    { connectedSources: [], unknownSources: ["google"] },
    {
      connectedSources: ["google"],
      unknownSources: [],
      failedSources: ["google"],
    },
  ])(
    "does not promote setup for connected, failed, or unknown calendars: %j",
    async (snapshot) => {
      mocks.snapshot.mockResolvedValue(snapshot);
      await observeCalendarNudgeMeeting(active);
      expect(await claimInlineCalendarNudge(meeting)).toBe(false);
      await sendCalendarReminder(ui, idle);
      expect(mocks.notify).not.toHaveBeenCalled();
    },
  );
  it("does not consume the budget for a hidden or unmounted note", async () => {
    expect(await claimInlineCalendarNudge(meeting, () => false)).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("respects deliberate disconnection and manual meetings", async () => {
    await observeCalendarNudgeMeeting({ ...active, detectionSource: "manual" });
    expect(mocks.values.size).toBe(0);
    expect(
      await claimInlineCalendarNudge({
        ...meeting,
        detection_source: "manual",
      }),
    ).toBe(false);
    mocks.values.set("calendarUserDisconnected", true);
    expect(await claimInlineCalendarNudge(meeting)).toBe(false);
    mocks.values.delete("calendarUserDisconnected");
    await dismissCalendarNudge();
    expect(await claimInlineCalendarNudge(meeting)).toBe(false);
  });
  it("fails closed when suppression cannot be persisted", async () => {
    mocks.save.mockRejectedValue(new Error("disk full"));
    await expect(claimInlineCalendarNudge(meeting)).rejects.toThrow(
      "disk full",
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

describe("post-meeting fallback", () => {
  it("sends once from persisted pending state, then never promotes again", async () => {
    await observeCalendarNudgeMeeting(active);
    await sendCalendarReminder(ui, idle);
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).toHaveBeenCalledOnce();
    const body = JSON.parse(mocks.notify.mock.calls[0][1].body);
    expect(body).toMatchObject({
      type: "meeting",
      priority: "normal",
      actions: [{ url: "screenpipe://calendar-connections" }],
    });
    expect(await claimInlineCalendarNudge(meeting)).toBe(false);
  });
  it("never treats startup idle, an API failure or an unfinished meeting as meeting end", async () => {
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
    await observeCalendarNudgeMeeting(active);
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "offline" }, { status: 503 }),
    );
    await expect(sendCalendarReminder(ui, idle)).rejects.toThrow("HTTP 503");
    mocks.fetch.mockResolvedValue(
      Response.json({ ...meeting, meeting_end: null }),
    );
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("defers during a back-to-back meeting and rechecks status after loading calendars", async () => {
    await observeCalendarNudgeMeeting(active);
    await sendCalendarReminder(ui, () => false);
    mocks.fetch.mockImplementation(async (url: string) =>
      Response.json(url === "/meetings/status" ? { active: true } : meeting),
    );
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.values.get(CALENDAR_NUDGE_KEY)).not.toHaveProperty(
      "reminderConsumed",
    );
  });
  it("honors meeting notification preferences", async () => {
    await observeCalendarNudgeMeeting(active);
    mocks.values.set("settings", {
      notificationPrefs: { meetingLiveNotes: false },
    });
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous delivery failure after restart", async () => {
    await observeCalendarNudgeMeeting(active);
    mocks.notify.mockRejectedValue(new Error("response lost"));
    await expect(sendCalendarReminder(ui, idle)).rejects.toThrow(
      "response lost",
    );
    await sendCalendarReminder(ui, idle);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
  it("serializes simultaneous note and fallback attempts", async () => {
    await observeCalendarNudgeMeeting(active);
    await Promise.all([
      claimInlineCalendarNudge(meeting),
      sendCalendarReminder(ui, idle),
    ]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("follows real status transitions and reports delivery failure through browser logs", async () => {
    let socket: any;
    vi.stubGlobal(
      "WebSocket",
      class {
        onopen: any;
        onmessage: any;
        onclose: any;
        onerror: any;
        constructor() {
          socket = this;
        }
        close() {}
      },
    );
    mocks.notify.mockRejectedValue(new Error("HTTP 503"));
    const view = render(<MeetingCalendarReminder />);
    await waitFor(() => expect(socket?.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onmessage({ data: JSON.stringify(active) });
      socket.onmessage({ data: JSON.stringify({ active: false }) });
    });
    await waitFor(() =>
      expect(mocks.log).toHaveBeenCalledWith(
        "error",
        expect.stringContaining(
          "calendar reminder not confirmed: Error: HTTP 503",
        ),
      ),
    );
    // The support form collects this exact console_logs buffer; native support
    // collection also receives the same entry through writeBrowserLogs.
    expect(localStorage.getItem("console_logs")).toContain(
      "calendar reminder not confirmed: Error: HTTP 503",
    );
    expect(mocks.persistedLogs).toHaveBeenCalledWith([
      expect.objectContaining({
        level: "error",
        message: "calendar reminder not confirmed: Error: HTTP 503",
      }),
    ]);
    view.unmount();
    render(<MeetingCalendarReminder />);
    await waitFor(() => expect(socket?.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onmessage({ data: JSON.stringify({ active: false }) });
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});
