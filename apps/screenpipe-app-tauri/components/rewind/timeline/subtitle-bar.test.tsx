// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubtitleBar } from "./subtitle-bar";
import { mergeTimelineAudioUpdate } from "@/lib/hooks/timeline-frame-merge";
import type { AudioData, StreamTimeSeriesResponse } from "../timeline";

const now = Date.parse("2026-09-26T19:48:41Z");
const audio = (text: string, seconds = 0): AudioData => ({
  captured_at: new Date(now + seconds * 1000).toISOString(),
  audio_chunk_id: 31,
  transcription: text,
  device_name: "Microphone",
  is_input: true,
  audio_file_path: "fixture.wav",
  duration_secs: 5,
  start_offset: seconds,
});
const frame = (seconds: number, entries: AudioData[]): StreamTimeSeriesResponse => ({
  timestamp: new Date(now + seconds * 1000).toISOString(),
  devices: [{
    device_id: "screen", frame_id: String(seconds), frame: "", offset_index: 0, fps: 1,
    metadata: {
      file_path: "", app_name: "Test", window_name: "", text: "",
      timestamp: new Date(now + seconds * 1000).toISOString(),
    },
    audio: entries,
  }],
});

afterEach(cleanup);
describe("timeline captions from live meeting audio", () => {
  it("uses speech time instead of the earliest nearby screenshot", () => {
    const turn = audio("The transcript is here.");
    render(<SubtitleBar frames={[frame(0, [turn]), frame(-60, [turn])]} currentIndex={0} />);
    expect(screen.getByText("“The transcript is here.”")).toBeInTheDocument();
  });

  it("keeps different turns in one audio file", () => {
    render(<SubtitleBar frames={[frame(0, [audio("First turn"), audio("Second turn", 12)])]} currentIndex={0} />);
    expect(screen.getByText("“First turn”")).toBeInTheDocument();
    expect(screen.getByText("“Second turn”")).toBeInTheDocument();
  });

  it("shows late persisted audio without moving the timeline cursor", () => {
    const original = [frame(0, []), frame(-120, [])];
    const view = render(<SubtitleBar frames={original} currentIndex={0} />);
    const update = audio("Arrived after the frame");
    const updated = mergeTimelineAudioUpdate(original, new Date(now).toISOString(), update);
    expect(updated).not.toBe(original);
    expect(original[0].devices[0].audio).toEqual([]);
    expect(updated[1]).toBe(original[1]);
    view.rerender(<SubtitleBar frames={updated} currentIndex={0} />);
    expect(screen.getByText("“Arrived after the frame”")).toBeInTheDocument();
    expect(mergeTimelineAudioUpdate(updated, new Date(now).toISOString(), update)).toBe(updated);
  });
});
