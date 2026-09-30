// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowsHelpDialog } from "./workflows-help-dialog";

vi.mock("@/components/settings/feedback-section", () => ({
  FeedbackSection: () => <div>Existing Screenpipe help</div>,
}));

it("opens shared Help above Workflows and dismisses without replacing the workspace", () => {
  const close = vi.fn();
  const { rerender } = render(<><main>Workflow context</main><WorkflowsHelpDialog open onOpenChange={close} /></>);
  expect(screen.getByRole("dialog", { name: "Help" })).toBeVisible();
  expect(screen.getByText("Existing Screenpipe help")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(close).toHaveBeenCalledWith(false);
  rerender(<><main>Workflow context</main><WorkflowsHelpDialog open={false} onOpenChange={close} /></>);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveTextContent("Workflow context");
});
