// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands } from "@/lib/utils/tauri";
import { SwitchToPersonalAccount } from "./switch-to-personal-account";

vi.mock("@/lib/utils/tauri", () => ({
  commands: {
    canSwitchToPersonalAccount: vi.fn(),
    switchToPersonalAccount: vi.fn(),
  },
}));
vi.mock("gt-react", () => ({ useGT: () => (text: string) => text }));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("leaves administrator-managed devices alone", async () => {
  vi.mocked(commands.canSwitchToPersonalAccount).mockResolvedValue(false);
  render(<SwitchToPersonalAccount />);
  await waitFor(() => expect(commands.canSwitchToPersonalAccount).toHaveBeenCalled());
  expect(screen.queryByRole("button")).toBeNull();
});

it("requires confirmation and lets the user retry a failed switch", async () => {
  vi.mocked(commands.canSwitchToPersonalAccount).mockResolvedValue(true);
  vi.mocked(commands.switchToPersonalAccount)
    .mockResolvedValueOnce({ status: "error", error: "store unavailable" })
    .mockResolvedValueOnce({ status: "ok", data: null });
  render(<SwitchToPersonalAccount />);
  fireEvent.click(await screen.findByRole("button", { name: "Switch to personal account" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(commands.switchToPersonalAccount).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Switch to personal account" }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out and restart" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Sign out and restart" }));
  expect(commands.switchToPersonalAccount).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole("button", {name: "Restarting…"})).toBeDisabled();
});
