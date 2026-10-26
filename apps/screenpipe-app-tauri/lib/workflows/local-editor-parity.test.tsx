// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowsView } from "../../../../packages/workflows-ui/src/workflows-app";
import { WorkflowEditor, WorkflowDocument } from "../../../../packages/workflows-ui/src/workflow-editor";
import { workflowEdit } from "../../../../packages/workflows-ui/src/workflow-edits";
import { addVariableExample, parameterize, updateVariable, workflowAuthoredContext } from "../../../../packages/workflows-ui/src/workflow-variables";
import { createFixtureWorkflowsPlatform, fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
import type { WorkflowVariable } from "../../../../packages/workflows-ui/src/model";

const variable: WorkflowVariable = { id: "customer", kind: "input", name: "Customer", description: "Customer name", examples: [] };
const source = () => {
  const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
  workflow.id = "wf-test";
  workflow.revision = 3;
  workflow.stages[0].description = "Review Acme before sending the report.";
  return workflow;
};
it("parameterizes exact prose while preserving URLs, code, identifiers and original source values", () => {
  const result = parameterize("Acme, Acme-Co, `Acme`, [Acme](https://example.com/Acme), https://example.com/Acme", "Acme", variable);
  expect(result.count).toBe(1);
  expect(result.markdown).toContain("[Customer](#workflow-io-customer)");
  expect(result.markdown).toContain("Acme-Co");
  expect(result.markdown).toContain("`Acme`");
  expect(result.markdown).toContain("https://example.com/Acme");
  const workflow = source();
  const draft = workflowEdit(workflow);
  const next = addVariableExample(draft, variable, { stepId: "step-0", field: "description", value: "Acme" });
  expect(next.variables![0].examples[0].value).toBe("Acme");
  expect(next.stages[0].sourceIndex).toBe(0);
  expect(workflow.stages[0].description).toContain("Acme");
  expect(next.stages[0]).not.toHaveProperty("evidence");
  expect(() => addVariableExample(draft, variable, { stepId: "missing", field: "description", value: "Acme" })).toThrow("removed");
});
it("renames formatted references once, removes links without deleting prose, and rejects duplicate names", () => {
  const draft = workflowEdit(source());
  draft.variables = [variable];
  draft.stages[0].description = "Review [Cus**tomer**](#workflow-io-customer).";
  const renamed = updateVariable(draft, variable.id, { ...variable, name: "Account" });
  expect(renamed.stages[0].description.match(/Account/g)).toHaveLength(1);
  const removed = updateVariable(renamed, variable.id);
  expect(removed.stages[0].description).toBe("Review Account.");
  expect(removed.variables).toEqual([]);
  draft.variables.push({ ...variable, id: "other", name: "Account" });
  expect(() => updateVariable(draft, variable.id, { ...variable, name: "account" })).toThrow("unique");
});
it("keeps variable examples and execution fields in the portable skill context", () => {
  const workflow = source();
  workflow.variables = [{ ...variable, examples: [{ stepId: "step-0", field: "description", value: "Acme" }] }];
  workflow.stages[0].requiredAccess = "Reporting access";
  workflow.stages[0].exceptions = "Stop if evidence is missing";
  workflow.stages[0].linkedWorkflowId = "wf-review";
  const markdown = workflowAuthoredContext(workflow);
  expect(markdown).toContain("Acme");
  expect(markdown).toContain("Reporting access");
  expect(markdown).toContain("Stop if evidence is missing");
  expect(markdown).toContain("wf-review");
});
it("creates a named reference through the real editor and can undo it", async () => {
  const save = vi.fn(async () => source());
  render(<WorkflowEditor workflow={source()} save={save} sessionRecovery={false} saveDisabled />);
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Variables" }));
  fireEvent.click(screen.getByRole("button", { name: "Add input" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name", exact: true }), { target: { value: "Customer" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Example value" }), { target: { value: "Acme" } });
  fireEvent.click(screen.getByRole("button", { name: "Use named reference" }));
  expect(screen.getByRole("link", { name: "Customer" })).toHaveAttribute("href", expect.stringContaining("#workflow-io-"));
  expect(screen.getByText("Acme", { selector: "blockquote" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Undo last edit" }));
  expect(screen.queryByRole("link", { name: "Customer" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Step 1 description" })).toHaveTextContent("Acme");
});
it("persists variables, archive state and versions across reopen, then restores retained sources", async () => {
  localStorage.clear();
  const analysis = structuredClone(fixtureWorkflowAnalysis);
  analysis.analysis.workflows[0] = source();
  for (const w of analysis.analysis.workflows) for (const s of w.stages) { delete s.screenshot; delete s.screenshots; }
  const platform = createFixtureWorkflowsPlatform(analysis);
  const draft = addVariableExample(workflowEdit(source()), variable, { stepId: "step-0", field: "description", value: "Acme" });
  const saved = await platform.saveWorkflowEdits!({ ...draft, archived: true, reviewStatus: "needs-edits", reviewNote: "Check access" });
  expect(saved.variables![0].examples[0].value).toBe("Acme");
  expect(saved.stages[0].evidence).toEqual(source().stages[0].evidence);
  const reopened = await createFixtureWorkflowsPlatform(analysis).loadCapturedWork!();
  expect(reopened!.analysis.workflows[0].archived).toBe(true);
  expect(reopened!.analysis.workflows[0].versions).toHaveLength(1);
  const restored = await platform.saveWorkflowEdits!({ ...workflowEdit(saved), restoreRevision: 3 });
  expect(restored.stages[0].description).toContain("Acme");
  expect(restored.variables).toBeUndefined();
  expect(restored.revision).toBe(5);
  expect(restored.versions).toHaveLength(2);
  await expect(platform.saveWorkflowEdits!(workflowEdit(saved))).rejects.toThrow();
});
it("shows saved definitions and execution context on the read-only document", () => {
  const workflow = source();
  workflow.variables = [{ ...variable, examples: [] }];
  workflow.stages[0].requiredAccess = "Reporting access";
  render(<WorkflowDocument workflow={workflow} />);
  expect(screen.getByText("Reporting access")).toBeVisible();
  expect(screen.getByRole("button", { name: "Customer" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Add input" })).toBeNull();
});
it("restores through the revision-checked save path and retains typing made while restore is pending", async () => {
  const workflow = source();
  const old = structuredClone(workflow); old.title = "Earlier title";
  workflow.versions = [{ revision: 2, at: "", snapshot: old }];
  let resolve!: (workflow: typeof old) => void;
  const save = vi.fn((_draft: ReturnType<typeof workflowEdit>) => new Promise<typeof old>(done => { resolve = done; }));
  render(<WorkflowEditor workflow={workflow} save={save} sessionRecovery={false} />);
  fireEvent.click(screen.getByRole("button", { name: "More workflow actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore revision 2" }));
  expect(save.mock.calls[0][0]).toMatchObject({ expected_revision: 3, restoreRevision: 2 });
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow title" }), { target: { value: "My typing" } });
  resolve({ ...old, revision: 4 });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Workflow title" })).toHaveValue("My typing"));
  await waitFor(() => expect(screen.getByText(/Your newer typing is kept/)).toBeVisible());
});

it("allocates legacy IDs without colliding with previously reordered steps",()=>{
  const workflow=source(); workflow.stages[1].id="step-0";
  workflow.stages[0].procedure=[{kind:"action",text:"First",quote:"",app:"Docs",timestamp:""},{id:"block-0",kind:"action",text:"Second",quote:"",app:"Docs",timestamp:""}];
  const draft=workflowEdit(workflow);
  expect(new Set(draft.stages.map(s=>s.id)).size).toBe(draft.stages.length);
  expect(draft.stages[1].id).toBe("step-0");
  expect(draft.stages[0].procedure[0].id).not.toBe("block-0");
});
it("opens linked workflows through document navigation and blocks leaving unsaved edits",()=>{
  const workflow=source(); workflow.stages[0].linkedWorkflowId="wf-related";
  const open=vi.fn();
  render(<WorkflowEditor workflow={workflow} save={vi.fn()} sessionRecovery={false} saveDisabled relatedWorkflows={[{...source(),id:"wf-related",title:"Review findings"}]} openRelated={open}/>);
  const link=screen.getByRole("button",{name:"Open linked workflow: Review findings"});
  fireEvent.click(link);expect(open).toHaveBeenCalledWith("wf-related");
  fireEvent.change(screen.getByRole("textbox",{name:"Workflow title"}),{target:{value:"Unsaved"}});
  expect(link).toBeDisabled();
});

it("filters local archive and review state without losing the underlying workflow index",()=>{
  const open=vi.fn();
  const workflows=[{...source(),title:"Archived research",archived:true},{...source(),title:"Active research",reviewStatus:"needs-edits" as const}];
  render(<WorkflowsView documentFilters workflows={workflows} knownWorkflowCount={2} query="" setQuery={vi.fn()} openWorkflow={open} analyze={vi.fn()} analyzing={false} error="" activityState={{cycleId:"",items:[],unavailable:false}}/>);
  expect(screen.queryByRole("heading",{name:"Archived research"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:/Active research/}));expect(open).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole("button",{name:"Filter workflows"}));
  fireEvent.click(screen.getByRole("checkbox",{name:"Show archived"}));
  expect(screen.getByRole("heading",{name:"Archived research"})).toBeVisible();
  expect(screen.queryByRole("heading",{name:"Active research"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Filter workflows"}));
  fireEvent.click(screen.getByRole("option",{name:/Unreviewed/}));
  expect(screen.queryByRole("heading",{name:"Active research"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Reset",exact:true}));
  expect(screen.getByRole("heading",{name:"Active research"})).toBeVisible();
  expect(screen.queryByRole("heading",{name:"Archived research"})).toBeNull();
});

it("opens secondary tools by keyboard and restores focus without changing the draft", () => {
  render(<WorkflowEditor workflow={source()} save={vi.fn()} sessionRecovery={false} />);
  const trigger = screen.getByRole("button", { name: "More workflow actions" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Variables" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  // Disabled Undo is skipped until there is an edit to undo.
  expect(screen.getByRole("menuitem", { name: "Archive workflow" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Workflow title" }), { target: { value: "My unfinished edit" } });
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "h" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Workflow title" })).toHaveValue("My unfinished edit");
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});
