// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";

const f = vi.hoisted(() => ({ settings: {} as any, update: vi.fn() }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: f.settings, updateSettings: f.update }) }));
vi.mock("./workflow-sharing-controls", () => ({ WorkflowSharingControls: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>Skip sharing</button> }));
beforeEach(() => {
  f.settings = { user: { id: "fixture-user" }, workflowSharingPromptSeen: { "fixture-user": "2026-09-23" } };
  f.update.mockReset().mockImplementation(async patch => { f.settings = { ...f.settings, ...patch }; });
});
afterEach(() => vi.useRealTimers());
function service(states = [false, false, false, false]) {
  const value = () => ({ enabled: states.every(Boolean), title: "Keep your workflows current", schedule: "Hourly discovery", tasks: states.map((enabled, i) => ({ name: `task-${i}`, title: `Task ${i}`, enabled })) });
  return {
    load: vi.fn().mockImplementation(async () => value()),
    enable: vi.fn().mockImplementation(async () => { states.fill(true); }),
    disable: vi.fn().mockImplementation(async () => { states.fill(false); }),
  };
}
const toggle = () => screen.getByRole("switch", { name: "Automatic updates" });
async function loaded() { await waitFor(() => expect(toggle()).toBeEnabled()); }
async function enable() {
  fireEvent.click(toggle());
  fireEvent.click(await screen.findByRole("button", { name: "Enable automatic updates" }));
}
describe("workflow schedule control", () => {
  it("does not load or mutate while Chat is active", () => {
    const tasks = service(); render(<WorkflowTasksPrompt active={false} tasks={tasks} />);
    expect(tasks.load).not.toHaveBeenCalled(); expect(tasks.enable).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
  it.each([[true,true,true,true], [true,true,false,true], [false,false,false,false]])("reflects the persisted group %j", async (...states) => {
    const tasks = service(states as boolean[]); render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded();
    expect(toggle()).toHaveAttribute("aria-checked", String(states.every(Boolean)));
    expect(tasks.enable).not.toHaveBeenCalled(); expect(tasks.disable).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("asks before enabling, saves every role, and reads back the result", async () => {
    const tasks = service([true,false,true,true]); render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded();
    expect(screen.getByRole("status")).toHaveTextContent("Some tasks are off");
    await enable(); await waitFor(() => expect(toggle()).toBeChecked());
    expect(tasks.enable).toHaveBeenCalledOnce(); expect(tasks.load).toHaveBeenCalledTimes(2);
  });
  it("turns all schedules off and does not nag to enable on re-entry", async () => {
    const tasks = service([true,true,true,true]); const view = render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded();
    fireEvent.click(toggle()); await waitFor(() => expect(tasks.disable).toHaveBeenCalledOnce());
    await waitFor(() => expect(toggle()).not.toBeChecked());
    view.rerender(<WorkflowTasksPrompt active={false} tasks={tasks} />); view.rerender(<WorkflowTasksPrompt active tasks={tasks} />); await loaded();
    expect(toggle()).not.toBeChecked(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("allows disabling when allowance/access is unavailable, but explains a blocked enable", async () => {
    const tasks = service([true,true,true,true]); const unavailable = vi.fn();
    render(<WorkflowTasksPrompt active tasks={tasks} canEnable={false} onEnableUnavailable={unavailable} />); await loaded();
    fireEvent.click(toggle()); await waitFor(() => expect(toggle()).not.toBeChecked()); await loaded();
    fireEvent.click(toggle()); expect(unavailable).toHaveBeenCalledOnce(); expect(tasks.enable).not.toHaveBeenCalled();
  });
  it("prevents duplicate writes and keeps the old state while saving", async () => {
    const tasks = service([true,true,true,true]); let finish!: () => void;
    tasks.disable.mockImplementationOnce(() => new Promise<void>(r => {finish = r;}));
    render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded(); fireEvent.click(toggle()); fireEvent.click(toggle());
    expect(toggle()).toBeDisabled(); expect(toggle()).toBeChecked(); expect(tasks.disable).toHaveBeenCalledOnce();
    finish(); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn’t save changes"));
  });
  it("keeps partial failures visible and retries the original off intent", async () => {
    const states = [true,true,true,true]; const tasks = service(states);
    tasks.disable.mockImplementationOnce(async () => {states[0] = false; throw new Error("offline");});
    render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded(); fireEvent.click(toggle());
    expect(await screen.findByRole("button", {name:"Retry automatic updates"})).toBeVisible();
    expect(toggle()).not.toBeChecked(); expect(screen.getByRole("status")).toHaveTextContent("Couldn’t save changes");
    await act(async () => {window.dispatchEvent(new Event("focus"));});
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t save changes");
    fireEvent.click(screen.getByRole("button", {name:"Retry automatic updates"}));
    await waitFor(() => expect(tasks.disable).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("status")).toBeEmptyDOMElement()); expect(tasks.enable).not.toHaveBeenCalled();
  });
  it("shows enable failure in the consent dialog and offers sharing only after success", async () => {
    f.settings.workflowSharingPromptSeen = {};
    const tasks = service(); tasks.enable.mockRejectedValueOnce(new Error("offline"));
    render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded(); await enable();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not enable");
    expect(screen.queryByText("Skip sharing")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Enable automatic updates"}));
    expect(await screen.findByText("Skip sharing")).toBeVisible();
  });
  it("preserves account-scoped sharing consent separately from the schedules", async () => {
    f.settings.workflowSharingPromptSeen = {"another-account":"2026-09-23"};
    const tasks = service([true,true,true,true]); render(<WorkflowTasksPrompt active tasks={tasks} />);
    fireEvent.click(await screen.findByText("Skip sharing"));
    await waitFor(() => expect(f.settings.workflowSharingPromptSeen["fixture-user"]).toBe("2026-09-23"));
    expect(tasks.enable).not.toHaveBeenCalled(); expect(tasks.disable).not.toHaveBeenCalled();
  });
  it("keeps sharing open across recorder disconnect and reconnect until explicitly closed", async () => {
    f.settings.workflowSharingPromptSeen = {};
    const tasks = service();
    const view = render(<WorkflowTasksPrompt active tasks={tasks} />);
    await loaded(); await enable();
    expect(await screen.findByRole("dialog", { name: "Help improve Screenpipe" })).toBeVisible();
    view.rerender(<WorkflowTasksPrompt active backendReady={false} tasks={tasks} />);
    expect(screen.getByRole("dialog", { name: "Help improve Screenpipe" })).toBeVisible();
    view.rerender(<WorkflowTasksPrompt active backendReady tasks={tasks} />);
    expect(screen.getByRole("dialog", { name: "Help improve Screenpipe" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(f.settings.workflowSharingPromptSeen["fixture-user"]).toBe("2026-09-23");
  });
  it("ignores outside clicks on both consent steps without recording a choice", async () => {
    f.settings.workflowSharingPromptSeen = {};
    const tasks = service(); render(<WorkflowTasksPrompt active tasks={tasks} />); await loaded();
    fireEvent.click(toggle());
    // Radix registers outside-pointer handling after the opening event.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.pointerDown(document.querySelector("[data-modal-overlay]")!, { pointerType: "mouse", button: 0 });
    expect(screen.getByRole("dialog", { name: "Keep your workflows up to date?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Enable automatic updates" }));
    expect(await screen.findByText("Skip sharing")).toBeVisible();
    fireEvent.pointerDown(document.querySelector("[data-modal-overlay]")!, { pointerType: "mouse", button: 0 });
    expect(screen.getByRole("dialog", { name: "Help improve Screenpipe" })).toBeVisible();
    expect(f.update).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("waits for backend readiness and recovers on reconnect without clicking retry", async () => {
    const tasks = service([true,true,true,true]);
    const view = render(<WorkflowTasksPrompt active backendReady={false} tasks={tasks} />);
    expect(tasks.load).not.toHaveBeenCalled(); expect(toggle()).toBeDisabled();
    view.rerender(<WorkflowTasksPrompt active backendReady tasks={tasks} />); await loaded(); expect(toggle()).toBeChecked();
  });
  it("recovers after the initial retry window expires and observes external changes", async () => {
    vi.useFakeTimers(); const states = [true,true,true,true]; const tasks = service(states);
    for (let i=0;i<4;i++) tasks.load.mockRejectedValueOnce(new Error("offline"));
    const view = render(<WorkflowTasksPrompt active tasks={tasks} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(toggle()).toBeDisabled(); expect(screen.getByRole("status")).toHaveTextContent("Couldn’t check status");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(toggle()).toBeChecked(); expect(screen.getByRole("status")).toBeEmptyDOMElement();
    states[2] = false; await act(async () => {window.dispatchEvent(new Event("focus"));});
    expect(toggle()).not.toBeChecked(); expect(screen.getByRole("status")).toHaveTextContent("Some tasks are off");
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
