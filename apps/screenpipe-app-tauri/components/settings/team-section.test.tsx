// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  isManagedDeployment: false,
  open: vi.fn(),
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => ({ settings: { user: mocks.user } }),
}));
vi.mock("@/lib/hooks/use-managed-policy", () => ({
  useManagedPolicy: () => ({ isManagedDeployment: mocks.isManagedDeployment }),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: mocks.open }));

import { TeamSection } from "./team-section";

describe("desktop Team settings", () => {
  beforeEach(() => {
    mocks.user = null;
    mocks.isManagedDeployment = false;
    mocks.open.mockReset();
  });
  afterEach(cleanup);

  it.each([
    "team", "enterprise", "pro", "pro_max", "pro_ultra", "business",
    "business_max", "business_ultra", "monthly", "annual",
  ])("opens account directly for %s, without relying on a browser session", (plan) => {
    mocks.user = { subscription_plan: plan };
    render(<TeamSection />);
    expect(screen.getByRole("heading", { name: "Manage your team" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account dashboard" }));
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account");
  });

  it("opens account for an Enterprise install without a consumer login", () => {
    mocks.isManagedDeployment = true;
    render(<TeamSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open account dashboard" }));
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account");
  });

  it("opens account for an organization member regardless of personal plan", () => {
    mocks.user = { subscription_plan: "none", enterprise_account: { team_id: "test-team" } };
    render(<TeamSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open account dashboard" }));
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account");
  });

  it("supports legacy Business responses with only the cloud flag", () => {
    mocks.user = { cloud_subscribed: true };
    render(<TeamSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open account dashboard" }));
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account");
  });

  it.each([null, "none", "standard", "basic", "lifetime"])(
    "preserves the team introduction for a non-team %s account", (plan) => {
      if (plan) mocks.user = { subscription_plan: plan, cloud_subscribed: true };
      render(<TeamSection />);
      expect(screen.getByRole("heading", { name: "Bring your team to Screenpipe" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open team on the web" }));
      expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/team");
    },
  );

  it("updates the destination when account state arrives", () => {
    const { rerender } = render(<TeamSection />);
    mocks.user = { subscription_plan: "team" };
    rerender(<TeamSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open account dashboard" }));
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account");
  });
});
