// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
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
  });
  it("rejects invalid dates, duplicate and overlapping runs", () => {
    const value = workflow.timing!;
    expect(workflowTiming({ ...value, runs: [value.runs[0], value.runs[0]] })).toBeNull();
    expect(workflowTiming({ ...value, runs: [{ ...value.runs[0], end: { ...value.runs[0].end, timestamp: "invalid" } }] })).toBeNull();
    expect(workflowTiming({ ...value, basis: "model-guess" })).toBeNull();
  });
  it("filters by average time, without classifying unknowns as short runs", () => {
    const unknown = { ...workflow, timing: null, durationSource: "unknown" as const };
    expect(filterWorkflows([workflow, unknown], { ...defaultWorkflowFilters, duration: "medium" })).toEqual([workflow]);
    expect(filterWorkflows([unknown], { ...defaultWorkflowFilters, duration: "short" })).toEqual([]);
  });
  it("shows average, single and unknown cards without the removed evidence diagnostics", async () => {
    window.history.replaceState(null, "", "/home?mode=workflows");
    const openLink = vi.fn().mockResolvedValue(undefined);
    const platform = createFixtureWorkflowsPlatform();
    platform.assistant!.openLink = openLink;
    await act(async () => { render(<WorkflowsApp platform={platform} initialAnalysis={fixtureWorkflowAnalysis} storageKey={null} />); });
    const card = screen.getByRole("heading", { name: "Research synthesis" }).closest("article")!;
    expect(within(card).getByText(/~24m \/ run · estimated/)).toBeVisible();
    expect(within(card).getByText(workflow.description)).toBeVisible();
    expect(card.querySelector("details")).toBeNull();
    expect(within(card).getAllByRole("button")).toHaveLength(1);
    const single = screen.getByRole("heading", { name: "Partner meeting preparation" }).closest("article")!;
    expect(within(single).getByText(/~12m \/ run · estimated/)).toBeVisible();
    const unknown = screen.getByRole("heading", { name: "Website release check" }).closest("article")!;
    expect(within(unknown).queryByText(/\/ run/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Open map" }));
    expect(screen.queryByText("Correct this workflow")).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence and limitations")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Questions and feedback" })).toBeVisible();
    // Removing diagnostic chrome must not discard the persisted run boundaries.
    expect(workflowTiming(workflow.timing)).toMatchObject({ averageMinutes: 24, sampleCount: 3 });
  });
});
