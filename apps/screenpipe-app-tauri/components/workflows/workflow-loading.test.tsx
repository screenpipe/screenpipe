// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

beforeEach(() => { vi.useFakeTimers(); window.history.replaceState(null, "", "/home?mode=workflows"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const mount = async (platform: ReturnType<typeof createFixtureWorkflowsPlatform>, cached = false) => {
  await act(async () => { render(<WorkflowsApp platform={platform} storageKey={null} initialAnalysis={cached ? fixtureWorkflowAnalysis : null} />); });
};
const exhaustRetries = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); };

describe("workflow catalog loading", () => {
  it("shows a skeleton until the catalog arrives, never onboarding during the read", async () => {
    const platform = createFixtureWorkflowsPlatform();
    let resolve!: (value: typeof fixtureWorkflowAnalysis) => void;
    platform.loadCapturedWork = () => new Promise(r => { resolve = r; });
    await mount(platform);
    expect(screen.getByRole("region", { name: "Loading workflows" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Your first work map starts here")).not.toBeInTheDocument();
    await act(async () => resolve(fixtureWorkflowAnalysis));
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Loading workflows" })).not.toBeInTheDocument();
  });
  it("recovers from a temporary backend restart without showing an error", async () => {
    const platform = createFixtureWorkflowsPlatform();
    platform.loadCapturedWork = vi.fn().mockRejectedValueOnce(new Error("Load failed")).mockResolvedValue(fixtureWorkflowAnalysis);
    await mount(platform);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    expect(screen.queryByText("Couldn’t load your workflows")).not.toBeInTheDocument();
  });
  it("offers read-only retry after failure and shows onboarding only after confirmed empty success", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(new Error("Load failed"));
    platform.loadCapturedWork = load;
    await mount(platform);
    await exhaustRetries();
    expect(load).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Couldn’t load your workflows")).toBeVisible();
    expect(screen.queryByText("Your first work map starts here")).not.toBeInTheDocument();
    load.mockResolvedValue(null);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(screen.getByText("Your first work map starts here")).toBeVisible();
  });
  it("keeps previously loaded cards visible after a failed refresh", async () => {
    const platform = createFixtureWorkflowsPlatform();
    platform.loadCapturedWork = vi.fn().mockRejectedValue(new Error("Offline"));
    await mount(platform, true);
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    await exhaustRetries();
    expect(screen.getByText("Couldn’t refresh. Your last loaded workflows are still shown.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("allows retry when runtime preparation itself fails", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const ensure = platform.ensureRuntime;
    platform.ensureRuntime = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockImplementation(ensure);
    platform.loadCapturedWork = vi.fn().mockResolvedValue(fixtureWorkflowAnalysis);
    await mount(platform);
    expect(screen.getByText("Couldn’t load your workflows")).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("does not show onboarding from an old empty cache while the current read fails", async () => {
    const platform = createFixtureWorkflowsPlatform();
    platform.loadCapturedWork = vi.fn().mockRejectedValue(new Error("Offline"));
    const empty = { ...fixtureWorkflowAnalysis, analysis: { ...fixtureWorkflowAnalysis.analysis, workflows: [] } };
    await act(async () => { render(<WorkflowsApp platform={platform} storageKey={null} initialAnalysis={empty} />); });
    await exhaustRetries();
    expect(screen.getByText("Couldn’t load your workflows")).toBeVisible();
    expect(screen.queryByText("Your first work map starts here")).not.toBeInTheDocument();
  });
  it("cancels scheduled retries when the view unmounts", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(new Error("Offline"));
    platform.loadCapturedWork = load;
    await mount(platform);
    cleanup();
    await exhaustRetries();
    expect(load).toHaveBeenCalledTimes(1);
  });

});
