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
  it("loads the exact frame thumbnail without borrowing a nearby recording or verifying the claim", async () => {
    fetch.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(new Response("image", { headers: { "content-type": "image/jpeg" } }));
    const image = await loadWorkflowScreenshot(timestamp, "Obsidian", new AbortController().signal);
    expect(image).toMatchObject({ frameId: 42, timestamp: frame.timestamp, visualVerified: false, matchDistanceSeconds: 0, dataUrl: "blob:source-preview" });
    expect(fetch.mock.calls[1][0]).toBe("/frames/42/thumbnail?width=960&quality=80&fallback=false");
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
