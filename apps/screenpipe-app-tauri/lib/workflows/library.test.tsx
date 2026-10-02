// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkflowLibrary } from "../../../../packages/workflows-ui/src/workflow-library";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
import { WorkflowsApp } from "../../../../packages/workflows-ui/src/workflows-app";
import type { WorkflowsPlatform } from "../../../../packages/workflows-ui/src/platform";
import type { WorkflowGuide } from "../../../../packages/workflows-ui/src/guide";

const workflow = { ...fixtureWorkflowAnalysis.analysis.workflows[0], id: "saved-source", revision: 1 };
const guide: WorkflowGuide = { version: 1, workflowKey: "saved-source", sourceRevision: 1, title: "Research SOP", summary: "Saved summary", prerequisites: [], steps: [{ title: "Collect sources", instruction: "Keep the useful sources.", sourceStage: 0, expectedResult: "", includeImage: false }], exceptions: [], completion: [], questions: [] };
function platform(): WorkflowsPlatform {
  return {
    ensureRuntime: vi.fn().mockResolvedValue({ recording: false, source: "screenpipe" }),
    analyzeCapturedWork: vi.fn(),
    guides: { list: vi.fn().mockResolvedValue([guide]), load: vi.fn().mockResolvedValue(guide), save: vi.fn(), export: vi.fn(), generate: vi.fn() },
    library: { listSkillDrafts: vi.fn().mockResolvedValue([{ workflowKey: "skill-source", draft: { name: "Review skill", description: "Review sources", instructions: "Read sources", sourceWorkflow: "Research" } }]), saveSkillDraft: vi.fn().mockResolvedValue(undefined), listInstalledSkills: vi.fn().mockResolvedValue([]) },
    saveWorkflowSkill: vi.fn(),
  };
}
beforeEach(() => { window.history.replaceState(null, "", "/?view=library"); localStorage.clear(); });
afterEach(cleanup);
it("opens a saved SOP with no source workflow without regenerating it", async () => {
  const p = platform();
  render(<WorkflowLibrary platform={p} workflows={[]} />);
  fireEvent.click(await screen.findByRole("button", { name: /Research SOP/ }));
  expect(await screen.findByText("Saved summary")).toBeTruthy();
  expect(p.guides!.generate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Back to Library" })).toBeTruthy();
  expect(new URLSearchParams(location.search).get("libraryItem")).toBe(guide.workflowKey);
});
it("reopens the selected SOP from its URL after remount", async () => {
  window.history.replaceState(null, "", "/?view=library&libraryItem=saved-source");
  const p = platform();
  const view = render(<WorkflowLibrary platform={p} workflows={[workflow]} />);
  expect(await screen.findByText("Saved summary")).toBeTruthy();
  view.unmount();
  render(<WorkflowLibrary platform={p} workflows={[workflow]} />);
  expect(await screen.findByText("Saved summary")).toBeTruthy();
  expect(p.guides!.generate).not.toHaveBeenCalled();
});
it("retains a load error and retries instead of offering to create over saved SOPs", async () => {
  const p = platform(); vi.mocked(p.guides!.list!).mockRejectedValueOnce(new Error("Saved SOPs unreadable"));
  render(<WorkflowLibrary platform={p} workflows={[]} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved SOPs unreadable");
  expect(screen.queryByText("No saved SOPs yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Research SOP/ })).toBeTruthy();
});
it("opens and autosaves a skill without installing it", async () => {
  const p = platform(); render(<WorkflowLibrary platform={p} workflows={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Skills", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: /Review skill/ }));
  fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Read and compare sources" } });
  await waitFor(() => expect(p.library!.saveSkillDraft).toHaveBeenCalledWith("skill-source", expect.objectContaining({ instructions: "Read and compare sources" })));
  expect(p.saveWorkflowSkill).not.toHaveBeenCalled();
});
it("shows saved drafts when installed-skill discovery fails", async () => {
  const p = platform(); vi.mocked(p.library!.listInstalledSkills!).mockRejectedValue(new Error("Offline"));
  render(<WorkflowLibrary platform={p} workflows={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Skills", exact: true }));
  expect(await screen.findByRole("button", { name: /Review skill/ })).toBeTruthy();
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not check installed skills");
});
it("keeps Library accessible when the workflow backend cannot load", async () => {
  const p = platform(); p.ensureRuntime = vi.fn().mockRejectedValue(new Error("Unavailable"));
  p.loadCapturedWork = vi.fn().mockRejectedValue(new Error("Unavailable"));
  render(<WorkflowsApp platform={p} storageKey={null} />);
  expect(await screen.findByRole("button", { name: /Research SOP/ })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Library" })).toBeTruthy();
});

it("the Library sidebar returns from an open SOP to the saved list", async () => {
  const p = platform();
  render(<WorkflowsApp platform={p} storageKey={null} />);
  fireEvent.click(await screen.findByRole("button", { name: /Research SOP/ }));
  expect(await screen.findByText("Saved summary")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Library", exact: true }));
  expect(await screen.findByRole("button", { name: /Research SOP/ })).toBeTruthy();
  expect(new URLSearchParams(location.search).get("libraryItem")).toBeNull();
});

it("a background workflow revision does not close its open SOP", async () => {
  window.history.replaceState(null, "", "/?view=workflows");
  const p = platform();
  const analysis = { ...fixtureWorkflowAnalysis, analysis: { workflows: [workflow] } };
  p.loadCapturedWork = vi.fn().mockResolvedValue(analysis);
  const view = render(<WorkflowsApp platform={p} initialAnalysis={analysis} storageKey={null} />);
  await waitFor(() => expect(screen.queryByText("Refreshing saved workflows…")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Open map", exact: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Open SOP", exact: true }));
  expect(await screen.findByText("Saved summary")).toBeTruthy();
  const refreshed = { ...p, loadCapturedWork: vi.fn().mockResolvedValue({ ...analysis, analysis: { workflows: [{ ...workflow, title: "Refined source title", revision: 2 }] } }) };
  view.rerender(<WorkflowsApp platform={refreshed} initialAnalysis={analysis} storageKey={null} />);
  expect(await screen.findByRole("button", { name: "Review screenshots" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back to workflow" })).toBeTruthy();
  expect(screen.getByText("Saved summary")).toBeTruthy();
  expect(p.guides!.generate).not.toHaveBeenCalled();
});
