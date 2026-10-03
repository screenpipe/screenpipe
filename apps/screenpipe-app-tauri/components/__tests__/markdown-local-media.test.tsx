// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import remarkGfm from "remark-gfm";

// The native media reader is the only boundary faked here: everything between
// the markdown text and the file request runs for real.
const getMediaFileCommand = vi.hoisted(() => vi.fn());

vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    getMediaFile: getMediaFileCommand,
    openViewerWindow: vi.fn(async () => ({ status: "ok" })),
  },
}));

import { MemoizedReactMarkdown, chatUrlTransform } from "@/components/markdown";

describe("MemoizedReactMarkdown local media", () => {
  beforeEach(() => {
    getMediaFileCommand.mockResolvedValue({
      status: "ok",
      data: { data: "AAAA", mimeType: "video/mp4" },
    });
    URL.createObjectURL = vi.fn(() => "blob:local-media");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    getMediaFileCommand.mockReset();
  });

  it.each([
    ["a bare filename", "Here is the file: `demo.mp4`", ["demo.mp4"]],
    ["a bare extension", "any name ending in `.mp4`", [".mp4"]],
    ["a relative path", "saved to `clips/demo.mp4`", ["clips/demo.mp4"]],
    [
      "a filename pattern",
      "recordings are saved as `~/.screenpipe/data/monitor_*.mp4`",
      ["~/.screenpipe/data/monitor_*.mp4"],
    ],
    [
      "a placeholder path",
      "saved as `~/.screenpipe/data/monitor_<id>.mp4`",
      ["~/.screenpipe/data/monitor_<id>.mp4"],
    ],
    [
      "two paths on one line",
      "compare `/Users/me/Movies/a.mp4, /Users/me/Movies/b.mp4`",
      ["/Users/me/Movies/a.mp4, /Users/me/Movies/b.mp4"],
    ],
    [
      "bare filenames in a table",
      [
        "| File | Size |",
        "|---|---|",
        "| `before-github.mp4` | 2.6 MB |",
        "| `after-github.mp4` | 2.5 MB |",
      ].join("\n"),
      ["before-github.mp4", "after-github.mp4"],
    ],
  ])("keeps %s in inline code as text", (_label, markdown, names) => {
    render(
      <MemoizedReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</MemoizedReactMarkdown>,
    );

    for (const name of names) {
      expect(screen.getByText(name).tagName).toBe("CODE");
    }
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  it("keeps a code block listing several recordings as text", () => {
    const { container } = render(
      <MemoizedReactMarkdown>
        {"```\n/Users/me/Movies/a.mp4\n/Users/me/Movies/b.mp4\n```"}
      </MemoizedReactMarkdown>,
    );

    expect(container.querySelector("pre code")?.textContent).toContain("/Users/me/Movies/b.mp4");
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  // An <img> can never show audio or video, so a media address the reader
  // can't open must not fall through to a broken image.
  it.each([
    ["a bare filename", "![after](after-github.mp4)", "after-github.mp4", "after after-github.mp4"],
    ["a name with spaces", "![](<after github.mp4>)", "after github.mp4", "after github.mp4"],
  ])("shows an image-syntax video with %s as text", (_label, markdown, name, text) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>{markdown}</MemoizedReactMarkdown>,
    );

    expect(container.textContent).toBe(text);
    expect(screen.getByText(name).tagName).toBe("CODE");
    expect(container.querySelector("img")).toBeNull();
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/clip.webm"],
    ["https://example.com/clip.mp4?t=1"],
  ])("opens an image-syntax web video at %s as a link", (src) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>
        {`![clip](${src})`}
      </MemoizedReactMarkdown>,
    );

    expect(screen.getByRole("link", { name: "clip" })).toHaveAttribute("href", src);
    expect(container.querySelector("img")).toBeNull();
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  // Nothing in the app resolves a relative address, so such a link would do
  // nothing when clicked.
  it.each([
    ["a bare filename", "after-github.mp4"],
    ["a relative path with a fragment", "clips/after-github.mp4#t=3"],
  ])("shows a link to %s as its words and address", (_label, address) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>
        {`Watch [after](${address}) now`}
      </MemoizedReactMarkdown>,
    );

    expect(container.textContent).toBe(`Watch after ${address} now`);
    expect(screen.getByText(address).tagName).toBe("CODE");
    expect(screen.queryByRole("link")).toBeNull();
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  it("shows a link with no words as its address alone", () => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>
        {"Watch [](after-github.mp4) now"}
      </MemoizedReactMarkdown>,
    );

    expect(container.textContent).toBe("Watch after-github.mp4 now");
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["https://example.com/demo.mp4"],
    ["//cdn.example.com/demo.mp4"],
  ])("keeps a web link to %s as a link", (href) => {
    render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>
        {`[demo](${href})`}
      </MemoizedReactMarkdown>,
    );

    expect(screen.getByRole("link", { name: "demo" })).toHaveAttribute("href", href);
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  // The meeting chat hides images with its own img; media isn't an image.
  it.each([
    ["web", "![clip](https://example.com/clip.mp4)", "clip", () => screen.getByRole("link", { name: "clip" })],
    ["relative", "![after](after-github.mp4)", "after after-github.mp4", () => screen.getByText("after-github.mp4")],
  ])("keeps a %s media image visible when the caller hides images", (_label, markdown, text, find) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform} components={{ img: () => null }}>
        {markdown}
      </MemoizedReactMarkdown>,
    );

    expect(container.textContent).toBe(text);
    expect(find()).toBeInTheDocument();
    expect(getMediaFileCommand).not.toHaveBeenCalled();
  });

  // The media player caches by path for the whole module, so every case below
  // uses a path no other test loads.
  it.each([
    [
      "an absolute recording path",
      "`/Users/me/.screenpipe/data/monitor_1_2026-09-28_10-30-00.mp4`",
      "/Users/me/.screenpipe/data/monitor_1_2026-09-28_10-30-00.mp4",
    ],
    [
      "an image-syntax video",
      "![screen recording](</Users/me/Movies/demo-run.mp4>)",
      "/Users/me/Movies/demo-run.mp4",
    ],
    ["a home-relative path", "`~/Downloads/clip.mp4`", "~/Downloads/clip.mp4"],
    [
      "a Windows path",
      "`C:\\Users\\me\\.screenpipe\\data\\monitor_1.mp4`",
      "C:\\Users\\me\\.screenpipe\\data\\monitor_1.mp4",
    ],
    [
      "a file URL link",
      "[clip](file:///Users/me/Movies/export.mp4)",
      "/Users/me/Movies/export.mp4",
    ],
    [
      // The markdown parser percent-encodes backslashes in link addresses.
      "an image-syntax Windows video",
      "![export](<C:\\Users\\me\\Downloads\\export.mp4>)",
      "C:\\Users\\me\\Downloads\\export.mp4",
    ],
  ])("plays %s", async (_label, markdown, path) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>{markdown}</MemoizedReactMarkdown>,
    );

    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    expect(getMediaFileCommand).toHaveBeenCalledWith(path);
  });

  // Audio recordings are named after the device, which can hold a `<`.
  it.each([
    [
      "inline code",
      "/Users/me/.screenpipe/data/Sam's Buds <3 (input)_2026-09-29_10-00-00.mp4",
      (path: string) => `\`${path}\``,
    ],
    [
      "a link",
      "/Users/me/.screenpipe/data/Sam's Buds <3 (input)_2026-09-29_10-00-01.mp4",
      (path: string) => `[the recording](${path})`,
    ],
  ])("plays a device recording whose name has <3, written as %s", async (_label, path, write) => {
    const { container } = render(
      <MemoizedReactMarkdown urlTransform={chatUrlTransform}>{write(path)}</MemoizedReactMarkdown>,
    );

    await waitFor(() => expect(container.querySelector("audio")).not.toBeNull());
    expect(getMediaFileCommand).toHaveBeenCalledWith(path);
  });

  describe("when the file can't be read", () => {
    // Long enough for the player to use up all of its retries.
    const RETRIES_DONE_MS = 4_000;

    beforeEach(() => {
      vi.useFakeTimers();
      getMediaFileCommand.mockResolvedValue({ status: "error", error: "File does not exist" });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const renderMarkdown = (markdown: string) =>
      render(
        <MemoizedReactMarkdown urlTransform={chatUrlTransform}>{markdown}</MemoizedReactMarkdown>,
      );

    it.each([
      [
        "inline code",
        "saved to `/Users/me/Movies/missing-code.mp4`",
        "saved to /Users/me/Movies/missing-code.mp4",
      ],
      [
        "a link",
        "Here is [the recording](</Users/me/Movies/missing-link.mp4>).",
        "Here is the recording /Users/me/Movies/missing-link.mp4.",
      ],
      [
        "a link named by its own path",
        "Here is [/Users/me/Movies/missing-self.mp4](/Users/me/Movies/missing-self.mp4).",
        "Here is /Users/me/Movies/missing-self.mp4.",
      ],
      [
        "an image",
        "![clip](</Users/me/Movies/missing-image.mp4>)",
        "clip /Users/me/Movies/missing-image.mp4",
      ],
      [
        "an image with no alt text",
        "![](</Users/me/Movies/missing-no-alt.mp4>)",
        "/Users/me/Movies/missing-no-alt.mp4",
      ],
    ])("shows %s as text that keeps the path", async (_label, markdown, text) => {
      const { container } = renderMarkdown(markdown);
      await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));

      expect(container.textContent).toBe(text);
      expect(container.querySelector("code")?.textContent).toMatch(/^\/Users\/me\/Movies\/missing-/);
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByText(/Failed to load media/)).toBeNull();
    });

    it("shows a file already found missing at once, checking it only once more", async () => {
      const path = "/Users/me/Movies/missing-again.mp4";
      const first = renderMarkdown(`\`${path}\``);
      await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));
      first.unmount();
      getMediaFileCommand.mockClear();

      // Switching back to the chat mounts the player again.
      renderMarkdown(`\`${path}\``);
      expect(screen.getByText(path).tagName).toBe("CODE");
      expect(screen.queryByText("Loading media...")).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));
      expect(getMediaFileCommand).toHaveBeenCalledTimes(1);
    });

    it("plays a file that appears after it was found missing", async () => {
      const path = "/Users/me/Movies/appears-later.mp4";
      const first = renderMarkdown(`\`${path}\``);
      await act(() => vi.advanceTimersByTimeAsync(RETRIES_DONE_MS));
      first.unmount();

      getMediaFileCommand.mockResolvedValue({
        status: "ok",
        data: { data: "AAAA", mimeType: "video/mp4" },
      });
      const { container } = renderMarkdown(`\`${path}\``);
      await act(() => vi.advanceTimersByTimeAsync(10));

      expect(container.querySelector("video")).not.toBeNull();
    });
  });
});
