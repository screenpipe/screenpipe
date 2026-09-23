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
  expect(screen.getByRole("status")).toHaveTextContent("Updating workflows");
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searched captured activity");
  act(() => publish([{ id: "t", label: "An update action failed", status: "error" }]));
  expect(screen.getByRole("status")).toHaveTextContent("Updating workflows");
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("An update action failed");
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
  expect(screen.getByRole("status")).toHaveTextContent("Waiting to start");
  view.unmount();
  await act(async () => { resolve(off); });
  expect(off).toHaveBeenCalledOnce();
  act(() => publish([{ id: "late", label: "Old run", status: "running" }]));
  expect(screen.queryByText("Old run")).not.toBeInTheDocument();
});

it("shows no-change success and never labels a failed run with older change counts", () => {
  const view = render(<WorkflowRunProgress active={false} job={{ id: "1", status: "complete" }} changes={{ created: 0, updated: 0 }} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("No changes found");
  view.rerender(<WorkflowRunProgress active={false} job={{ id: "2", status: "failed" }} changes={{ created: 0, updated: 2 }} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Update failed");
  expect(screen.queryByText("0 new · 2 updated")).not.toBeInTheDocument();
});

it("shows an incomplete pipeline as resumable without claiming the catalog saved", () => {
  const analyze = vi.fn();
  render(<WorkflowRunProgress active={false} job={{ id: "activity:48", status: "incomplete", message: "Resume to continue" }} changes={{ created: 0, updated: 2 }} analyze={analyze} />);
  expect(screen.getByRole("status")).toHaveTextContent("Update incomplete");
  expect(screen.queryByText("0 new · 2 updated")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume update" }));
  expect(analyze).toHaveBeenCalledOnce();
});

it("shows actual reviewed coverage after reload rather than calling yesterday's batch current", () => {
  render(<WorkflowRunProgress active={false} updatedAt="2026-09-17T17:55:00Z" checkedThrough="2026-09-16T21:08:00Z" changes={{created:0,updated:0}} analyze={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("No changes found");
  expect(screen.getByRole("status")).toHaveTextContent("Sep 16");
  fireEvent.click(screen.getByRole("button",{name:/Show agent activity/}));
  expect(screen.getByRole("region",{name:"Agent activity"})).toHaveTextContent("Data reviewed through");
  expect(screen.queryByText(/Waiting for the next agent/)).not.toBeInTheDocument();
});

it("keeps quiet receipts compact without hiding failure, resume, or stop controls", () => {
  const analyze = vi.fn(), stop = vi.fn();
  const props = { quiet: true, active: false, analyze, stop, checkedThrough: "2026-09-16T21:08:00Z", updatedAt: "2026-09-17T17:55:00Z", changes: { created: 0, updated: 0 } };
  const view = render(<WorkflowRunProgress {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent("Reviewed through");
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("No changes found");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Agent activity" })).not.toBeInTheDocument();
  view.rerender(<WorkflowRunProgress {...props} job={{ id: "failed", status: "failed" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Update failed");
  view.rerender(<WorkflowRunProgress {...props} job={{ id: "incomplete", status: "incomplete" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Update incomplete");
  fireEvent.click(screen.getByRole("button", { name: "Resume update" }));
  expect(analyze).toHaveBeenCalledOnce();
  view.rerender(<WorkflowRunProgress {...props} active job={{ id: "active", status: "processing" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledOnce();
});

it("keeps an open feed across agent handoffs, namespaces action IDs, and resets only for a new cycle", async () => {
  const callbacks = new Map<string, (items: WorkflowRunActivity[]) => void>();
  const cleanups: ReturnType<typeof vi.fn>[] = [];
  const subscribe = vi.fn(async (id, publish) => { callbacks.set(id, publish); const off = vi.fn(); cleanups.push(off); return off; });
  const props = { active: true, subscribe, analyze: vi.fn() };
  const view = render(<WorkflowRunProgress {...props} job={{ id: "discover:1", cycleId: "cycle-a", status: "processing" }} />);
  await act(async () => {});
  act(() => callbacks.get("discover:1")!([{ id: "1", label: "Searching recordings", status: "running" }]));
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  view.rerender(<WorkflowRunProgress {...props} job={{ id: "review:2", cycleId: "cycle-a", status: "processing" }} />);
  await act(async () => {});
  act(() => callbacks.get("review:2")!([{ id: "1", label: "Saving workflows", status: "running" }]));
  act(() => callbacks.get("discover:1")!([{ id: "1", label: "Searched recordings", status: "complete" }]));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searched recordings");
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Saving workflows");
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(cleanups[0]).not.toHaveBeenCalled();
  view.rerender(<WorkflowRunProgress {...props} job={{ id: "discover:3", cycleId: "cycle-b", status: "processing" }} />);
  await act(async () => {});
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(cleanups[1]).toHaveBeenCalledOnce();
  act(() => callbacks.get("review:2")!([{ id: "1", label: "Stale result", status: "complete" }]));
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  expect(screen.getByRole("region", { name: "Agent activity" })).not.toHaveTextContent(/Searched recordings|Saving workflows|Stale result/);
});

it("keeps activity through reconnects and empty snapshots without duplicating replayed actions", async () => {
  let publish!: (items: WorkflowRunActivity[]) => void;
  const subscribe = vi.fn(async (_id, callback) => { publish = callback; return vi.fn(); });
  const props = { active: true, subscribe, analyze: vi.fn(), job: { id: "1", cycleId: "cycle", status: "processing" as const } };
  const view = render(<WorkflowRunProgress {...props} />);
  await act(async () => {});
  act(() => publish([{ id: "a", label: "Searched recordings", status: "complete" }]));
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  view.rerender(<WorkflowRunProgress {...props} active={false} />);
  view.rerender(<WorkflowRunProgress {...props} />);
  await act(async () => {});
  act(() => publish([]));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Searched recordings");
  act(() => publish([{ id: "a", label: "Searching recordings", status: "running" }]));
  expect(screen.getByRole("status")).toHaveTextContent("Updating workflows");
  act(() => publish([{ id: "a", label: "Searched recordings", status: "complete" }]));
  expect(screen.getAllByText("Searched recordings")).toHaveLength(1);
});

it("does not rotate old snapshots back into the recent feed during overlapping agents", async () => {
  const callbacks = new Map<string, (items: WorkflowRunActivity[]) => void>();
  const subscribe = vi.fn(async (id, callback) => { callbacks.set(id, callback); return vi.fn(); });
  const props = { active: true, subscribe, analyze: vi.fn() };
  const view = render(<WorkflowRunProgress {...props} job={{ id: "first", cycleId: "cycle", status: "processing" }} />);
  await act(async () => {});
  const old: WorkflowRunActivity[] = Array.from({ length: 20 }, (_, n) => ({ id: String(n), label: `Earlier action ${n}`, status: "complete" }));
  act(() => callbacks.get("first")!(old));
  fireEvent.click(screen.getByRole("button", { name: /Show agent activity/ }));
  view.rerender(<WorkflowRunProgress {...props} job={{ id: "second", cycleId: "cycle", status: "processing" }} />);
  await act(async () => {});
  act(() => callbacks.get("second")!([{ id: "new", label: "Saving workflows", status: "running" }]));
  act(() => callbacks.get("first")!(old));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Saving workflows");
  expect(screen.queryByText("Earlier action 0", { exact: true })).not.toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(20);
  act(() => callbacks.get("first")!([{ ...old[0], label: "Earlier action failed", status: "error" }, ...old.slice(1)]));
  expect(screen.getByRole("region", { name: "Agent activity" })).toHaveTextContent("Earlier action failed");
});
