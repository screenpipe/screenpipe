// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MeetingJoinNotification } from "./meeting-join-notification";
import { meetingJoinChoices, meetingProvider } from "@/lib/notifications/meeting-join";
import type { NotificationAction } from "@/lib/notifications/actions";

const actions: NotificationAction[] = [
  { id: "join", type: "meeting_join", label: "join and take notes", url: "https://meet.google.com/example", deeplinkUrl: "screenpipe://meeting/42", primary: true },
  { id: "hd", type: "api", url: "/capture/hd/start", method: "POST", body: { boundTo: "prewarm_pending" }, label: "+ HD" },
];
const openNoteActions: NotificationAction[] = [
  { id: "open-live-notes", action: "open-live-notes", type: "deeplink", label: "open note", url: "screenpipe://meeting/42", primary: true },
  { id: "record-hd", action: "record-hd", type: "api", label: "open note + HD", url: "/capture/hd/start", method: "POST", body: { meetingId: 42 }, deeplinkUrl: "screenpipe://meeting/42" },
];
const props = { title: "meeting starting in 1 min", body: "Weekly team sync", actions, onDismiss: vi.fn() };

describe("shared desktop join card", () => {
  it("keeps the shared footprint, scaled geometry, and action surface with or without HD", () => {
    const { container, rerender } = render(<MeetingJoinNotification {...props} onAction={vi.fn()} />);
    const card = screen.getByRole("region", { name: "Meeting starting" });
    expect(card).toHaveStyle({ width: "460px", height: "124px" });
    const controls = container.querySelector(".meeting-join-controls");
    expect(controls).toHaveStyle({ borderRadius: "6px", background: "rgb(235, 235, 235)" });

    for (const scale of [1, 1.5, 2]) {
      rerender(<MeetingJoinNotification {...props} scale={scale} onAction={vi.fn()} />);
      expect((container.firstElementChild as HTMLDivElement).style.transform).toBe(`scale(${scale})`);
    }
    rerender(<MeetingJoinNotification {...props} actions={[actions[0]]} onAction={vi.fn()} />);
    expect(container.querySelector(".meeting-join-controls")).toHaveStyle({
      borderRadius: "6px", background: "rgb(235, 235, 235)",
    });
  });
  it("joins normally in one click without starting HD", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<MeetingJoinNotification {...props} onAction={onAction} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "join and take notes" })));
    expect(onAction).toHaveBeenCalledWith(actions[0]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
  it("joins and records HD in one click, preserving the meeting and note URLs", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<MeetingJoinNotification {...props} onAction={onAction} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" })));
    expect(onAction).toHaveBeenCalledWith({ ...actions[0], id: "hd", screen_detail: actions[1].body });
  });
  it("prevents a second join while the first request is pending", async () => {
    let finish!: () => void;
    const onAction = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<MeetingJoinNotification {...props} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Join and take notes with HD screen recording" }));
    fireEvent.click(screen.getByRole("button", { name: "join and take notes" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });
  it("only offers HD when the notification includes an eligible capture action", () => {
    render(<MeetingJoinNotification {...props} actions={[actions[0]]} onAction={vi.fn()} />);
    expect(screen.queryByText("join + HD")).toBeNull();
    expect(meetingJoinChoices([actions[0], { ...actions[1], url: "/unrelated" }])?.hd).toBeNull();
  });
  it("keeps the HD choice visible while truncating a long join label", () => {
    const longLabel = "join and take notes for the quarterly planning meeting";
    render(<MeetingJoinNotification {...props}
      actions={[{ ...actions[0], label: longLabel }, actions[1]]} onAction={vi.fn()} />);
    const joinButton = screen.getByRole("button", { name: longLabel });
    expect(joinButton.style.minWidth).toBe("0");
    expect(joinButton.style.flexGrow).toBe("1");
    expect(joinButton.querySelector("span")).toHaveStyle({ overflow: "hidden", textOverflow: "ellipsis" });
    expect(screen.getByRole("button", { name: "Join and take notes with HD screen recording" })).toBeInTheDocument();
  });
  it("uses the same scaled card for detected meetings and preserves open-note actions", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = render(<MeetingJoinNotification {...props}
      title="meeting detected" actions={openNoteActions} scale={1.5} onAction={onAction} />);
    expect(screen.getByRole("region", { name: "Meeting detected" })).toHaveStyle({ width: "460px", height: "124px" });
    expect((container.firstElementChild as HTMLDivElement).style.transform).toBe("scale(1.5)");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "open note + HD" })));
    expect(onAction).toHaveBeenCalledWith(openNoteActions[1]);
    rerender(<MeetingJoinNotification {...props} title="meeting detected"
      actions={[openNoteActions[0]]} onAction={onAction} />);
    expect(screen.getByRole("button", { name: "open note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "open note + HD" })).toBeNull();
  });
  it.each([
    ["https://meet.google.com/example", "googleMeet"], ["https://us02web.zoom.us/j/1", "zoom"],
    ["https://teams.microsoft.com/l/meetup-join/1", "teams"], ["https://example.webex.com/meet/test", "webex"],
    ["https://zoom.us.evil.example/", null], ["https://evil.example/?next=https://meet.google.com", null],
    ["not-a-url", null],
  ])("matches provider only from the destination hostname: %s", (url, expected) => {
    expect(meetingProvider(url)).toBe(expected);
  });
});
