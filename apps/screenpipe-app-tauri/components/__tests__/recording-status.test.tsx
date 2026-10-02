// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingStatus, type RecordingDevice } from "../recording-status";
import { TooltipProvider } from "../ui/tooltip";
import { localFetch } from "@/lib/api";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));

const devices: RecordingDevice[] = [
  { name: "Display 1", fullName: "Display 1", kind: "monitor", active: true, id: 1 },
  { name: "Microphone", fullName: "Microphone (input)", kind: "input", active: true },
];

function openStatus(overrides: Partial<React.ComponentProps<typeof RecordingStatus>> = {}) {
  const props = {
    devices,
    onDevicesChange: vi.fn(),
    meetingActive: false,
    onPauseRecording: vi.fn(),
    onResumeRecording: vi.fn(),
    onRefreshDevices: vi.fn(),
    onOpenRecordingSettings: vi.fn(),
    ...overrides,
  };
  render(<TooltipProvider><RecordingStatus {...props} /></TooltipProvider>);
  fireEvent.click(screen.getByTestId("recording-status-trigger"));
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localFetch).mockResolvedValue({ ok: true } as Response);
});

describe("RecordingStatus", () => {
  it("shows low storage without opening the status dot and routes to cleanup", () => {
    const props = openStatus({ isGloballyPaused: true,
      storageWarning: { availableBytes: 3 * 1024 ** 3, thresholdBytes: 5 * 1024 ** 3 },
      onOpenStorageSettings: vi.fn(), onRefreshStorage: vi.fn() });
    expect(screen.getByTestId("recording-status-trigger")).toHaveTextContent("Low storage");
    expect(screen.getByText("3.0 GB free. Recording needs more than 5.0 GB.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resume all recording" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage storage" }));
    expect(props.onOpenStorageSettings).toHaveBeenCalledOnce();
    expect(props.onResumeRecording).not.toHaveBeenCalled();
  });

  it("rechecks storage without starting capture or deleting anything", () => {
    const props = openStatus({ isGloballyPaused: true, onRefreshStorage: vi.fn(), storageError: true });
    expect(screen.getByText(/Could not check free space/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Check free space" }));
    expect(props.onRefreshStorage).toHaveBeenCalledOnce();
    expect(props.onResumeRecording).not.toHaveBeenCalled();
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("keeps resume disabled during a fresh space check", () => {
    openStatus({ isGloballyPaused: true, storageChecking: true, onRefreshStorage: vi.fn() });
    expect(screen.getByRole("button", { name: "Resume all recording" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Checking space..." })).toBeDisabled();
  });

  it("does not mislabel active capture from an old storage warning", () => {
    openStatus({ storageWarning: { availableBytes: 0, thresholdBytes: 5 * 1024 ** 3 } });
    expect(screen.getByTestId("recording-status-trigger")).toHaveAccessibleName("Recording");
    expect(screen.queryByText("Low storage")).not.toBeInTheDocument();
  });

  it("does not infer stopped capture or offer pause from an empty device list", () => {
    const props = openStatus({ devices: [] });
    expect(screen.getByTestId("recording-status-trigger")).toHaveAccessibleName("Recording status unavailable");
    expect(screen.queryByTestId("recording-status-pause-all")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeEnabled();
    expect(props.onPauseRecording).not.toHaveBeenCalled();
    expect(props.onResumeRecording).not.toHaveBeenCalled();
  });

  it("retries status without changing capture and prevents duplicate requests", async () => {
    let complete!: () => void;
    const onRefreshDevices = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const props = openStatus({ devices: [], onRefreshDevices });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Checking…" }));
    expect(onRefreshDevices).toHaveBeenCalledOnce();
    complete();
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(screen.getByTestId("recording-status-popover")).toBeVisible();
    expect(props.onPauseRecording).not.toHaveBeenCalled();
    expect(props.onResumeRecording).not.toHaveBeenCalled();
  });

  it("keeps recovery available after a failed retry", async () => {
    openStatus({ devices: [], onRefreshDevices: vi.fn().mockRejectedValue(new Error("offline")) });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    expect(screen.getByTestId("recording-status-trigger")).toHaveAccessibleName("Recording status unavailable");
  });

  it("opens recording settings from the unavailable state", () => {
    const props = openStatus({ devices: [] });
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(props.onOpenRecordingSettings).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("recording-status-popover")).not.toBeInTheDocument();
  });

  it.each([[], devices, devices.map(d => ({ ...d, active: false }))].map(snapshot => [snapshot]))(
    "resumes the global session even with empty or stale device data (%j)", async (snapshot) => {
      const props = openStatus({ devices: snapshot, isGloballyPaused: true });
      expect(screen.getByTestId("recording-status-trigger")).toHaveAccessibleName("Recording paused");
      expect(screen.queryByRole("button", { name: "Pause", exact: true })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume", exact: true })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Resume all recording" }));
      await waitFor(() => expect(props.onResumeRecording).toHaveBeenCalledOnce());
      expect(props.onPauseRecording).not.toHaveBeenCalled();
      expect(localFetch).not.toHaveBeenCalled();
    },
  );

  it("disables global resume when no resume callback exists", () => {
    openStatus({ devices: [], isGloballyPaused: true, onResumeRecording: undefined });
    expect(screen.getByRole("button", { name: "Resume all recording" })).toBeDisabled();
  });

  it("resumes individually paused devices through device endpoints", async () => {
    const props = openStatus({ devices: devices.map(d => ({ ...d, active: false })), isGloballyPaused: false });
    fireEvent.click(screen.getByRole("button", { name: "Resume all recording" }));
    await waitFor(() => expect(localFetch).toHaveBeenCalledTimes(2));
    expect(localFetch).toHaveBeenCalledWith("/vision/device/start", expect.objectContaining({ body: JSON.stringify({ monitor_id: 1 }) }));
    expect(localFetch).toHaveBeenCalledWith("/audio/device/start", expect.objectContaining({ body: JSON.stringify({ device_name: "Microphone (input)" }) }));
    expect(props.onResumeRecording).not.toHaveBeenCalled();
  });

  it.each([devices, [devices[0], { ...devices[1], active: false }]].map(snapshot => [snapshot]))(
    "pauses the global session when devices are active (%j)", async (snapshot) => {
      const props = openStatus({ devices: snapshot });
      fireEvent.click(screen.getByRole("button", { name: "Pause all recording" }));
      await waitFor(() => expect(props.onPauseRecording).toHaveBeenCalledOnce());
      expect(props.onResumeRecording).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("disabled settings override device and global state (paused=%s)", (isGloballyPaused) => {
    const props = openStatus({ allCaptureDisabled: true, isGloballyPaused });
    expect(screen.getByTestId("recording-status-trigger")).toHaveAccessibleName("Recording disabled");
    expect(screen.queryByText("Display 1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recording-status-pause-all")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(props.onOpenRecordingSettings).toHaveBeenCalledOnce();
  });
});
