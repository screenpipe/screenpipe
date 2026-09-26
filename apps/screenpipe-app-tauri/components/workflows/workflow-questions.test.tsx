// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useEffect } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowQuestions } from "../../../../packages/workflows-ui/src/workflow-questions";
import { readWorkflowAnswers, writeWorkflowAnswers } from "../../../../packages/workflows-ui/src/workflow-answers";
import type { WorkflowComposerAccessoryProps } from "../../../../packages/workflows-ui/src/assistant";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
const question = "Who reviews the synthesis?";
const workflow = { ...fixtureWorkflowAnalysis.analysis.workflows[0], id: "wf-review", revision: 4, userCorrection: "Keep the reviewed step.", openQuestions: [question, question, "Where is it saved?"] };

it("preserves existing notes and old questions, replaces edited answers, and supports clearing", () => {
  const old = writeWorkflowAnswers(workflow.userCorrection, [{ question: "Old question?", answer: "Old answer" }, { question, answer: "First" }]);
  const next = writeWorkflowAnswers(old + "\n\nUser feedback: Keep screenshots.", [{ question, answer: "Second\nwith detail" }]);
  expect(next).toContain(workflow.userCorrection);
  expect(next).toContain("User feedback: Keep screenshots.");
  expect(readWorkflowAnswers(next)).toEqual([{ question: "Old question?", answer: "Old answer" }, { question, answer: "Second\nwith detail" }]);
  expect(readWorkflowAnswers(writeWorkflowAnswers(next, [{ question, answer: "" }]))).toEqual([{ question: "Old question?", answer: "Old answer" }]);
  expect(() => writeWorkflowAnswers("", [{ question, answer: "界".repeat(10000) }])).toThrow("too long");
});

it("deduplicates generated questions and saves reviewed answers only on submit, restoring them on return", async () => {
  const save = vi.fn(async (userCorrection: string) => ({ ...workflow, revision: 5, userCorrection }));
  const view = render(<WorkflowQuestions workflow={workflow} save={save} />);
  expect(screen.getAllByRole("textbox")).toHaveLength(2);
  fireEvent.change(screen.getByLabelText(question), { target: { value: "The project lead." } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByRole("button", { name: "Save answers" }).closest("form")!);
  await screen.findByText("Answers saved for the next workflow update.");
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toContain("Keep the reviewed step.");
  const saved = await save.mock.results[0].value;
  view.unmount();
  render(<WorkflowQuestions workflow={saved} save={save} />);
  expect(screen.getByLabelText(question)).toHaveValue("The project lead.");
  expect(screen.getByRole("button", { name: "Save answers" })).toBeDisabled();
});

it("keeps a failed draft, prevents duplicate submission, and permits retry", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; }))
    .mockImplementation(async (userCorrection: string) => ({ ...workflow, userCorrection }));
  render(<WorkflowQuestions workflow={workflow} save={save} />);
  fireEvent.change(screen.getByLabelText(question), { target: { value: "Reviewer" } });
  const form = screen.getByRole("button", { name: "Save answers" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(save).toHaveBeenCalledTimes(1);
  reject(new Error("Could not save. Try again."));
  await screen.findByRole("alert");
  expect(screen.getByLabelText(question)).toHaveValue("Reviewer");
  fireEvent.submit(form);
  await screen.findByText("Answers saved for the next workflow update.");
});

function Voice(props: WorkflowComposerAccessoryProps) {
  useEffect(() => { props.onBusyChange?.(true); return () => props.onBusyChange?.(false); }, [props.onBusyChange]);
  return <button type="button" onClick={() => { props.onValueChange(props.inputValue + " Spoken answer."); props.onBusyChange?.(false); }}>Finish dictation</button>;
}
it("dictates only into the selected input, blocks save during voice, and unmounts voice when hidden", async () => {
  const save = vi.fn(async (userCorrection: string) => ({ ...workflow, userCorrection }));
  const props = { workflow, save, composerAccessory: (p: WorkflowComposerAccessoryProps) => <Voice {...p} /> };
  const view = render(<WorkflowQuestions {...props} />);
  fireEvent.change(screen.getByLabelText(question), { target: { value: "Typed answer." } });
  fireEvent.focus(screen.getByLabelText(question));
  expect(screen.getByRole("button", { name: "Save answers" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Finish dictation" }));
  expect(screen.getByLabelText(question)).toHaveValue("Typed answer. Spoken answer.");
  expect(screen.getByLabelText("Where is it saved?")).toHaveValue("");
  expect(save).not.toHaveBeenCalled();
  view.rerender(<WorkflowQuestions {...props} active={false} />);
  expect(screen.queryByRole("button", { name: "Finish dictation" })).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save answers" })).toBeEnabled());
});

it("keeps a local draft while receiving new saved answers and preserves untouched remote answers", async () => {
  const save = vi.fn(async (userCorrection: string) => ({ ...workflow, userCorrection }));
  const view = render(<WorkflowQuestions workflow={workflow} save={save} />);
  fireEvent.change(screen.getByLabelText(question), { target: { value: "My draft reviewer" } });
  const refreshed = { ...workflow, revision: 5, userCorrection: writeWorkflowAnswers(workflow.userCorrection, [{ question: "Where is it saved?", answer: "Shared drive" }]) };
  view.rerender(<WorkflowQuestions workflow={refreshed} save={save} />);
  expect(screen.getByLabelText(question)).toHaveValue("My draft reviewer");
  expect(screen.getByLabelText("Where is it saved?")).toHaveValue("Shared drive");
  fireEvent.click(screen.getByRole("button", {name:"Save answers"}));
  await screen.findByText("Answers saved for the next workflow update.");
  expect(readWorkflowAnswers(save.mock.calls[0][0])).toEqual(expect.arrayContaining([{question:"Where is it saved?",answer:"Shared drive"},{question,answer:"My draft reviewer"}]));
});

it("does not remount step media when saving answers only changes the revision", async () => {
  const { WorkflowEditor } = await import("../../../../packages/workflows-ui/src/workflow-editor");
  const save = vi.fn();
  const source = () => <div data-testid="step-media">Screenshot</div>;
  const view = render(<WorkflowEditor workflow={workflow} save={save} renderSource={source} />);
  const original = screen.getAllByTestId("step-media")[0];
  view.rerender(<WorkflowEditor workflow={{ ...workflow, revision: 5, userCorrection: "New answer" }} save={save} renderSource={source} />);
  expect(screen.getAllByTestId("step-media")[0]).toBe(original);
  expect(save).not.toHaveBeenCalled();
});
