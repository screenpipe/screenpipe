// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowRunProgress, type WorkflowRunActivity } from "@screenpipe/workflows-ui";

it("reveals real tool progress on demand, stops, and retains a calm completion receipt", async () => {
  let publish!: (items: WorkflowRunActivity[]) => void;
  const off = vi.fn(), stop = vi.fn();
  const subscribe = vi.fn(async (_id, callback) => { publish = callback; return off; });
  const props = { job: { id: "1", status: "processing" as const }, active: true, subscribe, stop, analyze: vi.fn() };
  const view = render(<WorkflowRunProgress {...props} />);
  await act(async () => {});
  act(() => publish([{ id: "t", label: "Searching captured activity", status: "running" }]));
  expect(screen.queryByRole("region", { name: "Agent activity" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Searching captured activity/ }));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searching captured activity");
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledOnce();
  act(() => publish([{ id: "t", label: "Searched captured activity", status: "complete" }]));
  view.rerender(<WorkflowRunProgress {...props} active={false} job={{ id: "1", status: "complete" }} changes={{ created: 1, updated: 2 }} />);
  expect(off).toHaveBeenCalledOnce();
  expect(screen.getByRole("status")).toHaveTextContent("1 new · 2 updated");
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
});

it("cleans up late subscriptions and ignores stale events after switching runs", async () => {
  let resolve!: (off: () => void) => void;
  let publish!: (items: WorkflowRunActivity[]) => void;
  const off = vi.fn();
  const subscribe = vi.fn((_id, callback) => { publish = callback; return new Promise<() => void>(r => { resolve = r; }); });
  const view = render(<WorkflowRunProgress active job={{ id: "old", status: "queued" }} subscribe={subscribe} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for agent");
  view.unmount();
  await act(async () => { resolve(off); });
  expect(off).toHaveBeenCalledOnce();
  act(() => publish([{ id: "late", label: "Old run", status: "running" }]));
  expect(screen.queryByText("Old run")).not.toBeInTheDocument();
});

it("shows no-change success and never labels a failed run with older change counts", () => {
  const view = render(<WorkflowRunProgress active={false} job={{ id: "1", status: "complete" }} changes={{ created: 0, updated: 0 }} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Up to date");
  view.rerender(<WorkflowRunProgress active={false} job={{ id: "2", status: "failed" }} changes={{ created: 0, updated: 2 }} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Update not saved");
  expect(screen.queryByText("0 new · 2 updated")).not.toBeInTheDocument();
});
