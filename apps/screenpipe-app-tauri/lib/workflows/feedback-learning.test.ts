// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), load: vi.fn(), apply: vi.fn() }));
vi.mock("./agent-runner", () => ({ runWorkflowAgent: mocks.run }));
vi.mock("./scheduled-discovery", () => ({ loadScheduledCatalog: mocks.load, applyWorkflowFeedback: mocks.apply, saveWorkflowFeedback: vi.fn() }));
vi.mock("./disk-storage", () => ({ loadAssistantFromDisk: vi.fn(), saveAssistantToDisk: vi.fn() }));
import { desktopAssistant } from "./assistant";
import { parseWorkflowRefinement } from "../../../../packages/workflows-ui/src/feedback-tool";
const workflow = { id: "wf-a", revision: 3, title: "Research", description: "Original", userCorrection: "Existing learning" };
const refinement = { learning: "CRM is reference only.", changes: { description: "Review the schedule; CRM is reference only." } };
const request = () => ({ question: "CRM is only a reference, not preparation.", context: { key: "feedback:wf-a", title: "Research", purpose: "feedback" as const, workflow: workflow as any }, history: [{ id: "u", role: "user" as const, text: "Review this workflow", at: "" }], signal: new AbortController().signal, onProgress: vi.fn() });
function proposal(onEvent: any, value = refinement) { onEvent({ type: "tool_execution_end", toolName: "refine_workflow", result: { content: [{ text: JSON.stringify(value) }] } }); }
beforeEach(() => {
 vi.clearAllMocks(); mocks.load.mockResolvedValue({ analysis: { workflows: [workflow] } });
 mocks.apply.mockResolvedValue({ ...workflow, ...refinement.changes, revision: 4 });
 mocks.run.mockImplementation(async ({ onEvent }) => { proposal(onEvent); return "CRM belongs in reference context."; });
});
describe("feedback learning", () => {
 it("saves only after successful completion and returns the updated workflow", async () => {
  const r = request();
  expect(await desktopAssistant.ask(r)).toContain("Workflow updated.");
  expect(mocks.apply).toHaveBeenCalledWith(workflow, refinement.learning, refinement.changes);
  expect(r.onProgress).toHaveBeenCalledWith(expect.objectContaining({ workflow: expect.objectContaining({ revision: 4 }) }));
  expect(mocks.run.mock.calls[0][0].config.allowedTools).toContain("refine_workflow");
 });
 it("does not enable changes in the opening interview", async () => {
  mocks.run.mockResolvedValue("Three questions");
  await desktopAssistant.ask({ ...request(), history: [] });
  expect(mocks.run.mock.calls[0][0].config.allowedTools).not.toContain("refine_workflow");
  expect(mocks.apply).not.toHaveBeenCalled();
 });
 it("keeps vague conversation as conversation without a proposal", async () => {
  mocks.run.mockResolvedValue("Tell me more.");
  expect(await desktopAssistant.ask(request())).toBe("Tell me more.");
  expect(mocks.apply).not.toHaveBeenCalled();
 });
 it("does not save an interrupted or failed turn", async () => {
  mocks.run.mockImplementation(async ({ onEvent }) => { proposal(onEvent); throw new Error("Interrupted"); });
  await expect(desktopAssistant.ask(request())).rejects.toThrow("Interrupted");
  expect(mocks.apply).not.toHaveBeenCalled();
 });
 it("does not claim success after a concurrent update rejects the save", async () => {
  mocks.apply.mockRejectedValue(new Error("Workflow changed"));
  const r = request();
  await expect(desktopAssistant.ask(r)).rejects.toThrow("Workflow changed");
  expect(r.onProgress).not.toHaveBeenCalled();
 });
 it("rejects changes to evidence, measurements or another workflow", () => {
  for (const changes of [{ stages: [] }, { timing: 40 }, { id: "another" }]) expect(() => parseWorkflowRefinement({ ...refinement, changes })).toThrow();
 });
});
