// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { fixtureWorkflowAnalysis } from "@screenpipe/workflows-ui/fixture";
import { WorkflowAgentActions } from "./workflow-agent-actions";
import { showChatWithPrefill } from "@/lib/chat-utils";
import { performAgentHandoff } from "@/lib/first-run/agent-handoff";
import { toast } from "@/components/ui/use-toast";
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/components/ui/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/first-run/agent-handoff", async importOriginal => ({ ...await importOriginal<object>(), performAgentHandoff: vi.fn().mockResolvedValue({ prefilled: true, copied: true }) }));
const workflow = { ...fixtureWorkflowAnalysis.analysis.workflows[0], id: "wf-source" };
async function choose(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: "Open in agent" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
describe("workflow agent handoff", () => {
  it("puts Codex first without changing the selected runner", async () => {
    render(<WorkflowAgentActions workflow={workflow} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open in agent" }), { key: "ArrowDown" });
    await screen.findByRole("menuitem", { name: "Codex" });
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Codex", "Claude", "Cursor", "Screenpipe"]);
  });
  it("offers the handoff for a normal workflow without automation metadata", () => {
    render(<WorkflowAgentActions workflow={workflow} />);
    expect(screen.getByRole("button", { name: "Open in agent" })).toBeEnabled();
  });
  it("prefills the existing Screenpipe flow without sending or enabling a schedule", async () => {
    render(<WorkflowAgentActions workflow={workflow} />); await choose("Screenpipe");
    expect(showChatWithPrefill).toHaveBeenCalledWith(expect.objectContaining({ autoSend: false, useHomeChat: true, prompt: expect.stringContaining("Help me carry it out") }));
    expect(vi.mocked(showChatWithPrefill).mock.calls.at(-1)?.[0]?.prompt).not.toContain("recurring");
  });
  it.each(["Claude", "Codex", "Cursor"])("hands the generic workflow task and identity to %s", async label => {
    vi.mocked(performAgentHandoff).mockClear();
    render(<WorkflowAgentActions workflow={workflow} />); await choose(label);
    expect(performAgentHandoff).toHaveBeenCalledWith(expect.objectContaining({ id: label.toLowerCase() }), expect.any(Object), expect.stringContaining("Help me carry it out"));
    const prompt = vi.mocked(performAgentHandoff).mock.calls[0][2]!;
    expect(prompt).toContain("wf-source");
    expect(prompt).toContain("Retrieve its current steps and sources");
    expect(prompt).not.toContain("recurring");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open in agent" })).toBeEnabled());
  });
  it("shows the clipboard fallback and permits retry when the external app cannot open", async () => {
    vi.mocked(performAgentHandoff).mockResolvedValueOnce({ prefilled: false, copied: true, launched: false, replayed: false });
    render(<WorkflowAgentActions workflow={workflow} />); await choose("Codex");
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Prompt copied" })));
    expect(screen.getByRole("button", { name: "Open in agent" })).toBeEnabled();
  });
});
