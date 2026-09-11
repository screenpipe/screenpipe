// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowReplay, type WorkflowRecording } from "@screenpipe/workflows-ui";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";

function fixture() {
  const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
  workflow.stages = workflow.stages.slice(0, 2).map((stage, index) => ({ ...stage, screenshot: null,
    evidence: [{ timestamp: `2026-09-0${index + 1}T10:00:00Z`, app: "Editor", source: "parsed", detail: `Real observed detail ${index}` }] }));
  return workflow;
}
const image: WorkflowRecording = { kind: "image", url: "blob:test-image", timestamp: "2026-09-01T10:00:00Z", frameId: 4, offsetSeconds: 0, matchDistanceSeconds: 0 };

describe("workflow replay", () => {
  it("loads media only on explicit open and releases it when closed", async () => {
    const load = vi.fn().mockResolvedValue(image);
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    render(<WorkflowReplay workflow={fixture()} loadRecording={load} />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Open replay"));
    expect(await screen.findByRole("img")).toHaveAttribute("src", "blob:test-image");
    expect(load).toHaveBeenCalledWith("2026-09-01T10:00:00Z", "Editor");
    expect(screen.getByText(/Still image, not a video/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Hide replay"));
    expect(revoke).toHaveBeenCalledWith("blob:test-image");
  });
  it("keeps text visible when media is absent and does not claim a continuous run", async () => {
    render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue(null)} />);
    fireEvent.click(screen.getByText("Open replay"));
    expect(await screen.findByText(/No playable recording/)).toBeVisible();
    expect(screen.getByText("Real observed detail 0")).toBeInTheDocument();
    expect(screen.getByText(/Separate observations, not a verified/)).toBeInTheDocument();
    expect(screen.getByText("Previous moment")).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByText("Next moment")));
    expect(screen.getByText("Real observed detail 1")).toBeInTheDocument();
    expect(screen.getByText("Next moment")).toBeDisabled();
  });
  it("ignores a late response after switching moments", async () => {
    let resolve!: (media: WorkflowRecording) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ...image, url: "blob:second" });
    render(<WorkflowReplay workflow={fixture()} loadRecording={load} />);
    fireEvent.click(screen.getByText("Open replay"));
    fireEvent.click(screen.getByText("Next moment"));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "blob:second"));
    await act(async () => resolve(image));
    expect(screen.getByRole("img")).toHaveAttribute("src", "blob:second");
  });
  it("supports retry without sending private error details into UI", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("secret-token-local-path")).mockResolvedValue(image);
    render(<WorkflowReplay workflow={fixture()} loadRecording={load} />);
    fireEvent.click(screen.getByText("Open replay"));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("secret-token");
    fireEvent.click(screen.getByText("Retry"));
    expect(await screen.findByRole("img")).toBeInTheDocument();
  });
  it("renders native MP4 controls without autoplay and seeks to the captured offset", async () => {
    const { container } = render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue({ ...image, kind: "video", offsetSeconds: 8 })} />);
    fireEvent.click(screen.getByText("Open replay"));
    const video = await screen.findByLabelText("Local recording") as HTMLVideoElement;
    expect(video).toHaveAttribute("controls");
    expect(video).not.toHaveAttribute("autoplay");
    Object.defineProperty(video, "duration", { value: 60 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(8);
    expect(container.querySelector(".ph-no-capture.ph-mask")).not.toBeNull();
    fireEvent.error(video);
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be played");
  });
  it("opens the exact captured moment through the native adapter, not webview navigation", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue(image)} openCapturedMoment={open} />);
    fireEvent.click(screen.getByText("Open replay"));
    fireEvent.click(await screen.findByRole("button", { name: "Open captured moment" }));
    expect(open).toHaveBeenCalledWith(4, "2026-09-01T10:00:00Z");
    expect(screen.queryByRole("link", { name: "Open captured moment" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Open captured moment" })).toBeEnabled());
  });
  it("shows a safe handoff failure and permits retry", async () => {
    const open = vi.fn().mockRejectedValue(new Error("private-path-token"));
    render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue(image)} openCapturedMoment={open} />);
    fireEvent.click(screen.getByText("Open replay"));
    fireEvent.click(await screen.findByRole("button", { name: "Open captured moment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open Screenpipe");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private-path-token");
  });
  it("releases native streaming capabilities on close", async () => {
    const url = "http://127.0.0.1:4567/media/12345678-1234-1234-1234-123456789abc";
    const release = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue({ ...image, kind: "video", url })} releaseRecording={release} />);
    fireEvent.click(screen.getByText("Open replay"));
    expect(await screen.findByLabelText("Local recording")).toHaveAttribute("src", url);
    fireEvent.click(screen.getByText("Hide replay"));
    expect(release).toHaveBeenCalledWith(url);
  });
  it("does not leave an undecodable video as an endless black player", async () => {
    vi.useFakeTimers();
    try {
      render(<WorkflowReplay workflow={fixture()} loadRecording={vi.fn().mockResolvedValue({ ...image, kind: "video" })} />);
      await act(async () => fireEvent.click(screen.getByText("Open replay")));
      await act(async () => vi.advanceTimersByTime(12000));
      expect(screen.getByRole("alert")).toHaveTextContent("could not decode");
      expect(screen.queryByLabelText("Local recording")).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });
  it("does not invent replay for audio-only or invalid timestamps", () => {
    const workflow = fixture();
    workflow.stages.forEach((stage) => { stage.evidence[0].source = "audio"; });
    render(<WorkflowReplay workflow={workflow} />);
    expect(screen.getByText("No recorded moments linked yet")).toBeVisible();
    expect(screen.queryByText("Open replay")).not.toBeInTheDocument();
  });
  it("clamps selection when the same workflow receives fewer moments", async () => {
    const workflow = fixture();
    const { rerender } = render(<WorkflowReplay workflow={workflow} />);
    fireEvent.click(screen.getByText("Open replay"));
    fireEvent.click(screen.getByText("Next moment"));
    const shorter = { ...workflow, stages: workflow.stages.slice(0, 1) };
    rerender(<WorkflowReplay workflow={shorter} />);
    expect(screen.getByText("Real observed detail 0")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeVisible();
  });
});
