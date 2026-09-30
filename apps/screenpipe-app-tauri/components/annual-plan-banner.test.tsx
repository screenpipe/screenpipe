// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnnualPlanBanner } from "./annual-plan-banner";

const mocks = vi.hoisted(() => ({
  open: vi.fn(), fetch: vi.fn(),
  user: { id: "fixture", token: "fixture-token", subscription_plan: "pro" } as any,
  managed: false,
}));
vi.mock("@/lib/open-external-url", () => ({ openExternalUrl: mocks.open }));
vi.mock("@/lib/http/tauri-fetch", () => ({ tauriFetchWithDeadline: mocks.fetch }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: { user: mocks.user } }) }));
vi.mock("@/lib/hooks/use-managed-policy", () => ({ useManagedPolicy: () => ({ isManagedDeployment: mocks.managed, isManagedDeploymentResolved: true }) }));
const billing = { subscription_scope: "personal", subscription_status: "active", subscription_id: "sub-fixture", plan: "pro", active_subscription: { interval: "month", amount_cents: 5000, cancel_at_period_end: false, lifetime: false } };
const options = { current: { tier: "pro", interval: "month", seats: 1 }, targets: [{ plan: "pro", tier: "pro", interval: "year", unitAmount: 500, perSeat: false, requiresSeats: false }] };
const findSwitch = () => screen.findByRole("button", { name: "Switch to annual" });
beforeEach(() => {
  localStorage.clear();
  mocks.user = { id: "fixture", token: "fixture-token", subscription_plan: "pro" };
  mocks.managed = false;
  mocks.open.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("change-plan") ? options : billing)));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("annual billing banner", () => {
  it("opens a same-plan annual review without writing billing", async () => {
    render(<AnnualPlanBanner />);
    fireEvent.click(await findSwitch());
    await screen.findByText(/Billing opened in your browser/);
    expect(mocks.open).toHaveBeenCalledWith("https://screenpipe.com/account/billing?target_plan=pro&interval=year");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls) {
      expect(init.method).toBeUndefined();
      expect(init.headers.Authorization).toBe("Bearer fixture-token");
    }
    expect(screen.getByText(/Before discounts and taxes/)).toBeInTheDocument();
  });
  it("keeps the decline across remounts and scopes it to the account", async () => {
    const first = render(<AnnualPlanBanner />);
    await findSwitch();
    fireEvent.click(screen.getByRole("button", { name: "Keep monthly" }));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
    first.unmount();
    const second = render(<AnnualPlanBanner />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(4));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
    mocks.user = { ...mocks.user, id: "other" };
    second.rerender(<AnnualPlanBanner />);
    await findSwitch();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("shows pending, suppresses repeated clicks, and recovers from an opening error", async () => {
    let reject!: (reason: Error) => void;
    mocks.open.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    render(<AnnualPlanBanner />);
    fireEvent.click(await findSwitch());
    const pending = screen.getByRole("button", { name: "Opening billing…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    reject(new Error("browser unavailable"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/Billing opened in your browser/);
  });
  it("fails quietly when billing cannot be verified", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    render(<AnnualPlanBanner />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
  });
  it.each(["annual", "workspace", "trial"])("hides live %s status", async state => {
    mocks.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("change-plan") ? options : { ...billing, ...(state === "workspace" ? { subscription_scope: "workspace" } : state === "trial" ? { subscription_status: "trialing" } : { active_subscription: { ...billing.active_subscription, interval: "year" } }) })));
    render(<AnnualPlanBanner />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
  });
  it("does not request billing for managed deployments or signed-out users", () => {
    mocks.managed = true;
    const view = render(<AnnualPlanBanner />);
    mocks.managed = false; mocks.user = null;
    view.rerender(<AnnualPlanBanner />);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not show an old account's delayed offer after sign-out", async () => {
    let resolve!: (value: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const view = render(<AnnualPlanBanner />);
    mocks.user = null; view.rerender(<AnnualPlanBanner />);
    resolve(new Response(JSON.stringify(billing)));
    await waitFor(() => expect(screen.queryByTestId("annual-plan-banner")).toBeNull());
  });
});

describe("annual offer revalidation", () => {
  it("rechecks on return from billing even inside the focus throttle", async () => {
    render(<AnnualPlanBanner />);
    fireEvent.click(await findSwitch());
    await screen.findByText(/Billing opened in your browser/);
    mocks.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes("change-plan") ? options : { ...billing, active_subscription: { ...billing.active_subscription, interval: "year" } })));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(4));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
  });
  it("still dismisses when local storage is unavailable", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      render(<AnnualPlanBanner />);
      await findSwitch();
      fireEvent.click(screen.getByRole("button", { name: "Keep monthly" }));
      expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
    } finally { set.mockRestore(); }
  });
  it("never presents fallback prices for malformed or rejected responses", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 503 }));
    render(<AnnualPlanBanner />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("annual-plan-banner")).toBeNull();
  });
});
