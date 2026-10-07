// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_CSP } from "@/lib/utils/html-sandbox";

// Stands in for mermaid.min.js. Real Mermaid needs layout, which jsdom lacks;
// the browser checks in the PR cover drawing and the CSP itself.
const FAKE_MERMAID = `
window.mermaidCalls = { configs: [], documents: [] };
window.mermaid = {
  initialize: function (config) {
    window.mermaidCalls.configs.push(JSON.parse(JSON.stringify(config)));
  },
  render: function (id, chart) {
    window.mermaidCalls.documents.push(document);
    if (chart === "bad") return Promise.reject(new Error("Unsupported color format"));
    if (chart === "never") return new Promise(function () {});
    if (chart === "image shape") {
      // Mermaid sizes an image shape from its decoded picture.
      var picture = new Image();
      picture.src = "https://evil.example/shape.png";
      return picture.decode().then(function () {
        window.mermaidCalls.decoded = picture.src;
        return { svg: '<svg viewBox="0 0 10 10"><text>image shape</text></svg>' };
      });
    }
    return Promise.resolve({
      svg: '<svg id="' + id + '" width="100%" style="max-width: 200px;" viewBox="0 0 200 100">' +
        '<style>.node { fill: red; }</style>' +
        '<foreignObject><div>' + chart + '<br></div></foreignObject><text>end</text></svg>'
    });
  }
};`;

type FrameWindow = Window & {
  mermaidCalls: { configs: Array<Record<string, unknown>>; documents: Document[]; decoded?: string };
};

describe("renderMermaidSvg", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn(async () => new Response(FAKE_MERMAID, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("runs Mermaid inside a frame that carries the no-network CSP", async () => {
    const { renderMermaidSvg } = await import("../mermaid-sandbox");

    const { svg, text } = await renderMermaidSvg("hello", { theme: "dark", securityLevel: "loose" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/mermaid\/dist\/mermaid\.min\.js$/);
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    // jsdom does not parse srcdoc, so check the document the browser gets.
    expect(frame.srcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    );
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("img-src data:");

    // Mermaid's code ran in the frame, so what it creates belongs to the
    // frame's document and its CSP, not the app window's.
    const calls = (frame.contentWindow as FrameWindow).mermaidCalls;
    expect(calls.documents).toEqual([frame.contentDocument]);
    expect(calls.documents[0]).not.toBe(document);
    // A caller cannot loosen Mermaid's own sanitizing.
    expect(calls.configs[0]).toMatchObject({ theme: "dark", securityLevel: "strict" });

    // XML an <img> can parse, sized to Mermaid's natural size.
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect(parsed.documentElement.getAttribute("width")).toBe("200");
    expect(parsed.documentElement.getAttribute("height")).toBe("100");
    expect(parsed.documentElement.getAttribute("style") ?? "").not.toContain("max-width");
    expect(parsed.documentElement.textContent).toContain("hello");
    // The label text, without the stylesheet, for screen readers.
    expect(text).toBe("hello end");
  });

  it("loads Mermaid once and applies each render's own config", async () => {
    const { renderMermaidSvg } = await import("../mermaid-sandbox");

    await Promise.all([
      renderMermaidSvg("first", { theme: "default" }),
      renderMermaidSvg("second", { theme: "dark" }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const frame = document.querySelector("iframe")!;
    const calls = (frame.contentWindow as FrameWindow).mermaidCalls;
    expect(calls.configs.map((config) => config.theme)).toEqual(["default", "dark"]);
  });

  it("starts the next render from a fresh frame after a render fails", async () => {
    const { renderMermaidSvg } = await import("../mermaid-sandbox");

    await expect(renderMermaidSvg("bad", {})).rejects.toThrow("Unsupported color format");
    const failedFrame = document.querySelector("iframe");
    expect(failedFrame).toBeNull();
    await expect(renderMermaidSvg("good", {})).resolves.toMatchObject({ text: "good end" });

    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const calls = (frames[0]!.contentWindow as FrameWindow).mermaidCalls;
    expect(calls.documents).toEqual([frames[0]!.contentDocument]);
    // The bundle itself is fetched once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up on a diagram that never finishes, so later diagrams still draw", async () => {
    const { renderMermaidSvg } = await import("../mermaid-sandbox");
    await renderMermaidSvg("first", {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A label image that never loads in the hidden frame keeps Mermaid waiting.
      const stuck = expect(renderMermaidSvg("never", {})).rejects.toThrow("took too long");
      const next = renderMermaidSvg("next", {});
      await vi.advanceTimersByTimeAsync(15_000);
      await stuck;
      await expect(next).resolves.toMatchObject({ text: "next end" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws an image shape whose picture the CSP blocks from a blank stand-in", async () => {
    // jsdom decodes nothing. Give each new frame the browser's behavior: the
    // CSP refuses a web picture, so its decode rejects; a data: picture decodes.
    const observer = new MutationObserver(() => {
      const frame = document.querySelector("iframe");
      const FrameImage = (frame?.contentWindow as unknown as typeof globalThis | null)?.HTMLImageElement;
      if (!FrameImage || FrameImage.prototype.decode) return;
      FrameImage.prototype.decode = function (this: HTMLImageElement) {
        return this.src.startsWith("data:")
          ? Promise.resolve()
          : Promise.reject(new Error("The source image cannot be decoded."));
      };
    });
    observer.observe(document.body, { childList: true });
    try {
      const { renderMermaidSvg } = await import("../mermaid-sandbox");

      await expect(renderMermaidSvg("image shape", {})).resolves.toMatchObject({ text: "image shape" });

      const frame = document.querySelector("iframe")!;
      expect((frame.contentWindow as FrameWindow).mermaidCalls.decoded).toMatch(/^data:image\/png;base64,/);
    } finally {
      observer.disconnect();
    }
  });

  it("reports a bundle that fails to load and tries again next time", async () => {
    const { renderMermaidSvg } = await import("../mermaid-sandbox");
    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));

    await expect(renderMermaidSvg("a", {})).rejects.toThrow("Failed to load Mermaid (404)");
    await expect(renderMermaidSvg("b", {})).resolves.toMatchObject({ text: "b end" });
  });
});
