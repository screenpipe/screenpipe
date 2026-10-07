// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { Mermaid } from "mermaid";
import { SANDBOX_CSP } from "@/lib/utils/html-sandbox";

/**
 * Renders Mermaid diagrams where they cannot reach the network.
 *
 * Diagram source in chat is written by an AI working from captured screens,
 * pages and files, so outside content can steer it. Mermaid fetches URLs from
 * the source while it lays a diagram out: the image shape
 * (`A@{ img: "https://…" }`), `<img>` and `style="…url()"` in labels, and
 * `themeCSS` in an init directive. `securityLevel: "strict"` stops none of
 * them, and the app window has no CSP. So instead of filtering diagram source,
 * Mermaid is loaded into a hidden iframe whose document carries the same
 * no-network CSP as HTML artifacts (see html-sandbox.ts). Mermaid's code runs
 * in that frame's realm, so every element, image and stylesheet it creates
 * belongs to the frame and is blocked by its CSP. Callers show the finished
 * SVG through an `<img>`, where SVG never loads anything or runs scripts.
 *
 * The frame shares the app's origin. This is a network boundary, not a
 * script boundary (Mermaid used to run in the app window itself). An opaque
 * origin would be both, but Chromium skips layout in cross-origin frames
 * while the window is hidden, and Mermaid measures text as it draws, so
 * diagrams rendered then came out empty.
 */

// A blank 100×100 PNG: what an image shape is sized from when its picture
// can't load.
const BLANK_PICTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAQAAADa613fAAAAKUlEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAPBiToQAAUDCSS0AAAAASUVORK5CYII=";

// Renders run one at a time, so a diagram that never finishes (a label image
// that never loads in the hidden frame, say) would hold back every later one.
const RENDER_TIMEOUT_MS = 15_000;

let mermaidSource: Promise<string> | null = null;
let frameMermaid: Promise<{ frame: HTMLIFrameElement; mermaid: Mermaid }> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

function loadMermaidSource(): Promise<string> {
  mermaidSource ??= (async () => {
    // One of the app's own static files.
    const response = await fetch(new URL("mermaid/dist/mermaid.min.js", import.meta.url));
    if (!response.ok) throw new Error(`Failed to load Mermaid (${response.status})`);
    return response.text();
  })();
  mermaidSource.catch(() => {
    mermaidSource = null;
  });
  return mermaidSource;
}

function loadFrameMermaid(): Promise<{ frame: HTMLIFrameElement; mermaid: Mermaid }> {
  frameMermaid ??= (async () => {
    const source = await loadMermaidSource();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    // Off screen but laid out: Mermaid measures text while it renders.
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;visibility:hidden;pointer-events:none";
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      document.body.appendChild(frame);
    });

    // Mermaid's image shape (`A@{ img: "…" }`) waits for its picture to decode
    // to size itself. The CSP blocks the picture, and the rejected decode
    // would fail the whole diagram, so the shape is sized from a blank
    // stand-in instead and draws as an empty box. The SVG keeps the picture's
    // address, which the <img> showing the SVG never loads.
    const FrameImage = (frame.contentWindow as unknown as typeof globalThis).HTMLImageElement;
    const decode = FrameImage.prototype.decode;
    FrameImage.prototype.decode = function (this: HTMLImageElement) {
      return decode.call(this).catch(() => {
        this.src = BLANK_PICTURE;
        return decode.call(this);
      });
    };

    const frameDocument = frame.contentDocument!;
    const script = frameDocument.createElement("script");
    script.textContent = source;
    frameDocument.head.appendChild(script);
    const mermaid = (frame.contentWindow as unknown as { mermaid?: Mermaid }).mermaid;
    if (!mermaid) {
      frame.remove();
      throw new Error("Failed to load Mermaid");
    }
    return { frame, mermaid };
  })();
  frameMermaid.catch(() => {
    frameMermaid = null;
  });
  return frameMermaid;
}

export interface MermaidImage {
  /** The diagram as XML for an `<img>`. */
  svg: string;
  /** The diagram's own text, for screen readers: an image hides it. */
  text: string;
}

// An <img> parses SVG as XML and needs a size of its own: give it Mermaid's
// natural size so it scales down like the inline SVG did.
function svgForImage(svg: string): MermaidImage {
  // DOMParser documents are inert, so nothing in the SVG loads here.
  const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  if (!root) throw new Error("Mermaid returned no diagram");
  const [, , width, height] = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if (width > 0 && height > 0) {
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    root.style.removeProperty("max-width");
  }
  // Label by label: textContent would run "Alice" and "Bob" together.
  const words: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const word = node.nodeValue?.trim();
    if (word && node.parentElement?.localName !== "style") words.push(word);
  }
  return {
    svg: new XMLSerializer().serializeToString(root),
    text: words.join(" ").replace(/\s+/g, " "),
  };
}

/**
 * Renders `chart` with `config` for display through an `<img>`. Renders run
 * one at a time because each one sets Mermaid's global config.
 */
export function renderMermaidSvg(
  chart: string,
  config: Record<string, unknown>,
): Promise<MermaidImage> {
  const render = renderQueue.then(async () => {
    const { frame, mermaid } = await loadFrameMermaid();
    try {
      mermaid.initialize({
        ...config,
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { svg } = await Promise.race([
        mermaid.render(`mermaid-${nextDiagramId++}`, chart),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Diagram took too long to render")), RENDER_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      return svgForImage(svg);
    } catch (error) {
      // A failed render can leave Mermaid's global state broken (one bad
      // theme colour failed every later diagram), so the next render starts
      // from a fresh frame.
      frame.remove();
      frameMermaid = null;
      throw error;
    }
  });
  renderQueue = render.catch(() => undefined);
  return render;
}
