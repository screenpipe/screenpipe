// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "../../../../packages/workflows-ui/src/workflow-editor";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import type { WorkflowEdit } from "../../../../packages/workflows-ui/src/workflow-edits";

const workflow = fixtureWorkflowAnalysis.analysis.workflows.find(w => w.title === "Research synthesis")!;
const type = () => screen.getByRole("combobox", { name: "Block 1 type in step 1", exact: true });
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });
function Harness({ save }: { save: (draft: WorkflowEdit) => Promise<typeof workflow> }) {
  const [value, setValue] = useState(workflow);
  return <WorkflowEditor workflow={value} save={async draft => { const saved = await save(draft); setValue(saved); return saved; }} />;
}

describe("direct workflow block type editing", () => {
  it("changes type without a menu and preserves the block's text and source", async () => {
    const save = vi.fn(createFixtureWorkflowsPlatform().saveWorkflowEdits!);
    render(<Harness save={save} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(Array.from((type() as HTMLSelectElement).options, option => option.value)).toEqual(["action", "input", "output", "decision", "check"]);
    fireEvent.change(type(), { target: { value: "decision" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0][0].stages[0].procedure[0]).toEqual({
      sourceIndex: 0, kind: "decision", text: workflow.stages[0].procedure![0].text,
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo last edit" }));
    expect(type()).toHaveValue(workflow.stages[0].procedure![0].kind);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it("retains a failed type edit for retry instead of reverting the label", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Offline. Try again.")).mockResolvedValue({ ...workflow, revision: 1 });
    render(<WorkflowEditor workflow={workflow} save={save} />);
    fireEvent.change(type(), { target: { value: "check" } });
    await screen.findByText("Offline. Try again.", {}, { timeout: 2000 });
    expect(type()).toHaveValue("check");
    const recovered = JSON.parse(sessionStorage.getItem(`screenpipe:workflow-edit:${workflow.id ?? workflow.title}`)!);
    expect(recovered.stages[0].procedure[0].kind).toBe("check");
    fireEvent.click(screen.getByRole("button", { name: "Retry save", exact: true }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0].stages[0].procedure[0].kind).toBe("check");
  });
});
