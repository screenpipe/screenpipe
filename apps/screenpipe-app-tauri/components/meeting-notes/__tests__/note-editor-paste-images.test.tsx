// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

const tauriFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/http/tauri-fetch", () => ({
  tauriFetchWithDeadline: tauriFetchMock,
}));

// jsdom cannot decode images, so resizing would never settle.
vi.mock("../image-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../image-utils")>()),
  resizeImageDataUrl: async (dataUrl: string) => dataUrl,
}));

import { NoteEditor, type NoteEditorHandle } from "../note-editor";

const EMBEDDED = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const WEB_IMAGE = "https://example.com/diagram.png";
const DOWNLOADED = /data:image\/png;base64,R0lG/;

async function mountNoteEditor(value = "") {
  const { container } = render(<NoteEditor value={value} onChange={() => {}} />);
  const root = await waitFor(() => {
    const element = container.querySelector<HTMLElement>('[data-testid="note-editor"]');
    if (!element) throw new Error("editor not mounted");
    return element;
  });
  return { editor: (root as unknown as { editor: Editor }).editor, root };
}

function markdownOf(editor: Editor): string {
  return (editor.storage as unknown as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();
}

// What the browser puts on the clipboard when the user copies the whole note.
function copyAll(editor: Editor) {
  const { dom, text } = editor.view.serializeForClipboard(
    editor.state.doc.slice(0, editor.state.doc.content.size),
  );
  return { html: dom.innerHTML, text };
}

// A paste event as the browser delivers it, so the note's own paste handling
// sees it before the editor's.
function paste(editor: Editor, clipboard: { html?: string; text?: string }) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      items: [],
      types: ["text/plain", "text/html"],
      getData: (format: string) =>
        format === "text/html" ? clipboard.html ?? "" : format === "text/plain" ? clipboard.text ?? "" : "",
    },
  });
  fireEvent(editor.view.dom, event);
}

function imageResponse() {
  return new Response(new Uint8Array([71, 73, 70]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

describe("pasting into a note", () => {
  // jsdom has no layout, but the editor scrolls the caret into view on the
  // next frame after a paste.
  const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  beforeAll(() => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => emptyRect;
    vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  });
  afterAll(() => {
    delete (Range.prototype as Partial<Range>).getClientRects;
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    vi.mocked(window.scrollBy).mockRestore();
  });

  afterEach(() => {
    tauriFetchMock.mockReset();
  });

  it("keeps blocked images, alt text, size and order when part of a note is pasted", async () => {
    // A blocked image followed by an embedded one.
    const note = [
      "intro",
      "",
      "![sales chart](https://example.com/chart.png?d=secret)",
      "",
      `<img src="${EMBEDDED}" alt="whiteboard" width="40" height="30" />`,
    ].join("\n");
    const source = await mountNoteEditor(note);
    const target = await mountNoteEditor();

    paste(target.editor, copyAll(source.editor));

    await waitFor(() => expect(markdownOf(target.editor)).toBe(markdownOf(source.editor)));
    expect(markdownOf(target.editor)).toContain("![sales chart](https://example.com/chart.png?d=secret)");
    expect(target.root.querySelector(".meeting-note-image-blocked")).toHaveTextContent("sales chart");
    expect(target.root.querySelectorAll("img")).toHaveLength(1);
    expect(tauriFetchMock).not.toHaveBeenCalled();
  });

  it("embeds an image pasted from a web page", async () => {
    tauriFetchMock.mockResolvedValue(imageResponse());
    const { editor, root } = await mountNoteEditor("Notes");

    paste(editor, { html: `<img src="${WEB_IMAGE}">`, text: WEB_IMAGE });

    await waitFor(() => expect(markdownOf(editor)).toMatch(DOWNLOADED));
    expect(tauriFetchMock).toHaveBeenCalledWith(WEB_IMAGE, { method: "GET" }, expect.anything());
    expect(root.querySelector(".meeting-note-image-blocked")).toBeNull();
    expect(markdownOf(editor)).not.toContain(WEB_IMAGE);
  });

  it("keeps a pasted web image that can't be downloaded as a blocked image with its address", async () => {
    // Behind a login or hotlink protection.
    tauriFetchMock.mockResolvedValue(new Response("sign in", { status: 403, headers: { "content-type": "text/html" } }));
    const { editor, root } = await mountNoteEditor("Notes");

    paste(editor, { html: `<p>intro</p><img src="${WEB_IMAGE}">`, text: "intro" });

    await waitFor(() => expect(markdownOf(editor)).toContain(WEB_IMAGE));
    expect(markdownOf(editor)).toMatch(/intro/);
    const chip = root.querySelector(".meeting-note-image-blocked");
    expect(chip?.querySelector("[title]")).toHaveAttribute("title", WEB_IMAGE);
    expect(chip?.querySelector("button")).toHaveTextContent("Load image");
    expect(root.querySelector("img")).toBeNull();
  });

  it("keeps a pasted image as a blocked image when the note turns read-only during its download", async () => {
    let respond!: (response: Response) => void;
    tauriFetchMock.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));
    const onChange = vi.fn();
    const note = (readOnly: boolean) => <NoteEditor value="Notes" onChange={onChange} readOnly={readOnly} />;
    const { container, rerender } = render(note(false));
    const root = await waitFor(() => container.querySelector<HTMLElement>('[data-testid="note-editor"]')!);
    const editor = (root as unknown as { editor: Editor }).editor;

    paste(editor, { html: `<p>intro</p><img src="${WEB_IMAGE}">`, text: "intro" });
    await waitFor(() => expect(tauriFetchMock).toHaveBeenCalled());
    // A summary starts writing into the note.
    rerender(note(true));
    await waitFor(() => expect(editor.isEditable).toBe(false));
    const pasted = markdownOf(editor);
    respond(imageResponse());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The image stays where it was pasted, and can be loaded once the note can change.
    expect(pasted).toContain(WEB_IMAGE);
    expect(markdownOf(editor)).toBe(pasted);
    expect(root.querySelector(".meeting-note-image-blocked [title]")).toHaveAttribute("title", WEB_IMAGE);
    expect(onChange).not.toHaveBeenCalledWith(expect.stringMatching(DOWNLOADED));
  });

  it("holds a pasted web image's place and fills it in without moving the caret or focus", async () => {
    let respond!: (response: Response) => void;
    tauriFetchMock.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));
    const { editor, root } = await mountNoteEditor("Agenda");
    act(() => {
      editor.commands.focus("end");
    });

    paste(editor, { html: `<p>intro</p><img src="${WEB_IMAGE}">`, text: "intro" });
    await waitFor(() => expect(root.querySelector(".meeting-note-image-blocked")).not.toBeNull());
    // The paste itself focuses the note, a frame later.
    await waitFor(() => expect(document.activeElement).toBe(root));
    // The user keeps typing during the download, then moves to another field.
    act(() => {
      editor.commands.insertContent("Action items");
    });
    const selection = editor.state.selection.toJSON();
    const otherField = document.createElement("input");
    document.body.appendChild(otherField);
    otherField.focus();

    respond(imageResponse());

    await waitFor(() => expect(markdownOf(editor)).toMatch(DOWNLOADED));
    const text = markdownOf(editor);
    expect(text.indexOf("intro")).toBeLessThan(text.search(DOWNLOADED));
    expect(text.search(DOWNLOADED)).toBeLessThan(text.indexOf("Action items"));
    expect(text).not.toContain(WEB_IMAGE);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(document.activeElement).toBe(otherField);
    otherField.remove();
  });

  // The note page tells the user, and skips its analytics, when a dropped
  // image is left out.
  it("reports whether a dropped image went into the note", async () => {
    const ref = React.createRef<NoteEditorHandle>();
    const note = (readOnly: boolean) => (
      <NoteEditor ref={ref} value="Notes" onChange={() => {}} readOnly={readOnly} />
    );
    // A summary is being written into the note.
    const { container, rerender } = render(note(true));
    const root = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-testid="note-editor"]');
      if (!element) throw new Error("editor not mounted");
      return element;
    });
    const editor = (root as unknown as { editor: Editor }).editor;

    expect(ref.current!.insertImages([EMBEDDED])).toBe(false);
    expect(markdownOf(editor)).toBe("Notes");

    rerender(note(false));
    await waitFor(() => expect(editor.isEditable).toBe(true));
    let inserted = false;
    act(() => {
      inserted = ref.current!.insertImages([EMBEDDED]);
    });
    expect(inserted).toBe(true);
    expect(markdownOf(editor)).toContain(EMBEDDED);
  });

  it("keeps the rest of a pasted web selection while its image downloads", async () => {
    tauriFetchMock.mockResolvedValue(imageResponse());
    const { editor } = await mountNoteEditor();

    // Ends with a rule, which the editor selects after inserting it.
    paste(editor, { html: `<p>intro</p><hr><img src="${WEB_IMAGE}">`, text: "intro" });

    await waitFor(() => expect(markdownOf(editor)).toMatch(DOWNLOADED));
    expect(markdownOf(editor)).toMatch(/^intro\n\n---\n\n!\[/);
  });

  it("replaces the selection when pasting, not what is selected during the download", async () => {
    let respond!: (response: Response) => void;
    tauriFetchMock.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));
    const { editor } = await mountNoteEditor("draft agenda");

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 7 });
    });
    paste(editor, { html: `<img src="${WEB_IMAGE}">`, text: WEB_IMAGE });
    expect(editor.state.doc.textContent).toBe("agenda");

    // The user selects the remaining text before the image arrives.
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 7 });
    });
    respond(imageResponse());

    await waitFor(() => expect(markdownOf(editor)).toMatch(DOWNLOADED));
    expect(editor.state.doc.textContent).toBe("agenda");
  });
});
