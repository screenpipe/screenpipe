// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, test } from "bun:test";
import { moveBlock, validWorkflowEdit, workflowEdit, retainNewerWorkflowEdits } from "../../../../packages/workflows-ui/src/workflow-edits";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";

describe("workflow block editing", () => {
  test("editable drafts contain references, never image bytes or editable evidence", () => {
    const source = fixtureWorkflowAnalysis.analysis.workflows[0];
    const draft = workflowEdit(source);
    expect(validWorkflowEdit(draft)).toBe(true);
    expect(draft.stages.map(s => s.sourceIndex)).toEqual(source.stages.map((_, i) => i));
    expect(JSON.stringify(draft)).not.toContain('dataUrl');
    expect(JSON.stringify(draft)).not.toContain('quote');
    draft.stages[0].name = "Changed";
    expect(source.stages[0].name).not.toBe("Changed");
  });
  test("drag and keyboard reordering preserve source references and reject boundaries", () => {
    const draft = workflowEdit(fixtureWorkflowAnalysis.analysis.workflows[0]);
    const next = moveBlock(draft.stages, 0, 2);
    expect(next[2].sourceIndex).toBe(0);
    expect(draft.stages[0].sourceIndex).toBe(0);
    expect(moveBlock(next, 0, -1)).toBe(next);
    expect(moveBlock(next, 0, 100)).toBe(next);
  });
  test("incomplete drafts can be recovered but cannot be saved", () => {
    const draft = workflowEdit(fixtureWorkflowAnalysis.analysis.workflows[0]);
    draft.stages.push({ sourceIndex: null, name: "", description: "", procedure: [] });
    expect(validWorkflowEdit(draft)).toBe(false);
    expect(validWorkflowEdit(draft, true)).toBe(true);
    draft.stages.at(-1)!.name = "Deliver";
    expect(validWorkflowEdit(draft)).toBe(true);
    draft.title = "é".repeat(4001);
    expect(validWorkflowEdit(draft)).toBe(false);
  });
});

test("late catalog reads cannot roll back a saved edit", () => {
  const current = structuredClone(fixtureWorkflowAnalysis);
  current.analysis.workflows[0] = { ...current.analysis.workflows[0], id: "wf-edited", revision: 4, userEditedAt: "2026-09-20", title: "My saved title" };
  const incoming = structuredClone(current);
  incoming.analysis.workflows[0].revision = 3;
  incoming.analysis.workflows[0].title = "Older title";
  expect(retainNewerWorkflowEdits(current, incoming).analysis.workflows[0].title).toBe("My saved title");
  incoming.analysis.workflows[0].revision = 5;
  expect(retainNewerWorkflowEdits(current, incoming).analysis.workflows[0].title).toBe("Older title");
});
