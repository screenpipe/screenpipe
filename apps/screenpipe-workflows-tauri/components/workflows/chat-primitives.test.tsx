// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown, ComposerTextArea } from "@screenpipe/workflows-ui/chat";

describe("shared Screenpipe chat primitives", () => {
  it("renders real Markdown structure without loading images or active HTML", () => {
    const { container } = render(<ChatMarkdown text={'## Findings\n\n1. **Review** the brief\n2. Share feedback\n\n| Step | Result |\n| --- | --- |\n| Review | Ready |\n\n```ts\nconst ready = true;\n```\n\n![tracking](https://example.com/pixel)\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1))'} />);
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("const ready = true;");
    expect(container.querySelector("img, script")).toBeNull();
    expect(screen.queryByRole("link", { name: "Bad" })).not.toBeInTheDocument();
  });

  it("keeps completed streaming blocks formatted and replaces the tail on completion", () => {
    const { rerender } = render(<ChatMarkdown text={"**Ready.**\n\nA partial *word"} streaming />);
    const stable = screen.getByText("Ready.").closest("p");
    expect(stable?.querySelector("strong")).not.toBeNull();
    expect(screen.getByTestId("streaming-markdown-tail")).toHaveTextContent("A partial *word");
    rerender(<ChatMarkdown text={"**Ready.**\n\nA partial *word completed*."} streaming />);
    expect(screen.getByText("Ready.").closest("p")).toBe(stable);
    rerender(<ChatMarkdown text={"**Ready.**\n\nA partial *word completed*."} />);
    expect(screen.queryByTestId("streaming-markdown-tail")).not.toBeInTheDocument();
    expect(screen.getByText("word completed").tagName).toBe("EM");
  });

  it("does not send on Shift-Enter or an IME composition confirmation", () => {
    const onSend = vi.fn();
    render(<ComposerTextArea aria-label="Message" onSend={onSend} />);
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("grows with the draft, caps its height, and shrinks after sending", () => {
    const { rerender } = render(<ComposerTextArea value="" onChange={() => {}} />);
    const input = screen.getByRole("textbox");
    Object.defineProperty(input, "scrollHeight", { value: 300, configurable: true });
    rerender(<ComposerTextArea value="Long draft" onChange={() => {}} />);
    expect(input).toHaveStyle({ height: "160px", overflowY: "auto" });
    Object.defineProperty(input, "scrollHeight", { value: 30, configurable: true });
    rerender(<ComposerTextArea value="" onChange={() => {}} />);
    expect(input).toHaveStyle({ height: "42px", overflowY: "hidden" });
  });
});
