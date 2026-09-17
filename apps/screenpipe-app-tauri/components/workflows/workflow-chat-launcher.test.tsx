// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowAssistant, emptyAssistantState, type WorkflowsAssistantPlatform, type AssistantState } from "@screenpipe/workflows-ui";

function Shell({ platform }: { platform: WorkflowsAssistantPlatform }) {
  const [mode, setMode] = useState<AssistantState["mode"] | null>(null);
  const [docked, setDocked] = useState(false);
  return <>
    {mode === "sidebar" && !docked && <button aria-label="Open right sidebar" onClick={() => window.dispatchEvent(new Event("workflows:toggle-assistant"))} />}
    <WorkflowAssistant platform={platform} context={{ key: "catalog", title: "Workflows" }} headerToggle onModeChange={setMode} onDockChange={setDocked} />
  </>;
}
function platform(load: WorkflowsAssistantPlatform["load"]): WorkflowsAssistantPlatform {
  return { load, save: vi.fn().mockResolvedValue(undefined), ask: vi.fn().mockResolvedValue("Answer") };
}

describe("chat launchers follow the saved display mode", () => {
  it.each(["floating", "sidebar"] as const)("restores %s before showing its launcher, without opening chat", async mode => {
    let finish!: (state: AssistantState) => void;
    const load = vi.fn(() => new Promise<AssistantState>(resolve => { finish = resolve; }));
    render(<Shell platform={platform(load)} />);
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open right sidebar" })).not.toBeInTheDocument();
    const saved = emptyAssistantState(); saved.mode = mode;
    saved.conversations[0].draft = "Keep my draft";
    await act(async () => finish(saved));
    const launcher = mode === "floating" ? "Open chat" : "Open right sidebar";
    expect(screen.queryByRole("region", { name: "Screenpipe assistant" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: launcher }));
    expect(screen.getByRole("region", { name: "Screenpipe assistant" })).toHaveAttribute("data-mode", mode);
    expect(screen.getByRole("textbox", { name: "Ask Screenpipe" })).toHaveValue("Keep my draft");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("defaults to the bubble and swaps launchers only when the user changes display mode", async () => {
    const api = platform(vi.fn().mockResolvedValue(null));
    render(<Shell platform={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    expect(screen.queryByRole("button", { name: "Open right sidebar" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent question" } });
    fireEvent.click(screen.getByRole("button", { name: "Chat display" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse right sidebar" }));
    expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open right sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat display" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Floating" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimize chat" }));
    expect(screen.queryByRole("button", { name: "Open right sidebar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByRole("textbox")).toHaveValue("Unsent question");
    await waitFor(() => expect(api.save).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "floating" })));
  });
});
