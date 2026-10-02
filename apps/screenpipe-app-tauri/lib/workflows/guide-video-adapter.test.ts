// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), cancel: vi.fn(), discard: vi.fn(), fetch: vi.fn(), listen: vi.fn(), unlisten: vi.fn(), save: vi.fn(), copy: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/utils/tauri", () => ({ commands: { createWorkflowVideo: mocks.create, cancelWorkflowVideo: mocks.cancel, discardWorkflowVideo: mocks.discard } }));
vi.mock("@/lib/api", () => ({ localFetch: mocks.fetch }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset:${path}` }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ copyFile: mocks.copy }));
vi.mock("posthog-js", () => ({ default: { capture: mocks.capture } }));
import { desktopGuideVideo } from "./guide-video";
const scenes = [{ title: "Private title", narration: "Private instructions", image: null }];
beforeEach(() => { vi.resetAllMocks(); mocks.listen.mockResolvedValue(mocks.unlisten); mocks.cancel.mockResolvedValue({status:"ok"}); mocks.discard.mockResolvedValue({status:"ok"}); mocks.create.mockResolvedValue({ status:"ok", data: { path:"/local/video.mp4", captionsPath:"/local/captions.vtt" } }); });
describe("desktop video boundary", () => {
  it("uses native rendering and emits no source content in telemetry", async () => {
    const output = await desktopGuideVideo.generate(scenes, new AbortController().signal, vi.fn());
    expect(output.url).toBe("asset:/local/video.mp4");
    expect(mocks.create).toHaveBeenCalledWith(expect.any(String), scenes.map(scene => ({...scene, pace: 1, focus: null})));
    expect(JSON.stringify(mocks.capture.mock.calls)).not.toMatch(/Private|local/);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
    await desktopGuideVideo.release(output);
    expect(mocks.discard).toHaveBeenCalledWith(mocks.create.mock.calls[0][0]);
  });
  it("blocks unavailable screenshots before any speech/render call", async () => {
    mocks.fetch.mockResolvedValue({ok:false,status:410});
    await expect(desktopGuideVideo.generate([{ ...scenes[0], imageFrameId: 123 }], new AbortController().signal, vi.fn())).rejects.toThrow(/screenshot is unavailable/);
    expect(mocks.fetch.mock.calls[0][0]).toBe("/frames/123?fallback=false");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it("deduplicates source loading and never enables neighboring-frame fallback", async () => {
    mocks.fetch.mockResolvedValue({ok:true,blob:async()=>new Blob(["image"],{type:"image/png"})});
    await desktopGuideVideo.generate([{...scenes[0],imageFrameId:123},{...scenes[0],imageFrameId:123}],new AbortController().signal,vi.fn());
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][1][0].image).toMatch(/^data:image\/png;base64,/);
  });
  it("handles cancellation before native registration and discards a late successful output", async () => {
    const abort = new AbortController(); let event!: (value: {payload:string}) => void;
    mocks.listen.mockImplementation(async (_name, handler) => { event=handler; return mocks.unlisten; });
    mocks.create.mockImplementation(async () => { abort.abort(); event({payload:"Preparing video"}); return {status:"ok",data:{path:"/local/video.mp4",captionsPath:"/local/captions.vtt"}}; });
    await expect(desktopGuideVideo.generate(scenes,abort.signal,vi.fn())).rejects.toThrow();
    expect(mocks.cancel).toHaveBeenCalledWith(mocks.create.mock.calls[0][0]);
    expect(mocks.discard).toHaveBeenCalledWith(mocks.create.mock.calls[0][0]);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
  it("never copies or tracks a download when the save dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);
    const result = {url:"asset:test",path:"/video.mp4",captionsPath:"/captions.vtt"};
    expect(await desktopGuideVideo.export(result,"SOP",false)).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});

it("resolves an unattached exact source and loads the original before rendering", async () => {
 const timestamp="2026-09-24T02:07:42.820687Z";
 mocks.fetch.mockResolvedValueOnce(Response.json({data:[{content:{frame_id:42,timestamp,app_name:"Obsidian"}}]}))
   .mockResolvedValueOnce({ok:true,blob:async()=>new Blob(["image"],{type:"image/png"})});
 await desktopGuideVideo.generate([{...scenes[0],requiresImage:true,imageSources:[{timestamp,app:"Obsidian"}]}],new AbortController().signal,vi.fn());
 expect(mocks.fetch.mock.calls[1][0]).toBe("/frames/42?fallback=false");
 expect(mocks.create.mock.calls[0][1][0].image).toMatch(/^data:image\/png;base64,/);
});
it("does not render a text substitute when a source frame cannot be resolved", async () => {
 mocks.fetch.mockResolvedValueOnce(Response.json({data:[]}));
 await expect(desktopGuideVideo.generate([{...scenes[0],requiresImage:true,imageSources:[{timestamp:"2026-09-24T02:07:42Z",app:"Obsidian"}]}],new AbortController().signal,vi.fn())).rejects.toThrow(/recording.*unavailable/);
 expect(mocks.create).not.toHaveBeenCalled();
});
