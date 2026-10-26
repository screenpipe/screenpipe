// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { TimingDisclosure } from "../../../../packages/workflows-ui/src/timing-disclosure";
import { WorkflowEditor } from "../../../../packages/workflows-ui/src/workflow-editor";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowsApp, workflowTiming, sanitizeWorkflowAnalysis, filterWorkflows, defaultWorkflowFilters } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

describe("workflow elapsed timing", () => {
  const workflow = fixtureWorkflowAnalysis.analysis.workflows.find(w => w.title === "Research synthesis")!;
  it("derives the arithmetic average from runs and keeps it through catalog sanitization", () => {
    const corruptTotals = { ...workflow.timing!, averageMinutes: 9999, sampleCount: 50 };
    expect(workflowTiming(corruptTotals)).toMatchObject({ averageMinutes: 24, sampleCount: 3, minMinutes: 18, maxMinutes: 30 });
    const catalog = sanitizeWorkflowAnalysis(fixtureWorkflowAnalysis);
    expect(catalog.analysis.workflows.find(w => w.title === workflow.title)?.timing?.averageMinutes).toBe(24);
    expect(workflowTiming(null)).toBeNull();
    expect(catalog.analysis.workflows.find(w => w.title === workflow.title)?.stages[0].timing).toMatchObject({ averageMinutes: 5, sampleCount: 2 });
  });
  it("rejects invalid dates, duplicate and overlapping runs", () => {
    const value = workflow.timing!;
    expect(workflowTiming({ ...value, runs: [value.runs[0], value.runs[0]] })).toBeNull();
    expect(workflowTiming({ ...value, runs: [{ ...value.runs[0], end: { ...value.runs[0].end, timestamp: "invalid" } }] })).toBeNull();
    expect(workflowTiming({ ...value, basis: "model-guess" })).toBeNull();
  });
  it("labels legacy meeting medians accurately", () => {
    render(<TimingDisclosure value={null} label="Meeting timing" measured={{ minutes: 30, samples: 4 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Meeting timing" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("30m median duration");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("on average");
  });
  it("omits empty timing in documents and shows the duration when evidence exists", () => {
    const view = render(<TimingDisclosure value={null} label="Timing" hideWhenUnknown showDuration />);
    expect(screen.queryByRole("button", { name: "Timing" })).not.toBeInTheDocument();
    view.rerender(<TimingDisclosure value={workflow.timing} label="Timing" hideWhenUnknown showDuration />);
    const trigger = screen.getByRole("button", { name: "Timing" });
    expect(trigger).toHaveTextContent("24m");
    fireEvent.click(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("3 observed runs");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    view.rerender(<TimingDisclosure value={null} label="Timing" hideWhenUnknown showDuration measured={{ minutes: 30, samples: 1 }} />);
    expect(screen.queryByRole("button", { name: "Timing" })).not.toBeInTheDocument();
  });
  it("filters by average time, without classifying unknowns as short runs", () => {
    const unknown = { ...workflow, timing: null, durationSource: "unknown" as const };
    expect(filterWorkflows([workflow, unknown], { ...defaultWorkflowFilters, duration: "medium" })).toEqual([workflow]);
    expect(filterWorkflows([unknown], { ...defaultWorkflowFilters, duration: "short" })).toEqual([]);
  });
  it("keeps step timing tied to its source on reorder and hides stale timing while editing", async () => {
    sessionStorage.clear();
    render(<WorkflowEditor workflow={workflow} save={() => new Promise(() => {})} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Step 1 actions" }), { key: "ArrowDown", altKey: true });
    const moved = screen.getByRole("button", { name: "Timing for step 2" });
    fireEvent.mouseEnter(moved);
    expect(screen.getByRole("tooltip")).toHaveTextContent("5m on average");
    fireEvent.mouseLeave(moved);
    fireEvent.change(screen.getByRole("textbox", { name: "Step 2 title" }), { target: { value: "Different scope" } });
    expect(screen.queryByRole("button", { name: "Timing for step 2" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workflow timing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("keeps catalog metrics separate from measured timing in the workflow", async () => {
    window.history.replaceState(null, "", "/home?mode=workflows");
    const openLink = vi.fn().mockResolvedValue(undefined);
    const platform = createFixtureWorkflowsPlatform();
    platform.assistant!.openLink = openLink;
    await act(async () => { render(<WorkflowsApp platform={platform} initialAnalysis={fixtureWorkflowAnalysis} storageKey={null} />); });
    const card = screen.getByRole("heading", { name: "Research synthesis" }).closest("article")!;
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(within(card).getByText("Evidence-backed steps")).toBeVisible();
    expect(within(card).getByText("Not estimated")).toBeVisible();
    expect(within(card).queryByRole("button", { name: "Timing for Research synthesis" })).not.toBeInTheDocument();
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(card).getByRole("button"));
    expect(screen.queryByText("Correct this workflow")).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence and limitations")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Questions and feedback" })).toBeVisible();
    const global = screen.getByRole("button", { name: "Workflow timing" });
    fireEvent.click(global);
    expect(screen.getByRole("tooltip")).toHaveTextContent("24m on average");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const step = screen.getByRole("button", { name: "Timing for step 1" });
    fireEvent.mouseEnter(step);
    expect(screen.getByRole("tooltip")).toHaveTextContent("5m on average");
    expect(screen.getByRole("tooltip")).toHaveTextContent("2 observed runs · 4m to 6m");
    fireEvent.mouseLeave(step);
    expect(screen.queryByRole("button", { name: "Timing for step 2" })).not.toBeInTheDocument();
    // Removing diagnostic chrome must not discard the persisted run boundaries.
    expect(workflowTiming(workflow.timing)).toMatchObject({ averageMinutes: 24, sampleCount: 3 });
  });
});
