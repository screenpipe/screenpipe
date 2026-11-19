// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkflowMoreActions } from "../../../../packages/workflows-ui/src/workflow-more-actions";
import { Plus } from "lucide-react";
import { WorkflowEditor } from "../../../../packages/workflows-ui/src/workflow-editor";
import { WorkflowStepEvidence } from "../../../../packages/workflows-ui/src/workflow-step-evidence";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";

afterEach(cleanup);
const workflow = () => structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
const button = (name: string) => screen.getByRole("button", { name, exact: true });
const title = (index: number) => screen.getByRole("textbox", { name: `Step ${index} title`, exact: true });
function editor(stepsOnly = false) {
  const change = vi.fn();
  const save = vi.fn();
  render(<WorkflowEditor workflow={workflow()} save={save} onDraftChange={change} sessionRecovery={false} saveDisabled stepsOnly={stepsOnly} />);
  return { change, save };
}

it("shows one editable step, bounds navigation, and never saves a view change", () => {
  const { change, save } = editor();
  expect(screen.queryByRole("textbox", { name: "Step 3 title" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Add step at start" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Workflow trigger" })).toBeNull();
  fireEvent.click(button("Walkthrough"));
  expect(button("Walkthrough")).toHaveAttribute("aria-pressed", "true");
  expect(title(1)).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Step 2 title" })).toBeNull();
  expect(button("Previous")).toBeDisabled();
  fireEvent.click(button("Next"));
  expect(title(2)).toBeVisible();
  fireEvent.click(button("Next"));
  expect(title(3)).toBeVisible();
  expect(button("Next")).toBeDisabled();
  expect(screen.getByText("Step 3 of 3")).toBeVisible();
  fireEvent.click(button("Previous"));
  fireEvent.click(button("Previous"));
  expect(title(1)).toBeVisible();
  expect(change).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("keeps the same fields and unfinished edits when changing steps and views", () => {
  const { change } = editor();
  const first = title(1);
  fireEvent.change(first, { target: { value: "My unfinished instruction" } });
  fireEvent.click(button("Walkthrough"));
  fireEvent.click(button("Next"));
  fireEvent.click(button("Previous"));
  expect(title(1)).toBe(first);
  expect(title(1)).toHaveValue("My unfinished instruction");
  fireEvent.click(button("Steps"));
  expect(title(1)).toBe(first);
  expect(title(3)).toBeVisible();
  expect(change.mock.lastCall![0].stages).toHaveLength(3);
  expect(change.mock.lastCall![0].stages[0]).toMatchObject({ name: "My unfinished instruction", sourceIndex: 0 });
});

it("follows the selected step identity when it moves, retaining its source reference", () => {
  const { change } = editor();
  fireEvent.click(button("Walkthrough"));
  fireEvent.click(button("Step 1 actions"));
  fireEvent.click(button("Move step 1 down"));
  expect(title(2)).toHaveValue(workflow().stages[0].name);
  expect(screen.queryByRole("textbox", { name: "Step 1 title" })).toBeNull();
  expect(screen.getByText("Step 2 of 3")).toBeVisible();
  expect(change.mock.lastCall![0].stages[1].sourceIndex).toBe(0);
});

it("opens inserted steps and keeps navigation valid after deleting them", () => {
  editor();
  fireEvent.click(button("Walkthrough"));
  fireEvent.click(button("Step 1 actions"));
  fireEvent.click(button("Add step below"));
  expect(title(2)).toHaveValue("");
  expect(screen.getByText("Step 2 of 4")).toBeVisible();
  fireEvent.click(button("Step 2 actions"));
  fireEvent.click(button("Delete step 2"));
  expect(title(2)).toHaveValue(workflow().stages[1].name);
  expect(screen.getByText("Step 2 of 3")).toBeVisible();
});

it("leaves the cloud steps-only consumer's view controls with its host", () => {
  editor(true);
  expect(screen.queryByRole("group", { name: "Workflow view" })).toBeNull();
  expect(title(3)).toBeVisible();
});

it("keeps secondary step editing behind the step menu in both views", () => {
  const { change } = editor();
  for (const view of ["Walkthrough", "Steps"]) {
    fireEvent.click(button(view));
    expect(screen.queryByRole("button", { name: "Add detail to step 1" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Details for step 1" })).toBeNull();
    fireEvent.click(button("Step 1 actions"));
    fireEvent.click(button("Execution details and links"));
    const details = screen.getByRole("region", { name: "Details for step 1" });
    expect(within(details).getByRole("textbox", { name: "Required access for step 1" })).toBeVisible();
    fireEvent.click(button("Close step details"));
    expect(details).not.toBeVisible();
  }
  fireEvent.click(button("Step 1 actions"));
  fireEvent.click(button("Add block"));
  expect(change.mock.lastCall![0].stages[0].procedure).toHaveLength((workflow().stages[0].procedure?.length ?? 0) + 1);
});

it("keeps the same evidence mounted while switching presentation", () => {
  const source = workflow();
  render(<WorkflowEditor workflow={source} save={vi.fn()} sessionRecovery={false} saveDisabled renderSource={stage => <img alt={stage.name} src={stage.screenshot!.dataUrl} />} />);
  const image = screen.getByRole("img", { name: source.stages[0].name });
  fireEvent.click(button("Steps"));
  expect(screen.getByRole("img", { name: source.stages[0].name })).toBe(image);
  fireEvent.click(button("Walkthrough"));
  fireEvent.click(button("Next"));
  fireEvent.click(button("Previous"));
  expect(screen.getByRole("img", { name: source.stages[0].name })).toBe(image);
});

it("adds an expected result using the existing check-block save contract", () => {
  const { change } = editor();
  fireEvent.click(button("Step 1 actions"));
  fireEvent.click(button("Add expected result"));
  expect(screen.getByText("Expected result", { exact: true })).toBeVisible();
  expect(change.mock.lastCall![0].stages[0].procedure.at(-1)).toMatchObject({ kind: "check", text: "" });
});

it("uses the same selected step in Map and lets screenshots be hidden without editing the draft", () => {
  const source = workflow(), change = vi.fn();
  render(<WorkflowEditor workflow={source} save={vi.fn()} onDraftChange={change} sessionRecovery={false} saveDisabled renderSource={stage => <img alt={stage.name} src={stage.screenshot!.dataUrl} />} />);
  const image = screen.getByRole("img", { name: source.stages[0].name });
  fireEvent.click(button("Screenshots on"));
  expect(image).not.toBeVisible();
  expect(button("Screenshots off")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(button("Map"));
  fireEvent.click(button(`03 ${source.stages[2].name}`));
  expect(title(3)).toBeVisible();
  fireEvent.click(button("Walkthrough"));
  expect(title(3)).toBeVisible();
  expect(button("Next")).toBeDisabled();
  fireEvent.click(button("Screenshots off"));
  fireEvent.click(button("Previous"));
  fireEvent.click(button("Previous"));
  expect(screen.getByRole("img", { name: source.stages[0].name })).toBe(image);
  expect(change).not.toHaveBeenCalled();
});

it("enlarges an existing screenshot without selecting, deleting or reordering it", () => {
  const prototype = HTMLDialogElement.prototype;
  const originalShow = Object.getOwnPropertyDescriptor(prototype, "showModal");
  const originalClose = Object.getOwnPropertyDescriptor(prototype, "close");
  Object.defineProperty(prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  try {
    const source = workflow();
    const change = vi.fn();
    render(<WorkflowStepEvidence workflow={source} stage={source.stages[0]} platform={createFixtureWorkflowsPlatform()} onImageLayoutChange={change} />);
    fireEvent.click(button(`Enlarge screenshot for ${source.stages[0].name}`));
    const dialog = screen.getByRole("dialog", { name: `Enlarged screenshot for ${source.stages[0].name}` });
    expect(within(dialog).getByRole("img")).toHaveAttribute("src", source.stages[0].screenshot!.dataUrl);
    expect(button(`Select screenshot for ${source.stages[0].name}`)).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close screenshot" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(change).not.toHaveBeenCalled();
  } finally {
    if (originalShow) Object.defineProperty(prototype, "showModal", originalShow); else Reflect.deleteProperty(prototype, "showModal");
    if (originalClose) Object.defineProperty(prototype, "close", originalClose); else Reflect.deleteProperty(prototype, "close");
  }
});

it("keeps review, export and workflow details in the document header", () => {
  const { change } = editor();
  expect(button("Export workflow")).toBeVisible();
  fireEvent.click(button("Review workflow"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Reviewed", exact: true }));
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ reviewStatus: "reviewed" }));
  fireEvent.click(button("Workflow details"));
  expect(screen.getByRole("dialog", { name: "Workflow details" })).toBeVisible();
  fireEvent.click(button("Close workflow details"));
  expect(screen.queryByRole("dialog", { name: "Workflow details" })).toBeNull();
});

it("keeps a low field menu within the viewport and restores focus on Escape", () => {
  render(<WorkflowMoreActions label="Step behavior" actions={[{ label: "Expected result", icon: Plus, onSelect: vi.fn(), separatorBefore: true }]} />);
  const trigger = button("Step behavior");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ top: 700, bottom: 736 } as DOMRect);
  const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
  fireEvent.click(trigger);
  const menu = screen.getByRole("menu");
  expect(menu).toHaveStyle({ top: "auto", bottom: "calc(100% + 6px)", maxHeight: "520px" });
  expect(within(menu).queryByRole("separator")).toBeNull();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger).toHaveFocus();
  height.mockRestore();
});
