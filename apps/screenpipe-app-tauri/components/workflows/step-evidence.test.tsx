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
    const recording = vi.fn().mockResolvedValue(null);
    const open = vi.fn().mockResolvedValue(undefined);
    const before = JSON.stringify(bare);
    render(<WorkflowStepEvidence workflow={workflow} stage={bare} platform={{ loadWorkflowScreenshot: load, loadWorkflowRecording: recording, openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", preview.dataUrl);
    expect(screen.getByText(/Source screenshot/)).toBeVisible();
    expect(load).toHaveBeenCalledWith(bare.evidence[0].timestamp, bare.evidence[0].app, expect.any(AbortSignal));
    expect(recording).not.toHaveBeenCalled();
    expect(JSON.stringify(bare)).toBe(before);
    play();
    await waitFor(() => expect(recording).toHaveBeenCalledWith(preview.timestamp, preview.app));
    expect(open).not.toHaveBeenCalled();
  });
  it("replaces legacy embedded previews with the recorder frame", async () => {
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const load = vi.fn().mockResolvedValue({ ...stage.screenshot!, dataUrl: "blob:original" });
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:original");
    expect(load).toHaveBeenCalledWith(stage.screenshot!.timestamp, stage.screenshot!.app, expect.any(AbortSignal), stage.screenshot!.frameId);
  });
  it("recovers the source image when a catalog refresh omits the attachment", async () => {
    const load = vi.fn().mockResolvedValue({ ...stage.screenshot!, visualVerified: false });
    const platform = { loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform;
    const { rerender } = render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={platform} />);
    await screen.findByRole("img");
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
  it("shows all unique images, selects without resizing and opens the selected frame", async () => {
    const second = { ...stage.screenshot!, frameId: 9002, timestamp: "2026-09-22T11:02:00Z" };
    const multi = { ...stage, screenshots: [stage.screenshot!, second, second, { ...second, frameId: 9003, visualVerified: false }] };
    const open = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={multi} platform={{ openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /Select screenshot/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: `Select screenshot 1 for ${stage.name}` }));
    expect(screen.getByRole("button", { name: `Select screenshot 1 for ${stage.name}` })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: `Select screenshot 2 for ${stage.name}` })).toHaveAttribute("aria-pressed", "false");
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
    expect(screen.getByRole("button", { name: `Select screenshot for ${stage.name}` })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: /sources?$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: `Sources for ${stage.name}` })).not.toBeInTheDocument();
  });

  it("plays inline when the desktop also provides native Timeline navigation", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/clip.mp4", frameId: 123, timestamp: stage.screenshot!.timestamp, offsetSeconds: 2 });
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ openCapturedMoment: open, loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    expect(load).not.toHaveBeenCalled();
    play();
    expect(await screen.findByLabelText("Local recording")).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open captured moment" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(123, stage.screenshot!.timestamp));
  });

  it("replays an attached capture without matching text evidence", async () => {
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/clip.mp4", frameId: stage.screenshot!.frameId, timestamp: stage.screenshot!.timestamp, offsetSeconds: 0 });
    render(<WorkflowStepEvidence workflow={workflow} stage={{ ...stage, evidence: [] }} platform={{ loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    play();
    expect(await screen.findByLabelText("Local recording")).toBeVisible();
    expect(load).toHaveBeenCalledWith(stage.screenshot!.timestamp, stage.screenshot!.app);
  });

  it("keeps Timeline navigation for hosts without an inline recording loader", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    fireEvent.click(screen.getByRole("button", { name: `Open recording for ${stage.name}` }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(stage.screenshot!.frameId, stage.screenshot!.timestamp));
    expect(screen.queryByLabelText("Local recording")).toBeNull();
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
    const pause = vi.spyOn(video as HTMLVideoElement, "pause").mockImplementation(() => {});
    (video as HTMLVideoElement).currentTime = 20;
    fireEvent.timeUpdate(video);
    expect(pause).not.toHaveBeenCalled();
    fireEvent.play(video);
    expect((video as HTMLVideoElement).currentTime).toBe(20);
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

  it("keeps the source image and Timeline available after a video decode failure", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/broken.mp4", frameId: 123, timestamp: stage.screenshot!.timestamp, offsetSeconds: 0 });
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowRecording: load, openCapturedMoment: open } as unknown as WorkflowsPlatform} />);
    play();
    fireEvent.error(await screen.findByLabelText("Local recording"));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be played");
    expect(screen.getByRole("img", { name: `Captured moment for ${stage.name}` })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open captured moment" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(stage.screenshot!.frameId, stage.screenshot!.timestamp));
  });

  it.each([-1, NaN, Infinity, 30])("rejects invalid or expired video offset %s", async offsetSeconds => {
    const load = vi.fn().mockResolvedValue({ kind: "video", url: "https://fixture.invalid/clip.mp4", frameId: 123, timestamp: stage.screenshot!.timestamp, offsetSeconds });
    render(<WorkflowStepEvidence workflow={workflow} stage={stage} platform={{ loadWorkflowRecording: load } as unknown as WorkflowsPlatform} />);
    play();
    const video = await screen.findByLabelText("Local recording");
    Object.defineProperty(video, "duration", { value: 30 });
    fireEvent.loadedMetadata(video);
    expect(await screen.findByRole("alert")).toHaveTextContent("offset is outside");
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


describe("recorder references", () => {
  it("loads references lazily, retains them off screen, and releases them on unmount", async () => {
    const observers = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>();
    vi.stubGlobal("IntersectionObserver", class {
      callback: (entries: { isIntersecting: boolean }[]) => void;
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { this.callback = callback; }
      observe(element: Element) { observers.set(element, this.callback); }
      disconnect() {}
    });
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
    const first = { ...stage.screenshot!, dataUrl: "" };
    const second = { ...first, frameId: 9002, timestamp: "2026-09-22T11:02:00Z" };
    const load = vi.fn().mockImplementation(async (_timestamp, _app, _signal, id) => ({ ...(id === first.frameId ? first : second), dataUrl: `blob:${id}` }));
    try {
      const { container, unmount } = render(<WorkflowStepEvidence workflow={workflow} stage={{ ...stage, screenshot: null, screenshots: [first, second] }} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
      const figures = container.querySelectorAll("figure");
      expect(load).not.toHaveBeenCalled();
      act(() => observers.get(figures[0])!([{ isIntersecting: true }]));
      await screen.findByRole("img");
      expect(load).toHaveBeenCalledTimes(1);
      act(() => observers.get(figures[0])!([{ isIntersecting: false }]));
      expect(revoke).not.toHaveBeenCalled();
      expect(load.mock.calls[0][2].aborted).toBe(false);
      expect(screen.getByRole("img")).toHaveAttribute("src", `blob:${first.frameId}`);
      act(() => observers.get(figures[1])!([{ isIntersecting: true }]));
      await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
      expect(screen.getAllByRole("img")[1]).toHaveAttribute("src", "blob:9002");
      expect(load).toHaveBeenCalledTimes(2);
      unmount();
      expect(revoke).toHaveBeenCalledWith(`blob:${first.frameId}`);
      expect(revoke).toHaveBeenCalledWith("blob:9002");
      expect(load.mock.calls.every(call => call[2].aborted)).toBe(true);
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });

  it("keeps another screenshot visible when one capture has expired", async () => {
    const first = { ...stage.screenshot!, dataUrl: "" };
    const second = { ...first, frameId: 9002 };
    const load = vi.fn().mockImplementation(async (_timestamp, _app, _signal, id) => id === first.frameId ? null : { ...second, dataUrl: "blob:available" });
    render(<WorkflowStepEvidence workflow={workflow} stage={{ ...stage, screenshot: null, screenshots: [first, second] }} platform={{ loadWorkflowScreenshot: load } as unknown as WorkflowsPlatform} />);
    expect(await screen.findByText("This screenshot is no longer available.")).toBeVisible();
    expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:available");
  });
});

it("selects, moves and deletes images through the authored layout without altering captures", () => {
  const second = { ...stage.screenshot!, frameId: 9002, timestamp: "2026-09-22T11:02:00Z" };
  const multi = { ...stage, screenshots: [stage.screenshot!, second] };
  const change = vi.fn();
  const { rerender } = render(<WorkflowStepEvidence workflow={workflow} stage={multi} platform={{} as WorkflowsPlatform} onImageLayoutChange={change} />);
  const select = screen.getByRole("button", { name: `Select screenshot 2 for ${stage.name}` });
  fireEvent.click(select);
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("toolbar", { name: "Selected image" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Move image up" }));
  let layout = change.mock.lastCall![0];
  expect(layout.order).toEqual([second.frameId, stage.screenshot!.frameId]);
  rerender(<WorkflowStepEvidence workflow={workflow} stage={{ ...multi, imageLayout: layout }} platform={{} as WorkflowsPlatform} onImageLayoutChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Move image up" }));
  layout = change.mock.lastCall![0];
  expect(layout.beforeText).toBe(true);
  fireEvent.keyDown(screen.getByRole("button", { name: `Select screenshot 1 for ${stage.name}` }), { key: "Delete" });
  layout = change.mock.lastCall![0];
  expect(layout.hidden).toEqual([second.frameId]);
  rerender(<WorkflowStepEvidence workflow={workflow} stage={{ ...multi, imageLayout: layout }} platform={{} as WorkflowsPlatform} onImageLayoutChange={change} />);
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(multi.screenshots).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Restore deleted images" }));
  expect(change.mock.lastCall![0].hidden).toEqual([]);
});
