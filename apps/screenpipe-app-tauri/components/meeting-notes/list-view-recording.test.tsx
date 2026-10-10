// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListView } from "./list-view";
import { computeLiveCaptureState } from "@/lib/utils/live-capture-state";

vi.mock("./coming-up", () => ({ ComingUp: () => null }));
vi.mock("./past-meetings", () => ({ PastMeetings: () => null }));

afterEach(cleanup);

const noop = () => {};
const props: React.ComponentProps<typeof ListView> = {
  meetings: [], activeId: 1,
  activeMeeting: {
    id: 1, title: "Meeting in progress", meeting_start: "2026-09-26T12:00:00Z",
    meeting_end: null, meeting_app: "zoom", attendees: null, note: "",
    detection_source: "manual", created_at: "2026-09-26T12:00:00Z",
  },
  onSelect: noop, onDelete: noop, onMerged: noop, onStart: noop, onStop: noop,
  onStartFromEvent: noop, starting: false, loadingMore: false, hasMore: false, canLoadMore: true,
  onLoadMore: noop, errorText: null, onRetry: noop, comingUp: [],
  comingUpStatus: "ready", connectedCalendarSources: [],
  onOpenCalendarConnections: noop, meetingActive: true, searchInput: "",
  onSearchInputChange: noop, searching: false, hasSearchQuery: false,
};

const captureState = (status: string) => computeLiveCaptureState({
  isLive: true, health: { capture_status: { status } },
});

describe("meeting recording indicator", () => {
  it("keeps the same animation mounted through transcription backlog and silence", () => {
    const { container, rerender } = render(
      <ListView {...props} captureState={captureState("recording")} />,
    );
    const bars = Array.from(container.querySelectorAll(".meeting-listening-stick"));
    expect(bars).toHaveLength(5);
    for (const status of ["transcript_pending", "waiting_for_voice", "recording"]) {
      rerender(<ListView {...props} captureState={captureState(status)} />);
      const current = container.querySelectorAll(".meeting-listening-stick");
      expect(current).toHaveLength(5);
      bars.forEach((bar, index) => expect(current[index]).toBe(bar));
    }
  });

  it.each(["waiting_for_meeting", "audio_stalled", "disabled", "mic_paused"])(
    "does not animate when capture is %s", (status) => {
      const { container } = render(<ListView {...props} captureState={captureState(status)} />);
      expect(container.querySelector(".meeting-listening-stick")).toBeNull();
    },
  );

  it("removes the recording indicator when the meeting stops", () => {
    const { container, rerender } = render(<ListView {...props} captureState={captureState("recording")} />);
    rerender(<ListView {...props} meetingActive={false} />);
    expect(container.querySelector(".meeting-listening-stick")).toBeNull();
  });

  it("keeps a search that filters the list visible and clearable", () => {
    const onSearchInputChange = vi.fn();
    render(
      <ListView
        {...props}
        searchInput="standup"
        hasSearchQuery
        onSearchInputChange={onSearchInputChange}
      />,
    );

    expect(screen.getByPlaceholderText("Search by title, email, note…")).toHaveValue("standup");
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(onSearchInputChange).toHaveBeenCalledWith("");
  });

  it("leaves the header to the recording strip without a search", () => {
    render(<ListView {...props} />);
    expect(screen.queryByPlaceholderText("Search by title, email, note…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Search meetings" })).toBeNull();
  });
});

describe("meeting list paging", () => {
  it("holds \"Show more\" until the list can be paged", () => {
    const meetings = [props.activeMeeting!];
    const { rerender } = render(
      <ListView {...props} meetings={meetings} hasMore canLoadMore={false} />,
    );
    expect(screen.getByRole("button", { name: "Show more" })).toBeDisabled();

    rerender(<ListView {...props} meetings={meetings} hasMore canLoadMore />);
    expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled();
  });
});
