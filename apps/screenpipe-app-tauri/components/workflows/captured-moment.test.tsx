// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapturedMomentButton } from "../../../../packages/workflows-ui/src/workflow-replay";
import { desktopWorkflowsPlatform } from "@/lib/workflows/desktop-platform";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/workflows/model-choice", () => ({ workflowModelPreference: {} }));
vi.mock("@/lib/workflows/guides", () => ({ desktopGuides: {} }));
vi.mock("@/lib/workflows/assistant", () => ({ desktopAssistant: {} }));
vi.mock("@/lib/workflows/context", () => ({ fillWorkContext: vi.fn() }));
vi.mock("@/lib/workflows/run-activity", () => ({ subscribeWorkflowActivity: vi.fn() }));
vi.mock("@/lib/workflows/runtime", () => ({
  analyzeCapturedWork: vi.fn(), getWorkflowRuntime: vi.fn(),
  generateWorkflowSkill: vi.fn(), saveWorkflowSkill: vi.fn(),
}));
vi.mock("@/lib/workflows/disk-storage", () => ({
  isStoredWorkflowAnalysis: vi.fn(), loadWorkflowAnalysisFromDisk: vi.fn(),
  loadWorkProfileFromDisk: vi.fn(), saveWorkflowAnalysisToDisk: vi.fn(),
  saveWorkProfileToDisk: vi.fn(),
}));
vi.mock("@/lib/workflows/scheduled-discovery", () => ({
  ensureWorkflowTask: vi.fn(), startWorkflowJob: vi.fn(), getWorkflowJob: vi.fn(),
  latestWorkflowJob: vi.fn(), stopWorkflowJob: vi.fn(), loadScheduledCatalog: vi.fn(),
  saveWorkflowCorrections: vi.fn(), saveWorkflowEdits: vi.fn(),
}));

const timestamp = "2026-09-20T07:39:00-07:00";
const navigate = vi.mocked(invoke);
beforeEach(() => { navigate.mockReset(); navigate.mockResolvedValue(null); });
afterEach(cleanup);

describe("captured moment native handoff", () => {
  it.each([false, true])("opens the selected frame through the normal Timeline command (compact=%s)", async compact => {
    render(<CapturedMomentButton frameId={321} timestamp={timestamp} compact={compact} open={desktopWorkflowsPlatform.openCapturedMoment} />);
    fireEvent.click(screen.getByRole("button", { name: "Open captured moment" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("search_navigate_to_timeline", {
      timestamp, frameId: 321, searchTerms: null, searchResultsJson: null, searchQuery: null, timelineOrigin: null,
    }));
    expect(navigate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a native navigation error and allows a successful retry", async () => {
    navigate.mockRejectedValueOnce("Timeline unavailable");
    render(<CapturedMomentButton frameId={321} timestamp={timestamp} open={desktopWorkflowsPlatform.openCapturedMoment} />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open this moment in Timeline. Try again.");
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("contains a rejected IPC call and re-enables the button", async () => {
    navigate.mockRejectedValueOnce(new Error("IPC unavailable"));
    render(<CapturedMomentButton frameId={321} timestamp={timestamp} open={desktopWorkflowsPlatform.openCapturedMoment} />);
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByRole("alert")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  });

  it("does not dispatch repeated clicks during the handoff", async () => {
    let finish!: (value: unknown) => void;
    navigate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<CapturedMomentButton frameId={321} timestamp={timestamp} open={desktopWorkflowsPlatform.openCapturedMoment} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toBeDisabled();
    fireEvent.click(screen.getByRole("button"));
    expect(navigate).toHaveBeenCalledOnce();
    await act(async () => finish(null));
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it.each([[0, timestamp], [-1, timestamp], [NaN, timestamp], [1.5, timestamp], [321, "bad-date"]])(
    "rejects an invalid source (%s, %s) without opening Timeline", async (frameId, time) => {
      await expect(desktopWorkflowsPlatform.openCapturedMoment!(frameId as number, time as string)).rejects.toThrow("Invalid captured moment");
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("does not offer a native action on a platform without it", () => {
    render(<CapturedMomentButton frameId={321} timestamp={timestamp} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
