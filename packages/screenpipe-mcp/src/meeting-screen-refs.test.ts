// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it, vi } from "vitest";
import { findMeetingScreenRefs } from "./meeting-screen-refs";

const meeting = {
  meeting_app: "Google Meet",
  meeting_start: "2026-11-24T10:00:00-08:00",
  meeting_end: "2026-11-24T10:30:00-08:00",
  title: "Project kickoff",
};
const room = "https://meet.google.com/abc-defg-hij";
const timestamp = "2026-11-24T18:15:00Z";

function screen(frame_id: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "OCR",
    content: {
      frame_id, timestamp, app_name: "Google Chrome", window_name: "Meet - abc-defg-hij",
      browser_url: room, text_source: "accessibility", ...overrides,
    },
  };
}

function page(data: ReturnType<typeof screen>[], total = data.length) {
  return Response.json({ data, pagination: { total } });
}

describe("meeting screen references", () => {
  it("links a single in-call room within the meeting bounds and returns shared frame IDs", async () => {
    const api = vi.fn(async () => page([
      screen(1, { browser_url: "https://example.com/?to=meet.google.com/zzz-zzzz-zzz" }),
      screen(2, { browser_url: "https://meet.google.com/" }),
      screen(3, { timestamp: "2026-11-24T18:31:00Z" }),
      screen(5, { text_source: "ocr" }),
      screen(4, { browser_url: room + "?authuser=1" }),
      screen(4),
    ]));
    expect(await findMeetingScreenRefs(meeting, 3, api)).toEqual({
      screen_refs_status: "matched",
      screen_refs: [
        { frame_id: 4, timestamp, screenshot_uri: "screenpipe://frame/4", text_source: "accessibility" },
        { frame_id: 5, timestamp, screenshot_uri: "screenpipe://frame/5", text_source: "ocr" },
      ],
    });
    expect(api).toHaveBeenCalledWith(
      expect.stringContaining("start_time=2026-11-24T18%3A00%3A00.000Z&end_time=2026-11-24T18%3A30%3A00.000Z"),
      { signal: expect.any(AbortSignal) },
    );
    expect(api).toHaveBeenCalledWith(expect.stringContaining("browser_url=meet.google.com"), expect.anything());
  });

  it("withholds references when rooms conflict or an untitled-room match is only partially covered", async () => {
    const anotherRoom = screen(2, { browser_url: "https://meet.google.com/xyz-abcd-efg" });
    const api = vi.fn()
      .mockResolvedValueOnce(page([screen(1), anotherRoom]))
      .mockResolvedValueOnce(page([screen(1)], 200));
    for (let i = 0; i < 2; i++) {
      expect(await findMeetingScreenRefs(meeting, 3, api)).toEqual({
        screen_refs: [], screen_refs_status: "ambiguous",
      });
    }
  });

  it("uses a matching room title to disambiguate provider captures", async () => {
    const api = vi.fn(async () => page([
      screen(1, { browser_url: "https://meet.google.com/xyz-abcd-efg" }),
      screen(2, { window_name: "Meet | Project kickoff" }),
    ]));
    expect((await findMeetingScreenRefs(meeting, 1, api)).screen_refs.map(ref => ref.frame_id)).toEqual([2]);
  });

  it("requires both app and specific title for native captures", async () => {
    const api = vi.fn()
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([
        screen(1, { app_name: "Zoom Workplace", window_name: "Project kickoff", browser_url: null }),
        screen(2, { app_name: "Zoom Workplace", window_name: "Project kickoff notes", browser_url: null }),
        screen(3, { window_name: "Project kickoff", browser_url: null }),
      ]));
    const result = await findMeetingScreenRefs({ ...meeting, meeting_app: "zoom.us" }, 3, api);
    expect(result.screen_refs.map(ref => ref.frame_id)).toEqual([1]);
  });

  it("keeps a failed lookup distinct from a missing match and skips manual meetings", async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error("backend unavailable"));
    expect(await findMeetingScreenRefs(meeting, 3, api)).toEqual({
      screen_refs_status: "unavailable", screen_refs: [],
    });
    expect(await findMeetingScreenRefs({ ...meeting, meeting_app: "manual" }, 3, api)).toEqual({
      screen_refs_status: "no_match", screen_refs: [],
    });
    expect(api).toHaveBeenCalledTimes(1);
  });
});
