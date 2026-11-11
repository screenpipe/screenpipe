// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FocusedRecordingPanel, type FocusedRecordingPanelProps } from "./focused-recording-panel";

afterEach(cleanup);
function fixture(patch: Partial<FocusedRecordingPanelProps> = {}) {
  return {
    phase: "recording", name: "Review an invoice", seconds: 42,
    micHot: true, voiceAllowed: true, busy: false,
    media: { screenFrames: 12, audioSeconds: 8 },
    onNameChange: vi.fn(), onVoice: vi.fn(), onPause: vi.fn(),
    onResume: vi.fn(), onFinish: vi.fn(), onDelete: vi.fn(),
    onKeep: vi.fn(), onSubmit: vi.fn(), onClose: vi.fn(), onNew: vi.fn(),
    ...patch,
  } satisfies FocusedRecordingPanelProps;
}
it("permits naming during immediate capture and exposes the recording actions", () => {
  const props = fixture(); render(<FocusedRecordingPanel {...props} />);
  expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  expect(screen.getByText("00:42")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow name" }), { target: { value: "New name" } });
  expect(props.onNameChange).toHaveBeenCalledWith("New name");
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  fireEvent.click(screen.getByRole("button", { name: "Finish" }));
  expect(props.onPause).toHaveBeenCalledOnce(); expect(props.onFinish).toHaveBeenCalledOnce();
});
it("never displays a hot microphone while paused, even if the host has a stale hot flag", () => {
  const props = fixture({ phase: "paused" }); render(<FocusedRecordingPanel {...props} />);
  expect(screen.getByRole("button", { name: "Voice off" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Voice on" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(props.onResume).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled();
});
it("shows supplied captured media, allows summary recovery, and rejects empty names", () => {
  const props = fixture({ phase: "summary", name: "  ", media: { screenFrames: 0, audioSeconds: 0 } });
  render(<FocusedRecordingPanel {...props} />);
  expect(screen.getByText("No screen captured")).toBeVisible();
  expect(screen.getByText("No audio captured")).toBeVisible();
  expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(props.onDelete).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(props.onResume).toHaveBeenCalledOnce();
});
it("retains summary actions after a submit error and blocks duplicate requests while busy", () => {
  const props = fixture({ phase: "summary", error: "Could not submit. Try again." });
  const view = render(<FocusedRecordingPanel {...props} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Could not submit");
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(props.onSubmit).toHaveBeenCalledOnce();
  view.rerender(<FocusedRecordingPanel {...props} busy />);
  expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
});
it("offers explicit Delete and Keep recording actions in confirmation", () => {
  const props = fixture({ phase: "delete-confirm" }); render(<FocusedRecordingPanel {...props} />);
  expect(screen.getByRole("region", { name: "Focused recording" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Keep recording" }));
  expect(props.onKeep).toHaveBeenCalledOnce();
});
it("makes the submitted name read-only and offers Close and New workflow", () => {
  const props = fixture({ phase: "submitted" }); render(<FocusedRecordingPanel {...props} />);
  expect(screen.getByRole("textbox", { name: "Workflow name" })).toHaveAttribute("readonly");
  expect(screen.getByRole("status")).toHaveTextContent("Workflow submitted");
  expect(screen.getByRole("region", { name: "Focused recording" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
  expect(props.onNew).toHaveBeenCalledOnce();
});
it("shows available zero-duration audio without waiting for a transcript", () => {
  const props = fixture({ phase: "summary", media: { screenFrames: 0, audioSeconds: 0, audioChunks: 1 } });
  render(<FocusedRecordingPanel {...props} />);
  expect(screen.queryByText("No audio captured")).toBeNull();
  expect(screen.getByText("00:00")).toBeVisible();
});

it("keeps stop actions available during a background save", () => {
  render(<FocusedRecordingPanel {...fixture({busy:true})} />);
  expect(screen.getByRole("button", {name:"Pause"})).toBeEnabled();
  expect(screen.getByRole("button", {name:"Finish"})).toBeEnabled();
  expect(screen.getByRole("button", {name:"Voice on"})).toBeDisabled();
});
