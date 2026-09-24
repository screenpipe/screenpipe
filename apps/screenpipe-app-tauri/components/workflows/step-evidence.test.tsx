// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepEvidence } from "../../../../packages/workflows-ui/src/workflow-step-evidence";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
import type { WorkflowsPlatform } from "../../../../packages/workflows-ui/src/platform";

const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
const stage = workflow.stages[0];
const close = () => fireEvent.click(screen.getByRole("button", { name: `Close recording for ${stage.name}` }));
const play = () => fireEvent.click(screen.getByRole("button", { name: `View recording for ${stage.name}` }));
afterEach(cleanup);

describe("missing attached screenshots", () => {
  const bare = { ...stage, screenshot: null, screenshots: [] };
  it("automatically shows an exact source preview without changing evidence or starting replay", async () => {
    const preview = { ...stage.screenshot!, visualVerified: false };
    const load = vi.fn().mockResolvedValue(preview);
    const recording = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    const before = JSON.stringify(bare);
    render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={{ loadWorkflowScreenshot: load, loadWorkflowRecording: recording, openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", preview.dataUrl);
    expect(screen.getByText(/Source screenshot/)).toBeVisible();
    expect(load).toHaveBeenCalledWith(bare.evidence[0].timestamp, bare.evidence[0].app, expect.any(AbortSignal));
    expect(recording).not.toHaveBeenCalled();
    expect(JSON.stringify(bare)).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: `Open recording for ${stage.name}` }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(preview.frameId, preview.timestamp));
  });
  it("keeps attached images without a lookup", () => {
    const load = vi.fn();
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    expect(screen.getByRole("img")).toBeVisible();
    expect(load).not.toHaveBeenCalled();
  });
  it("recovers the source image when a catalog refresh omits the attachment", async () => {
    const load = vi.fn().mockResolvedValue({ ...stage.screenshot!, visualVerified: false });
    const platform = { loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform;
    const { rerender } = render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={platform} />);
    expect(load).not.toHaveBeenCalled();
    rerender(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={platform} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", stage.screenshot!.dataUrl);
    expect(screen.getByText(/Source screenshot/)).toBeVisible();
  });
  it("does not look up media until the step approaches the viewport", async () => {
    let observe!: (entries: { isIntersecting: boolean }[]) => void;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof observe) { observe = callback; }
      observe() {} disconnect = disconnect;
    });
    try {
      const load = vi.fn().mockResolvedValue(stage.screenshot);
      render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
      expect(load).not.toHaveBeenCalled();
      act(() => observe([{ isIntersecting: true }]));
      expect(await screen.findByRole("img")).toBeVisible();
      expect(disconnect).toHaveBeenCalled();
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });
  it("tries another source when the first capture is unavailable", async () => {
    const second = { ...bare.evidence[0], timestamp: "2026-09-23T10:00:00Z" };
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...stage.screenshot!, timestamp: second.timestamp });
    render(<WorkflowStepEvidence workflow={workflow} stage={{ ...bare, evidence: [bare.evidence[0], second] }} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByRole("img")).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("shows missing capture and recovers from a transient failure with retry", async () => {
    const load = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(stage.screenshot);
    render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByText("No screenshot available for this step.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry screenshot" }));
    expect(await screen.findByText("Could not load the source screenshot.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry screenshot" }));
    expect(await screen.findByRole("img")).toBeVisible();
  });
  it("aborts navigation and releases a late blob without attaching it to another step", async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
    let resolve!: (value: any) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(null);
    const platform = { loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform;
    const { rerender } = render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={platform} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const signal = load.mock.calls[0][2];
    rerender(<WorkflowStepEvidence workflow={workflow} stage={{ ...bare, evidence: [{ ...bare.evidence[0], timestamp: "2026-09-24T12:00:00Z" }] }} platform={platform} />);
    await act(async () => resolve({ ...stage.screenshot!, dataUrl: "blob:late" }));
    expect(signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:late");
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("releases visible preview blobs on unmount", async () => {
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
    const load = vi.fn().mockResolvedValue({ ...stage.screenshot!, dataUrl: "blob:preview" });
    const { unmount } = render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    await screen.findByRole("img");
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
  });
});

describe("step evidence media", () => {
  it("shows all unique verified images, keeps independent sizing and opens the selected frame", async () => {
    const second = { ...stage.screenshot!, frameId: 9002, timestamp: "2026-09-22T11:02:00Z" };
    const multi = { ...stage, screenshots: [stage.screenshot!, second, second, { ...second, frameId: 9003, visualVerified: false }] };
    const open = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={multi} platform={{ openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Reduce screenshot/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: `Reduce screenshot 1 for ${stage.name}` }));
    expect(screen.getByRole("button", { name: `Enlarge screenshot 1 for ${stage.name}` })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: `Reduce screenshot 2 for ${stage.name}` })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: `Open recording 2 for ${stage.name}` }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(second.frameId, second.timestamp));
  });

  it("plays the selected array-only screenshot instead of the first capture", async () => {
    const second = { ...stage.screenshot!, frameId: 9002, timestamp: "2026-09-22T11:02:00Z" };
    const multi = { ...stage, screenshot: null, screenshots: [stage.screenshot!, second], evidence: [...stage.evidence, { ...stage.evidence[0], timestamp: second.timestamp, app: second.app }] };
    const load = vi.fn().mockResolvedValue(null);
    render(<WorkflowStepEvidence workflow={workflow} stage={multi} platform={{ loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: `View recording 2 for ${stage.name}` }));
    await waitFor(() => expect(load).toHaveBeenCalledWith(second.timestamp, second.app));
    expect(await screen.findByRole("img", { name: `Captured moment for ${stage.name}` })).toHaveAttribute("src", second.dataUrl);
  });

  it("shows the verified screenshot large by default without a redundant source list", () => {
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{} as WorkflowsPlatform} />);
    expect(screen.getByRole("img", { name: `Captured reference for ${stage.name}` })).toBeVisible();
    expect(screen.getByRole("button", { name: `Reduce screenshot for ${stage.name}` })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: /sources?$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: `Sources for ${stage.name}` })).not.toBeInTheDocument();
  });

  it("opens verified captures in native Timeline without loading an inline video", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn();
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ openCapturedMoment: open, loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: `Open recording for ${stage.name}` }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(stage.screenshot!.frameId, stage.screenshot!.timestamp));
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Local recording")).toBeNull();
  });

  it("resolves legacy captures, opens Timeline and releases the temporary media", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/legacy.mp4", frameId: 123, timestamp: stage.evidence[0].timestamp });
    const release = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={{ ...stage, screenshot: null }} platform={{ openCapturedMoment: open, loadWorkflowRecording: load, releaseWorkflowRecording: release } as unknown as WorkflowsPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: `Open recording for ${stage.name}` }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(123, stage.evidence[0].timestamp));
    expect(release).toHaveBeenCalledWith("https://fixture.invalid/legacy.mp4");
  });

  it("loads only on request and releases the media when closed", async () => {
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/clip.mp4", timestamp: stage.evidence[0].timestamp, frameId: 1, offsetSeconds: 2 });
    const release = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowRecording: load, releaseWorkflowRecording: release } as unknown as WorkflowsPlatform} />);
    expect(load).not.toHaveBeenCalled();
    play();
    const video = await screen.findByLabelText("Local recording");
    expect(video).toHaveAttribute("controls");
    Object.defineProperty(video, "duration", { value: 30 });
    fireEvent.loadedMetadata(video);
    expect((video as HTMLVideoElement).currentTime).toBe(2);
    fireEvent.loadedData(video);
    close();
    await waitFor(() => expect(release).toHaveBeenCalledWith("https://fixture.invalid/clip.mp4"));
    expect(screen.queryByLabelText("Local recording")).toBeNull();
  });

  it("shows a failed load and retries on request", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null);
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    play();
    expect(await screen.findByRole("alert")).toHaveTextContent("Recording unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not fabricate screenshots or offer playback without a source", () => {
    render(<WorkflowStepEvidence workflow={workflow} stage={{ ...stage, screenshot: null, evidence: [], procedure: [] }} platform={{ loadWorkflowRecording: vi.fn() } as unknown as WorkflowsPlatform} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button", { name: /View recording/ })).toBeNull();
  });

  it("ignores a response arriving after the player is closed", async () => {
    let resolve!: (value: unknown) => void;
    const load = vi.fn().mockReturnValue(new Promise(done => { resolve = done; }));
    const release = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowRecording: load, releaseWorkflowRecording: release } as unknown as WorkflowsPlatform} />);
    play(); close();
    resolve({ kind: "video", url: "https://fixture.invalid/late.mp4" });
    await waitFor(() => expect(release).toHaveBeenCalledWith("https://fixture.invalid/late.mp4"));
    expect(screen.queryByLabelText("Local recording")).toBeNull();
  });
});
