// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowStepEvidence } from "../../../../packages/workflows-ui/src/workflow-step-evidence";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
import type { WorkflowsPlatform } from "../../../../packages/workflows-ui/src/platform";

const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
const stage = workflow.stages[0];
const close = () => fireEvent.click(screen.getByRole("button", { name: `Close recording for ${stage.name}` }));
const play = () => fireEvent.click(screen.getByRole("button", { name: `View recording for ${stage.name}` }));
afterEach(cleanup);

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
