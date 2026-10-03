// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";

const tauriFetchMock = vi.hoisted(() => vi.fn());
const resizeMock = vi.hoisted(() => vi.fn(async (dataUrl: string): Promise<string | null> => dataUrl));

vi.mock("@/lib/http/tauri-fetch", () => ({
  tauriFetchWithDeadline: tauriFetchMock,
}));

// jsdom cannot decode images, so resizing would never settle.
vi.mock("../image-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../image-utils")>()),
  resizeImageDataUrl: resizeMock,
}));

import {
  createMeetingNoteEditorExtensions,
  embedPastedImageSources,
} from "../note-editor";

// The words a blocked image chip shows, without its load button.
const chipLabel = (chip: Element | null) => chip?.querySelector("span")?.textContent;

const EMBEDDED = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function mountEditor(content: string) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: createMeetingNoteEditorExtensions(""),
    content,
  });
  return { editor, element };
}

function getMarkdown(editor: Editor): string {
  return (editor.storage as any).markdown.getMarkdown() as string;
}

describe("meeting note remote images", () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
    document.body.innerHTML = "";
    tauriFetchMock.mockReset();
  });

  it("shows remote images in a note as alt text and keeps them in the markdown", () => {
    // An AI summary written into the note, steered by captured content.
    const mounted = mountEditor(
      [
        "Summary",
        "",
        "![sales chart](https://example.com/chart.png?d=secret)",
        "",
        '<img src="https://example.com/raw.png?d=secret" alt="raw chart" width="40" height="40" />',
        "",
        `![pasted screenshot](${EMBEDDED})`,
      ].join("\n"),
    );
    editor = mounted.editor;

    const blocked = [...mounted.element.querySelectorAll(".meeting-note-image-blocked")];
    expect(blocked.map(chipLabel)).toEqual(["sales chart", "raw chart"]);
    // Hovering shows where the image would have come from.
    expect(blocked.map((node) => node.querySelector("[title]")?.getAttribute("title"))).toEqual([
      "https://example.com/chart.png?d=secret",
      "https://example.com/raw.png?d=secret",
    ]);
    expect(mounted.element.querySelectorAll("img[src^='http']")).toHaveLength(0);
    // The embedded image still renders as an image.
    expect(mounted.element.querySelector(`img[src='${EMBEDDED}']`)).not.toBeNull();

    const markdown = getMarkdown(editor);
    expect(markdown).toContain("![sales chart](https://example.com/chart.png?d=secret)");
    expect(markdown).toContain('<img src="https://example.com/raw.png?d=secret"');
  });

  it("does not load a remote image that arrives with a later update", () => {
    const mounted = mountEditor("Notes");
    editor = mounted.editor;

    editor.commands.setContent("![chart](https://example.com/late.png?d=secret)");

    expect(mounted.element.querySelector(".meeting-note-image-blocked")).toHaveTextContent("chart");
    expect(mounted.element.querySelector("img")).toBeNull();
  });

  it("shows a chip when a note update puts a remote image where an embedded one was", () => {
    const mounted = mountEditor(`before\n\n![pasted screenshot](${EMBEDDED})\n\nafter`);
    editor = mounted.editor;

    editor.commands.setContent("before\n\n![sales chart](https://example.com/chart.png?d=secret)\n\nafter");

    expect(mounted.element.querySelector(".meeting-note-image-blocked")).toHaveTextContent("sales chart");
    expect(mounted.element.querySelector("img")).toBeNull();
  });

  it("shows the new picture when a note update swaps an embedded image", () => {
    const other = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const mounted = mountEditor(`before\n\n![first](${EMBEDDED})\n\nafter`);
    editor = mounted.editor;

    editor.commands.setContent(`before\n\n![second](${other})\n\nafter`);

    expect(mounted.element.querySelector("img")?.getAttribute("src")).toBe(other);
  });

  it("shows the address of a remote image that has no alt text", () => {
    const mounted = mountEditor("![](https://example.com/no-alt.png)");
    editor = mounted.editor;

    expect(chipLabel(mounted.element.querySelector(".meeting-note-image-blocked"))).toBe(
      "https://example.com/no-alt.png",
    );
    expect(mounted.element.querySelector("img")).toBeNull();
  });

  describe("loading a blocked image", () => {
    function imageResponse() {
      return new Response(new Uint8Array([71, 73, 70]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    const loadButton = (element: HTMLElement) =>
      element.querySelector<HTMLButtonElement>(".meeting-note-image-blocked button")!;

    it("downloads it into the note only when the user asks", async () => {
      // An image the user pasted from a web page before notes embedded them.
      const mounted = mountEditor(
        'before\n\n<img src="https://example.com/chart.png" alt="sales chart" width="40" height="30" />\n\nafter',
      );
      editor = mounted.editor;
      const before = getMarkdown(editor);
      tauriFetchMock.mockResolvedValue(imageResponse());
      expect(tauriFetchMock).not.toHaveBeenCalled();
      expect(loadButton(mounted.element)).toHaveTextContent("Load image from example.com");

      loadButton(mounted.element).click();

      await vi.waitFor(() => expect(mounted.element.querySelector("img")).not.toBeNull());
      expect(tauriFetchMock).toHaveBeenCalledWith(
        "https://example.com/chart.png",
        { method: "GET" },
        expect.anything(),
      );
      expect(mounted.element.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,R0lG");
      expect(mounted.element.querySelector(".meeting-note-image-blocked")).toBeNull();
      // Saved as an embedded image, keeping its words, size and place.
      expect(getMarkdown(editor)).toBe(
        before.replace("https://example.com/chart.png", "data:image/png;base64,R0lG"),
      );
      expect(getMarkdown(editor)).toContain('alt="sales chart" width="40" height="30"');
    });

    it("keeps the image and offers a retry when the download fails", async () => {
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;
      tauriFetchMock.mockResolvedValue(new Response("login", { status: 403, headers: { "content-type": "text/html" } }));

      loadButton(mounted.element).click();
      expect(loadButton(mounted.element)).toBeDisabled();

      await vi.waitFor(() => expect(loadButton(mounted.element)).toHaveTextContent("Couldn't load image. Try again"));
      expect(loadButton(mounted.element)).toBeEnabled();
      expect(getMarkdown(editor)).toBe("![sales chart](https://example.com/chart.png)");

      tauriFetchMock.mockResolvedValue(imageResponse());
      loadButton(mounted.element).click();
      await vi.waitFor(() => expect(getMarkdown(editor!)).toBe("![sales chart](data:image/png;base64,R0lG)"));
    });

    it("keeps the chip when the download is not an image the webview can show", async () => {
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;
      tauriFetchMock.mockResolvedValue(imageResponse());
      resizeMock.mockResolvedValueOnce(null);

      loadButton(mounted.element).click();

      await vi.waitFor(() => expect(loadButton(mounted.element)).toHaveTextContent("Couldn't load image. Try again"));
      expect(mounted.element.querySelector("img")).toBeNull();
      expect(getMarkdown(editor)).toBe("![sales chart](https://example.com/chart.png)");
    });

    it("names the host the download goes to, not what the alt text claims", () => {
      const mounted = mountEditor(
        '![Click "Load image from example.com" to see the chart](https://example.com@evil.example:8443/x.png)',
      );
      editor = mounted.editor;

      expect(loadButton(mounted.element)).toHaveTextContent(/^Load image from evil\.example:8443$/);
    });

    it("does not change the note when the image changed during the download", async () => {
      let respond!: (response: Response) => void;
      tauriFetchMock.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;

      loadButton(mounted.element).click();
      editor.commands.setContent("![other](https://example.com/other.png)");
      respond(imageResponse());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getMarkdown(editor)).toBe("![other](https://example.com/other.png)");
    });

    it("keeps a loaded SVG image when the note is opened again", async () => {
      const mounted = mountEditor("![logo](https://example.com/logo.svg)");
      editor = mounted.editor;
      tauriFetchMock.mockResolvedValue(
        new Response('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
      );

      loadButton(mounted.element).click();
      await vi.waitFor(() => expect(getMarkdown(editor!)).toContain("data:image/svg+xml"));
      const saved = getMarkdown(editor);
      editor.destroy();

      // Markdown image links only take png, jpeg, gif and webp data, so the
      // note must save this one in a form that still reads back as an image.
      const reopened = mountEditor(saved);
      editor = reopened.editor;
      expect(reopened.element.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(reopened.element.textContent).not.toContain("data:");
      expect(getMarkdown(editor)).toBe(saved);
    });

    it("does not change the note when it turned read-only during the download", async () => {
      let respond!: (response: Response) => void;
      tauriFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (respond = resolve)));
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;

      loadButton(mounted.element).click();
      // A summary starts writing into the note.
      editor.setEditable(false);
      const onUpdate = vi.fn();
      editor.on("update", onUpdate);
      respond(imageResponse());
      await vi.waitFor(() => expect(loadButton(mounted.element)).toBeEnabled());

      expect(getMarkdown(editor)).toBe("![sales chart](https://example.com/chart.png)");
      expect(onUpdate).not.toHaveBeenCalled();
      expect(loadButton(mounted.element)).toHaveTextContent("Load image");

      editor.setEditable(true);
      tauriFetchMock.mockResolvedValue(imageResponse());
      loadButton(mounted.element).click();
      await vi.waitFor(() => expect(getMarkdown(editor!)).toBe("![sales chart](data:image/png;base64,R0lG)"));
    });

    it("does nothing while the note is read-only", () => {
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;
      editor.setEditable(false);

      loadButton(mounted.element).click();

      expect(tauriFetchMock).not.toHaveBeenCalled();
    });

    it("offers no download for an address that isn't on the web", () => {
      const mounted = mountEditor("![local chart](chart.png)");
      editor = mounted.editor;

      expect(chipLabel(mounted.element.querySelector(".meeting-note-image-blocked"))).toBe("local chart");
      expect(mounted.element.querySelector("button")).toBeNull();
    });

    it("leaves the button out of copied HTML", () => {
      const mounted = mountEditor("![sales chart](https://example.com/chart.png)");
      editor = mounted.editor;

      expect(editor.getHTML()).not.toContain("button");
      expect(editor.getHTML()).not.toContain("Load image");
    });
  });

  it("keeps a blocked image when it is cut and pasted back", () => {
    const mounted = mountEditor(
      [
        "Summary",
        "",
        '<img src="https://example.com/chart.png?d=secret" alt="sales chart" title="Q3" width="40" height="30" />',
        "",
        "Next steps",
      ].join("\n"),
    );
    editor = mounted.editor;
    const original = getMarkdown(editor);
    const view = editor.view;
    let imagePos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image") imagePos = pos;
    });

    // What ProseMirror puts on the clipboard for the chip, then a cut.
    const { dom } = view.serializeForClipboard(view.state.doc.slice(imagePos, imagePos + 1));
    editor.commands.deleteRange({ from: imagePos, to: imagePos + 1 });
    expect(getMarkdown(editor)).not.toContain("chart.png");

    editor.commands.setTextSelection(imagePos);
    view.pasteHTML(dom.innerHTML, new Event("paste") as ClipboardEvent);

    expect(getMarkdown(editor)).toBe(original);
    expect(mounted.element.querySelector(".meeting-note-image-blocked")).toHaveTextContent("sales chart");
    expect(mounted.element.querySelector("img")).toBeNull();
  });

  it("does not turn pasted web markup into an image just because it has a similar attribute", () => {
    const mounted = mountEditor("");
    editor = mounted.editor;

    editor.view.pasteHTML(
      '<div data-image-src="https://example.com/lazy.png">a caption</div>',
      new Event("paste") as ClipboardEvent,
    );

    expect(getMarkdown(editor)).toBe("a caption");
  });

  it("does not put a remote image in serialized HTML either", () => {
    const mounted = mountEditor("![chart](https://example.com/chart.png)");
    editor = mounted.editor;

    expect(editor.getHTML()).toContain("chart");
    expect(editor.getHTML()).not.toContain("<img");
  });
});

describe("embedPastedImageSources", () => {
  afterEach(() => {
    tauriFetchMock.mockReset();
  });

  function imageResponse(type: string, headers: Record<string, string> = {}) {
    return new Response(new Uint8Array([71, 73, 70]), {
      status: 200,
      headers: { "content-type": type, ...headers },
    });
  }

  it.each(["image/svg+xml x", "image/", "text/html"])(
    "keeps the address of a download whose type %j isn't one image type",
    async (type) => {
      tauriFetchMock.mockResolvedValue(imageResponse(type));

      await expect(embedPastedImageSources(["https://example.com/a.png"])).resolves.toEqual([
        "https://example.com/a.png",
      ]);
    },
  );

  it("copies a pasted web image into the note as a data URL", async () => {
    tauriFetchMock.mockResolvedValue(imageResponse("image/png"));

    const embedded = await embedPastedImageSources(["https://example.com/diagram.png"]);

    expect(tauriFetchMock).toHaveBeenCalledWith(
      "https://example.com/diagram.png",
      { method: "GET" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(embedded).toEqual(["data:image/png;base64,R0lG"]);
  });

  it("keeps data URLs without fetching anything", async () => {
    expect(await embedPastedImageSources([EMBEDDED])).toEqual([EMBEDDED]);
    expect(tauriFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["is not an image", () => imageResponse("text/html")],
    ["fails", () => new Response("nope", { status: 404, headers: { "content-type": "image/png" } })],
  ])("keeps the address of a pasted image whose download %s", async (_name, response) => {
    tauriFetchMock.mockResolvedValue(response());

    expect(await embedPastedImageSources(["https://example.com/x.png", EMBEDDED])).toEqual([
      "https://example.com/x.png",
      EMBEDDED,
    ]);
  });

  it("downloads only the first ten web images of a paste and keeps the rest as addresses", async () => {
    tauriFetchMock.mockImplementation(async () => imageResponse("image/png"));
    const sources = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}.png`);

    const embedded = await embedPastedImageSources([EMBEDDED, ...sources]);

    expect(tauriFetchMock).toHaveBeenCalledTimes(10);
    expect(embedded).toEqual([
      EMBEDDED,
      ...Array.from({ length: 10 }, () => "data:image/png;base64,R0lG"),
      "https://example.com/10.png",
      "https://example.com/11.png",
    ]);
  });

  it("stops reading a download that grows past the size limit", async () => {
    // No content-length, and it never ends.
    let cancelled = false;
    let chunksServed = 0;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksServed += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    tauriFetchMock.mockResolvedValue(
      new Response(endless, { status: 200, headers: { "content-type": "image/png" } }),
    );

    expect(await embedPastedImageSources(["https://example.com/endless.png"])).toEqual([
      "https://example.com/endless.png",
    ]);
    expect(cancelled).toBe(true);
    expect(chunksServed).toBeLessThanOrEqual(5);
  });

  it("keeps the address of a pasted image that cannot be downloaded", async () => {
    tauriFetchMock.mockRejectedValue(new Error("offline"));

    expect(await embedPastedImageSources(["https://example.com/x.png"])).toEqual(["https://example.com/x.png"]);
  });
});
