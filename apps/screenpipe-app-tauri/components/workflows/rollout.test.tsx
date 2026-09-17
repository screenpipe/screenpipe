// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ flag: undefined as boolean | undefined, fetch: vi.fn() }));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => state.flag }));
vi.mock("posthog-js", () => ({ default: { isFeatureEnabled: () => state.flag } }));
vi.mock("@/lib/api", () => ({ localFetch: state.fetch }));
import { ProductSwitcher } from "./product-switcher";
import { WorkflowsRolloutSync } from "./rollout-sync";
import { isWorkflowsRolloutEnabled } from "@/lib/workflows/rollout";
import { enableWorkflowTask, startWorkflowJob } from "@/lib/workflows/scheduled-discovery";
beforeEach(() => { state.flag = undefined; state.fetch.mockReset().mockResolvedValue(new Response("{}")); });
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
