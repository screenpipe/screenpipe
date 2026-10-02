// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { cleanup, render } from "@testing-library/react";
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
  onStartFromEvent: noop, starting: false, loadingMore: false, hasMore: false,
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
});
