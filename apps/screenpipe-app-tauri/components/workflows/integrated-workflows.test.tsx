// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingStatus } from "@/components/recording-status";
import { SidebarFooter } from "@/components/sidebar-footer";
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

it("keeps Settings and Help in the footer and opens workspace shortcuts from Help", async () => {
  const settings = vi.fn(), help = vi.fn();
  render(<IntegratedWorkflows active onModeChange={vi.fn()} recordingStatus={null}
    navigationFooter={({ openKeyboardShortcuts }) => <SidebarFooter onSettings={settings} onHelp={help} onKeyboardShortcuts={openKeyboardShortcuts} />} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(settings).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /Keyboard shortcuts/ })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "Help" }), { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
  expect(await screen.findByRole("dialog", { name: /command/i })).toBeVisible();
});
