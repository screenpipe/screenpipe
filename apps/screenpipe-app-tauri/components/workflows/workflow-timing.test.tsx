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
  it("filters by average time, without classifying unknowns as short runs", () => {
    const unknown = { ...workflow, timing: null, durationSource: "unknown" as const };
    expect(filterWorkflows([workflow, unknown], { ...defaultWorkflowFilters, duration: "medium" })).toEqual([workflow]);
    expect(filterWorkflows([unknown], { ...defaultWorkflowFilters, duration: "short" })).toEqual([]);
  });
  it("keeps step timing tied to its source on reorder and hides stale timing while editing", async () => {
    sessionStorage.clear();
    render(<WorkflowEditor workflow={workflow} save={() => new Promise(() => {})} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Move step 1" }), { key: "ArrowDown", altKey: true });
    const moved = screen.getByRole("button", { name: "Timing for step 2" });
    fireEvent.mouseEnter(moved);
    expect(screen.getByRole("tooltip")).toHaveTextContent("5m on average");
    fireEvent.mouseLeave(moved);
    fireEvent.change(screen.getByRole("textbox", { name: "Step 2 title" }), { target: { value: "Different scope" } });
    fireEvent.mouseEnter(moved);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Time not measured yet");
    fireEvent.mouseLeave(moved);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Workflow timing" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Time not measured yet");
  });
  it("shows average, single and unknown cards without the removed evidence diagnostics", async () => {
    window.history.replaceState(null, "", "/home?mode=workflows");
    const openLink = vi.fn().mockResolvedValue(undefined);
    const platform = createFixtureWorkflowsPlatform();
    platform.assistant!.openLink = openLink;
    await act(async () => { render(<WorkflowsApp platform={platform} initialAnalysis={fixtureWorkflowAnalysis} storageKey={null} />); });
    const card = screen.getByRole("heading", { name: "Research synthesis" }).closest("article")!;
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const clock = within(card).getByRole("button", { name: "Timing for Research synthesis" });
    fireEvent.mouseEnter(clock);
    expect(screen.getByRole("tooltip")).toHaveTextContent("24m on average");
    expect(screen.getByRole("tooltip")).toHaveTextContent("3 observed runs · 18m to 30m");
    fireEvent.keyDown(clock, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(within(card).getByText(workflow.description)).toBeVisible();
    expect(card.querySelector("details")).toBeNull();
    expect(within(card).getAllByRole("button")).toHaveLength(2);
    const single = screen.getByRole("heading", { name: "Partner meeting preparation" }).closest("article")!;
    const singleClock = within(single).getByRole("button", { name: "Timing for Partner meeting preparation" });
    fireEvent.focus(singleClock);
    expect(screen.getByRole("tooltip")).toHaveTextContent("12m for one run");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("on average");
    fireEvent.blur(singleClock);
    const unknown = screen.getByRole("heading", { name: "Website release check" }).closest("article")!;
    expect(within(unknown).queryByText(/\/ run/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Open map" }));
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
    fireEvent.focus(screen.getByRole("button", { name: "Timing for step 2" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Time not measured yet");
    // Removing diagnostic chrome must not discard the persisted run boundaries.
    expect(workflowTiming(workflow.timing)).toMatchObject({ averageMinutes: 24, sampleCount: 3 });
  });
});
