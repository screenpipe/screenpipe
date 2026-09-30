// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplayAudio, replayAudioAt, replayAudioFiles } from "./replay-audio";
import type { MeetingAudioChunk } from "@/lib/utils/meeting-context";
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/actions/video-actions", () => ({ getMediaFile: load }));
const start = Date.parse("2026-09-26T12:00:00Z");
const chunk = (
  path: string,
  second: number,
  offset = 0,
  input = true,
): MeetingAudioChunk => ({
  audioChunkId: second,
  audioFilePath: path,
  audioStartTimeSecs: offset,
  timestamp: new Date(start + second * 1000).toISOString(),
  isInput: input,
  deviceType: input ? "input" : "output",
  transcription: "fixture",
  speakerId: null,
  speakerName: "",
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  load.mockReset().mockResolvedValue({ data: "AA==", mimeType: "audio/wav" });
  URL.createObjectURL = vi.fn(() => "blob:fixture");
  URL.revokeObjectURL = vi.fn();
});
describe("meeting replay audio", () => {
  it("prefers a known file offset over unaligned legacy live turns", () => {
    const early = { ...chunk("output", 5, 0, false), audioStartTimeSecs: null };
    const aligned = chunk("output", 15, 5, false);
    expect(replayAudioFiles([early, aligned])[0].startMs).toBe(start + 10000);
    expect(replayAudioFiles([aligned, early])[0].startMs).toBe(start + 10000);
  });
  it("aligns offsets, deduplicates turns, and mixes mic and output", () => {
    const files = replayAudioFiles([
      chunk("mic", 12, 2),
      chunk("mic", 15, 5),
      chunk("out", 10, 0, false),
      chunk("next", 40),
      chunk("", 10),
      chunk("bad", 10, -1),
    ]);
    expect(files).toHaveLength(3);
    expect(replayAudioAt(files, start + 9000)).toEqual([]);
    expect(replayAudioAt(files, start + 14000).map((f) => f.path)).toEqual([
      "mic",
      "out",
    ]);
    expect(replayAudioAt(files, start + 41000).map((f) => f.path)).toEqual([
      "next",
      "out",
    ]);
  });
  it("seeks, changes speed, pauses, mutes, respects file end, and releases resources", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    const status = vi.fn();
    const props = {
      file: { path: "mic", startMs: start, input: true },
      cursorMs: start + 4000,
      playing: true,
      muted: false,
      rate: 1,
      onStatus: status,
    };
    const view = render(<ReplayAudio {...props} />);
    const audio = view.container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { value: 30, configurable: true });
    await waitFor(() => expect(audio.src).toBe("blob:fixture"));
    fireEvent.canPlay(audio);
    expect(audio.currentTime).toBe(4);
    expect(play).toHaveBeenCalledTimes(1);
    view.rerender(
      <ReplayAudio
        {...props}
        cursorMs={start + 8000}
        rate={2}
        playing={false}
      />,
    );
    expect(audio.currentTime).toBe(8);
    expect(audio.playbackRate).toBe(2);
    expect(pause).toHaveBeenCalled();
    view.rerender(<ReplayAudio {...props} muted />);
    expect(audio.muted).toBe(true);
    const plays = play.mock.calls.length;
    view.rerender(<ReplayAudio {...props} cursorMs={start + 31000} />);
    expect(play).toHaveBeenCalledTimes(plays);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
  });
  it("reports missing media", async () => {
    load.mockRejectedValue(new Error("missing"));
    const status = vi.fn();
    render(
      <ReplayAudio
        file={{ path: "gone", startMs: start, input: true }}
        cursorMs={start}
        playing
        muted={false}
        rate={1}
        onStatus={status}
      />,
    );
    await waitFor(() => expect(status).toHaveBeenCalledWith("gone", "error"));
  });
  it("discards a late load after navigation", async () => {
    let resolve!: (value: { data: string; mimeType: string }) => void;
    load.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = render(
      <ReplayAudio
        file={{ path: "slow", startMs: start, input: true }}
        cursorMs={start}
        playing={false}
        muted={false}
        rate={1}
        onStatus={vi.fn()}
      />,
    );
    view.unmount();
    await act(async () => resolve({ data: "AA==", mimeType: "audio/wav" }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
