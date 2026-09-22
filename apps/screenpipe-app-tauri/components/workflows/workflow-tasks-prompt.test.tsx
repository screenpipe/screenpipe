// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";

const f = vi.hoisted(() => ({ settings: {} as any, update: vi.fn() }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: f.settings, updateSettings: f.update }) }));
vi.mock("./workflow-sharing-controls", () => ({ WorkflowSharingControls: ({ onDone }: { onDone: () => void }) => <div data-testid="sharing-controls"><button onClick={onDone}>Not now</button></div> }));
beforeEach(() => {
  f.settings = { user: { id: "fixture-user" }, workflowSharing: null };
  f.update.mockReset().mockImplementation(async patch => { f.settings = { ...f.settings, ...patch }; });
});

const setup = { enabled: false, title: "Update my workflows", schedule: "every 24h" };
function service(enabled = false) {
  return { load: vi.fn().mockResolvedValue({ ...setup, enabled }), enable: vi.fn().mockResolvedValue(undefined) };
}

describe("workflow task opt-in", () => {
  it("does not check or enable while Chat is active", () => {
    const tasks = service();
    render(<WorkflowTasksPrompt active={false} tasks={tasks} />);
    expect(tasks.load).not.toHaveBeenCalled();
    expect(tasks.enable).not.toHaveBeenCalled();
  });
  it("shows the task on entry, allows dismissal, and checks again on the next switch", async () => {
    const tasks = service();
    const view = render(<WorkflowTasksPrompt active tasks={tasks} />);
    expect(await screen.findByText(/every 24h/)).toBeVisible();
    fireEvent.click(screen.getByText("How daily updates work"));
    expect(screen.getByText(/Chat → Scheduled tasks/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByTestId("sharing-controls")).toBeVisible();
    expect(tasks.enable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(f.settings.workflowSharingPromptSeen).toEqual({ "fixture-user": "2026-09-21" }));
    view.rerender(<WorkflowTasksPrompt active={false} tasks={tasks} />);
    view.rerender(<WorkflowTasksPrompt active tasks={tasks} />);
    expect(await screen.findByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not prompt or mutate an already enabled task", async () => {
    const tasks = service(true);
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    await waitFor(() => expect(tasks.load).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tasks.enable).not.toHaveBeenCalled();
  });
  it("enables once then offers sharing only on success", async () => {
    const tasks = service();
    let finish!: () => void;
    tasks.enable.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    expect(screen.queryByTestId("sharing-controls")).not.toBeInTheDocument();
    const button = await screen.findByRole("button", { name: "Enable daily updates" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(tasks.enable).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Enabling…" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.getByTestId("sharing-controls")).toBeVisible());
  });
  it("keeps an enable failure recoverable", async () => {
    const tasks = service();
    tasks.enable.mockRejectedValueOnce(new Error("offline"));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable daily updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not enable");
    fireEvent.click(screen.getByRole("button", { name: "Enable daily updates" }));
    await waitFor(() => expect(screen.getByTestId("sharing-controls")).toBeVisible());
    expect(tasks.enable).toHaveBeenCalledTimes(2);
  });
  it("skips sharing for signed-out users", async () => {
    f.settings.user = null;
    render(<WorkflowTasksPrompt active tasks={service()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("does not ask again when sharing is already enabled", async () => {
    f.settings.workflowSharing = { epoch: "existing" };
    render(<WorkflowTasksPrompt active tasks={service()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not reuse another account's dismissal", async () => {
    f.settings.workflowSharingPromptSeen = { "different-user": "2026-09-21" };
    render(<WorkflowTasksPrompt active tasks={service()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.getByTestId("sharing-controls")).toBeVisible();
  });
  it("retries recorder startup quietly without opening a false consent dialog", async () => {
    vi.useFakeTimers();
    const tasks = service(); tasks.load.mockRejectedValueOnce(new Error("offline"));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(tasks.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", {name:"Enable daily updates"})).toBeVisible();
    vi.useRealTimers();
  });
});
