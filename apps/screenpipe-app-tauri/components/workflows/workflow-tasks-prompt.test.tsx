// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";

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
    expect(await screen.findByText("every 24h")).toBeVisible();
    expect(screen.getByText(/Chat → Scheduled tasks/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tasks.enable).not.toHaveBeenCalled();
    view.rerender(<WorkflowTasksPrompt active={false} tasks={tasks} />);
    view.rerender(<WorkflowTasksPrompt active tasks={tasks} />);
    expect(await screen.findByRole("dialog")).toBeVisible();
  });
  it("does not prompt or mutate an already enabled task", async () => {
    const tasks = service(true);
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    await waitFor(() => expect(tasks.load).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(tasks.enable).not.toHaveBeenCalled();
  });
  it("enables once after confirmation and closes only on success", async () => {
    const tasks = service();
    let finish!: () => void;
    tasks.enable.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    const button = await screen.findByRole("button", { name: "Enable tasks" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(tasks.enable).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Enabling…" })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("keeps an enable failure recoverable", async () => {
    const tasks = service();
    tasks.enable.mockRejectedValueOnce(new Error("offline"));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    fireEvent.click(await screen.findByRole("button", { name: "Enable tasks" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not enable");
    fireEvent.click(screen.getByRole("button", { name: "Enable tasks" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(tasks.enable).toHaveBeenCalledTimes(2);
  });
  it("retries recorder startup quietly without opening a false consent dialog", async () => {
    vi.useFakeTimers();
    const tasks = service(); tasks.load.mockRejectedValueOnce(new Error("offline"));
    render(<WorkflowTasksPrompt active tasks={tasks} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(tasks.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", {name:"Enable tasks"})).toBeVisible();
    vi.useRealTimers();
  });
});
