// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localFetch } from "@/lib/api";
import { loadWorkflowScreenshot } from "./source-screenshot";
vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
const fetch = vi.mocked(localFetch);
const timestamp = "2026-09-23T19:07:42.820687-07:00";
const frame = { frame_id: 42, timestamp: "2026-09-24T02:07:42.820687Z", app_name: "Obsidian" };
const lookup = (rows = [frame]) => Response.json({ data: rows.map(content => ({ type: "OCR", content })) });
const create = vi.fn().mockReturnValue("blob:source-preview");
beforeEach(() => { fetch.mockReset(); create.mockClear(); Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true }); });
describe("exact source screenshot adapter", () => {
  it("loads the original exact frame without borrowing a nearby recording or verifying the claim", async () => {
    fetch.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/jpeg" } }));
    const image = await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal);
    expect(image).toMatchObject({ frameId: 42, timestamp: frame.timestamp, visualVerified: false, matchDistanceSeconds: 0, dataUrl: "blob:source-preview" });
    expect(fetch.mock.calls[1][0]).toBe("/frames/42?fallback=false");
    const params = new URLSearchParams(String(fetch.mock.calls[0][0]).split("?")[1]);
    expect(params.get("app_name")).toBe("Obsidian");
    expect(params.get("content_type")).toBe("ocr");
    expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects another app, a nearby sub-millisecond frame and invalid frame IDs", async () => {
    fetch.mockResolvedValueOnce(lookup([{ ...frame, timestamp: "2026-09-24T02:07:42.820688Z" }, { ...frame, app_name: "Mail" }, { ...frame, frame_id: -1 }]));
    expect(await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
  it("distinguishes expired media from an offline recorder and rejects non-image responses", async () => {
    fetch.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal)).toBeNull();
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal)).rejects.toThrow("look up");
    fetch.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response("html", { headers: { "content-type": "text/html" } }));
    await expect(loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal)).rejects.toThrow("Invalid source");
  });
  it("does not create a preview after cancellation", async () => {
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(lookup()).mockImplementationOnce(async () => {
      controller.abort();
      return new Response("image", { headers: { "content-type": "image/jpeg" } });
    });
    await expect(loadWorkflowScreenshot(timestamp, "Obsidian", controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

it("resolves a saved ID through metadata and never searches or loads a reused ID", async () => {
  fetch.mockResolvedValueOnce(Response.json({ frame_id: 42, timestamp: frame.timestamp }))
    .mockResolvedValueOnce(new Response("original", { headers: { "content-type": "image/png" } }));
  expect(await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal, 42)).toMatchObject({ frameId: 42 });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/frames/42/metadata", "/frames/42?fallback=false"]);
  fetch.mockClear();
  fetch.mockResolvedValueOnce(Response.json({ frame_id: 42, timestamp: "2026-09-24T02:07:42.820688Z" }));
  expect(await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal, 42)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("rejects oversized image streams even without a Content-Length header", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17 * 1024 * 1024)); }, cancel });
  fetch.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response(body, { headers: { "content-type": "image/png" } }));
  await expect(loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal)).rejects.toThrow("limit");
  expect(cancel).toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("bounds parallel image requests and removes aborted work from the queue", async () => {
  const complete: ((value: Response) => void)[] = [];
  fetch.mockImplementation(() => new Promise(resolve => complete.push(resolve)));
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const calls = controllers.map(controller => loadWorkflowScreenshot(timestamp, "Obsidian", controller.signal, 42).catch(e => e));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  controllers[3].abort();
  complete[0](new Response(null, { status: 404 }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  complete.slice(1).forEach(resolve => resolve(new Response(null, { status: 404 })));
  const results = await Promise.all(calls);
  expect(results[3]).toMatchObject({ name: "AbortError" });
  expect(create).not.toHaveBeenCalled();
});
