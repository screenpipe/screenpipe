// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform } from "@screenpipe/workflows-ui/fixture";
import { WorkflowAccess } from "./workflow-access";

const state = vi.hoisted(() => ({ enabled: false, enable: vi.fn() }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({
  settings: { aiPresets: [], user: { id: "fixture-user" }, workflowSharingPromptSeen: { "fixture-user": "2026-09-23" } },
  updateSettings: vi.fn(),
}) }));
vi.mock("@/lib/hooks/use-usage-status", () => ({ useUsageStatusQuery: () => ({
  usage: { hosted_ai: { plan: "business" }, remaining: 100, cost_limit_reached: false }, isLoading: false,
}) }));
vi.mock("@/lib/hooks/use-health-check", () => ({ useHealthCheck: () => ({ health: {}, isServerDown: false }) }));
vi.mock("@/lib/workflows/model-choice", () => ({ workflowModelPreference: { load: async () => "intelligent" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./workflow-sharing-controls", () => ({ WorkflowSharingControls: () => null }));
vi.mock("@/lib/workflows/scheduled-discovery", () => ({
  loadWorkflowTaskSetup: async () => ({ enabled: state.enabled, title: "Keep your workflows current", schedule: "Hourly discovery" }),
  enableWorkflowTask: () => state.enable(), disableWorkflowTasks: vi.fn(),
}));

beforeEach(() => {
  state.enabled = false;
  state.enable.mockReset().mockImplementation(async () => { state.enabled = true; });
  window.history.replaceState(null, "", "/home?mode=workflows");
});
afterEach(cleanup);
function mount() {
  const platform = createFixtureWorkflowsPlatform();
  const job = { id: "workflow-discover:1", cycleId: "cycle", status: "processing" as const };
  platform.managesAnalysis = true;
  platform.loadCapturedWork = vi.fn().mockResolvedValue(null);
  platform.getLatestAnalysisJob = vi.fn().mockResolvedValue(null);
  platform.getAnalysisJob = vi.fn().mockResolvedValue(job);
  platform.startAnalysisJob = vi.fn().mockResolvedValue(job);
  function App() {
    const [reason, setReason] = useState<string | undefined>("Checking workflow access…");
    const [requested, setRequested] = useState(false);
    return <WorkflowsApp platform={platform} storageKey={null} analysisUnavailableReason={reason} onAnalysisUnavailable={() => setRequested(true)}
      toolbarAccessory={<WorkflowAccess active requested={requested} onRequestChange={setRequested} onAccessChange={setReason} />} />;
  }
  render(<App />);
  return platform;
}

it("routes build through explicit schedule setup, then starts and tracks the agent after opt-in", async () => {
  const platform = mount();
  const build = await screen.findByRole("button", { name: /Build my workflow catalog/ });
  await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic updates" })).toBeEnabled());
  fireEvent.click(build);
  expect(await screen.findByRole("dialog", { name: "Keep your workflows up to date?" })).toBeVisible();
  expect(platform.startAnalysisJob).not.toHaveBeenCalled();
  expect(state.enable).not.toHaveBeenCalled();
  expect(screen.queryByText("Looking for workflows")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Enable automatic updates" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(state.enable).toHaveBeenCalledOnce();
  expect(screen.getByRole("switch", { name: "Automatic updates" })).toBeChecked();
  const runtime = await platform.ensureRuntime();
  let releaseRuntime!: () => void;
  platform.ensureRuntime = vi.fn(() => new Promise<typeof runtime>(resolve => {
    releaseRuntime = () => resolve(runtime);
  }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Build my workflow catalog/ })));
  expect(platform.ensureRuntime).toHaveBeenCalledOnce();
  expect(platform.startAnalysisJob).not.toHaveBeenCalled();
  await act(async () => releaseRuntime());
  await waitFor(() => expect(platform.startAnalysisJob).toHaveBeenCalledOnce());
  await waitFor(() => expect(platform.getAnalysisJob).toHaveBeenCalledWith("workflow-discover:1"));
  expect(await screen.findByText("Looking for workflows")).toBeVisible();
});

it("allows cancelling setup and opening it again without enabling or starting work", async () => {
  const platform = mount();
  const build = await screen.findByRole("button", { name: /Build my workflow catalog/ });
  await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic updates" })).toBeEnabled());
  fireEvent.click(build);
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(state.enable).not.toHaveBeenCalled();
  expect(platform.startAnalysisJob).not.toHaveBeenCalled();
  expect(screen.getByRole("switch", { name: "Automatic updates" })).not.toBeChecked();
  fireEvent.click(build);
  expect(await screen.findByRole("dialog", { name: "Keep your workflows up to date?" })).toBeVisible();
});
