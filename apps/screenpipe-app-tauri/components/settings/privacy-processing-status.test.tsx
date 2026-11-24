// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PrivacyProcessingStatus, PrivacyStatusView, type PrivacyQueueStatus } from "./privacy-processing-status";
import { RedactionHistory } from "./redaction-history";
import { localFetch } from "@/lib/api";
vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
vi.mock("gt-react", () => ({ useGT: () => (text: string) => text }));
const status: PrivacyQueueStatus = { enabled:true,scope:"protected_capture_surfaces",surfaces:[
  {kind:"frames",discovering:false,pending:12,pending_capped:false,deferred:0},
  {kind:"image",discovering:false,pending:5,pending_capped:false,deferred:0},
] };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
describe("privacy processing status", () => {
  it("keeps queue counts visible while explanatory details are collapsed", () => {
    render(<PrivacyStatusView status={status} unavailable={false} />);
    const toggle = screen.getByRole("button", { name: "About these counts" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("5")).toBeVisible();
    expect(screen.queryByText(/This status covers privacy processing/)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/This status covers privacy processing/)).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("5")).toBeVisible();
  });
  it("shows pending text and images separately without claiming synced", () => {
    render(<PrivacyStatusView status={status} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Privacy processing");
    expect(screen.getByText("Text records waiting")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText("Synced")).toBeNull();
  });
  it("distinguishes discovery, retry, ready and inactive protection", () => {
    const {rerender}=render(<PrivacyStatusView status={{...status,surfaces:status.surfaces.map(s=>({...s,discovering:true,pending_capped:true}))}} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Checking existing history");
    expect(screen.getByText("12+")).toBeTruthy();
    rerender(<PrivacyStatusView status={{...status,surfaces:status.surfaces.map(s=>({...s,deferred:1}))}} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Privacy processing will retry");
    rerender(<PrivacyStatusView status={{...status,surfaces:status.surfaces.map(s=>({...s,pending:0}))}} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Enabled privacy checks complete");
    rerender(<PrivacyStatusView status={{...status,enabled:false}} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Waiting for protection to start");
  });
  it("labels disabled modalities instead of claiming they are processed", () => {
    const {rerender}=render(<PrivacyStatusView status={{...status,surfaces:[{...status.surfaces[0],pending:0}]}} unavailable={false} />);
    expect(screen.getByRole("status").textContent).toBe("Enabled privacy checks complete");
    expect(screen.getByText("Not enabled")).toBeTruthy();
    rerender(<PrivacyStatusView status={{...status,surfaces:[status.surfaces[1]]}} unavailable={false} />);
    expect(screen.getByText("Not enabled")).toBeTruthy();
  });
  it("rejects malformed status instead of showing a false ready state", async () => {
    vi.mocked(localFetch).mockResolvedValue(Response.json({enabled:true,scope:"protected_capture_surfaces",surfaces:[]}));
    render(<PrivacyProcessingStatus />);
    await waitFor(()=>expect(screen.getByRole("status").textContent).toBe("Processing status unavailable"));
  });
  it("keeps polls sequential and aborts the outstanding request on unmount", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(localFetch).mockImplementation((_path, init)=> {signal=init?.signal as AbortSignal;return new Promise(()=>{});});
    const {unmount}=render(<PrivacyProcessingStatus />);
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
    expect(localFetch).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    unmount();
    await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
    expect(localFetch).toHaveBeenCalledTimes(1);
  });
  it("recovers after an unavailable engine", async () => {
    vi.useFakeTimers();
    vi.mocked(localFetch).mockResolvedValueOnce(new Response(null,{status:503})).mockResolvedValueOnce(Response.json(status));
    render(<PrivacyProcessingStatus />);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
    expect(screen.getByRole("status").textContent).toBe("Processing status unavailable");
    await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});
    expect(screen.getByRole("status").textContent).toBe("Privacy processing");
  });
});


it("opens history on demand and pages by the final visible event", async () => {
  const timestamp = "2026-11-24T16:22:00.000Z";
  const event = { captured_at: timestamp, processed_at: timestamp, text_fields: ["full_text"], image_regions: null };
  vi.mocked(localFetch)
    .mockResolvedValueOnce(Response.json(Array.from({ length: 11 }, (_, index) => ({
      ...event, id: 21 - index, frame_id: 42 - index,
    }))))
    .mockResolvedValueOnce(Response.json([
      { ...event, id: 11, frame_id: 7, text_fields: null, image_regions: 2 },
    ]));
  render(<RedactionHistory />);
  expect(localFetch).not.toHaveBeenCalled();

  const details = screen.getByText("Redaction history").closest("details")!;
  await act(async () => {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  });
  expect(await screen.findAllByText("Screen text")).toHaveLength(10);
  fireEvent.click(screen.getByRole("button", { name: "Older redactions" }));
  expect(await screen.findByText("Screenshot regions masked 2")).toBeVisible();
  expect(localFetch).toHaveBeenLastCalledWith(
    "/privacy/redaction-history?limit=11&before=12",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
