// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingStatus } from "@/components/recording-status";
import { IntegratedWorkflows } from "./integrated-workflows";

vi.mock("@/lib/workflows/desktop-platform", async () => {
  const { createFixtureWorkflowsPlatform } = await import("@screenpipe/workflows-ui/fixture");
  return { desktopWorkflowsPlatform: createFixtureWorkflowsPlatform() };
});
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

it("renders the native recording dot and opens device controls in Workflows", async () => {
  render(<IntegratedWorkflows active onModeChange={vi.fn()} recordingStatus={
    <RecordingStatus devices={[{ name: "Display 1", fullName: "Display 1", kind: "monitor", active: true, id: 1 }]}
      onDevicesChange={vi.fn()} meetingActive={false} onPauseRecording={vi.fn()} />
  } />);
  fireEvent.click(await screen.findByRole("button", { name: "recording" }));
  expect(await screen.findByTestId("recording-status-popover")).toBeVisible();
  expect(screen.getByText("Display 1")).toBeVisible();
  expect(screen.getByRole("button", { name: "pause all recording" })).toBeVisible();
  expect(screen.queryByText("Starting")).not.toBeInTheDocument();
});
