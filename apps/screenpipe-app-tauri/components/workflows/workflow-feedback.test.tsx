// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowAssistant, emptyAssistantState, type WorkflowsAssistantPlatform } from "@screenpipe/workflows-ui";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

const workflow = { ...fixtureWorkflowAnalysis.analysis.workflows[0], id: "wf-original", userCorrection: "Keep the reviewed step." };
const feedback = { purpose: "feedback" as const, key: "feedback:wf-original", title: workflow.title, workflow };
function setup(overrides: Partial<WorkflowsAssistantPlatform> = {}) {
  const platform: WorkflowsAssistantPlatform = { load: vi.fn().mockResolvedValue(null), save: vi.fn().mockResolvedValue(undefined), saveFeedback: vi.fn().mockResolvedValue(undefined), ask: vi.fn().mockResolvedValue("I suggest tracking this in Attio."), ...overrides };
  const props = { platform, context: { key: "catalog", title: "Your workflows" }, onDockChange: vi.fn() };
  return { platform, props, ...render(<WorkflowAssistant {...props} />) };
}
async function openFeedback() {
  act(() => { window.dispatchEvent(new CustomEvent("workflows:feedback", { detail: feedback })); });
  await screen.findByRole("heading", { name: "What should change?" });
}
function submit() {
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Screenpipe" }), { target: { value: "Use Attio, not Gmail." } });
  fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
}

describe("workflow feedback conversation", () => {
  it("opens without AI or recording and preserves the ordinary chat draft", async () => {
    const saved = emptyAssistantState(); saved.conversations[0].draft = "An unfinished question";
    const { platform } = setup({ load: vi.fn().mockResolvedValue(saved) });
    await openFeedback();
    expect(platform.ask).not.toHaveBeenCalled();
    expect(platform.saveFeedback).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
    submit();
    await screen.findByText("I suggest tracking this in Attio.");
    expect(platform.save).toHaveBeenCalledWith(expect.objectContaining({ conversations: expect.arrayContaining([expect.objectContaining({ draft: "An unfinished question" })]) }));
  });

  it("saves before inference, stays scoped after navigation and does not save twice on retry", async () => {
    const { platform, props, rerender } = setup(); await openFeedback();
    rerender(<WorkflowAssistant {...props} context={{ key: "different", title: "Another workflow" }} />);
    submit(); await screen.findByText("I suggest tracking this in Attio.");
    expect(platform.saveFeedback).toHaveBeenCalledWith(expect.objectContaining({ id: "wf-original" }), expect.stringContaining("Keep the reviewed step.\n\nUser: Use Attio, not Gmail."));
    expect(platform.ask).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ purpose: "feedback", workflow: expect.objectContaining({ id: "wf-original" }) }) }));
    expect(vi.mocked(platform.saveFeedback!).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(platform.ask).mock.invocationCallOrder[0]);
    expect(screen.getByText("Feedback saved for the next update")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry answer" }));
    await waitFor(() => expect(platform.ask).toHaveBeenCalledTimes(2));
    expect(platform.saveFeedback).toHaveBeenCalledTimes(1);
  });

  it("does not run AI or show a saved receipt when saving feedback fails", async () => {
    const saveFeedback = vi.fn().mockRejectedValueOnce(new Error("Could not save feedback")).mockResolvedValue(undefined);
    const { platform } = setup({ saveFeedback }); await openFeedback(); submit();
    await screen.findByText("Could not save feedback");
    expect(platform.ask).not.toHaveBeenCalled();
    expect(screen.queryByText("Feedback saved for the next update")).not.toBeInTheDocument();
    expect(screen.getByText("Use Attio, not Gmail.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("I suggest tracking this in Attio.");
    expect(saveFeedback).toHaveBeenCalledTimes(2);
  });

  it("inserts dictation into the draft without sending and removes the control when hidden", async () => {
    const { platform, props, rerender } = setup();
    const accessory = ({ onValueChange }: any) => <button type="button" onClick={() => onValueChange("Dictated correction")}>Test microphone</button>;
    rerender(<WorkflowAssistant {...props} composerAccessory={accessory} />);
    await openFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    expect(screen.getByRole("textbox")).toHaveValue("Dictated correction");
    expect(platform.ask).not.toHaveBeenCalled();
    expect(platform.saveFeedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Minimize chat" }));
    expect(screen.queryByText("Test microphone")).not.toBeInTheDocument();
    rerender(<WorkflowAssistant {...props} active={false} composerAccessory={accessory} />);
    expect(screen.queryByText("Test microphone")).not.toBeInTheDocument();
  });
});
