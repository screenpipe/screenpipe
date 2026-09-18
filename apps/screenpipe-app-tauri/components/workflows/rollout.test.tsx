// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ flag: undefined as boolean | undefined, pathname: "/home", fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => state.flag }));
vi.mock("posthog-js", () => ({ default: { isFeatureEnabled: () => state.flag } }));
vi.mock("@/lib/api", () => ({ localFetch: state.fetch }));
import { ProductSwitcher } from "./product-switcher";
import { WorkflowsRolloutSync } from "./rollout-sync";
import { isWorkflowsRolloutEnabled } from "@/lib/workflows/rollout";
import { enableWorkflowTask, startWorkflowJob } from "@/lib/workflows/scheduled-discovery";
beforeEach(() => { state.flag = undefined; state.pathname = "/home"; state.fetch.mockReset().mockResolvedValue(new Response("{}")); });
it("fails closed until an explicit boolean true", () => {
  for (const flag of [undefined, null, false, "true", "test", 1]) expect(isWorkflowsRolloutEnabled(flag)).toBe(false);
  expect(isWorkflowsRolloutEnabled(true)).toBe(true);
});
it("hides the switcher before flag resolution and on revocation", () => {
  const view = render(<ProductSwitcher mode="screenpipe" onChange={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Switch workspace" })).toBeNull();
  state.flag = true; view.rerender(<ProductSwitcher mode="screenpipe" onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Switch workspace" })).toBeVisible();
  state.flag = false; view.rerender(<ProductSwitcher mode="screenpipe" onChange={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Switch workspace" })).toBeNull();
});
it("does not install or run tasks while excluded from rollout", async () => {
  await expect(enableWorkflowTask()).rejects.toThrow("not available");
  await expect(startWorkflowJob()).rejects.toThrow("not available");
  expect(state.fetch).not.toHaveBeenCalled();
});
it("syncs revocation to the engine without enabling a task", async () => {
  state.flag = true;
  const view = render(<WorkflowsRolloutSync />);
  await waitFor(() => expect(state.fetch).toHaveBeenCalled());
  expect(JSON.parse(state.fetch.mock.calls.at(-1)![1].body)).toEqual({ enabled: true });
  state.flag = false;
  act(() => view.rerender(<WorkflowsRolloutSync />));
  await waitFor(() => expect(JSON.parse(state.fetch.mock.calls.at(-1)![1].body)).toEqual({ enabled: false }));
  expect(state.fetch.mock.calls.every(([path]) => path === "/workflows/rollout")).toBe(true);
});

it("does not treat an unresolved secondary window flag as revocation", async () => {
  state.flag = true;
  render(<WorkflowsRolloutSync />);
  await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
  state.pathname = "/settings"; state.flag = undefined;
  render(<WorkflowsRolloutSync />);
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
it("waits for engine acknowledgement before installing or running a workflow", async () => {
  state.flag = true;
  let resolve!: (value: Response) => void;
  state.fetch.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  const started = startWorkflowJob();
  expect(state.fetch).toHaveBeenCalledTimes(1);
  expect(state.fetch.mock.calls[0][0]).toBe("/workflows/rollout");
  resolve(new Response("{}", { status: 503 }));
  await expect(started).rejects.toThrow("Could not confirm Workflows access");
  expect(state.fetch).toHaveBeenCalledTimes(1);
});
it("acknowledges the resolved grant before dispatching the selected stage", async () => {
  state.flag = true;
  state.fetch.mockImplementation(async (path: string) => {
    if (path === "/workflows/rollout" || path.endsWith("/install")) return new Response("{}");
    if (path.includes("/executions?")) return new Response(JSON.stringify({ data: [] }));
    if (path.includes("/workflows/pipeline")) return new Response(JSON.stringify({ ready: false }));
    if (path.endsWith("/run")) return new Response(JSON.stringify({ execution_id: 12 }));
    return new Response(JSON.stringify({ data: { config: { enabled: true } } }));
  });
  expect(await startWorkflowJob()).toMatchObject({ id: "workflow-activity:12", status: "queued" });
  expect(state.fetch.mock.calls[0][0]).toBe("/workflows/rollout");
  expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({ enabled: true });
  expect(state.fetch.mock.calls.at(-1)![0]).toBe("/pipes/workflow-activity/run");
});

it("does not write before flags resolve, and syncs outside home once resolved", async () => {
  state.pathname = "/settings";
  const view = render(<WorkflowsRolloutSync />);
  expect(state.fetch).not.toHaveBeenCalled();
  state.flag = true;
  view.rerender(<WorkflowsRolloutSync />);
  await waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(state.fetch.mock.calls[0][1].body)).toEqual({enabled:true});
});
it("reasserts resolved access after the engine restarts and stops on unmount", async () => {
  vi.useFakeTimers();
  try {
    state.flag = true;
    const view = render(<WorkflowsRolloutSync />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(state.fetch).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(state.fetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
