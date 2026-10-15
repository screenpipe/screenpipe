// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WorkflowTeamSharing } from "./workflow-team-sharing";
const status = { enabled: false, account_id: "alice", license_id: "team" };
it("keeps sharing off until the owner explicitly enables it for the displayed account", async () => {
  const api = { load: vi.fn().mockResolvedValue(status), set: vi.fn().mockResolvedValue(undefined) };
  render(<WorkflowTeamSharing active api={api} />);
  await waitFor(() => expect(api.load).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Team sharing" }));
  const toggle = await screen.findByRole("switch", { name: "Automatically share professional workflows" });
  expect(toggle).toHaveAttribute("aria-checked", "false"); expect(api.set).not.toHaveBeenCalled();
  expect(screen.getByText(/AI can misclassify/)).toBeVisible();
  api.load.mockResolvedValue({ ...status, enabled: true }); fireEvent.click(toggle);
  await waitFor(() => expect(api.set).toHaveBeenCalledWith(true, status));
  expect(await screen.findByRole("button", { name: "Team sharing: on" })).toBeVisible();
});
it("offers a local off action when account access cannot be checked", async () => {
  const api = { load: vi.fn().mockRejectedValue(new Error("Sign in")), set: vi.fn().mockResolvedValue(undefined) };
  render(<WorkflowTeamSharing active api={api} />);
  fireEvent.click(screen.getByRole("button", { name: "Team sharing" }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off sharing on this device" }));
  await waitFor(() => expect(api.set).toHaveBeenCalledWith(false, undefined));
});
it("shows a failed save without claiming sharing is on", async () => {
  const api = { load: vi.fn().mockResolvedValue(status), set: vi.fn().mockRejectedValue(new Error("Workspace access changed")) };
  render(<WorkflowTeamSharing active api={api} />);
  await waitFor(() => expect(api.load).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Team sharing" }));
  fireEvent.click(await screen.findByRole("switch"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Workspace access changed");
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
});
