// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Daily summaries and meeting notes render AI-written markdown with the
// default anchor. A plain web link there loads the site inside the app window,
// so web links must open in the system browser: the opener plugin does that
// for `_blank` http(s) clicks.

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    openViewerWindow: vi.fn(async () => ({ status: "ok" })),
  },
}));

vi.mock("@/components/rewind/media", () => ({
  MediaComponent: () => null,
}));

import { MemoizedReactMarkdown, chatUrlTransform } from "@/components/markdown";

function renderLink(markdown: string): HTMLElement {
  render(<MemoizedReactMarkdown urlTransform={chatUrlTransform}>{markdown}</MemoizedReactMarkdown>);
  return screen.getByRole("link");
}

describe("MemoizedReactMarkdown web links", () => {
  it.each(["https://example.com/a", "http://example.com/a", "HTTPS://example.com/a"])(
    "opens %s outside the app window",
    (href) => {
      const link = renderLink(`[site](${href})`);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    },
  );

  it("opens a web media image, which renders as a link, outside the app window", () => {
    const link = renderLink("![clip](https://example.com/clip.mp4)");
    expect(link.getAttribute("href")).toBe("https://example.com/clip.mp4");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it.each(["screenpipe://frame/123", "#notes"])("leaves %s to the app", (href) => {
    const link = renderLink(`[in app](${href})`);
    expect(link.getAttribute("href")).toBe(href);
    expect(link.hasAttribute("target")).toBe(false);
  });
});
