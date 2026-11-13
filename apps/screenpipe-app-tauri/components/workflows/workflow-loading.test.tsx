// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

beforeEach(() => { vi.useFakeTimers(); window.history.replaceState(null, "", "/home?mode=workflows"); });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.useRealTimers(); });
const mount = async (platform: ReturnType<typeof createFixtureWorkflowsPlatform>, cached = false) => {
  await act(async () => { render(<WorkflowsApp platform={platform} storageKey={null} initialAnalysis={cached ? fixtureWorkflowAnalysis : null} />); });
};
const exhaustRetries = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); };

describe("workflow catalog loading", () => {
  it("waits for the current catalog before opening a cached workflow document", async () => {
    const platform = createFixtureWorkflowsPlatform();
    let resolve!: (value: typeof fixtureWorkflowAnalysis) => void;
    platform.loadCapturedWork = () => new Promise(done => { resolve = done; });
    await mount(platform, true);
    fireEvent.click(screen.getByRole("button", { name: /Research synthesis/ }));
    expect(screen.queryByRole("region", { name: "Workflow document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export workflow" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Loading workflows" })).toBeVisible();
    await act(async () => resolve(fixtureWorkflowAnalysis));
    expect(screen.getByRole("textbox", { name: "Workflow title" })).toHaveValue("Research synthesis");
    expect(screen.queryByRole("region", { name: "Loading workflows" })).not.toBeInTheDocument();
  });
  it("keeps an open editor and its draft when Workflows resumes during a refresh", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockResolvedValue(fixtureWorkflowAnalysis);
    platform.loadCapturedWork = load;
    const view = render(<WorkflowsApp platform={platform} storageKey={null} active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Research synthesis/ }));
    const title = screen.getByRole("textbox", { name: "Workflow title" });
    fireEvent.change(title, { target: { value: "My unsaved title" } });
    view.rerender(<WorkflowsApp platform={platform} storageKey={null} active={false} />);
    let finish!: (value: typeof fixtureWorkflowAnalysis) => void;
    load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => view.rerender(<WorkflowsApp platform={platform} storageKey={null} active />));
    expect(screen.getByRole("textbox", { name: "Workflow title" })).toBe(title);
    expect(title).toHaveValue("My unsaved title");
    expect(screen.queryByRole("region", { name: "Loading workflows" })).not.toBeInTheDocument();
    await act(async () => finish(fixtureWorkflowAnalysis));
    expect(screen.getByRole("textbox", { name: "Workflow title" })).toBe(title);
    expect(title).toHaveValue("My unsaved title");
  });
  it("offers retry instead of a temporary read-only document after a cached detail fails to load", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(Object.assign(new Error("Access denied"), { status: 403 }));
    platform.loadCapturedWork = load;
    await mount(platform, true);
    fireEvent.click(screen.getByRole("button", { name: /Research synthesis/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load your workflows");
    expect(screen.queryByRole("region", { name: "Workflow document" })).not.toBeInTheDocument();
    load.mockResolvedValue(fixtureWorkflowAnalysis);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(screen.getByRole("textbox", { name: "Workflow title" })).toHaveValue("Research synthesis");
  });
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
    const load = vi.fn().mockRejectedValue(Object.assign(new Error("workflow_catalog_unreadable"), { status: 503 }));
    platform.loadCapturedWork = load;
    await mount(platform);
    await exhaustRetries();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Couldn’t load your workflows")).toBeVisible();
    expect(screen.queryByText("Your first work map starts here")).not.toBeInTheDocument();
    load.mockResolvedValue(null);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(screen.getByText("Your first work map starts here")).toBeVisible();
  });
  it("keeps previously loaded cards visible after a failed refresh", async () => {
    const platform = createFixtureWorkflowsPlatform();
    platform.loadCapturedWork = vi.fn().mockRejectedValue(Object.assign(new Error("Access denied"), { status: 403 }));
    await mount(platform, true);
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    await exhaustRetries();
    expect(screen.getByText("Couldn’t refresh. Your last loaded workflows are still shown.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("allows retry when runtime preparation itself fails", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const ensure = platform.ensureRuntime;
    platform.ensureRuntime = vi.fn().mockRejectedValueOnce(new Error("Invalid runtime configuration")).mockImplementation(ensure);
    platform.loadCapturedWork = vi.fn().mockResolvedValue(fixtureWorkflowAnalysis);
    await mount(platform);
    expect(screen.getByText("Couldn’t load your workflows")).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("does not show onboarding from an old empty cache while the current read fails", async () => {
    const platform = createFixtureWorkflowsPlatform();
    platform.loadCapturedWork = vi.fn().mockRejectedValue(Object.assign(new Error("Access denied"), { status: 403 }));
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

  it("survives a cold startup beyond the old retry window", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    platform.loadCapturedWork = load;
    await mount(platform);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByRole("region", { name: "Loading workflows" })).toBeVisible();
    expect(screen.getByText("Connecting to Screenpipe…")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Your first work map starts here")).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(5);
    load.mockResolvedValue(fixtureWorkflowAnalysis);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    expect(screen.queryByText("Connecting to Screenpipe…")).not.toBeInTheDocument();
  });
  it("retries runtime connection failures too", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const ensure = platform.ensureRuntime;
    platform.ensureRuntime = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockImplementation(ensure);
    platform.loadCapturedWork = vi.fn().mockResolvedValue(fixtureWorkflowAnalysis);
    await mount(platform);
    expect(screen.getByRole("region", { name: "Loading workflows" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("keeps cached cards through reconnect and cancels backoff on manual retry", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    platform.loadCapturedWork = load;
    await mount(platform, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByText("Reconnecting to Screenpipe. Your last loaded workflows are still shown.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    load.mockResolvedValue(fixtureWorkflowAnalysis);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry loading" })));
    expect(load).toHaveBeenCalledTimes(6);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(load).toHaveBeenCalledTimes(6);
    expect(screen.queryByText(/Reconnecting to Screenpipe/)).not.toBeInTheDocument();
  });
  it("pauses retries while inactive and resumes when Workflows opens", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const load = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    platform.loadCapturedWork = load;
    const view = render(<WorkflowsApp platform={platform} storageKey={null} active />);
    await act(async () => {});
    view.rerender(<WorkflowsApp platform={platform} storageKey={null} active={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(load).toHaveBeenCalledTimes(1);
    load.mockResolvedValue(fixtureWorkflowAnalysis);
    await act(async () => view.rerender(<WorkflowsApp platform={platform} storageKey={null} active />));
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
  });
  it("aborts on unmount and ignores late results", async () => {
    const platform = createFixtureWorkflowsPlatform();
    let signal: AbortSignal | undefined;
    let resolve!: (value: typeof fixtureWorkflowAnalysis) => void;
    platform.loadCapturedWork = (_days, options) => { signal = options?.signal; return new Promise(done => { resolve = done; }); };
    await mount(platform);
    expect(signal?.aborted).toBe(false);
    cleanup();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(fixtureWorkflowAnalysis));
    expect(screen.queryByRole("heading", { name: "Research synthesis" })).not.toBeInTheDocument();
  });

  it("cannot replace another scope with a late catalog response", async () => {
    const platform = createFixtureWorkflowsPlatform();
    const runtime = await platform.ensureRuntime();
    const personal = { id: "personal", kind: "personal" as const, label: "My work", detail: "Only on this device" };
    const other = { ...personal, id: "other", label: "Other workspace" };
    platform.ensureRuntime = vi.fn().mockResolvedValue({ ...runtime, availableScopes: [personal, other] });
    let finishOld!: (value: typeof fixtureWorkflowAnalysis) => void;
    let oldSignal: AbortSignal | undefined;
    const changed = structuredClone(fixtureWorkflowAnalysis);
    changed.analysis.workflows = [{ ...changed.analysis.workflows[0], title: "Other workspace workflow" }];
    platform.loadCapturedWork = (_days, options) => options?.scope?.id === "other"
      ? Promise.resolve(changed)
      : new Promise(done => { oldSignal = options?.signal; finishOld = done; });
    await mount(platform);
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Workflows scope" }), { target: { value: "other" } }));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finishOld(fixtureWorkflowAnalysis));
    expect(screen.getByRole("heading", { name: "Other workspace workflow" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Research synthesis" })).not.toBeInTheDocument();
  });

});

it("keeps update activity when opening a map and through missing or failed status polls", async () => {
  const platform = createFixtureWorkflowsPlatform();
  platform.managesAnalysis = true;
  platform.loadCapturedWork = async () => structuredClone(fixtureWorkflowAnalysis);
  const job = { id: "discover:1", cycleId: "cycle", status: "processing" as const };
  const latest = vi.fn().mockResolvedValue(job);
  platform.getLatestAnalysisJob = latest;
  platform.getAnalysisJob = async () => job;
  let publish!: Parameters<NonNullable<typeof platform.subscribeAnalysisActivity>>[1];
  const off = vi.fn();
  platform.subscribeAnalysisActivity = vi.fn(async (_id, callback) => { publish = callback; return off; });
  await mount(platform);
  act(() => publish([{ id: "a", label: "Searched recordings", status: "complete" }]));
  fireEvent.click(screen.getByRole("button", { name: /Customer feedback triage/ }));
  act(() => publish([{ id: "b", label: "Read saved workflows", status: "complete" }]));
  fireEvent.click(screen.getByRole("button", { name: "Workflows", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searched recordings");
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Read saved workflows");
  latest.mockResolvedValueOnce(null).mockRejectedValueOnce(new TypeError("Load failed"));
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searched recordings");
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Read saved workflows");
  expect(platform.subscribeAnalysisActivity).toHaveBeenCalledOnce();
  expect(off).not.toHaveBeenCalled();
});

it.each(["overview", "time", "bottlenecks", "evidence", "privacy"])("routes obsolete %s links to Home", async (view) => {
  window.history.replaceState(null, "", `/home?mode=workflows&view=${view}`);
  const platform = createFixtureWorkflowsPlatform();
  await mount(platform, true);
  expect(screen.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
  expect(screen.getByRole("button", { name: "Context", exact: true })).toBeVisible();
});

describe("starting a managed workflow update", () => {
  const oldJob = { id: "workflow-review:old", status: "incomplete" as const, message: "Previous update is incomplete" };
  const newJob = { id: "workflow-discover:new", cycleId: "new-cycle", status: "queued" as const };
  function platform() {
    const value = createFixtureWorkflowsPlatform();
    value.managesAnalysis = true;
    value.loadCapturedWork = vi.fn().mockResolvedValue(null);
    value.getLatestAnalysisJob = vi.fn().mockResolvedValue(oldJob);
    value.getAnalysisJob = vi.fn().mockResolvedValue(newJob);
    value.startAnalysisJob = vi.fn().mockResolvedValue(newJob);
    return value;
  }

  it.each(["incomplete", "complete", "failed", "processing"] as const)("ignores a pre-click %s response after accepting a new execution", async status => {
    const p = platform();
    let finishOld!: (job: any) => void;
    p.getLatestAnalysisJob = vi.fn(() => new Promise(resolve => { finishOld = resolve; }));
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    expect(p.getAnalysisJob).toHaveBeenCalledWith(newJob.id);
    await act(async () => finishOld({ ...oldJob, status }));
    expect(screen.getByText("Looking for workflows")).toBeVisible();
    expect(screen.getByRole("button", { name: /Waiting to start. Show agent activity/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Build my workflow catalog/ })).not.toBeInTheDocument();
  });

  it("keeps loading throughout a slow start even when an old poll finishes", async () => {
    const p = platform();
    let finishOld!: (job: any) => void;
    let finishStart!: (job: any) => void;
    p.getLatestAnalysisJob = vi.fn(() => new Promise(resolve => { finishOld = resolve; }));
    p.startAnalysisJob = vi.fn(() => new Promise(resolve => { finishStart = resolve; }));
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    await act(async () => finishOld(oldJob));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("Looking for workflows")).toBeVisible();
    expect(p.getLatestAnalysisJob).toHaveBeenCalledOnce();
    await act(async () => finishStart(newJob));
    expect(p.getAnalysisJob).toHaveBeenCalledWith(newJob.id);
    expect(screen.getByText("Looking for workflows")).toBeVisible();
  });

  it("ignores a late completed catalog from the previous request", async () => {
    const p = platform();
    p.getLatestAnalysisJob = vi.fn().mockResolvedValue({ ...oldJob, status: "complete" });
    let finishOld!: (job: any) => void;
    p.getAnalysisJob = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(newJob);
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    await act(async () => finishOld({ ...oldJob, status: "complete", result: fixtureWorkflowAnalysis }));
    expect(screen.getByText("Looking for workflows")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Research synthesis" })).not.toBeInTheDocument();
  });

  it("ignores an old status failure after accepting a new execution", async () => {
    const p = platform();
    let failOld!: (error: Error) => void;
    p.getLatestAnalysisJob = vi.fn(() => new Promise((_resolve, reject) => { failOld = reject; }));
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    await act(async () => failOld(new Error("Old status connection failed")));
    expect(screen.getByText("Looking for workflows")).toBeVisible();
    expect(screen.queryByText("Old status connection failed")).not.toBeInTheDocument();
  });

  it("ends loading immediately on a rejected start and preserves its cause through old-job polling", async () => {
    const p = platform();
    const message = "Enable workflow tasks with Automatic updates before updating.";
    p.startAnalysisJob = vi.fn().mockRejectedValue(new Error(message));
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    expect(screen.getByRole("button", { name: /Build my workflow catalog/ })).toBeVisible();
    expect(screen.queryByText("Looking for workflows")).not.toBeInTheDocument();
    expect(screen.getByText(message)).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(message)).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    expect(p.startAnalysisJob).toHaveBeenCalledTimes(2);
  });

  it("accepts a new active agent discovered while fetching a completed job's result", async () => {
    const p = platform();
    p.getLatestAnalysisJob = vi.fn().mockResolvedValue({ ...oldJob, status: "complete" });
    await mount(p);
    expect(screen.getByText("Looking for workflows")).toBeVisible();
    expect(screen.getByRole("button", { name: /Waiting to start. Show agent activity/ })).toBeVisible();
  });

  it("finishes the accepted run and then discovers later automatic updates", async () => {
    const p = platform();
    await mount(p);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
    vi.mocked(p.getAnalysisJob!).mockResolvedValueOnce({ ...newJob, status: "complete", result: fixtureWorkflowAnalysis });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("heading", { name: "Research synthesis" })).toBeVisible();
    expect(screen.queryByText("Looking for workflows")).not.toBeInTheDocument();
    vi.mocked(p.getLatestAnalysisJob!).mockResolvedValue({ ...newJob, id: "workflow-discover:scheduled", status: "processing" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("button", { name: /Updating workflows. Show agent activity/ })).toBeVisible();
  });
});
