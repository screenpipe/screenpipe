// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import { FocusedNarration } from "./focused-narration";

class Recorder {
  static instances: Recorder[] = [];
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  onerror?: () => void;
  constructor(public stream: MediaStream) { Recorder.instances.push(this); }
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
    queueMicrotask(() => this.onstop?.());
  }
}
function fixture() {
  Recorder.instances = [];
  vi.stubGlobal("MediaRecorder", Recorder);
  const track = { stop: vi.fn(), readyState: "live", onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const save = vi.fn(async (_chunk: unknown) => {});
  const state = vi.fn();
  return { track, stream, getUserMedia, save, state, voice: new FocusedNarration(save, state) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("stops microphone tracks synchronously on Pause/Finish and saves actual bytes without transcription", async () => {
  const h = fixture(); await h.voice.start();
  expect(h.state).toHaveBeenLastCalledWith({ hot: true });
  const stopped = h.voice.stop();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.state).toHaveBeenLastCalledWith({ hot: false });
  await stopped;
  expect(h.save).toHaveBeenCalledOnce();
  expect(h.save.mock.calls[0][0]).toEqual(expect.objectContaining({ audio: expect.any(Blob), start: expect.any(Number), end: expect.any(Number) }));
});
it("does not open duplicate microphone streams on repeated Start", async () => {
  const h = fixture(); await Promise.all([h.voice.start(), h.voice.start()]);
  expect(h.getUserMedia).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(1);
  await h.voice.stop();
});
it("closes a late permission result after Finish without opening a recorder", async () => {
  const h = fixture(); let resolve!: (stream: MediaStream) => void;
  h.getUserMedia.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const opening = h.voice.start();
  await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalledOnce());
  await h.voice.stop(); resolve(h.stream); await opening;
  expect(h.track.stop).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(0);
  expect(h.state).not.toHaveBeenCalledWith({ hot: true });
});
it("reports denied permission while leaving screen capture available", async () => {
  const h = fixture(); h.getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await expect(h.voice.start()).rejects.toThrow("Allow microphone access");
  expect(h.state).toHaveBeenLastCalledWith(expect.objectContaining({ hot: false }));
  expect(h.save).not.toHaveBeenCalled();
});
it("retains unsaved audio after storage failure and retries it before accepting new capture", async () => {
  const h = fixture(); h.save.mockRejectedValueOnce(new Error("Disk full"));
  await h.voice.start(); await expect(h.voice.stop()).rejects.toThrow("Disk full");
  expect(h.track.stop).toHaveBeenCalledOnce();
  await h.voice.flush();
  expect(h.save).toHaveBeenCalledTimes(2);
  expect(h.save.mock.calls[0][0]).toBe(h.save.mock.calls[1][0]);
  await h.voice.flush(); expect(h.save).toHaveBeenCalledTimes(2);
  await h.voice.start(); expect(h.getUserMedia).toHaveBeenCalledTimes(2);
  await h.voice.stop();
});
it("reports track interruption and stops the remaining microphone resources", async () => {
  const h = fixture(); await h.voice.start(); h.track.onended?.();
  await vi.waitFor(() => expect(h.state).toHaveBeenCalledWith(expect.objectContaining({ hot: false, error: expect.stringContaining("Microphone disconnected") })));
  expect(h.track.stop).toHaveBeenCalledOnce();
});
it("persists timed chunks in order and freezes the last boundary at stop intent", async () => {
  const h = fixture(); let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
  await h.voice.start(); const recorder = Recorder.instances[0];
  now = 6000; recorder.ondataavailable?.({ data: new Blob(["first"]) });
  await h.voice.flush(); now = 8000; await h.voice.stop();
  expect(h.save.mock.calls.map(([chunk]) => chunk)).toEqual([
    expect.objectContaining({ sequence: 0, start: 1000, end: 6000 }),
    expect.objectContaining({ sequence: 1, start: 6000, end: 8000 }),
  ]);
  vi.restoreAllMocks();
});
it("late permission denial cannot clear a newer microphone session", async () => {
  const h = fixture(); let reject!: (error: Error) => void;
  h.getUserMedia.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const stale = h.voice.start(); await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalledOnce());
  await h.voice.stop(); await h.voice.start();
  reject(new DOMException("Denied", "NotAllowedError")); await stale;
  expect(h.state).toHaveBeenLastCalledWith({ hot: true });
  await h.voice.start(); expect(h.getUserMedia).toHaveBeenCalledTimes(2);
  await h.voice.stop();
});
it("retains each audio chunk's recording owner when a save is retried before a new workflow", async () => {
  const h = fixture(); h.save.mockRejectedValueOnce(new Error("Storage unavailable"));
  await h.voice.start("first");
  await expect(h.voice.stop()).rejects.toThrow("Storage unavailable");
  await h.voice.start("second"); await h.voice.stop();
  expect(h.save.mock.calls.map(([chunk]) => (chunk as {recordingId:string}).recordingId)).toEqual(["first","first","second"]);
});
it("keeps narration chunks contiguous when the recorder emits an empty event", async () => {
  const h=fixture(); let now=1000; vi.spyOn(Date,"now").mockImplementation(()=>now);
  try {
    await h.voice.start(); const recorder=Recorder.instances[0];
    now=6000; recorder.ondataavailable?.({data:new Blob(["first"])}); await h.voice.flush();
    now=7000; recorder.ondataavailable?.({data:new Blob([])}); await h.voice.flush();
    now=8000; await h.voice.stop();
    expect(h.save.mock.calls.map(([chunk])=>chunk)).toEqual([
      expect.objectContaining({sequence:0,start:1000,end:6000}),
      expect.objectContaining({sequence:1,start:6000,end:8000}),
    ]);
  } finally { vi.restoreAllMocks(); }
});
