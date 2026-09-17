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
  await screen.findByText("I suggest tracking this in Attio.");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop answer" })).not.toBeInTheDocument());
}
function submit() {
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Screenpipe" }), { target: { value: "Use Attio, not Gmail." } });
  fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
}

describe("workflow feedback conversation", () => {
  it("automatically reviews a fresh chat on every click and preserves ordinary drafts", async () => {
    const saved = emptyAssistantState(); saved.conversations[0].draft = "An unfinished question";
    const { platform } = setup({ load: vi.fn().mockResolvedValue(saved) });
    await openFeedback();
    expect(platform.ask).toHaveBeenCalledTimes(1);
    expect(platform.ask).toHaveBeenLastCalledWith(expect.objectContaining({ question: expect.stringContaining("3 specific questions"), history: [], context: expect.objectContaining({ workflow: expect.objectContaining({ id: "wf-original" }) }) }));
    expect(platform.saveFeedback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save feedback" })).not.toBeInTheDocument();
    await openFeedback();
    await waitFor(() => expect(platform.ask).toHaveBeenCalledTimes(2));
    expect(vi.mocked(platform.ask).mock.calls[1][0].history).toEqual([]);
    const latest = vi.mocked(platform.save).mock.calls.at(-1)![0];
    expect(latest.conversations).toHaveLength(3);
    expect(latest.conversations[0].draft).toBe("An unfinished question");
  });

  it("keeps discussion scoped after navigation and saves only on an explicit click", async () => {
    const { platform, props, rerender } = setup(); await openFeedback();
    rerender(<WorkflowAssistant {...props} context={{ key: "different", title: "Another workflow" }} />);
    submit();
    await screen.findByRole("button", { name: "Save feedback" });
    expect(platform.saveFeedback).not.toHaveBeenCalled();
    expect(platform.ask).toHaveBeenLastCalledWith(expect.objectContaining({ context: expect.objectContaining({ purpose: "feedback", workflow: expect.objectContaining({ id: "wf-original" }) }) }));
    fireEvent.click(screen.getByRole("button", { name: "Save feedback" }));
    await screen.findByText("Feedback saved for the next update");
    expect(platform.saveFeedback).toHaveBeenCalledWith(expect.objectContaining({ id: "wf-original" }), expect.stringContaining("User: Use Attio, not Gmail."));
    const correction = vi.mocked(platform.saveFeedback!).mock.calls[0][1];
    expect(correction).toContain("Keep the reviewed step.");
    expect(correction).not.toContain("Review this workflow and ask me");
    fireEvent.click(screen.getByRole("button", { name: "Retry answer" }));
    await waitFor(() => expect(platform.ask).toHaveBeenCalledTimes(3));
    expect(platform.saveFeedback).toHaveBeenCalledTimes(1);
  });

  it("retains the conversation and allows a failed feedback save to be retried", async () => {
    const saveFeedback = vi.fn().mockRejectedValueOnce(new Error("Could not save feedback")).mockResolvedValue(undefined);
    const { platform } = setup({ saveFeedback }); await openFeedback(); submit();
    fireEvent.click(await screen.findByRole("button", { name: "Save feedback" }));
    await screen.findByText("Could not save feedback");
    expect(screen.queryByText("Feedback saved for the next update")).not.toBeInTheDocument();
    expect(screen.getByText("Use Attio, not Gmail.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save feedback" }));
    await screen.findByText("Feedback saved for the next update");
    expect(saveFeedback).toHaveBeenCalledTimes(2);
    expect(platform.ask).toHaveBeenCalledTimes(2);
  });

  it("starts only once when feedback is opened before saved chats finish loading", async () => {
    let resolveLoad!: (value: null) => void;
    const { platform } = setup({ load: vi.fn(() => new Promise(resolve => { resolveLoad = resolve; })) });
    act(() => { window.dispatchEvent(new CustomEvent("workflows:feedback", { detail: feedback })); });
    expect(platform.ask).not.toHaveBeenCalled();
    await act(async () => resolveLoad(null));
    await screen.findByText("I suggest tracking this in Attio.");
    expect(platform.ask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Minimize chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask Screenpipe" }));
    expect(platform.ask).toHaveBeenCalledTimes(1);
  });

  it("carries refinements into later turns without a save button or media in history", async () => {
    const updated = { ...workflow, revision: 4, description: "Use Attio", userCorrection: "User feedback: Use Attio.", screenshot: { dataUrl: "private-image" } };
    const ask = vi.fn().mockResolvedValueOnce("I suggest tracking this in Attio.").mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ text: "Refined", activity: "writing", workflow: updated }); return "Workflow updated.";
    }).mockResolvedValue("Anything else?");
    const { platform } = setup({ learnsFromFeedback: true, ask }); await openFeedback(); submit();
    await screen.findByText("Workflow updated.");
    expect(screen.queryByRole("button", { name: "Save feedback" })).not.toBeInTheDocument();
    submit();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
    const context = ask.mock.calls[2][0].context;
    expect(context.workflow.revision).toBe(4);
    expect(context.workflow.userCorrection).toBe("User feedback: Use Attio.");
    expect(JSON.stringify(context)).not.toContain("private-image");
    expect(platform.saveFeedback).not.toHaveBeenCalled();
  });

  it("inserts dictation into the draft without sending and removes the control when hidden", async () => {
    const { platform, props, rerender } = setup();
    const accessory = ({ onValueChange }: any) => <button type="button" onClick={() => onValueChange("Dictated correction")}>Test microphone</button>;
    rerender(<WorkflowAssistant {...props} composerAccessory={accessory} />);
    await openFeedback();
    fireEvent.click(screen.getByRole("button", { name: "Test microphone" }));
    expect(screen.getByRole("textbox")).toHaveValue("Dictated correction");
    expect(platform.ask).toHaveBeenCalledTimes(1);
    expect(platform.saveFeedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Minimize chat" }));
    expect(screen.queryByText("Test microphone")).not.toBeInTheDocument();
    rerender(<WorkflowAssistant {...props} active={false} composerAccessory={accessory} />);
    expect(screen.queryByText("Test microphone")).not.toBeInTheDocument();
  });
});
